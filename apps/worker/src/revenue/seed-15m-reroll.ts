import {
  createRevenueEventsStore,
  createRevenueRollupsStore,
  openBackfillLedger,
  sitesMissingFifteenMinuteHistory,
} from '@openanalytics/clickhouse'
import { resolveEnvFileReferences } from '@openanalytics/domain'
import { createLogger, createServiceMetadata } from '@openanalytics/observability'
import { createDatabase, createPool, markRevenueRollupRecompute } from '@openanalytics/postgres'

/**
 * `node apps/worker/dist/revenue/seed-15m-reroll.js [--dry-run] [--if-needed]`
 *
 * Seed the history of `revenue_15m` (ClickHouse migration 0026, ADR-0079
 * step 2) by pulling a revenue site's re-roll cursor back to its oldest fact.
 *
 * ## Why there is no backfill here
 *
 * `session_rollups_15m` gets one, because reconstructing a session bucket from
 * `session_facts_versions` is a single aggregate and the finalizer would
 * otherwise never revisit an old bucket. The revenue rollup already has the
 * mechanism: `revenue_attribution_state.rollup_recompute_from` is a floor the
 * attribution job walks forward one month per pass, recomputing and swapping
 * every bucket it crosses, and clearing itself when it reaches the ordinary
 * horizon. It exists for reporting-currency changes, which need exactly this —
 * "every bucket this site ever had is wrong, redo them all".
 *
 * A fifteen-minute grain arriving empty is the same problem with the same
 * answer, so this writes one column on a handful of rows and then gets out of
 * the way. Nothing here recomputes a bucket, and nothing here writes a rollup.
 * The worker does the work, at its own pace, under its own leases, with its own
 * idempotence — which is why this is safe to run with the worker already up.
 *
 * ## Which sites: `--if-needed`
 *
 * Without the flag every revenue site is seeded, which is a full re-roll of all
 * of them — right once, by hand, and wrong on every start: once the walk has
 * cleared its cursor, seeding again restarts it from the beginning.
 *
 * `--if-needed` seeds only the sites whose fifteen-minute history is MISSING:
 * `revenue_1d` holds a live bucket on a day `revenue_15m` does not reach
 * (`sitesMissingFifteenMinuteHistory`). The two grains are written by the same
 * planner from the same facts, so after the walk has passed a site the two
 * begin on the same day and the site drops out by itself. No done-marker is
 * needed or read, so this runs on every start of the self-hosted migrate
 * container and costs one read when there is nothing to do. A site mid-walk is
 * not re-seeded either: the walk starts at the oldest day, so its fifteen-minute
 * rows reach that day after the first pass.
 *
 * ## Why the floor comes from the facts
 *
 * `min(revenue_events.occurred_at)`, not the day rollup's first bucket and not
 * a fixed date. The question is how far back there is anything to process, and
 * the facts answer it directly. `markRevenueRollupRecompute` takes the `LEAST`
 * of the stored floor and the new one, so this can only ever move a cursor
 * further back.
 *
 * ## Credentials
 *
 * Either the migration identity — `POSTGRES_MIGRATION_URL` and
 * `CLICKHOUSE_MIGRATION_USER`/`_PASSWORD`, which is what the self-hosted migrate
 * container holds and the only one that may write `backfill_ledger` (0028) — or
 * the worker's own (`DATABASE_URL`, `CLICKHOUSE_INGEST_*`), in which case the
 * ledger row is skipped. `*_FILE` is resolved here because this is its own
 * first read of the environment (ADR-0065).
 *
 * Exit codes: 0 done, 78 misconfigured, 1 anything else.
 */

const logger = createLogger({
  service: createServiceMetadata({
    name: 'worker',
    version: process.env['SERVICE_VERSION'] ?? '0.0.0',
    commit: process.env['GIT_COMMIT'] ?? 'unknown',
    environment: process.env['ENVIRONMENT'] ?? 'local',
  }),
})

const env = resolveEnvFileReferences(process.env)

const migrationIdentity =
  env['CLICKHOUSE_MIGRATION_USER'] !== undefined &&
  env['CLICKHOUSE_MIGRATION_PASSWORD'] !== undefined
const databaseUrl = env['POSTGRES_MIGRATION_URL'] ?? env['DATABASE_URL']
const clickhouseUrl = env['CLICKHOUSE_URL']
const username = migrationIdentity
  ? env['CLICKHOUSE_MIGRATION_USER']
  : env['CLICKHOUSE_INGEST_USER']
const password = migrationIdentity
  ? env['CLICKHOUSE_MIGRATION_PASSWORD']
  : env['CLICKHOUSE_INGEST_PASSWORD']
// The migrate container spells it CLICKHOUSE_DATABASE, the worker CLICKHOUSE_DB.
const database = env['CLICKHOUSE_DATABASE'] ?? env['CLICKHOUSE_DB'] ?? 'analytics'

if (!databaseUrl || !clickhouseUrl || !username || password === undefined) {
  process.stderr.write(
    'POSTGRES_MIGRATION_URL or DATABASE_URL, CLICKHOUSE_URL, and either CLICKHOUSE_MIGRATION_USER/_PASSWORD or CLICKHOUSE_INGEST_USER/_PASSWORD are required\n',
  )
  process.exit(78) // EX_CONFIG
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const ifNeeded = args.includes('--if-needed')

const pool = createPool(databaseUrl)
const db = createDatabase(pool)
const connection = { url: clickhouseUrl, username, password, database }
const events = createRevenueEventsStore(connection)
const rollups = createRevenueRollupsStore(connection)
const ledger = migrationIdentity ? openBackfillLedger(connection) : null

try {
  const oldest = await events.listOldestOccurrencePerSite()
  const missing = ifNeeded
    ? new Set(
        sitesMissingFifteenMinuteHistory(await rollups.listFifteenMinuteCoverage()).map(
          (site) => site.siteId,
        ),
      )
    : null
  const targets = missing === null ? oldest : oldest.filter((site) => missing.has(site.siteId))
  logger.info('revenue_15m_reroll_plan', {
    store: 'clickhouse',
    dry_run: dryRun,
    if_needed: ifNeeded,
    revenue_sites: oldest.length,
    sites: targets.length,
  })

  const seeded: { siteId: string; from: string }[] = []
  for (const site of targets) {
    const from = new Date(site.oldestOccurredAtMs)
    if (!dryRun) {
      await markRevenueRollupRecompute(db, { siteId: site.siteId, from })
    }
    seeded.push({ siteId: site.siteId, from: from.toISOString() })
    logger.info('revenue_15m_reroll_seeded', {
      store: 'postgres',
      dry_run: dryRun,
      site_id: site.siteId,
      from: from.toISOString(),
    })
  }

  // Evidence, not a decision input (0028): a run that seeded, or the first to
  // look. Best effort — the cursors are already written.
  let ledgerRecorded = false
  if (!dryRun && ledger !== null) {
    try {
      const noop = seeded.length === 0
      if (!noop || !(await ledger.hasRecord('revenue_15m_reroll'))) {
        await ledger.record({
          name: 'revenue_15m_reroll',
          detail: {
            command: 'seed-15m-reroll',
            mode: ifNeeded ? 'if-needed' : 'all',
            noop,
            revenue_sites: oldest.length,
            seeded,
          },
        })
        ledgerRecorded = true
      }
    } catch (err) {
      logger.warn('backfill_ledger_write_failed', {
        store: 'clickhouse',
        name: 'revenue_15m_reroll',
        retryable: true,
        err,
      })
    }
  }

  process.stdout.write(
    `${JSON.stringify({ dryRun, ifNeeded, sites: seeded.length, seeded, ledgerRecorded }, null, 2)}\n`,
  )
} catch (err) {
  logger.error('revenue_15m_reroll_failed', { store: 'postgres', retryable: false, err })
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
} finally {
  await events.close()
  await rollups.close()
  await ledger?.close()
  await pool.end()
}
