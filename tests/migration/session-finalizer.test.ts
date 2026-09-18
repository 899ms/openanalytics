import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import {
  BackfillRefusedError,
  backfillSessionRollups15m,
  createSessionFactsStore,
  migrateClickHouse,
} from '@openanalytics/clickhouse'
import { DEFAULT_SESSION_CONFIG } from '@openanalytics/domain'
import { createRecordingMetrics } from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { finalizeSite } from '../../apps/worker/src/sessions/finalizer.ts'
import type { FinalizerDeps } from '../../apps/worker/src/sessions/deps.ts'
import type { FinalizerState } from '../../apps/worker/src/sessions/state.ts'

/**
 * The M8 session finalizer, proven end-to-end against a real ClickHouse (plan
 * Milestone 8 acceptance criteria 1-3; docs snapshot 05, D-211). Checkpoint B.
 *
 * The three acceptance criteria, each with a named test:
 *   1. a late second pageview flips a recorded bounce to engaged and the read
 *      reflects it — no incremental-MV shortcut, the finalizer re-sessionizes;
 *   2. re-running over an already-finalized range changes nothing and produces
 *      no duplicate versions or generations;
 *   3. a duplicated duration beacon does not inflate active duration.
 *
 * The finalizer is driven with a real ClickHouse store and an in-memory
 * watermark, so the whole recompute/version/swap path runs without needing
 * Postgres too. Skipped without TEST_CLICKHOUSE_URL; CI always provides one.
 */

const URL_ = process.env['TEST_CLICKHOUSE_URL']
const USERNAME = process.env['TEST_CLICKHOUSE_USER'] ?? 'default'
const PASSWORD = process.env['TEST_CLICKHOUSE_PASSWORD'] ?? ''
const describeIfClickHouse = URL_ ? describe : describe.skip

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

const INACTIVITY_MS = DEFAULT_SESSION_CONFIG.SESSION_INACTIVITY_MINUTES * 60_000
const LATENESS_MS = 24 * 60 * 60_000

function chDateTime64(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
}

/** An in-memory finalizer watermark + lease, so the data test needs no Postgres. */
function memoryState(): FinalizerState & {
  set(siteId: string, ms: number): void
  get(siteId: string): number
} {
  const watermark = new Map<string, number>()
  const held = new Set<string>()
  return {
    async claim(siteId) {
      if (held.has(siteId)) return null
      held.add(siteId)
      return { finalizedThroughMs: watermark.get(siteId) ?? 0, runSeq: 0 }
    },
    async advance(siteId, ms) {
      watermark.set(siteId, ms)
      held.delete(siteId)
    },
    async release(siteId) {
      held.delete(siteId)
    },
    set(siteId, ms) {
      watermark.set(siteId, ms)
    },
    get(siteId) {
      return watermark.get(siteId) ?? 0
    },
  }
}

describeIfClickHouse('session finalizer behaviour', () => {
  const url = URL_ as string
  const database = `m8final_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let client: ReturnType<typeof createClient>
  let store: ReturnType<typeof createSessionFactsStore>

  const queryRows = async <T>(query: string): Promise<T[]> => {
    const resultSet = await client.query({ query, format: 'JSONEachRow' })
    return await resultSet.json<T>()
  }
  const scalar = async (query: string): Promise<number> => {
    const [row] = await queryRows<Record<string, string>>(query)
    return Number(Object.values(row ?? {})[0] ?? 0)
  }

  interface RawEvent {
    eventId?: string
    type: string
    occurredMs: number
    anonymousId?: string
    sessionHint?: string
    userId?: string
    pagePath?: string
    activeMs?: number
  }

  const insertEvents = async (siteId: string, events: readonly RawEvent[]): Promise<void> => {
    const rows = events.map((event) => ({
      site_id: siteId,
      event_id: event.eventId ?? randomUUID(),
      type: event.type,
      occurred_at: chDateTime64(event.occurredMs),
      accepted_at: chDateTime64(event.occurredMs),
      anonymous_id: event.anonymousId ?? 'anonA',
      session_id: event.sessionHint ?? 'hintA',
      user_id: event.userId ?? '',
      page_path: event.pagePath ?? '/',
      properties:
        event.type === 'engagement'
          ? JSON.stringify({
              oa_active_ms: event.activeMs ?? 0,
              oa_visible_ms: event.activeMs ?? 0,
            })
          : '{}',
    }))
    await client.insert({ table: 'events_raw', values: rows, format: 'JSONEachRow' })
  }

  /** Sites this suite's finalizer may work. Overridden by the lifecycle-fence
   * test to prove a `deleting` site is skipped after the claim. */
  const finalizable = { blocked: new Set<string>() }

  const makeDeps = (state: FinalizerState, nowRef: { ms: number }): FinalizerDeps => ({
    store,
    state,
    filterFinalizable: async (siteIds) =>
      await Promise.resolve(siteIds.filter((siteId) => !finalizable.blocked.has(siteId))),
    sessionConfig: DEFAULT_SESSION_CONFIG,
    latenessMs: LATENESS_MS,
    logger: createCapturedLogger().logger,
    metrics: createRecordingMetrics(),
    now: () => new Date(nowRef.ms),
  })

  /** The current (latest-version, non-retracted) fact of a session. */
  const currentFact = (siteId: string, sessionId: string) =>
    queryRows<{
      engaged: string
      pageviews: string
      finalized: string
      retracted: string
      active: string
    }>(
      `SELECT
         argMax(sfv.engaged, sfv.version)            AS engaged,
         argMax(sfv.pageviews, sfv.version)          AS pageviews,
         argMax(sfv.finalized, sfv.version)          AS finalized,
         argMax(sfv.retracted, sfv.version)          AS retracted,
         argMax(sfv.active_duration_ms, sfv.version) AS active
       FROM session_facts_versions AS sfv
       WHERE site_id = '${siteId}' AND session_id = '${sessionId}'
       GROUP BY site_id, session_id`,
    )

  /**
   * The current (latest-generation) quarter-hour rollup of a site, summed over
   * its buckets.
   *
   * It read `session_rollups_1h` until ADR-0079 step 4 stopped the finalizer
   * writing that table. Every case below seeds inside one quarter, so the sum
   * is over exactly the bucket the hour row used to be.
   */
  const currentRollup = (siteId: string) =>
    queryRows<{ sessions: string; engaged: string; bounced: string }>(
      `SELECT
         sum(cur.sessions) AS sessions,
         sum(cur.engaged)  AS engaged,
         sum(cur.bounced)  AS bounced
       FROM (
         SELECT
           argMax(srh.sessions, srh.generation)         AS sessions,
           argMax(srh.engaged_sessions, srh.generation) AS engaged,
           argMax(srh.bounced_sessions, srh.generation) AS bounced
         FROM session_rollups_15m AS srh
         WHERE site_id = '${siteId}' GROUP BY site_id, bucket_start
       ) AS cur`,
    )

  beforeAll(async () => {
    const { logger } = createCapturedLogger()
    await migrateClickHouse({
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
      directory: MIGRATIONS_DIR,
      logger,
    })
    client = createClient({
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
      clickhouse_settings: { async_insert: 0, wait_for_async_insert: 1 },
    })
    store = createSessionFactsStore({ url, username: USERNAME, password: PASSWORD, database })
  }, 120_000)

  afterAll(async () => {
    await store?.close()
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` })
      await client.close()
    }
  })

  it('flips a recorded bounce to engaged when a late second pageview arrives (criterion 1)', async () => {
    const site = randomUUID()
    const state = memoryState()
    const baseMs = Date.parse('2026-05-01T10:00:00.000Z')

    // First pageview only: the first run records a provisional bounce.
    await insertEvents(site, [{ type: 'page_view', occurredMs: baseMs, pagePath: '/' }])
    const now = { ms: baseMs + 5 * 60_000 }
    const deps = makeDeps(state, now)
    const first = await finalizeSite(deps, site)
    expect(first.changed).toBe(1)

    // The session id is the sessionizer's hash of (site, earliest event id); read
    // the single stored session and confirm it bounced and is provisional.
    const [bouncedRow] = await queryRows<{
      session_id: string
      engaged: string
      finalized: string
    }>(
      `SELECT session_id, argMax(sfv.engaged, sfv.version) AS engaged,
              argMax(sfv.finalized, sfv.version) AS finalized
         FROM session_facts_versions AS sfv WHERE site_id = '${site}'
        GROUP BY site_id, session_id`,
    )
    expect(Number(bouncedRow!.engaged)).toBe(0)
    expect(Number(bouncedRow!.finalized)).toBe(0)
    const sessionId = bouncedRow!.session_id

    // The provisional rollup shows one bounced session.
    let [rollup] = await currentRollup(site)
    expect([Number(rollup!.sessions), Number(rollup!.engaged), Number(rollup!.bounced)]).toEqual([
      1, 0, 1,
    ])

    // A late second pageview arrives (4 minutes after the first, inside the gap).
    await insertEvents(site, [
      { type: 'page_view', occurredMs: baseMs + 4 * 60_000, pagePath: '/pricing' },
    ])
    now.ms = baseMs + 10 * 60_000
    const second = await finalizeSite(deps, site)
    expect(second.changed).toBe(1)

    // The read now reflects an engaged session on the SAME id — the bounce is
    // undone, with no incremental view anywhere.
    const [engagedRow] = await currentFact(site, sessionId)
    expect(Number(engagedRow!.engaged)).toBe(1)
    expect(Number(engagedRow!.pageviews)).toBe(2)
    expect(Number(engagedRow!.finalized)).toBe(0)

    // Two physical versions exist; the rollup swapped to engaged.
    expect(
      await scalar(
        `SELECT count() FROM session_facts_versions WHERE site_id = '${site}' AND session_id = '${sessionId}'`,
      ),
    ).toBe(2)
    ;[rollup] = await currentRollup(site)
    expect([Number(rollup!.sessions), Number(rollup!.engaged), Number(rollup!.bounced)]).toEqual([
      1, 1, 0,
    ])

    // Long past the horizon: the session finalizes, and the read stays engaged.
    now.ms = baseMs + LATENESS_MS + INACTIVITY_MS + 60 * 60_000
    const third = await finalizeSite(deps, site)
    expect(third.changed).toBe(1)
    const [finalRow] = await currentFact(site, sessionId)
    expect(Number(finalRow!.finalized)).toBe(1)
    expect(Number(finalRow!.engaged)).toBe(1)
  })

  it('changes nothing and adds no duplicates on a re-run over a finalized range (criterion 2)', async () => {
    const site = randomUUID()
    const state = memoryState()
    const baseMs = Date.parse('2026-05-02T10:00:00.000Z')
    await insertEvents(site, [
      { type: 'page_view', occurredMs: baseMs, pagePath: '/' },
      { type: 'page_view', occurredMs: baseMs + 3 * 60_000, pagePath: '/next' },
    ])

    // Finalize the range fully (now well past the horizon).
    const now = { ms: baseMs + LATENESS_MS + INACTIVITY_MS + 60 * 60_000 }
    const deps = makeDeps(state, now)
    await finalizeSite(deps, site)

    const factCountBefore = await scalar(
      `SELECT count() FROM session_facts_versions WHERE site_id = '${site}'`,
    )
    const rollupCountBefore = await scalar(
      `SELECT count() FROM session_rollups_15m WHERE site_id = '${site}'`,
    )
    const [rollupBefore] = await currentRollup(site)

    // Force a recompute of the already-finalized range by resetting the watermark
    // to zero, then re-run. The pure sessionizer reproduces byte-identical
    // sessions, so the diff is empty: no new version, no new generation.
    state.set(site, 0)
    const rerun = await finalizeSite(deps, site)
    expect(rerun.changed).toBe(0)
    expect(rerun.retracted).toBe(0)
    expect(rerun.rollupSwaps).toBe(0)

    expect(
      await scalar(`SELECT count() FROM session_facts_versions WHERE site_id = '${site}'`),
    ).toBe(factCountBefore)
    expect(await scalar(`SELECT count() FROM session_rollups_15m WHERE site_id = '${site}'`)).toBe(
      rollupCountBefore,
    )
    const [rollupAfter] = await currentRollup(site)
    expect(rollupAfter).toEqual(rollupBefore)

    // Exactly one current session, exactly one current bucket — no resurrection.
    expect(
      await scalar(
        `SELECT count() FROM (SELECT 1 FROM session_rollups_15m WHERE site_id = '${site}' GROUP BY site_id, bucket_start)`,
      ),
    ).toBe(1)
  })

  it('does not inflate active duration when a duration beacon is duplicated (criterion 3)', async () => {
    const site = randomUUID()
    const state = memoryState()
    const baseMs = Date.parse('2026-05-03T10:00:00.000Z')
    const beaconId = randomUUID()

    // A pageview, an engagement beacon, and the SAME beacon delivered twice (a
    // retried event, one id, two rows in events_raw).
    await insertEvents(site, [
      { type: 'page_view', occurredMs: baseMs, pagePath: '/' },
      { eventId: beaconId, type: 'engagement', occurredMs: baseMs + 8_000, activeMs: 8_000 },
      { eventId: beaconId, type: 'engagement', occurredMs: baseMs + 8_000, activeMs: 8_000 },
    ])

    const now = { ms: baseMs + LATENESS_MS + INACTIVITY_MS + 60 * 60_000 }
    await finalizeSite(makeDeps(state, now), site)

    const [row] = await queryRows<{ active: string; sessions: string }>(
      `SELECT
         argMax(sfv.active_duration_ms, sfv.version) AS active,
         count() OVER () AS sessions
       FROM session_facts_versions AS sfv WHERE site_id = '${site}'
       GROUP BY site_id, session_id`,
    )
    // 8 seconds of active time, not 16 — the duplicate beacon collapsed.
    expect(Number(row!.active)).toBe(8_000)
  })

  it('writes a day bucket equal to the sum of its quarters (ADR-0079 steps 2 and 4)', async () => {
    // The one property the fifteen-minute grain exists to provide, asserted end
    // to end through the finalizer rather than against hand-inserted rows: a
    // local day composed from 15m buckets can only be right if a coarser bucket
    // is exactly the sum of the quarters inside it.
    //
    // The coarser bucket was the hour until step 4 retired that grain, and it
    // is the day now -- which is the stronger of the two claims anyway, since
    // the day is what every UTC read and every local composition is checked
    // against. The four quarters below all fall in one hour, so the arithmetic
    // being proven is unchanged.
    //
    // EXACT equality, not approximate. Every measure on this rollup is a plain
    // UInt64 sum or count — sessions, engaged, bounced, pageviews and the two
    // duration totals — with no uniq state and no average anywhere, so there is
    // no merge semantics to appeal to and no rounding to tolerate. A single
    // unit off is a bug, and a test that allowed one would be hiding it.
    const site = randomUUID()
    const state = memoryState()
    const hourMs = Date.parse('2026-05-04T10:00:00.000Z')

    // Four visitors, one per quarter of the same UTC hour, each with a
    // different shape so the measures are not accidentally symmetric: quarter 0
    // bounces, quarters 1-3 engage with a different pageview count and a
    // different amount of active time.
    const events = [
      { type: 'page_view', occurredMs: hourMs + 60_000, anonymousId: 'q0', sessionHint: 'h0' },

      { type: 'page_view', occurredMs: hourMs + 16 * 60_000, anonymousId: 'q1', sessionHint: 'h1' },
      { type: 'page_view', occurredMs: hourMs + 18 * 60_000, anonymousId: 'q1', sessionHint: 'h1' },
      {
        type: 'engagement',
        occurredMs: hourMs + 19 * 60_000,
        anonymousId: 'q1',
        sessionHint: 'h1',
        activeMs: 11_000,
      },

      { type: 'page_view', occurredMs: hourMs + 31 * 60_000, anonymousId: 'q2', sessionHint: 'h2' },
      { type: 'page_view', occurredMs: hourMs + 33 * 60_000, anonymousId: 'q2', sessionHint: 'h2' },
      { type: 'page_view', occurredMs: hourMs + 35 * 60_000, anonymousId: 'q2', sessionHint: 'h2' },
      {
        type: 'engagement',
        occurredMs: hourMs + 36 * 60_000,
        anonymousId: 'q2',
        sessionHint: 'h2',
        activeMs: 23_000,
      },

      { type: 'page_view', occurredMs: hourMs + 47 * 60_000, anonymousId: 'q3', sessionHint: 'h3' },
      { type: 'page_view', occurredMs: hourMs + 49 * 60_000, anonymousId: 'q3', sessionHint: 'h3' },
      {
        type: 'engagement',
        occurredMs: hourMs + 50 * 60_000,
        anonymousId: 'q3',
        sessionHint: 'h3',
        activeMs: 7_000,
      },
    ]
    await insertEvents(site, events)

    // Past the horizon, so every session finalizes in one pass.
    const now = { ms: hourMs + LATENESS_MS + INACTIVITY_MS + 60 * 60_000 }
    await finalizeSite(makeDeps(state, now), site)

    const MEASURES = [
      'sessions',
      'engaged_sessions',
      'bounced_sessions',
      'pageviews',
      'total_session_duration_ms',
      'total_active_duration_ms',
    ] as const

    const current = (table: string) =>
      queryRows<Record<string, string>>(
        `SELECT ${MEASURES.map((m) => `sum(cur.${m}) AS ${m}`).join(', ')}
           FROM (
             SELECT ${MEASURES.map((m) => `argMax(sr.${m}, sr.generation) AS ${m}`).join(', ')}
               FROM ${table} AS sr
              WHERE sr.site_id = '${site}'
              GROUP BY sr.site_id, sr.bucket_start
           ) AS cur`,
      )

    // Four distinct quarter buckets were written, and exactly one day bucket.
    expect(
      Number(
        await scalar(
          `SELECT uniqExact(bucket_start) FROM session_rollups_15m WHERE site_id = '${site}'`,
        ),
      ),
    ).toBe(4)
    expect(
      Number(
        await scalar(
          `SELECT uniqExact(bucket_start) FROM session_rollups_1d WHERE site_id = '${site}'`,
        ),
      ),
    ).toBe(1)
    // And nothing at all reached the frozen hour table (migration 0027).
    expect(await scalar(`SELECT count() FROM session_rollups_1h WHERE site_id = '${site}'`)).toBe(0)

    const [quarters] = await current('session_rollups_15m')
    const [day] = await current('session_rollups_1d')
    for (const measure of MEASURES) {
      expect(Number(quarters![measure]), `${measure}: 1d must equal the sum of its 15m`).toBe(
        Number(day![measure]),
      )
    }

    // Non-trivially so: a table of zeros would satisfy the loop above.
    expect(Number(day!['sessions'])).toBe(4)
    expect(Number(day!['engaged_sessions'])).toBe(3)
    expect(Number(day!['bounced_sessions'])).toBe(1)
    expect(Number(day!['pageviews'])).toBe(8)
    expect(Number(day!['total_active_duration_ms'])).toBe(41_000)

    // And each quarter really is its own bucket, not four copies of the hour.
    const perQuarter = await queryRows<{ bucket_start: string; sessions: string }>(
      `SELECT formatDateTime(sr.bucket_start, '%F %T') AS bucket_start,
              argMax(sr.sessions, sr.generation)       AS sessions
         FROM session_rollups_15m AS sr
        WHERE sr.site_id = '${site}'
        GROUP BY sr.site_id, sr.bucket_start
        ORDER BY bucket_start`,
    )
    expect(perQuarter.map((row) => row.bucket_start)).toEqual([
      '2026-05-04 10:00:00',
      '2026-05-04 10:15:00',
      '2026-05-04 10:30:00',
      '2026-05-04 10:45:00',
    ])
    expect(perQuarter.map((row) => Number(row.sessions))).toEqual([1, 1, 1, 1])
  })

  it('reconstructs the fifteen-minute rollup from the facts alone (backfill-15m --sessions)', async () => {
    // The prod step this covers is the one with no undo: migration 0026 creates
    // `session_rollups_15m` empty, and unlike the eight view-backed families of
    // 0025 there is nothing to replay it from except the versioned facts. If
    // the backfill's arithmetic disagreed with the finalizer's by even one
    // session, every historical bucket would be wrong and the disagreement
    // would only surface once a read moved onto the new grain in step 3.
    //
    // So the assertion is not "the backfill wrote something" but "the backfill
    // wrote exactly what the finalizer had written": the rows are captured
    // first, the table is truncated, the backfill runs, and the two are
    // compared bucket by bucket.
    const site = randomUUID()
    const state = memoryState()
    const hourMs = Date.parse('2026-05-05T09:00:00.000Z')

    await insertEvents(site, [
      { type: 'page_view', occurredMs: hourMs + 2 * 60_000, anonymousId: 'b0', sessionHint: 'k0' },
      { type: 'page_view', occurredMs: hourMs + 4 * 60_000, anonymousId: 'b0', sessionHint: 'k0' },
      { type: 'page_view', occurredMs: hourMs + 22 * 60_000, anonymousId: 'b1', sessionHint: 'k1' },
      { type: 'page_view', occurredMs: hourMs + 51 * 60_000, anonymousId: 'b2', sessionHint: 'k2' },
    ])
    const now = { ms: hourMs + LATENESS_MS + INACTIVITY_MS + 60 * 60_000 }
    await finalizeSite(makeDeps(state, now), site)

    const quarterRows = () =>
      queryRows<{ bucket_start: string; sessions: string; pageviews: string; generation: string }>(
        `SELECT formatDateTime(sr.bucket_start, '%F %T')  AS bucket_start,
                argMax(sr.sessions, sr.generation)        AS sessions,
                argMax(sr.pageviews, sr.generation)       AS pageviews,
                max(sr.generation)                        AS generation
           FROM session_rollups_15m AS sr
          WHERE sr.site_id = '${site}'
          GROUP BY sr.site_id, sr.bucket_start
          ORDER BY bucket_start`,
      )

    const written = await quarterRows()
    expect(written.length).toBeGreaterThan(0)

    // The hour rollup this site would have carried into the upgrade.
    //
    // ADR-0079 step 4 stopped the finalizer writing `session_rollups_1h`, so a
    // site finalized by THIS code has no hour rows at all — and the backfill's
    // equality gate ("every stored hour equals the sum of its four quarters")
    // would compare nothing and pass vacuously. The install the gate exists for
    // is the upgrading one, which holds exactly the hour rows its pre-step-4
    // finalizer wrote, so they are written here: folded up from the quarters
    // the finalizer just produced, which is what the hour swap computed from
    // the same facts.
    await client.command({
      query: `INSERT INTO session_rollups_1h
        SELECT q.site_id                     AS site_id,
               toStartOfHour(q.bucket_start) AS bucket_start,
               toUInt64(1)                   AS generation,
               sum(q.sessions)                   AS sessions,
               sum(q.engaged_sessions)           AS engaged_sessions,
               sum(q.bounced_sessions)           AS bounced_sessions,
               sum(q.pageviews)                  AS pageviews,
               sum(q.total_session_duration_ms)  AS total_session_duration_ms,
               sum(q.total_active_duration_ms)   AS total_active_duration_ms,
               max(q.computed_at)                AS computed_at
          FROM (
            SELECT sr.site_id                                          AS site_id,
                   sr.bucket_start                                     AS bucket_start,
                   argMax(sr.sessions, sr.generation)                  AS sessions,
                   argMax(sr.engaged_sessions, sr.generation)          AS engaged_sessions,
                   argMax(sr.bounced_sessions, sr.generation)          AS bounced_sessions,
                   argMax(sr.pageviews, sr.generation)                 AS pageviews,
                   argMax(sr.total_session_duration_ms, sr.generation) AS total_session_duration_ms,
                   argMax(sr.total_active_duration_ms, sr.generation)  AS total_active_duration_ms,
                   argMax(sr.computed_at, sr.generation)               AS computed_at
              FROM session_rollups_15m AS sr
             WHERE sr.site_id = '${site}'
             GROUP BY sr.site_id, sr.bucket_start
          ) AS q
         GROUP BY q.site_id, bucket_start`,
    })

    const options = {
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
      logger: createCapturedLogger().logger,
      settleSeconds: 0,
    }

    // Guard 1: the table is not empty, so the backfill refuses and writes
    // nothing. The rows are untouched afterwards.
    await expect(backfillSessionRollups15m(options)).rejects.toBeInstanceOf(BackfillRefusedError)
    await expect(backfillSessionRollups15m(options)).rejects.toMatchObject({
      reason: 'target_not_empty',
    })
    expect(await quarterRows()).toEqual(written)

    // ...unless it is asked for a STATE rather than an action. `--if-needed`
    // over a table with no gap is the no-op an automated upgrade needs: it
    // succeeds, says so, and leaves every row alone.
    const noop = await backfillSessionRollups15m({ ...options, ifNeeded: true })
    expect(noop.noop).toBe(true)
    expect(noop.rowsWritten).toBe(0)
    expect(noop.reports.find((entry) => entry.siteId === site)).toBeUndefined()
    expect(await quarterRows()).toEqual(written)

    // The worker kept running through the upgrade: the finalizer wrote the
    // newest quarter, history is missing (every other quarter deleted here to
    // model it). Only the missing quarters are filled, and the finalizer's own
    // row is left exactly as it was.
    const newest = written[written.length - 1]!
    await client.command({
      query: `ALTER TABLE session_rollups_15m DELETE
               WHERE site_id = '${site}' AND bucket_start != toDateTime('${newest.bucket_start}', 'UTC')
              SETTINGS mutations_sync = 2`,
    })
    const partial = await quarterRows()
    expect(partial.map((row) => row.bucket_start)).toEqual([newest.bucket_start])

    const gapFill = await backfillSessionRollups15m({ ...options, ifNeeded: true })
    expect(gapFill.noop).toBe(false)
    const refilled = await quarterRows()
    expect(refilled.map((row) => row.bucket_start)).toEqual(written.map((row) => row.bucket_start))
    expect(refilled.map((row) => row.sessions)).toEqual(written.map((row) => row.sessions))
    expect(refilled.map((row) => row.pageviews)).toEqual(written.map((row) => row.pageviews))
    // The filled quarters at generation 0, the finalizer's quarter untouched.
    expect(refilled.map((row) => Number(row.generation))).toEqual(
      refilled.map((row) =>
        row.bucket_start === newest.bucket_start ? Number(partial[0]!.generation) : 0,
      ),
    )

    // Now the real thing: an empty table, refilled from the facts.
    await client.command({ query: 'TRUNCATE TABLE session_rollups_15m' })
    expect(await quarterRows()).toHaveLength(0)

    // And `--if-needed` over an EMPTY table is an ordinary backfill — the flag
    // changes which states are acceptable, never what the work is.
    const result = await backfillSessionRollups15m({ ...options, ifNeeded: true })
    expect(result.noop).toBe(false)
    expect(result.dryRun).toBe(false)
    expect(result.rowsWritten).toBeGreaterThan(0)

    const rebuilt = await quarterRows()
    // Same buckets, same measures — the whole claim.
    expect(rebuilt.map((row) => row.bucket_start)).toEqual(written.map((row) => row.bucket_start))
    expect(rebuilt.map((row) => row.sessions)).toEqual(written.map((row) => row.sessions))
    expect(rebuilt.map((row) => row.pageviews)).toEqual(written.map((row) => row.pageviews))
    // ...at generation 0, below anything the finalizer mints, so the
    // finalizer's next write supersedes it whichever of the two lands first.
    expect(rebuilt.map((row) => Number(row.generation))).toEqual(rebuilt.map(() => 0))

    // And the equality gate it reports on is satisfied for this site.
    const report = result.reports.find((entry) => entry.siteId === site)
    expect(report).toBeDefined()
    expect(report!.mismatchedHours).toEqual([])
    expect(report!.comparedHours).toBeGreaterThan(0)

    // A second run finds no gap: nothing written, nothing moved.
    const again = await backfillSessionRollups15m({ ...options, ifNeeded: true })
    expect(again.noop).toBe(true)
    expect(await quarterRows()).toEqual(rebuilt)

    // The finalizer then overwrites the backfilled generation on its next
    // touch, which is what makes generation 0 the safe seed: a late event in
    // one of these quarters must still be able to change the answer.
    await insertEvents(site, [
      { type: 'page_view', occurredMs: hourMs + 6 * 60_000, anonymousId: 'b0', sessionHint: 'k0' },
    ])
    state.set(site, 0)
    now.ms += 60 * 60_000
    await finalizeSite(makeDeps(state, now), site)
    const after = await quarterRows()
    expect(Number(after[0]!.generation)).toBeGreaterThan(0)
    expect(Number(after[0]!.pageviews)).toBe(3)
  })
})
