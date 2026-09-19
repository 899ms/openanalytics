import { createHash } from 'node:crypto'
import { createClient, type ClickHouseClient } from '@clickhouse/client'

/**
 * The revenue rollups' ClickHouse surface (ADR-0033, D7; migration 0018).
 * Milestone 12 Checkpoint 5.
 *
 * Two statements and a row type, and deliberately nothing else. What a bucket
 * *contains* — the D2d sign rules, the refunded-charge rule, the unconverted
 * exclusion — is decided by a pure planner in the worker
 * (`apps/worker/src/revenue/rollup-plan.ts`), for the same reason the session
 * swap keeps `planRollupSwap` out of `session-facts.ts`: a rule that lives in
 * SQL can only be tested against a running ClickHouse, and these are exactly the
 * rules that must be provable in the always-run unit project.
 *
 * The aggregation input is therefore **not** here either. The rollup step reads
 * current facts through `RevenueEventsStore.readCurrentRows` — the one
 * implementation of the argMax-by-version read rule — and aggregates them in
 * TypeScript. That read is bucket-aligned by the caller, which is what makes an
 * edge bucket complete: a horizon floor in the middle of an hour would otherwise
 * recompute that hour from the fraction of it the horizon happened to cover and
 * write a bucket that is missing its own first minutes.
 *
 * ## The read rule
 *
 * `argMax(col, generation) GROUP BY (site_id, bucket_start)`, never `FINAL`.
 * ReplacingMergeTree's merge is space reclamation, not a correctness mechanism
 * (ADR-0005). Aggregated columns are qualified through the table alias, because
 * CI's ClickHouse resolves a bare name an alias shadows to the alias and throws
 * ILLEGAL_AGGREGATION.
 *
 * ## Written by the worker, never by the api
 *
 * Same boundary as every other analytics table (D-208): the api holds no
 * ClickHouse credential and reads these through the signed query gateway. The
 * worker writes on `oa_ingest`, which needs `INSERT` and `SELECT` on
 * `revenue_15m` and `revenue_1d` through the entrypoint XML and a container
 * **recreate** — CP7's deploy step, exactly as `revenue_events` and
 * `revenue_attributions` needed before it.
 */

export const REVENUE_ROLLUP_15M_TABLE = 'revenue_15m'
export const REVENUE_ROLLUP_1D_TABLE = 'revenue_1d'

/**
 * The grains the attribution job writes.
 *
 * Two, not three, since ADR-0079 step 4 retired the hour grain: every read had
 * already moved to the fifteen-minute family in step 3, so the hour swap was
 * pure cost. The narrowing is the enforcement — a write to `revenue_1h` did
 * not type-check any more — and migration 0029 (v0.8.0) dropped the table.
 */
export type RevenueRollupUnit = '15m' | '1d'

/**
 * One row of `revenue_15m`/`revenue_1d` (migrations 0018 and 0026).
 *
 * snake_case because these are the migration's column names, sent as
 * `JSONEachRow`. Numbers rather than bigints: every amount is an `Int64` of
 * minor units in the site's reporting currency, far inside `2^53` for any real
 * account (nine quadrillion minor units is ninety trillion dollars).
 */
export interface RevenueRollupRow {
  readonly site_id: string
  /** `YYYY-MM-DD HH:MM:SS`, UTC — a `DateTime('UTC')` literal. */
  readonly bucket_start: string
  readonly generation: number

  readonly charge_gross_minor: number
  readonly refund_minor: number
  readonly dispute_withdrawn_minor: number
  readonly dispute_reinstated_minor: number
  readonly fee_minor: number
  readonly net_minor: number

  readonly charge_count: number
  readonly refund_count: number
  readonly dispute_count: number
  readonly unconverted_count: number

  /** `YYYY-MM-DD HH:MM:SS.mmm`, UTC. */
  readonly computed_at: string
}

/** The additive measures of one bucket, without the identity of the bucket. */
export interface RevenueBucketMeasures {
  readonly chargeGrossMinor: number
  readonly refundMinor: number
  readonly disputeWithdrawnMinor: number
  readonly disputeReinstatedMinor: number
  readonly feeMinor: number
  readonly netMinor: number
  readonly chargeCount: number
  readonly refundCount: number
  readonly disputeCount: number
  readonly unconvertedCount: number
}

/** A recomputed bucket, keyed by its UTC start. */
export interface RevenueBucketAggregate extends RevenueBucketMeasures {
  /** Bucket start as epoch seconds (UTC). */
  readonly bucketSeconds: number
  /** Bucket start as a ClickHouse `DateTime` literal, `YYYY-MM-DD HH:MM:SS`. */
  readonly bucketStart: string
}

/** The current (latest-generation) stored rollup of a bucket. */
export interface StoredRevenueRollupBucket extends RevenueBucketAggregate {
  readonly generation: number
}

export interface RevenueRollupsStoreOptions {
  readonly url: string
  readonly username: string
  readonly password: string
  readonly database: string
  readonly requestTimeoutMs?: number
  /** Overridable for tests that migrate into a throwaway database. */
  readonly rollup15mTable?: string
  readonly rollup1dTable?: string
}

export const DEFAULT_REVENUE_ROLLUP_TIMEOUT_MS = 60_000

export interface RevenueRollupsStore {
  /** Current generation per rollup bucket intersecting `[loMs, hiMs)`. */
  readStoredRollups(input: {
    siteId: string
    unit: RevenueRollupUnit
    loMs: number
    hiMs: number
  }): Promise<StoredRevenueRollupBucket[]>
  /** Insert rollup rows under a stable, content-derived deduplication token. */
  insertRollups(input: {
    unit: RevenueRollupUnit
    rows: readonly RevenueRollupRow[]
  }): Promise<void>
  /**
   * Per site with revenue history, where its day rollup and its fifteen-minute
   * rollup each begin. The re-roll seed's gap test (`sitesMissingFifteenMinuteHistory`).
   */
  listFifteenMinuteCoverage(): Promise<readonly RevenueFifteenMinuteCoverage[]>
  ping(): Promise<boolean>
  close(): Promise<void>
}

/**
 * Where a site's two revenue grains begin, over LIVE buckets only: the current
 * generation of a bucket, and only when it counts at least one fact. A bucket
 * a later recompute zeroed is not history either grain has to match.
 */
export interface RevenueFifteenMinuteCoverage {
  readonly siteId: string
  /** Start of the first live `revenue_1d` bucket, epoch ms. */
  readonly firstDayMs: number
  /** Start of the first live `revenue_15m` bucket, epoch ms, or null when there is none. */
  readonly firstQuarterMs: number | null
}

const MS_PER_DAY = 86_400_000

/**
 * The sites whose fifteen-minute revenue history is missing: the day grain
 * holds a live bucket on a day the fifteen-minute grain does not reach.
 *
 * The two grains are recomputed from the same facts by the same planner, so a
 * site whose re-roll has run has the same first DAY in both, and the test
 * settles to "nothing to do" by itself. That is what lets it run on every
 * start: unlike "seed every revenue site", it cannot restart a finished re-roll,
 * and unlike a done-marker it needs nothing written anywhere to know.
 */
export function sitesMissingFifteenMinuteHistory(
  coverage: readonly RevenueFifteenMinuteCoverage[],
): readonly RevenueFifteenMinuteCoverage[] {
  return coverage.filter(
    (site) =>
      site.firstQuarterMs === null ||
      Math.floor(site.firstQuarterMs / MS_PER_DAY) * MS_PER_DAY > site.firstDayMs,
  )
}

/**
 * The batch's deduplication token: sha256 over a namespace and the rows.
 *
 * Identical in shape to the session rollup's and the revenue fact's. A crashed
 * swap that is retried rebuilds byte-identical rows — the planner is pure over
 * `(facts, stored rollups, computed_at)` and the caller passes the tick's
 * `nowMs` once — so the retry hashes to the same token and ClickHouse drops it.
 */
export function revenueRollupToken(
  unit: RevenueRollupUnit,
  rows: readonly RevenueRollupRow[],
): string {
  const hash = createHash('sha256')
  hash.update(`revenue_rollup:${unit}`)
  hash.update('\n')
  hash.update(JSON.stringify(rows))
  return hash.digest('hex').slice(0, 32)
}

export function createRevenueRollupsStore(
  options: RevenueRollupsStoreOptions,
): RevenueRollupsStore {
  // A total `Record` over the unit union, not a ternary. The ternary it
  // replaces had no third case, so adding `'15m'` to `RevenueRollupUnit` would
  // have sent every fifteen-minute read and every fifteen-minute swap to
  // `revenue_1d` -- silently, with no type error, corrupting the day grain
  // instead of merely failing.
  const rollupTables: Readonly<Record<RevenueRollupUnit, string>> = {
    '15m': options.rollup15mTable ?? REVENUE_ROLLUP_15M_TABLE,
    '1d': options.rollup1dTable ?? REVENUE_ROLLUP_1D_TABLE,
  }
  const rollupTable = (unit: RevenueRollupUnit): string => rollupTables[unit]

  const client: ClickHouseClient = createClient({
    url: options.url,
    username: options.username,
    password: options.password,
    database: options.database,
    request_timeout: options.requestTimeoutMs ?? DEFAULT_REVENUE_ROLLUP_TIMEOUT_MS,
    clickhouse_settings: {
      // The swap must be durable before the attribution watermark advances past
      // the range it summarises, exactly as the session finalizer's is.
      async_insert: 0,
      wait_for_async_insert: 1,
    },
  })

  return {
    async readStoredRollups({ siteId, unit, loMs, hiMs }) {
      const resultSet = await client.query({
        query: `SELECT
                  toUnixTimestamp(rr.bucket_start)                         AS bucket_seconds,
                  formatDateTime(rr.bucket_start, '%F %T')                 AS bucket_start,
                  max(rr.generation)                                       AS generation,
                  argMax(rr.charge_gross_minor, rr.generation)             AS charge_gross_minor,
                  argMax(rr.refund_minor, rr.generation)                   AS refund_minor,
                  argMax(rr.dispute_withdrawn_minor, rr.generation)        AS dispute_withdrawn_minor,
                  argMax(rr.dispute_reinstated_minor, rr.generation)       AS dispute_reinstated_minor,
                  argMax(rr.fee_minor, rr.generation)                      AS fee_minor,
                  argMax(rr.net_minor, rr.generation)                      AS net_minor,
                  argMax(rr.charge_count, rr.generation)                   AS charge_count,
                  argMax(rr.refund_count, rr.generation)                   AS refund_count,
                  argMax(rr.dispute_count, rr.generation)                  AS dispute_count,
                  argMax(rr.unconverted_count, rr.generation)              AS unconverted_count
                FROM ${rollupTable(unit)} AS rr
                WHERE rr.site_id = {siteId:String}
                  AND rr.bucket_start >= toDateTime(intDiv({loMs:Int64}, 1000))
                  AND rr.bucket_start <  toDateTime(intDiv({hiMs:Int64}, 1000))
                GROUP BY rr.site_id, rr.bucket_start`,
        query_params: { siteId, loMs, hiMs },
        format: 'JSONEachRow',
      })
      const rows = await resultSet.json<Record<string, string>>()
      return rows.map((row) => ({
        bucketSeconds: Number(row['bucket_seconds']),
        bucketStart: row['bucket_start'] as string,
        generation: Number(row['generation']),
        chargeGrossMinor: Number(row['charge_gross_minor']),
        refundMinor: Number(row['refund_minor']),
        disputeWithdrawnMinor: Number(row['dispute_withdrawn_minor']),
        disputeReinstatedMinor: Number(row['dispute_reinstated_minor']),
        feeMinor: Number(row['fee_minor']),
        netMinor: Number(row['net_minor']),
        chargeCount: Number(row['charge_count']),
        refundCount: Number(row['refund_count']),
        disputeCount: Number(row['dispute_count']),
        unconvertedCount: Number(row['unconverted_count']),
      }))
    },

    async insertRollups({ unit, rows }) {
      if (rows.length === 0) return
      await client.insert({
        table: rollupTable(unit),
        values: rows,
        format: 'JSONEachRow',
        clickhouse_settings: { insert_deduplication_token: revenueRollupToken(unit, rows) },
      })
    },

    async listFifteenMinuteCoverage() {
      const live = (table: string) => `
        SELECT l.site_id AS site_id, min(l.bucket_start) AS first_bucket
          FROM (
            SELECT rr.site_id AS site_id,
                   rr.bucket_start AS bucket_start,
                   argMax(rr.charge_count + rr.refund_count + rr.dispute_count + rr.unconverted_count, rr.generation) AS facts
              FROM ${table} AS rr
             GROUP BY rr.site_id, rr.bucket_start
          ) AS l
         WHERE l.facts > 0
         GROUP BY l.site_id`
      const resultSet = await client.query({
        query: `SELECT toString(d.site_id)                      AS site_id,
                       toUnixTimestamp(d.first_bucket) * 1000   AS first_day_ms,
                       if(q.first_bucket IS NULL, NULL, toUnixTimestamp(q.first_bucket) * 1000) AS first_quarter_ms
                  FROM (${live(rollupTable('1d'))}) AS d
                  LEFT JOIN (${live(rollupTable('15m'))}) AS q ON q.site_id = d.site_id
                 ORDER BY site_id
                SETTINGS join_use_nulls = 1`,
        format: 'JSONEachRow',
      })
      const rows = await resultSet.json<{
        site_id: string
        first_day_ms: string
        first_quarter_ms: string | null
      }>()
      return rows.map((row) => ({
        siteId: row.site_id,
        firstDayMs: Number(row.first_day_ms),
        firstQuarterMs: row.first_quarter_ms === null ? null : Number(row.first_quarter_ms),
      }))
    },

    async ping() {
      const result = await client.ping()
      return result.success
    },

    async close() {
      await client.close()
    },
  }
}
