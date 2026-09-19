import { createClient, type ClickHouseClient } from '@clickhouse/client'
import type { Logger } from '@openanalytics/observability'
import {
  createSessionFactsStore,
  SESSION_FACTS_TABLE,
  SESSION_ROLLUP_15M_TABLE,
  type RollupBucketAggregate,
  type SessionFactsStore,
  type SessionRollupRow,
} from './session-facts.ts'
import { BackfillRefusedError } from './backfill-15m.ts'
import { hasBackfillRecord, recordBackfill } from './backfill-ledger.ts'

/**
 * The history half of ClickHouse migration 0026 for the SESSION rollup
 * (ADR-0079, step 2).
 *
 * ## Why this exists at all
 *
 * The eight families of 0025 are materialized views, so their history came from
 * one `INSERT ... SELECT` per month partition straight out of `events_raw`:
 * the same SELECT the view runs, replayed. `session_rollups_15m` has no view.
 * It is written by the worker's session finalizer, which recomputes only the
 * buckets a changed session touched, and a bucket nothing touches is never
 * visited again. So on a populated install the new table would hold the last
 * few hours of traffic and nothing else, forever, and the equality that the
 * whole fifteen-minute grain rests on ("an hour is the sum of its four
 * quarters") would be false for every older bucket.
 *
 * ## What it does: fill the gaps
 *
 * A gap is a `(site_id, quarter hour)` that has current, non-retracted session
 * facts and no row in `session_rollups_15m`. For each site with gaps it
 * recomputes those buckets from `session_facts_versions` — through the very
 * same `aggregateRollupBuckets` the finalizer uses, so the arithmetic cannot
 * drift from the finalizer's — and inserts them at **generation 0**. A bucket
 * that holds a row, whoever wrote it, is never written. A second run finds no
 * gap and writes nothing, and a run that died half way is completed by the next.
 *
 * Generation 0 is what makes this safe beside a RUNNING worker, which it now
 * has to be (the self-hosted migrate container runs it on every start, see
 * `--if-needed`). The finalizer mints `max(stored generation) + 1`, which is
 * at least 1, so whenever the finalizer and this write the same bucket the
 * finalizer's row wins — in either order, including the order where this lands
 * second. Two writers at ONE generation are the one tie
 * `ReplacingMergeTree(generation)` cannot resolve, and generation 0 is a
 * number the finalizer never writes, so that tie cannot occur. (Until the
 * gap-fill rework this wrote generation 1 and needed a stopped worker to make
 * that safe. The stopped-worker guard is gone with it.)
 *
 * ## Proof
 *
 * Per site, every quarter hour this run was responsible for — those below the
 * first quarter hour the site held before the run, and the gap buckets it
 * wrote above it — is compared, measure by measure, with a fresh recompute from
 * `session_facts_versions`: the facts every writer of this table computes
 * from. A disagreement that survives one re-read fails the run (exit 3).
 *
 * ## Exit contract
 *
 * Guards throw `BackfillRefusedError` and the CLI turns them into exit codes,
 * the same vocabulary the 0025 backfill uses: 2 for a refusal that wrote
 * nothing, 3 for a run that wrote but whose equality report disagrees. The one
 * refusal left is the plain (hand-run) command over a populated table;
 * `--if-needed` refuses nothing.
 */

export interface BackfillSessionRollupsOptions {
  readonly url: string
  readonly username: string
  readonly password: string
  readonly database: string
  readonly logger: Logger
  /** Plan only — no INSERT is issued; the report counts the gap instead. */
  readonly dryRun?: boolean
  /**
   * Fill whatever gap there is, over any state, and succeed having written
   * nothing when there is none. Without it the command refuses a populated
   * table, as the hand-run step always has.
   */
  readonly ifNeeded?: boolean
  /** Accepted for the CLI's shared option set. The session fill no longer waits. */
  readonly settleSeconds?: number
  /**
   * Sites excluded from the equality gate, still reported. The same escape the
   * 0025 backfill has, for the same situation: a site whose stored rollups
   * outlived the facts they were computed from (a hand purge).
   */
  readonly acceptSites?: readonly string[]
  /** Per-statement memory ceiling. Default 1.5 GB. */
  readonly maxMemoryBytes?: number
  /**
   * Test seam: awaited after every site's fill and before the equality gate
   * reads anything. Production passes nothing.
   */
  readonly afterFill?: () => Promise<void>
}

export interface BackfillSessionSiteReport {
  readonly siteId: string
  /** Fifteen-minute buckets written (or that would be written, on a dry run). */
  readonly buckets: number
  readonly minBucket: string | null
  readonly maxBucket: string | null
  /**
   * Quarter hours whose stored row (at its current generation) does not equal
   * a recompute from the session facts. Empty is the passing state.
   */
  readonly mismatchedBuckets: readonly string[]
  /** Quarter hours compared; 0 on a dry run. */
  readonly comparedBuckets: number
  readonly accepted: boolean
}

export interface BackfillSessionRollupsResult {
  readonly dryRun: boolean
  readonly mode: 'imperative' | 'if-needed'
  /** No gap: every bucket with facts already holds a row. */
  readonly noop: boolean
  /** Sites that had at least one gap. */
  readonly sites: number
  readonly rowsWritten: number
  readonly durationMs: number
  readonly reports: readonly BackfillSessionSiteReport[]
  readonly ledgerRecorded: boolean
}

/** The measures compared per hour. Every one is a plain sum, so the check is exact. */
const MEASURES = [
  'sessions',
  'engaged_sessions',
  'bounced_sessions',
  'pageviews',
  'total_session_duration_ms',
  'total_active_duration_ms',
] as const

/** The generation a backfilled row carries: below anything the finalizer mints. */
export const SESSION_BACKFILL_GENERATION = 0

const QUARTER_HOUR_MS = 15 * 60 * 1000

async function queryRows<T>(
  client: ClickHouseClient,
  query: string,
  params?: Record<string, unknown>,
): Promise<T[]> {
  const resultSet = await client.query({
    query,
    format: 'JSONEachRow',
    ...(params === undefined ? {} : { query_params: params }),
  })
  return await resultSet.json<T>()
}

interface SiteGap {
  readonly siteId: string
  /** The site's first quarter hour in the table before this run, epoch ms, or null. */
  readonly cutMs: number | null
  readonly loMs: number
  readonly hiMs: number
  readonly gaps: number
}

/**
 * Per site: the span of its gap buckets and the first bucket it already held.
 * A gap is a quarter hour with a current, non-retracted fact and no rollup row.
 */
async function readGaps(client: ClickHouseClient): Promise<SiteGap[]> {
  const rows = await queryRows<{
    site_id: string
    lo: string
    hi: string
    gaps: string
    cut: string | null
  }>(
    client,
    `SELECT toString(g.site_id)                       AS site_id,
            toUnixTimestamp(min(g.b)) * 1000          AS lo,
            toUnixTimestamp(max(g.b)) * 1000          AS hi,
            count()                                    AS gaps,
            any(c.cut)                                 AS cut
       FROM (
         SELECT DISTINCT cur.site_id AS site_id, cur.b AS b
           FROM (
             SELECT sfv.site_id AS site_id,
                    toStartOfFifteenMinutes(toDateTime(argMax(sfv.session_start, sfv.version), 'UTC')) AS b,
                    argMax(sfv.retracted, sfv.version) AS retracted
               FROM ${SESSION_FACTS_TABLE} AS sfv
              GROUP BY sfv.site_id, sfv.session_id
           ) AS cur
          WHERE cur.retracted = 0
       ) AS g
       LEFT JOIN (
         SELECT sr.site_id AS site_id, toUnixTimestamp(min(sr.bucket_start)) * 1000 AS cut
           FROM ${SESSION_ROLLUP_15M_TABLE} AS sr
          GROUP BY sr.site_id
       ) AS c ON c.site_id = g.site_id
      WHERE (g.site_id, g.b) NOT IN (SELECT site_id, bucket_start FROM ${SESSION_ROLLUP_15M_TABLE})
      GROUP BY g.site_id
      ORDER BY site_id
     SETTINGS join_use_nulls = 1`,
  )
  return rows.map((row) => ({
    siteId: row.site_id,
    cutMs: row.cut === null ? null : Number(row.cut),
    loMs: Number(row.lo),
    // Inclusive of the last gap bucket: the store's window is half-open.
    hiMs: Number(row.hi) + QUARTER_HOUR_MS,
    gaps: Number(row.gaps),
  }))
}

export async function backfillSessionRollups15m(
  options: BackfillSessionRollupsOptions,
): Promise<BackfillSessionRollupsResult> {
  const { logger } = options
  const dryRun = options.dryRun === true
  const ifNeeded = options.ifNeeded === true
  const mode = ifNeeded ? 'if-needed' : 'imperative'
  const accepted = new Set(options.acceptSites ?? [])
  const startedAt = Date.now()

  const client = createClient({
    url: options.url,
    username: options.username,
    password: options.password,
    database: options.database,
    clickhouse_settings: {
      async_insert: 0,
      wait_for_async_insert: 1,
      max_memory_usage: String(options.maxMemoryBytes ?? 1_500_000_000),
      max_execution_time: 0,
    },
    request_timeout: 30 * 60 * 1000,
  })

  // The aggregation and the insert both go through the store the finalizer
  // uses, on the migration credential. Reusing it rather than re-spelling the
  // SELECT is the point: a backfill whose arithmetic is a second copy of the
  // finalizer's is a backfill that can disagree with it.
  const store = createSessionFactsStore({
    url: options.url,
    username: options.username,
    password: options.password,
    database: options.database,
  })

  try {
    // The hand-run refusal: the plain command fills an empty table only.
    if (!ifNeeded) {
      const [existing] = await queryRows<{ c: string }>(
        client,
        `SELECT count() AS c FROM ${SESSION_ROLLUP_15M_TABLE}`,
      )
      const existingRows = Number(existing?.c ?? 0)
      if (existingRows > 0) {
        throw new BackfillRefusedError(
          'target_not_empty',
          `refusing to backfill: ${SESSION_ROLLUP_15M_TABLE} already holds ${String(existingRows)} rows. The plain command fills an empty table only. To fill whatever is missing — safely, beside a running worker — run it with --if-needed.`,
        )
      }
    }

    const siteGaps = await readGaps(client)
    logger.info('backfill_sessions_15m_plan', {
      store: 'clickhouse',
      dry_run: dryRun,
      mode,
      sites: siteGaps.length,
      gaps: siteGaps.reduce((sum, site) => sum + site.gaps, 0),
    })

    const computedAt = new Date().toISOString().replace('T', ' ').replace('Z', '')
    const reports: BackfillSessionSiteReport[] = []
    let rowsWritten = 0

    // Fill every site first, then prove every site: the proof reads the table
    // as the whole run left it.
    const filled: Array<{
      readonly site: SiteGap
      readonly rows: readonly SessionRollupRow[]
      readonly written: ReadonlySet<number>
    }> = []
    for (const site of siteGaps) {
      const { siteId, loMs, hiMs } = site

      const buckets = await store.aggregateRollupBuckets({ siteId, unit: '15m', loMs, hiMs })
      // Present is re-read here, per site, rather than trusted from the plan:
      // the finalizer may have written a bucket since, and a written bucket is
      // not a gap. (Were it written after this read, its generation still wins.)
      const present = new Set(
        (await store.readStoredRollups({ siteId, unit: '15m', loMs, hiMs })).map(
          (stored) => stored.bucketSeconds,
        ),
      )
      const gaps = buckets.filter((bucket) => !present.has(bucket.bucketSeconds))
      const rows: SessionRollupRow[] = gaps.map((bucket) => ({
        site_id: siteId,
        bucket_start: bucket.bucketStart,
        generation: SESSION_BACKFILL_GENERATION,
        sessions: bucket.sessions,
        engaged_sessions: bucket.engagedSessions,
        bounced_sessions: bucket.bouncedSessions,
        pageviews: bucket.pageviews,
        total_session_duration_ms: bucket.totalSessionDurationMs,
        total_active_duration_ms: bucket.totalActiveDurationMs,
        computed_at: computedAt,
      }))

      if (!dryRun && rows.length > 0) {
        await store.insertRollups({ unit: '15m', rows })
        rowsWritten += rows.length
      }
      filled.push({ site, rows, written: new Set(gaps.map((bucket) => bucket.bucketSeconds)) })
    }

    if (!dryRun && options.afterFill !== undefined) await options.afterFill()

    for (const { site, rows, written } of filled) {
      const { siteId } = site
      const sorted = [...rows].sort((a, b) => a.bucket_start.localeCompare(b.bucket_start))
      let comparison: { mismatchedBuckets: readonly string[]; comparedBuckets: number } = {
        mismatchedBuckets: [],
        comparedBuckets: 0,
      }
      if (!dryRun) {
        comparison = await compareBuckets(store, site, written)
        // A session finalized between the two reads moves one side first. It
        // agrees a moment later; a real disagreement does not.
        if (comparison.mismatchedBuckets.length > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1000))
          comparison = await compareBuckets(store, site, written)
        }
      }

      reports.push({
        siteId,
        buckets: rows.length,
        minBucket: sorted[0]?.bucket_start ?? null,
        maxBucket: sorted[sorted.length - 1]?.bucket_start ?? null,
        mismatchedBuckets: comparison.mismatchedBuckets,
        comparedBuckets: comparison.comparedBuckets,
        accepted: accepted.has(siteId),
      })
      logger.info('backfill_sessions_15m_site_done', {
        store: 'clickhouse',
        site_id: siteId,
        buckets: rows.length,
        compared_buckets: comparison.comparedBuckets,
        mismatched_buckets: comparison.mismatchedBuckets.length,
      })
    }

    const plannedOrWritten = dryRun
      ? reports.reduce((sum, report) => sum + report.buckets, 0)
      : rowsWritten
    const noop = plannedOrWritten === 0
    const failing = reports.filter(
      (report) => !report.accepted && report.mismatchedBuckets.length > 0,
    )

    let ledgerRecorded = false
    if (!dryRun) {
      ledgerRecorded = await recordRun(client, logger, noop, {
        command: 'backfill-15m --sessions',
        mode,
        generation: SESSION_BACKFILL_GENERATION,
        sites: reports.length,
        rows: rowsWritten,
        from:
          reports
            .map((report) => report.minBucket)
            .filter((value): value is string => value !== null)
            .sort()[0] ?? null,
        mismatched: failing.map((report) => ({
          site: report.siteId,
          buckets: report.mismatchedBuckets.length,
        })),
      })
    }

    const result: BackfillSessionRollupsResult = {
      dryRun,
      mode,
      noop,
      sites: siteGaps.length,
      rowsWritten,
      durationMs: Date.now() - startedAt,
      reports,
      ledgerRecorded,
    }

    if (!dryRun && failing.length > 0) {
      throw new BackfillRefusedError(
        'additive_mismatch',
        `backfill finished but a filled quarter hour disagrees with the session facts: ${failing
          .map((report) => `${report.siteId} (${report.mismatchedBuckets.join(', ')})`)
          .join('; ')}. Report: ${JSON.stringify(result)}`,
      )
    }
    return result
  } finally {
    await store.close()
    await client.close()
  }
}

async function recordRun(
  client: ClickHouseClient,
  logger: Logger,
  noop: boolean,
  detail: Record<string, unknown>,
): Promise<boolean> {
  try {
    if (noop && (await hasBackfillRecord(client, 'session_rollups_15m'))) return false
    await recordBackfill(client, { name: 'session_rollups_15m', detail: { ...detail, noop } })
    return true
  } catch (err) {
    logger.warn('backfill_ledger_write_failed', {
      store: 'clickhouse',
      name: 'session_rollups_15m',
      retryable: true,
      err,
    })
    return false
  }
}

type Measures = Readonly<Record<(typeof MEASURES)[number], number>>

const measuresOf = (bucket: RollupBucketAggregate): Measures => ({
  sessions: bucket.sessions,
  engaged_sessions: bucket.engagedSessions,
  bounced_sessions: bucket.bouncedSessions,
  pageviews: bucket.pageviews,
  total_session_duration_ms: bucket.totalSessionDurationMs,
  total_active_duration_ms: bucket.totalActiveDurationMs,
})

/**
 * Per site, the quarter hours where the stored 15m rollup (at its current
 * generation) and a fresh recompute from `session_facts_versions` disagree on
 * any measure — over every quarter hour of `[loMs, hiMs)` that this run was
 * responsible for: those below the first quarter hour the site held before the
 * run (`cutMs`; null means it held nothing, so all of them), plus the gap
 * buckets it wrote above that.
 *
 * The facts are the reference because they are what every writer computes
 * from. A finalizer pass that supersedes a backfilled row meanwhile computes
 * from the same facts, so it agrees; a session finalized while the run is going
 * changes both sides. A missing bucket reads as zeros on its side, so a gap
 * left behind (facts, no row) fails, and so does a row with no facts behind it.
 *
 * (Until v0.8.0 this compared hours against `session_rollups_1h`, which
 * migration 0027 froze and 0029 dropped.)
 */
async function compareBuckets(
  store: SessionFactsStore,
  site: {
    readonly siteId: string
    readonly cutMs: number | null
    readonly loMs: number
    readonly hiMs: number
  },
  written: ReadonlySet<number>,
): Promise<{ mismatchedBuckets: readonly string[]; comparedBuckets: number }> {
  const range = { siteId: site.siteId, unit: '15m' as const, loMs: site.loMs, hiMs: site.hiMs }
  const expected = new Map(
    (await store.aggregateRollupBuckets(range)).map((bucket) => [bucket.bucketSeconds, bucket]),
  )
  const stored = new Map(
    (await store.readStoredRollups(range)).map((bucket) => [bucket.bucketSeconds, bucket]),
  )
  const cutSeconds = site.cutMs === null ? Number.POSITIVE_INFINITY : site.cutMs / 1000

  const mismatched: string[] = []
  let compared = 0
  for (const seconds of new Set([...expected.keys(), ...stored.keys()])) {
    if (seconds >= cutSeconds && !written.has(seconds)) continue
    compared += 1
    const a = expected.get(seconds)
    const b = stored.get(seconds)
    const x = a === undefined ? null : measuresOf(a)
    const y = b === undefined ? null : measuresOf(b)
    const differs = MEASURES.some((measure) => (x?.[measure] ?? 0) !== (y?.[measure] ?? 0))
    if (differs) mismatched.push((a ?? b)?.bucketStart ?? String(seconds))
  }
  return { mismatchedBuckets: mismatched.sort(), comparedBuckets: compared }
}
