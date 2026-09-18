import { createClient, type ClickHouseClient } from '@clickhouse/client'
import type { Logger } from '@openanalytics/observability'
import {
  createSessionFactsStore,
  SESSION_FACTS_TABLE,
  SESSION_ROLLUP_15M_TABLE,
  SESSION_ROLLUP_1H_TABLE,
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
 * Per site, every hour wholly below the first quarter hour the site held before
 * this run — the hours this run filled — is compared with the stored hour
 * rollup, measure by measure. A disagreement fails the run (exit 3).
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
   * 0025 backfill has, for the same situation: a site whose stored hour rollups
   * outlived the facts they were computed from (a hand purge) can never satisfy
   * "hour equals the sum of its quarters", because the quarters are recomputed
   * from facts that are gone and the hour row is not.
   */
  readonly acceptSites?: readonly string[]
  /** Per-statement memory ceiling. Default 1.5 GB. */
  readonly maxMemoryBytes?: number
}

export interface BackfillSessionSiteReport {
  readonly siteId: string
  /** Fifteen-minute buckets written (or that would be written, on a dry run). */
  readonly buckets: number
  readonly minBucket: string | null
  readonly maxBucket: string | null
  /**
   * Hour buckets whose stored 1h row does not equal the sum of the four
   * quarters written for it. Empty is the passing state.
   */
  readonly mismatchedHours: readonly string[]
  /** Hour buckets compared. Zero means the site had no stored hour rollups in the filled range. */
  readonly comparedHours: number
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
      const rows: SessionRollupRow[] = buckets
        .filter((bucket) => !present.has(bucket.bucketSeconds))
        .map((bucket) => ({
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

      const sorted = [...rows].sort((a, b) => a.bucket_start.localeCompare(b.bucket_start))
      const comparison = dryRun
        ? { mismatchedHours: [], comparedHours: 0 }
        : await compareHours(client, siteId, site.cutMs)

      reports.push({
        siteId,
        buckets: rows.length,
        minBucket: sorted[0]?.bucket_start ?? null,
        maxBucket: sorted[sorted.length - 1]?.bucket_start ?? null,
        mismatchedHours: comparison.mismatchedHours,
        comparedHours: comparison.comparedHours,
        accepted: accepted.has(siteId),
      })
      logger.info('backfill_sessions_15m_site_done', {
        store: 'clickhouse',
        site_id: siteId,
        buckets: rows.length,
        compared_hours: comparison.comparedHours,
        mismatched_hours: comparison.mismatchedHours.length,
      })
    }

    const plannedOrWritten = dryRun
      ? reports.reduce((sum, report) => sum + report.buckets, 0)
      : rowsWritten
    const noop = plannedOrWritten === 0
    const failing = reports.filter(
      (report) => !report.accepted && report.mismatchedHours.length > 0,
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
          hours: report.mismatchedHours.length,
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
        `backfill finished but an hour rollup does not equal the sum of its four quarters: ${failing
          .map((report) => `${report.siteId} (${report.mismatchedHours.join(', ')})`)
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

/**
 * Per site, the hour buckets where the stored 1h rollup and the sum of the four
 * 15m rows disagree on any measure — over the hours wholly below the first
 * quarter hour the site held before this run (`cutMs`), which are the hours
 * this run filled. Null means the site held nothing, so every hour is in range.
 *
 * Both sides are read at their current generation, `argMax` over generation
 * exactly as the reader does, so a superseded row cannot enter the comparison.
 * Only hours the 1h table actually holds are compared: an hour with no stored
 * row is not a mismatch, it is a bucket the finalizer never had reason to
 * write.
 */
async function compareHours(
  client: ClickHouseClient,
  siteId: string,
  cutMs: number | null,
): Promise<{ mismatchedHours: readonly string[]; comparedHours: number }> {
  const conditions = MEASURES.map((measure) => `h.${measure} != q.${measure}`).join(' OR ')
  const current = (alias: string): string =>
    MEASURES.map(
      (measure) => `argMax(${alias}.${measure}, ${alias}.generation) AS ${measure}`,
    ).join(', ')
  // Far enough ahead to mean "no bound" and still a valid DateTime.
  const beforeSeconds = cutMs === null ? 4_000_000_000 : Math.floor(cutMs / 3_600_000) * 3600

  // The quarters of one site at their current generation, folded up to hours.
  const quartersByHour = `
         SELECT toStartOfHour(v.bucket_start) AS bucket_start,
                ${MEASURES.map((measure) => `sum(v.${measure}) AS ${measure}`).join(', ')}
           FROM (
             SELECT sq.bucket_start AS bucket_start,
                    ${current('sq')}
               FROM ${SESSION_ROLLUP_15M_TABLE} AS sq
              WHERE sq.site_id = {siteId:String}
                AND sq.bucket_start < toDateTime({before:UInt32}, 'UTC')
              GROUP BY sq.site_id, sq.bucket_start
           ) AS v
          GROUP BY bucket_start`

  // The stored hours of one site at their current generation.
  const hours = `
         SELECT sr.bucket_start AS bucket_start,
                ${current('sr')}
           FROM ${SESSION_ROLLUP_1H_TABLE} AS sr
          WHERE sr.site_id = {siteId:String}
            AND sr.bucket_start < toDateTime({before:UInt32}, 'UTC')
          GROUP BY sr.site_id, sr.bucket_start`

  const params = { siteId, before: beforeSeconds }
  const rows = await queryRows<{ bucket: string }>(
    client,
    `SELECT formatDateTime(h.bucket_start, '%F %T') AS bucket
       FROM (${hours}) AS h
       INNER JOIN (${quartersByHour}) AS q ON h.bucket_start = q.bucket_start
      WHERE ${conditions}
      ORDER BY bucket`,
    params,
  )

  const [countRow] = await queryRows<{ c: string }>(
    client,
    `SELECT count() AS c
       FROM (${hours}) AS h
       INNER JOIN (${quartersByHour}) AS q ON h.bucket_start = q.bucket_start`,
    params,
  )

  return {
    mismatchedHours: rows.map((row) => row.bucket),
    comparedHours: Number(countRow?.c ?? 0),
  }
}
