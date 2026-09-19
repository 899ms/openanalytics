import { eventOccurredMs, sessionize, type SessionizerEvent } from '@openanalytics/domain'
import type { SessionRollupUnit, WindowEventsPage } from '@openanalytics/clickhouse'
import { WORKER_METRICS } from '../ingest/metrics.ts'
import type { FinalizerDeps } from './deps.ts'
import { planRollupSwap, planSessionFacts } from './plan.ts'

/**
 * The session finalizer (plan Milestone 8 items 2-4; docs snapshot 02 §10, §15,
 * 05 D-211). Milestone 8 Checkpoint B.
 *
 * One site, one run, and never any session logic of its own: it reads the raw
 * events of the recompute window, drives the pure `sessionize` from
 * @openanalytics/domain, and turns the diff between what that produces and what
 * is stored into versioned fact writes and a rollup swap. The order is the
 * guarantee — facts are made durable before the rollups that summarise them, and
 * the watermark advances only after both, so a crash at any point is recovered by
 * a re-run that recomputes the same window and finds nothing left to do.
 *
 *   1. **Claim.** A conditional lease (migration 0017); a site another worker
 *      holds is skipped.
 *   2. **Recompute.** Read `[watermark, now)` from `events_raw`, sessionize,
 *      read the stored facts of the same window.
 *   3. **Version.** Insert a strictly higher version for every changed session
 *      and a tombstone for every vanished one (finalized iff past the
 *      inactivity + lateness horizon).
 *   4. **Swap.** Recompute every affected hour/day bucket from the current
 *      non-retracted facts and insert it at a higher generation.
 *   5. **Advance.** Move the watermark to the earliest still-provisional session
 *      and release the lease.
 */

const MS_PER_QUARTER_HOUR = 900_000
const MS_PER_DAY = 86_400_000

/**
 * The most raw events one recompute window may read.
 *
 * There was no cap at all until 2026-08-24, and `readWindowEvents` read
 * `[watermark, infinity)`. That is fine while the watermark keeps moving and
 * vicious the moment it stops: a site sending a million events accumulates them
 * all into one window, the window is read into memory, the process dies, the
 * watermark therefore never advances, and the next run reads the same window
 * plus whatever arrived meanwhile. The worker spent ten hours in that loop on
 * 2026-08-22 — 111 restarts — against a site with 961,858 rows in its window.
 *
 * A ROW cap and not a TIME cap, which is the part worth stating plainly: a time
 * cap bounds how much clock the window covers, not how much memory it costs. A
 * customer sending a million events an hour blows through an hour-wide window
 * exactly as they blew through an unbounded one. Rows are the thing that is
 * actually allocated, so rows are the thing to bound.
 *
 * 200,000: 962k rows exhausted a 768 MB heap, so a fifth of that is roughly a
 * 300 MB peak with the limit left where it is. The number is derived from one
 * measurement, and `docker stats oa-worker` after deployment is what should
 * move it — not a second estimate.
 */
const MAX_WINDOW_ROWS = 200_000

export interface FinalizeSiteResult {
  readonly siteId: string
  readonly skipped: boolean
  readonly changed: number
  readonly retracted: number
  readonly rollupSwaps: number
  readonly finalizedThroughMs: number
}

const UNIT_WIDTH_MS: Record<SessionRollupUnit, number> = {
  '15m': MS_PER_QUARTER_HOUR,
  '1d': MS_PER_DAY,
}

export async function finalizeSite(
  deps: FinalizerDeps,
  siteId: string,
): Promise<FinalizeSiteResult> {
  const claim = await deps.state.claim(siteId)
  if (!claim) {
    deps.metrics.increment(WORKER_METRICS.sessionFinalizeSkipped, { site_id: siteId })
    return {
      siteId,
      skipped: true,
      changed: 0,
      retracted: 0,
      rollupSwaps: 0,
      finalizedThroughMs: 0,
    }
  }

  // The *inner* half of the lifecycle fence (ADR-0030, decision 7). The driver
  // already filtered discovery, but this run may have been queued before the
  // site was marked `deleting`, and the claim above is what a deletion's
  // `finalizer_fence` phase competes for. Re-checking after the claim is what
  // makes the window between the two a no-op rather than a recompute that writes
  // rows into a table a purge is about to verify as empty.
  //
  // The lease is released, not held: this run has decided it has no work, and a
  // held lease would make the deletion job wait out the full TTL for nothing.
  const finalizable = await deps.filterFinalizable([siteId])
  if (finalizable.length === 0) {
    await deps.state.release(siteId).catch((releaseErr: unknown) => {
      deps.logger.error('session_finalize_release_failed', {
        site_id: siteId,
        err: releaseErr,
        retryable: false,
      })
    })
    deps.metrics.increment(WORKER_METRICS.sessionFinalizeSkipped, { site_id: siteId })
    deps.logger.info('session_finalize_skipped_lifecycle', { site_id: siteId })
    return {
      siteId,
      skipped: true,
      changed: 0,
      retracted: 0,
      rollupSwaps: 0,
      finalizedThroughMs: 0,
    }
  }

  const startedAt = Date.now()
  const nowMs = deps.now().getTime()
  const fromMs = claim.finalizedThroughMs
  const inactivityMs = deps.sessionConfig.SESSION_INACTIVITY_MINUTES * 60_000
  // The 24h session cap (ADR-0018), threaded from the same typed session config
  // the sessionizer is driven with, so the finalizer's watermark bound uses the
  // exact value the split enforces.
  const sessionMaxLengthMs = deps.sessionConfig.SESSION_MAX_LENGTH_HOURS * 60 * 60_000

  try {
    // 2. Recompute the window from the raw events, and read what is stored for it.
    //
    // The window is `[fromMs, windowToMs)`, and `windowToMs` is `nowMs` only
    // when everything up to now fitted under `MAX_WINDOW_ROWS`. When it did
    // not, the bound is pulled back to where the read actually stopped, and
    // this run finalizes a prefix of the backlog instead of choking on all of
    // it. Successive runs walk forward through the rest.
    const page = await deps.store.readWindowEvents({
      siteId,
      fromMs,
      toMs: nowMs,
      limit: MAX_WINDOW_ROWS,
    })
    const { windowToMs, events } = await resolveWindow(deps, siteId, fromMs, nowMs, page)

    const recomputed = sessionize(siteId, events, deps.sessionConfig)
    // The SAME bound. A stored fact starting after `windowToMs` is one this run
    // did not read the events for, and step 3 tombstones every stored session
    // it cannot find among the recomputed ones — so reading a wider set of
    // stored facts than events would retract the entire unread tail.
    const stored = await deps.store.readStoredFacts({ siteId, fromMs, toMs: windowToMs })

    const plan = planSessionFacts({
      siteId,
      recomputed,
      stored,
      nowMs,
      // The line the whole change turns on.
      //
      // `planSessionFacts` derives its finalization horizon from how much of the
      // past it may treat as settled, and left to itself it assumes that is
      // "everything up to `nowMs`". After a truncated read that assumption is
      // false: it would judge sessions whose events were never loaded, find them
      // missing from `recomputed`, and advance the watermark past rows nothing
      // ever sessionized. Telling it where the read actually stopped is what
      // keeps both from happening — the watermark it returns can never exceed
      // `windowToMs - inactivity`, so this run can never claim to have finalized
      // anything it did not look at.
      //
      // Passed alongside the real `nowMs` rather than instead of it, which
      // matters twice. Fact versions are stamped `computed_at: nowMs` and have
      // to stay monotonic against wall time. And the lateness allowance is a
      // statement about `nowMs` — how much of the RECENT past may still be
      // arriving — which is a different question from how far this read got, and
      // charging a seven-hour window for a twenty-four-hour allowance would put
      // the horizon behind the watermark and stall the site permanently.
      readThroughMs: windowToMs,
      inactivityMs,
      latenessMs: deps.latenessMs,
      sessionMaxLengthMs,
    })

    // 3. Versions and tombstones. Durable before the rollups summarise them.
    if (plan.factRows.length > 0) {
      await deps.store.insertFactVersions(plan.factRows)
      if (plan.changed > 0)
        deps.metrics.increment(WORKER_METRICS.sessionFactVersions, {}, plan.changed)
      if (plan.retracted > 0)
        deps.metrics.increment(WORKER_METRICS.sessionFactRetractions, {}, plan.retracted)
    }

    // 4. Swap every affected bucket at a higher generation.
    let rollupSwaps = 0
    // Two grains since ADR-0079 step 4 (migration 0027): the hour rollup was
    // read by nothing after step 3 moved every composition to the quarter, so
    // writing it was a third of this loop's work for nobody. Migration 0029
    // (v0.8.0) then dropped `session_rollups_1h` itself.
    const unitBuckets: Record<SessionRollupUnit, readonly number[]> = {
      '15m': plan.affectedQuarterBucketsMs,
      '1d': plan.affectedDayBucketsMs,
    }
    for (const unit of ['15m', '1d'] as const) {
      const affectedMs = unitBuckets[unit]
      if (affectedMs.length === 0) continue

      const loMs = affectedMs[0]!
      const hiMs = affectedMs[affectedMs.length - 1]! + UNIT_WIDTH_MS[unit]

      const [recomputedBuckets, storedRollups] = await Promise.all([
        deps.store.aggregateRollupBuckets({ siteId, unit, loMs, hiMs }),
        deps.store.readStoredRollups({ siteId, unit, loMs, hiMs }),
      ])

      const rollupPlan = planRollupSwap({
        siteId,
        recomputed: recomputedBuckets,
        stored: storedRollups,
        affectedBucketSeconds: affectedMs.map((ms) => ms / 1000),
        computedAtMs: nowMs,
      })

      if (rollupPlan.rows.length > 0) {
        await deps.store.insertRollups({ unit, rows: rollupPlan.rows })
        // Labelled by unit, as the revenue counter already is. An unlabelled
        // total cannot answer the one question a 15m rollout actually asks --
        // "is the finalizer writing the new grain at all" -- because a healthy
        // hour-and-day number hides a fifteen-minute zero.
        deps.metrics.increment(WORKER_METRICS.sessionRollupSwaps, { unit }, rollupPlan.changed)
        rollupSwaps += rollupPlan.changed
      }
    }

    // 5. Advance the watermark (monotonic) and release the lease.
    const finalizedThroughMs = Math.max(fromMs, plan.finalizedThroughMs)
    await deps.state.advance(siteId, finalizedThroughMs)

    deps.metrics.increment(WORKER_METRICS.sessionFinalizeRuns)
    deps.metrics.increment(WORKER_METRICS.sessionFinalizeMs, {}, Date.now() - startedAt)

    if (plan.changed > 0 || plan.retracted > 0 || rollupSwaps > 0) {
      deps.logger.info('session_finalized', {
        site_id: siteId,
        changed: plan.changed,
        retracted: plan.retracted,
        rollup_swaps: rollupSwaps,
        version: plan.version,
        finalized_through_ms: finalizedThroughMs,
      })
    }

    return {
      siteId,
      skipped: false,
      changed: plan.changed,
      retracted: plan.retracted,
      rollupSwaps,
      finalizedThroughMs,
    }
  } catch (err) {
    // Release without advancing so the next run retries the same window. Safe
    // because the whole recompute is a pure function of the events — a half-done
    // run left durable facts that a re-run recognises as already current.
    deps.metrics.increment(WORKER_METRICS.sessionFinalizeFailed, { site_id: siteId })
    deps.logger.error('session_finalize_failed', { site_id: siteId, err, retryable: true })
    await deps.state.release(siteId).catch((releaseErr: unknown) => {
      deps.logger.error('session_finalize_release_failed', {
        site_id: siteId,
        err: releaseErr,
        retryable: false,
      })
    })
    throw err
  }
}

/**
 * Decide the window's upper bound from what the capped read actually returned.
 *
 * Uncut page: the bound is `nowMs`, and this is the ordinary path — the cap is
 * inert on every site that is keeping up.
 *
 * Cut page: the last millisecond read is presumed INCOMPLETE, because the cap
 * can fall anywhere inside it and rows sharing a millisecond are ordered by
 * `event_id`, which means nothing. So the bound becomes that millisecond
 * (exclusive) and the events inside it are dropped along with it. They are not
 * lost; the next run starts there.
 */
async function resolveWindow(
  deps: FinalizerDeps,
  siteId: string,
  fromMs: number,
  nowMs: number,
  page: WindowEventsPage,
): Promise<{ windowToMs: number; events: SessionizerEvent[] }> {
  if (!page.truncated || page.lastOccurredMs === null) {
    return { windowToMs: nowMs, events: page.events }
  }

  const boundaryMs = page.lastOccurredMs

  // The degenerate case, and the one that would otherwise wedge the finalizer
  // permanently: every row under the cap shares a single millisecond, so
  // trimming to it gives `toMs <= fromMs` — a zero-width window, no watermark
  // movement, and the same read forever. No bound both respects the cap and
  // makes progress here, so progress wins: that millisecond is read whole, over
  // the cap, and the window advances by 1 ms.
  //
  // Deliberately unbounded, because bounding it is what creates the deadlock. A
  // single millisecond holding more than 200,000 events for one site is 200
  // million events per second from one customer; if that is ever real, the
  // collector's limiter is what failed, not this.
  if (boundaryMs <= fromMs) {
    const whole = await deps.store.readWindowEvents({ siteId, fromMs, toMs: fromMs + 1 })
    deps.logger.warn('session_window_millisecond_over_cap', {
      site_id: siteId,
      from_ms: fromMs,
      rows: whole.events.length,
    })
    return { windowToMs: fromMs + 1, events: whole.events }
  }

  // `<`, matching the exclusive upper bound the query itself uses, so the events
  // handed to the sessionizer are exactly those of `[fromMs, boundaryMs)` — no
  // wider than the window this run claims to have finalized.
  const events = page.events.filter((event) => eventOccurredMs(event.occurredAt) < boundaryMs)
  deps.logger.info('session_window_truncated', {
    site_id: siteId,
    from_ms: fromMs,
    to_ms: boundaryMs,
    now_ms: nowMs,
    events: events.length,
    // How far behind the site still is after this run. A figure that stays flat
    // across runs means the cap is below the site's arrival rate and the
    // finalizer can never catch up — the one thing here worth watching.
    lag_ms: nowMs - boundaryMs,
  })
  return { windowToMs: boundaryMs, events }
}
