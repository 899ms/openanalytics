import type { Logger } from '@openanalytics/observability'
import { createClient, type ClickHouseClient } from '@clickhouse/client'
import { hasBackfillRecord, recordBackfill } from './backfill-ledger.ts'

/**
 * Backfill of the fifteen-minute rollup family from `events_raw` (ADR-0079,
 * D3 — migration 0025).
 *
 * A materialized view aggregates only what is inserted after it exists, so the
 * eight `*_15m` targets 0025 creates are empty for every event already stored.
 * This fills that history with the same SELECT each view runs, one month
 * partition at a time, and then proves the result against the hour twins.
 *
 * ## What it fills: the gap, per site and quarter hour
 *
 * A **gap** is a `(site_id, bucket_start)` pair that `events_raw` has events
 * for (under the family's view `WHERE`) and the target holds no row for at
 * all. The fill inserts exactly the gaps and never touches a pair that holds a
 * row, whoever wrote it. That one rule is the whole safety argument:
 *
 *   - **No double count, structurally.** An AggregatingMergeTree sums what it
 *     is given, so the only way to double a count is to insert a pair's events
 *     a second time. A pair with any row is never inserted into, and the absence
 *     test and the raw read happen in the same statement, so a view writing the
 *     pair while the fill runs makes it present rather than doubled.
 *   - **Any starting state.** Empty targets (a stopped-worker upgrade), all
 *     targets holding the recent quarter hours only (the worker kept writing
 *     through the upgrade, so the views filled the present while history stayed
 *     empty), and targets that stay empty because the install has no such
 *     events (`custom_events_15m` on a site without custom events) are one case,
 *     not three. None of them is refused.
 *   - **Idempotent.** Once filled there is no gap, so a second run inserts
 *     nothing. An upgrade can therefore run this on every start of the migrate
 *     container, and a run that died half way is completed by the next one.
 *
 * The one thing a gap fill cannot recover is the **seam**: a pair the view
 * started writing part way through, at the moment the view was created with
 * the worker running. Its earlier events are in no rollup and the pair is no
 * longer a gap. That is at most one quarter hour per site, only on the upgrade
 * itself and only when the worker was not stopped for it — completing it would
 * mean deleting and rewriting a live bucket, which this does not do. A late
 * event (one whose `occurred_at` falls before the view existed, delivered
 * after) seams its own pair the same way and nothing more. Both are measured:
 * the report's `witness` compares the metrics family with `events_raw` pair by
 * pair and says how many events sit in seamed pairs.
 *
 * ## The live quarter hour
 *
 * The pair the worker is writing right now is excluded unless nothing is
 * writing: `max(received_at)` and `count()` on `events_raw` are read twice,
 * `settleSeconds` apart, and only a still table lets the fill reach the current
 * quarter hour. Otherwise the fill stops at its start, which keeps the fill and
 * the view apart even at part-commit granularity. The readings are taken only
 * when the live quarter hour actually has a gap, so an ordinary run does not
 * wait.
 *
 * ## Two modes
 *
 * The plain command is the hand-run step it has always been and keeps its two
 * refusals: every target must be empty (`target_not_empty`) and the raw table
 * must be still (`worker_still_writing`). `--if-needed` is the automated one
 * (the self-hosted migrate container runs it on every start): it refuses
 * nothing, fills whatever gap there is, and succeeds having written nothing
 * when there is none. A refusal there would stop the whole stack, collector
 * included, on a state the fill can complete by itself.
 *
 * ## Proof
 *
 * For each family the additive measures are compared per site between the 15m
 * table and the hour twin, over the hours that lie wholly below the first
 * quarter hour the site already held before this run — the hours this run
 * filled — and above the twin's first complete bucket. A mismatch fails the
 * run (exit 3). Unique-visitor states are reported merged over the same window
 * but not gated on: `uniq` is an estimator, and equality of two merges over
 * differently partitioned states is expected but is not the invariant this
 * step exists to prove.
 *
 * A run that wrote something records itself in `backfill_ledger` (0028) as
 * `rollups_15m`; so does the first run that found nothing to write. The ledger
 * is evidence only — nothing here reads it to decide.
 *
 * Runs under the migration credential: it has `SELECT` and `INSERT` on the
 * analytics database, which is all this needs. No grant is added for the
 * ingest user — a view pushing into its target needs none, as the hour family
 * has proven since 0006.
 */

export interface FifteenMinuteRollupSpec {
  /** The 15m target the view writes to. */
  readonly table: string
  /** The hour twin the equality report compares against. */
  readonly hourTwin: string
  /**
   * The SELECT list of the materialized view, verbatim, bucket expression
   * included. `{bucket}` is substituted with the bucket expression so a test can
   * compose the same SELECT at another grain.
   */
  readonly select: string
  /** The view's WHERE clause without the keyword, or empty when it has none. */
  readonly where: string
  /** The view's GROUP BY list without the keywords. */
  readonly groupBy: string
  /** Integer additive measures the equality report sums and compares exactly. */
  readonly additiveColumns: readonly string[]
  /** Float additive measures, compared within a relative tolerance. */
  readonly floatAdditiveColumns: readonly string[]
  /** Whether the table carries the `visitors` uniq state. */
  readonly hasVisitors: boolean
}

const IDENTITY = "if(user_id != '', user_id, anonymous_id)"

/**
 * The eight families, in migration order. Each `select` is the SELECT list of
 * the corresponding `*_15m_mv` in migration 0025 — the backfill must insert
 * exactly what the view would have inserted, so the two are kept side by side
 * here and `tests/migration/clickhouse-rollups.test.ts` proves a backfilled
 * table equals a view-populated one.
 */
export const FIFTEEN_MINUTE_ROLLUPS: readonly FifteenMinuteRollupSpec[] = [
  {
    table: 'metrics_15m',
    hourTwin: 'metrics_1h',
    select: `site_id, {bucket} AS bucket_start, type AS event_type, count() AS events, countIf(billable = 1) AS billable_events, uniqState(${IDENTITY}) AS visitors`,
    where: '',
    groupBy: 'site_id, bucket_start, event_type',
    additiveColumns: ['events', 'billable_events'],
    floatAdditiveColumns: [],
    hasVisitors: true,
  },
  {
    table: 'pages_15m',
    hourTwin: 'pages_1h',
    select: `site_id, {bucket} AS bucket_start, page_path, count() AS views, uniqState(${IDENTITY}) AS visitors`,
    where: "type = 'page_view'",
    groupBy: 'site_id, bucket_start, page_path',
    additiveColumns: ['views'],
    floatAdditiveColumns: [],
    hasVisitors: true,
  },
  {
    table: 'sources_15m',
    hourTwin: 'sources_1h',
    select: `site_id, {bucket} AS bucket_start, referrer_domain, utm_source, utm_medium, utm_campaign, count() AS views, uniqState(${IDENTITY}) AS visitors`,
    where: "type = 'page_view'",
    groupBy: 'site_id, bucket_start, referrer_domain, utm_source, utm_medium, utm_campaign',
    additiveColumns: ['views'],
    floatAdditiveColumns: [],
    hasVisitors: true,
  },
  {
    table: 'geography_15m',
    hourTwin: 'geography_1h',
    select: `site_id, {bucket} AS bucket_start, country, city, count() AS views, uniqState(${IDENTITY}) AS visitors`,
    where: "type = 'page_view'",
    groupBy: 'site_id, bucket_start, country, city',
    additiveColumns: ['views'],
    floatAdditiveColumns: [],
    hasVisitors: true,
  },
  {
    table: 'devices_15m',
    hourTwin: 'devices_1h',
    select: `site_id, {bucket} AS bucket_start, device_type, browser, os, count() AS views, uniqState(${IDENTITY}) AS visitors`,
    where: "type = 'page_view'",
    groupBy: 'site_id, bucket_start, device_type, browser, os',
    additiveColumns: ['views'],
    floatAdditiveColumns: [],
    hasVisitors: true,
  },
  {
    table: 'custom_events_15m',
    hourTwin: 'custom_events_1h',
    select: `site_id, {bucket} AS bucket_start, name AS event_name, type AS event_type, count() AS events, countIf(billable = 1) AS billable_events, uniqState(${IDENTITY}) AS visitors`,
    where: "name != ''",
    groupBy: 'site_id, bucket_start, event_name, event_type',
    additiveColumns: ['events', 'billable_events'],
    floatAdditiveColumns: [],
    hasVisitors: true,
  },
  {
    table: 'performance_15m',
    hourTwin: 'performance_1h',
    select: `site_id, {bucket} AS bucket_start, JSONExtractString(properties, 'oa_metric') AS metric, device_type, count() AS samples, sum(JSONExtractFloat(properties, 'oa_value')) AS value_sum, quantilesTDigestState(0.5, 0.75, 0.9, 0.95, 0.99)(JSONExtractFloat(properties, 'oa_value')) AS value_quantiles, countIf(JSONExtractString(properties, 'oa_rating') = 'good') AS good_samples, countIf(JSONExtractString(properties, 'oa_rating') = 'needs-improvement') AS needs_improvement_samples, countIf(JSONExtractString(properties, 'oa_rating') = 'poor') AS poor_samples`,
    where: "type = 'web_vital' AND metric != ''",
    groupBy: 'site_id, bucket_start, metric, device_type',
    additiveColumns: ['samples', 'good_samples', 'needs_improvement_samples', 'poor_samples'],
    floatAdditiveColumns: ['value_sum'],
    hasVisitors: false,
  },
  {
    table: 'custom_event_samples_15m',
    hourTwin: 'custom_event_samples_1h',
    select: `site_id, {bucket} AS bucket_start, name AS event_name, type AS event_type, count() AS events, max(occurred_at) AS last_seen_at, argMaxState(page_path, occurred_at) AS sample_page_path, argMaxState(properties, occurred_at) AS sample_properties`,
    where: "name != ''",
    groupBy: 'site_id, bucket_start, event_name, event_type',
    additiveColumns: ['events'],
    floatAdditiveColumns: [],
    hasVisitors: false,
  },
]

/** The bucket expression of every `*_15m_mv` in migration 0025. */
export const FIFTEEN_MINUTE_BUCKET = "toStartOfFifteenMinutes(toDateTime(occurred_at, 'UTC'))"

const QUARTER_HOUR_MS = 15 * 60 * 1000

/**
 * The gap predicate: the event's `(site_id, quarter hour)` holds no row in the
 * target. Scoped to one month partition when given, which keeps the set the
 * subquery builds to that month's pairs.
 */
function gapPredicate(spec: FifteenMinuteRollupSpec, yyyymm: number | null): string {
  const scope = yyyymm === null ? '' : ` WHERE toYYYYMM(bucket_start) = ${String(yyyymm)}`
  return `(site_id, ${FIFTEEN_MINUTE_BUCKET}) NOT IN (SELECT site_id, bucket_start FROM ${spec.table}${scope})`
}

function fillWhere(
  spec: FifteenMinuteRollupSpec,
  yyyymm: number | null,
  bound: { readonly beforeSeconds?: number | null; readonly fromSeconds?: number | null },
): string {
  return [
    yyyymm === null ? '' : `toYYYYMM(occurred_at) = ${String(yyyymm)}`,
    spec.where,
    gapPredicate(spec, yyyymm),
    bound.beforeSeconds == null
      ? ''
      : `occurred_at < toDateTime(${String(bound.beforeSeconds)}, 'UTC')`,
    bound.fromSeconds == null
      ? ''
      : `occurred_at >= toDateTime(${String(bound.fromSeconds)}, 'UTC')`,
  ]
    .filter((clause) => clause.length > 0)
    .join(' AND ')
}

/**
 * The INSERT ... SELECT that fills the gaps of one 15m target in one month
 * partition. `beforeSeconds` keeps the fill below the live quarter hour; null
 * lets it reach the present (only when nothing is writing). Exported so the
 * migration test can run the exact statement production runs.
 */
export function backfillStatement(
  spec: FifteenMinuteRollupSpec,
  yyyymm: number,
  beforeSeconds: number | null = null,
): string {
  const select = spec.select.replace('{bucket}', FIFTEEN_MINUTE_BUCKET)
  return `INSERT INTO ${spec.table} SELECT ${select} FROM events_raw WHERE ${fillWhere(spec, yyyymm, { beforeSeconds })} GROUP BY ${spec.groupBy}`
}

/** The rows `backfillStatement` would insert, counted instead of written. */
function gapRowsStatement(
  spec: FifteenMinuteRollupSpec,
  bound: { readonly beforeSeconds?: number | null; readonly fromSeconds?: number | null },
): string {
  const select = spec.select.replace('{bucket}', FIFTEEN_MINUTE_BUCKET)
  return `SELECT count() AS c FROM (SELECT ${select} FROM events_raw WHERE ${fillWhere(spec, null, bound)} GROUP BY ${spec.groupBy})`
}

/**
 * `worker_still_writing` and `target_not_empty` are refusals of the plain,
 * hand-run command only. `partially_populated` is no longer produced by
 * anything — a gap fill completes that state — and is kept in the union so a
 * caller that still names it compiles.
 */
export type BackfillRefusalReason =
  'target_not_empty' | 'partially_populated' | 'worker_still_writing' | 'additive_mismatch'

export class BackfillRefusedError extends Error {
  readonly reason: BackfillRefusalReason

  constructor(reason: BackfillRefusalReason, message: string) {
    super(message)
    this.name = 'BackfillRefusedError'
    this.reason = reason
  }
}

export interface BackfillFifteenMinuteOptions {
  readonly url: string
  readonly username: string
  readonly password: string
  readonly database: string
  readonly logger: Logger
  /** Plan and guard only — no INSERT is issued; the report counts the gap instead. */
  readonly dryRun?: boolean
  /**
   * The automated mode: refuse nothing, fill whatever gap there is, succeed
   * having written nothing when there is none. Without it the command keeps
   * its hand-run refusals (every target empty, raw table still).
   */
  readonly ifNeeded?: boolean
  /** Seconds between the two `events_raw` readings. Default 10. */
  readonly settleSeconds?: number
  /**
   * Sites whose raw rows were purged by hand after their hour rollups were
   * written (the 2026-08-25 cleanup, ADR-0074): their hour twin holds counts
   * the raw table no longer can, so they are listed in the report but excluded
   * from the equality gate.
   */
  readonly acceptSites?: readonly string[]
  /** Per-statement memory ceiling. Default 1.5 GB. */
  readonly maxMemoryBytes?: number
  /** Threads per statement. Default 2 — this runs beside live reads. */
  readonly maxThreads?: number
  /** The run's clock, for tests. Default `Date.now()`. */
  readonly nowMs?: number
}

export interface BackfillTableReport {
  readonly table: string
  /** Rows this run wrote into the table — or, on a dry run, would write. */
  readonly gapRows: number
  /** Sites that already held a row in the table when the run started. */
  readonly sitesWithRows: number
  readonly rows: number
  readonly buckets: number
  readonly minBucket: string | null
  readonly maxBucket: string | null
  /** The additive equality window's start against the hour twin, or null when the twin is empty. */
  readonly comparedFrom: string | null
  readonly mismatchedSites: readonly string[]
  readonly acceptedMismatchSites: readonly string[]
  readonly visitors15m: number | null
  readonly visitors1h: number | null
}

/**
 * `metrics_15m` has no view `WHERE`, so every raw event is in exactly one of
 * its pairs — which makes it the family that can be checked against
 * `events_raw` pair by pair, below the live quarter hour.
 */
export interface BackfillWitness {
  /** Pairs with raw events and no rollup row: gaps left after the fill. */
  readonly gapPairs: number
  readonly gapEvents: number
  /** Pairs whose rollup holds fewer events than raw: the seam (and late events). */
  readonly seamPairs: number
  readonly seamEvents: number
  /** Pairs whose rollup holds MORE events than raw: a double count, or raw purged by hand. */
  readonly overPairs: number
  readonly overEvents: number
}

export interface BackfillRawReading {
  readonly rows: number
  readonly maxReceivedAt: string | null
}

export interface BackfillFifteenMinuteResult {
  readonly dryRun: boolean
  readonly mode: 'imperative' | 'if-needed'
  /** Nothing to fill: no gap anywhere the run was allowed to reach. */
  readonly noop: boolean
  readonly partitions: readonly number[]
  /** The start of the quarter hour the run began in. */
  readonly liveFrom: string
  /** Whether the fill reached the live quarter hour (only when the raw table was still). */
  readonly liveIncluded: boolean
  /** The two stillness readings, or none when the live quarter hour had no gap to guard. */
  readonly rawReadings: readonly BackfillRawReading[]
  /** INSERT statements issued. */
  readonly inserts: number
  /** Rows written across the eight tables — or, on a dry run, the gap that would be. */
  readonly gapRows: number
  readonly durationMs: number
  readonly tables: readonly BackfillTableReport[]
  readonly witness: BackfillWitness | null
  readonly ledgerRecorded: boolean
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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

async function scalar(
  client: ClickHouseClient,
  query: string,
  params?: Record<string, unknown>,
): Promise<string | null> {
  const [row] = await queryRows<Record<string, string | null>>(client, query, params)
  const value = Object.values(row ?? {})[0]
  return value === undefined ? null : value
}

async function readRaw(client: ClickHouseClient): Promise<BackfillRawReading> {
  const [row] = await queryRows<{ c: string; m: string | null }>(
    client,
    'SELECT count() AS c, max(received_at) AS m FROM events_raw',
  )
  const rows = Number(row?.c ?? 0)
  return { rows, maxReceivedAt: rows === 0 ? null : (row?.m ?? null) }
}

/** Per site, the first quarter hour (epoch seconds) the table holds a row for. */
async function readCuts(
  client: ClickHouseClient,
  table: string,
): Promise<ReadonlyMap<string, number>> {
  const rows = await queryRows<{ s: string; c: string }>(
    client,
    `SELECT toString(t.site_id) AS s, toUnixTimestamp(min(t.bucket_start)) AS c
       FROM ${table} AS t
      GROUP BY t.site_id`,
  )
  return new Map(rows.map((row) => [row.s, Number(row.c)]))
}

/**
 * Runs the backfill end to end, or refuses. Throws `BackfillRefusedError` on a
 * guard, and returns the report on success — the CLI turns the two into exit
 * codes.
 */
export async function backfillFifteenMinuteRollups(
  options: BackfillFifteenMinuteOptions,
): Promise<BackfillFifteenMinuteResult> {
  const client = createClient({
    url: options.url,
    username: options.username,
    password: options.password,
    database: options.database,
    // The backfill inserts are large and synchronous. No dedup token: each
    // statement covers a partition's gaps once, and the gap predicate is what
    // makes "once" true — a retried statement finds no gap left.
    clickhouse_settings: {
      async_insert: 0,
      wait_for_async_insert: 1,
      max_memory_usage: String(options.maxMemoryBytes ?? 1_500_000_000),
      max_threads: options.maxThreads ?? 2,
      max_insert_threads: '1',
      max_execution_time: 0,
    },
    request_timeout: 30 * 60 * 1000,
  })

  try {
    return await run(client, options)
  } finally {
    await client.close()
  }
}

async function run(
  client: ClickHouseClient,
  options: BackfillFifteenMinuteOptions,
): Promise<BackfillFifteenMinuteResult> {
  const { logger } = options
  const dryRun = options.dryRun === true
  const ifNeeded = options.ifNeeded === true
  const settleSeconds = options.settleSeconds ?? 10
  const accepted = new Set(options.acceptSites ?? [])
  const startedAt = Date.now()
  const nowMs = options.nowMs ?? startedAt
  const liveFromSeconds = Math.floor(nowMs / QUARTER_HOUR_MS) * (QUARTER_HOUR_MS / 1000)
  const liveFrom = new Date(liveFromSeconds * 1000).toISOString()

  // The hand-run refusal: every target is empty. Kept for the plain command
  // only, where "fill these" run twice by mistake should stop and say so.
  if (!ifNeeded) {
    const populated: string[] = []
    for (const spec of FIFTEEN_MINUTE_ROLLUPS) {
      const count = Number(await scalar(client, `SELECT count() FROM ${spec.table}`))
      if (count > 0) populated.push(`${spec.table}=${String(count)}`)
    }
    if (populated.length > 0) {
      throw new BackfillRefusedError(
        'target_not_empty',
        `refusing to backfill: targets already hold rows (${populated.join(', ')}). The plain command fills empty targets only. To fill whatever is missing — safely, over any state — run it with --if-needed.`,
      )
    }
  }

  // Where each site already has rows, read BEFORE anything is written: the
  // gate compares only the hours below this, which are the hours this run
  // fills, and the report says how many sites the views had already reached.
  const cuts = new Map<string, ReadonlyMap<string, number>>()
  for (const spec of FIFTEEN_MINUTE_ROLLUPS)
    cuts.set(spec.table, await readCuts(client, spec.table))

  // The live quarter hour: is there a gap in it at all? Only then does the
  // stillness question matter (in the automated mode).
  let liveGap = 0
  for (const spec of FIFTEEN_MINUTE_ROLLUPS) {
    liveGap += Number(
      await scalar(client, gapRowsStatement(spec, { fromSeconds: liveFromSeconds })),
    )
  }

  const rawReadings: BackfillRawReading[] = []
  let liveIncluded = false
  if (!ifNeeded || liveGap > 0) {
    const first = await readRaw(client)
    logger.info('backfill_15m_raw_reading', {
      store: 'clickhouse',
      reading: 1,
      rows: first.rows,
      max_received_at: first.maxReceivedAt,
      settle_seconds: settleSeconds,
      live_gap_rows: liveGap,
    })
    await sleep(settleSeconds * 1000)
    const second = await readRaw(client)
    logger.info('backfill_15m_raw_reading', {
      store: 'clickhouse',
      reading: 2,
      rows: second.rows,
      max_received_at: second.maxReceivedAt,
    })
    rawReadings.push(first, second)
    const still = first.rows === second.rows && first.maxReceivedAt === second.maxReceivedAt
    if (!still && !ifNeeded) {
      throw new BackfillRefusedError(
        'worker_still_writing',
        `refusing to backfill: events_raw moved between two readings ${String(settleSeconds)} s apart (rows ${String(first.rows)} -> ${String(second.rows)}, max(received_at) ${String(first.maxReceivedAt)} -> ${String(second.maxReceivedAt)}). Stop the worker first (ADR-0079 D3), or run with --if-needed, which fills everything below the live quarter hour while the worker runs.`,
      )
    }
    liveIncluded = still
  }
  const beforeSeconds = liveIncluded ? null : liveFromSeconds

  // The month partitions that hold raw rows, oldest first.
  const partitionRows = await queryRows<{ p: string }>(
    client,
    'SELECT DISTINCT toYYYYMM(occurred_at) AS p FROM events_raw ORDER BY p',
  )
  const partitions = partitionRows.map((row) => Number(row.p))
  logger.info('backfill_15m_plan', {
    store: 'clickhouse',
    dry_run: dryRun,
    mode: ifNeeded ? 'if-needed' : 'imperative',
    partitions,
    live_from: liveFrom,
    live_included: liveIncluded,
  })

  const gapRows = new Map<string, number>()
  let inserts = 0
  if (dryRun) {
    for (const spec of FIFTEEN_MINUTE_ROLLUPS) {
      gapRows.set(
        spec.table,
        Number(await scalar(client, gapRowsStatement(spec, { beforeSeconds }))),
      )
    }
  } else {
    for (const yyyymm of partitions) {
      for (const spec of FIFTEEN_MINUTE_ROLLUPS) {
        const statementStarted = Date.now()
        const result = await client.command({
          query: backfillStatement(spec, yyyymm, beforeSeconds),
          // The summary header carries `written_rows` only once the query has
          // finished; without this it can be sent with the first bytes.
          clickhouse_settings: { wait_end_of_query: 1 },
        })
        const written = Number(result.summary?.written_rows ?? 0)
        gapRows.set(spec.table, (gapRows.get(spec.table) ?? 0) + written)
        inserts += 1
        logger.info('backfill_15m_partition_done', {
          store: 'clickhouse',
          table: spec.table,
          partition: yyyymm,
          rows: written,
          duration_ms: Date.now() - statementStarted,
        })
      }
    }
  }

  const totalGap = [...gapRows.values()].reduce((sum, value) => sum + value, 0)
  const noop = totalGap === 0
  const mode = ifNeeded ? 'if-needed' : 'imperative'

  // Nothing written means nothing to prove: the state the run found is the
  // state it leaves. Reports are for runs that changed something (or would).
  const tables: BackfillTableReport[] = []
  let witness: BackfillWitness | null = null
  if (!noop) {
    const liveHour = Math.floor(liveFromSeconds / 3600) * 3600
    for (const spec of FIFTEEN_MINUTE_ROLLUPS) {
      tables.push(
        await reportTable(client, spec, {
          accepted,
          cuts: cuts.get(spec.table) ?? new Map(),
          liveHourSeconds: liveHour,
          gapRows: gapRows.get(spec.table) ?? 0,
          compare: !dryRun,
        }),
      )
    }
    if (!dryRun) witness = await readWitness(client, liveFromSeconds)
  }

  if (
    witness !== null &&
    (witness.seamEvents > 0 || witness.overEvents > 0 || witness.gapEvents > 0)
  ) {
    logger.warn('backfill_15m_witness', { store: 'clickhouse', ...witness })
  }

  const failing = tables.filter((table) => table.mismatchedSites.length > 0)

  let ledgerRecorded = false
  if (!dryRun) {
    ledgerRecorded = await recordRun(client, logger, noop, {
      command: 'backfill-15m',
      mode,
      live_from: liveFrom,
      live_included: liveIncluded,
      partitions,
      rows: Object.fromEntries(gapRows),
      witness,
      mismatched: failing.map((table) => ({ table: table.table, sites: table.mismatchedSites })),
      seam_note:
        'a quarter hour the view had already started writing when history was filled keeps only what the view saw (ADR-0079 prework)',
    })
  }

  const result: BackfillFifteenMinuteResult = {
    dryRun,
    mode,
    noop,
    partitions,
    liveFrom,
    liveIncluded,
    rawReadings,
    inserts,
    gapRows: totalGap,
    durationMs: Date.now() - startedAt,
    tables,
    witness,
    ledgerRecorded,
  }

  if (!dryRun && failing.length > 0) {
    throw new BackfillRefusedError(
      'additive_mismatch',
      `backfill finished but the additive sums disagree with the hour twin: ${failing
        .map((table) => `${table.table} (${table.mismatchedSites.join(', ')})`)
        .join('; ')}. Report: ${JSON.stringify(result)}`,
    )
  }
  return result
}

/**
 * Record the run in the ledger when it wrote something, or when it is the first
 * run to look. Best effort: the fill is already done and correct, and a ledger
 * that could not be written must not turn that into a failure.
 */
async function recordRun(
  client: ClickHouseClient,
  logger: Logger,
  noop: boolean,
  detail: Record<string, unknown>,
): Promise<boolean> {
  try {
    if (noop && (await hasBackfillRecord(client, 'rollups_15m'))) return false
    await recordBackfill(client, { name: 'rollups_15m', detail: { ...detail, noop } })
    return true
  } catch (err) {
    logger.warn('backfill_ledger_write_failed', {
      store: 'clickhouse',
      name: 'rollups_15m',
      retryable: true,
      err,
    })
    return false
  }
}

async function readWitness(
  client: ClickHouseClient,
  liveFromSeconds: number,
): Promise<BackfillWitness> {
  const [row] = await queryRows<Record<string, string>>(
    client,
    `SELECT countIf(m.e = 0)                      AS gap_pairs,
            sumIf(r.n, m.e = 0)                   AS gap_events,
            countIf(m.e > 0 AND r.n > m.e)        AS seam_pairs,
            sumIf(r.n - m.e, m.e > 0 AND r.n > m.e) AS seam_events,
            countIf(m.e > r.n)                    AS over_pairs,
            sumIf(m.e - r.n, m.e > r.n)           AS over_events
       FROM (SELECT site_id AS site, ${FIFTEEN_MINUTE_BUCKET} AS b, count() AS n
               FROM events_raw
              WHERE occurred_at < toDateTime({live:UInt32}, 'UTC')
              GROUP BY site, b) AS r
       FULL OUTER JOIN
            (SELECT t.site_id AS site, t.bucket_start AS b, sum(t.events) AS e
               FROM metrics_15m AS t
              WHERE t.bucket_start < toDateTime({live:UInt32}, 'UTC')
              GROUP BY site, b) AS m
         ON r.site = m.site AND r.b = m.b
     SETTINGS join_use_nulls = 0`,
    { live: liveFromSeconds },
  )
  const n = (key: string) => Number(row?.[key] ?? 0)
  return {
    gapPairs: n('gap_pairs'),
    gapEvents: n('gap_events'),
    seamPairs: n('seam_pairs'),
    seamEvents: n('seam_events'),
    overPairs: n('over_pairs'),
    overEvents: n('over_events'),
  }
}

async function reportTable(
  client: ClickHouseClient,
  spec: FifteenMinuteRollupSpec,
  input: {
    readonly accepted: ReadonlySet<string>
    readonly cuts: ReadonlyMap<string, number>
    readonly liveHourSeconds: number
    readonly gapRows: number
    readonly compare: boolean
  },
): Promise<BackfillTableReport> {
  const [shape] = await queryRows<{
    rows: string
    buckets: string
    min_bucket: string | null
    max_bucket: string | null
  }>(
    client,
    `SELECT count() AS rows, uniqExact(bucket_start) AS buckets,
            if(count() = 0, NULL, toString(min(bucket_start))) AS min_bucket,
            if(count() = 0, NULL, toString(max(bucket_start))) AS max_bucket
       FROM ${spec.table}`,
  )
  const base = {
    table: spec.table,
    gapRows: input.gapRows,
    sitesWithRows: input.cuts.size,
    rows: Number(shape?.rows ?? 0),
    buckets: Number(shape?.buckets ?? 0),
    minBucket: shape?.min_bucket ?? null,
    maxBucket: shape?.max_bucket ?? null,
  }

  // The comparison window starts at the hour twin's first COMPLETE bucket: a
  // view created mid-hour saw only part of its first hour, and the samples
  // family (0021) was created onto a populated table, so its first bucket is a
  // fragment by construction.
  const twinMin = input.compare
    ? await scalar(
        client,
        `SELECT if(count() = 0, NULL, toString(min(bucket_start) + INTERVAL 1 HOUR)) FROM ${spec.hourTwin}`,
      )
    : null
  if (twinMin === null) {
    return {
      ...base,
      comparedFrom: null,
      mismatchedSites: [],
      acceptedMismatchSites: [],
      visitors15m: null,
      visitors1h: null,
    }
  }

  // And it ends, per site, at the hour of the first quarter hour the site held
  // before this run: every hour wholly below it was filled by this run from
  // raw, while an hour the view had reached holds whatever the view saw and
  // the hour twin — frozen since 0027 — cannot be its reference any more. The
  // live hour caps every site, since the twin has not seen it either.
  const sites = [...input.cuts.keys()]
  const hours = sites.map((site) => {
    const cut = input.cuts.get(site) ?? input.liveHourSeconds
    return Math.min(Math.floor(cut / 3600) * 3600, input.liveHourSeconds)
  })
  const windowParams = { cut_sites: sites, cut_hours: hours, live_hour: input.liveHourSeconds }
  const inWindow = (alias: string) =>
    `${alias}.bucket_start >= toDateTime('${twinMin}', 'UTC')
        AND ${alias}.bucket_start < toDateTime(transform(toString(${alias}.site_id), {cut_sites:Array(String)}, {cut_hours:Array(UInt32)}, {live_hour:UInt32}), 'UTC')`

  const measures = [...spec.additiveColumns, ...spec.floatAdditiveColumns]
  const sums = measures.map((column) => `sum(t.${column}) AS sum_${column}`).join(', ')
  const perSite = async (table: string) =>
    await queryRows<Record<string, string>>(
      client,
      // Qualified through `t` and aliased away from the column names for the
      // reason every gateway operation is (ADR-0011): an alias that shadows
      // its source column turns a later bare reference into ILLEGAL_AGGREGATION.
      `SELECT toString(t.site_id) AS site, ${sums}
         FROM ${table} AS t
        WHERE ${inWindow('t')}
        GROUP BY t.site_id`,
      windowParams,
    )
  const fifteen = new Map((await perSite(spec.table)).map((row) => [row['site'] ?? '', row]))
  const hour = new Map((await perSite(spec.hourTwin)).map((row) => [row['site'] ?? '', row]))

  const mismatched: string[] = []
  const acceptedMismatch: string[] = []
  for (const site of new Set([...fifteen.keys(), ...hour.keys()])) {
    const a = fifteen.get(site)
    const b = hour.get(site)
    let equal = a !== undefined && b !== undefined
    if (equal && a && b) {
      for (const column of spec.additiveColumns) {
        if (a[`sum_${column}`] !== b[`sum_${column}`]) equal = false
      }
      for (const column of spec.floatAdditiveColumns) {
        const x = Number(a[`sum_${column}`])
        const y = Number(b[`sum_${column}`])
        const tolerance = Math.max(Math.abs(x), Math.abs(y), 1) * 1e-9
        if (Math.abs(x - y) > tolerance) equal = false
      }
    }
    if (!equal) {
      if (input.accepted.has(site)) acceptedMismatch.push(site)
      else mismatched.push(site)
    }
  }

  let visitors15m: number | null = null
  let visitors1h: number | null = null
  if (spec.hasVisitors) {
    const merged = async (table: string) =>
      Number(
        await scalar(
          client,
          `SELECT uniqMerge(t.visitors) FROM ${table} AS t WHERE ${inWindow('t')}`,
          windowParams,
        ),
      )
    visitors15m = await merged(spec.table)
    visitors1h = await merged(spec.hourTwin)
  }

  return {
    ...base,
    comparedFrom: twinMin,
    mismatchedSites: mismatched.sort(),
    acceptedMismatchSites: acceptedMismatch.sort(),
    visitors15m,
    visitors1h,
  }
}
