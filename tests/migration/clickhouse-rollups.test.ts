import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import {
  BACKFILL_LEDGER_TABLE,
  BackfillRefusedError,
  FIFTEEN_MINUTE_ROLLUPS,
  backfillFifteenMinuteRollups,
  migrateClickHouse,
  readBackfillLedger,
  type FifteenMinuteRollupSpec,
} from '@openanalytics/clickhouse'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The Milestone 7 additive rollup family, proven with data (plan items 1-2).
 *
 * **Reads the grains that exist: fifteen minutes and one day.** Migration 0027
 * (ADR-0079 step 4) dropped the eight `*_1h_mv` and 0029 (v0.8.0) the hour
 * tables themselves. Until then this suite rebuilt the hour views in
 * `beforeAll` to model an upgraded install, because the 15m backfill proved
 * itself against the hour twins; it proves itself against `events_raw` now,
 * so the model is no longer needed and every assertion reads what production
 * reads.
 *
 * The bootstrap test (`clickhouse-analytics.test.ts`) proves the schema builds
 * and every dedup-bearing table carries the window. This one proves the three
 * behavioural invariants that the schema alone cannot:
 *
 *   1. **A deduplicated raw retry does not double any rollup.** Every rollup in
 *      the family reads directly from events_raw, so this is ADR-0005's finding
 *      applied to the whole family at once: three re-inserts of one batch under
 *      the same insert_deduplication_token must leave every rollup unchanged.
 *      Without the window on a target, the raw block deduplicates while that
 *      view fires again — a silent multiplication invisible in the raw table.
 *   2. **Unique visitors merge, they are not summed** (plan item 2). uniqMerge
 *      over several buckets counts a visitor active in two of them once; the
 *      naive sum of per-bucket uniques double-counts it.
 *   3. **The shipped identity rule (ADR-0036)**: a bucket's visitors are the
 *      distinct anonymous ids with at least one page view in it. `user_id`
 *      exists on the identify event alone, so an identified person is one
 *      visitor exactly when the merge is filtered to the page-view state —
 *      the filter the gateway ships — and `visitors <= pageviews` holds even
 *      when departure beacons land in the bucket after their page view.
 *      (This suite once seeded page_view rows carrying a user_id — a fixture
 *      production cannot produce — and asserted a fold that never ran; that
 *      is the drift ADR-0036 closed.)
 *
 * Plus the performance rollup's t-digest state answers a percentile of the
 * union, merged across buckets.
 *
 * Inserts run under the migration/default credential straight into events_raw,
 * which is what fires the views — the worker's row mapping is proven separately
 * in the M6 live suite. Skipped without TEST_CLICKHOUSE_URL; CI always provides
 * one.
 */

const URL_ = process.env['TEST_CLICKHOUSE_URL']
const USERNAME = process.env['TEST_CLICKHOUSE_USER'] ?? 'default'
const PASSWORD = process.env['TEST_CLICKHOUSE_PASSWORD'] ?? ''

const describeIfClickHouse = URL_ ? describe : describe.skip

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../packages/clickhouse/migrations/', import.meta.url),
)

interface RawRow {
  site_id: string
  event_id: string
  batch_id: string
  type: string
  name?: string
  occurred_at: string
  billable?: number
  anonymous_id?: string
  user_id?: string
  page_path?: string
  referrer_domain?: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  country?: string
  city?: string
  device_type?: string
  browser?: string
  os?: string
  properties?: string
}

describeIfClickHouse('analytics rollup family behaviour', () => {
  const url = URL_ as string
  const database = `m7rollup_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let client: ReturnType<typeof createClient>

  const queryRows = async <T>(query: string): Promise<T[]> => {
    const resultSet = await client.query({ query, format: 'JSONEachRow' })
    return await resultSet.json<T>()
  }

  const scalar = async (query: string): Promise<number> => {
    const [row] = await queryRows<Record<string, string>>(query)
    return Number(Object.values(row ?? {})[0] ?? 0)
  }

  /** Inserts a block into events_raw under a stable dedup token, as the worker does. */
  const insertRaw = async (token: string, rows: readonly RawRow[]): Promise<void> => {
    await client.insert({
      table: 'events_raw',
      values: rows.map((row) => ({
        schema_version: 1,
        name: '',
        billable: 1,
        anonymous_id: '',
        user_id: '',
        page_path: '',
        referrer_domain: '',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        country: '',
        city: '',
        device_type: '',
        browser: '',
        os: '',
        properties: '{}',
        ...row,
      })),
      format: 'JSONEachRow',
      clickhouse_settings: { insert_deduplication_token: token },
    })
  }

  const newSite = (): string => randomUUID()
  const newEvent = (): string => randomUUID()

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
  }, 120_000)

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` })
      await client.close()
    }
  })

  it('populates the metric rollups and does not double them on a deduplicated retry', async () => {
    const site = newSite()
    const at = '2026-07-23 10:00:00.000'
    // Three page views, two distinct anonymous visitors, two distinct paths.
    const rows: RawRow[] = [
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'b1',
        type: 'page_view',
        occurred_at: at,
        anonymous_id: 'v1',
        page_path: '/a',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'b1',
        type: 'page_view',
        occurred_at: at,
        anonymous_id: 'v1',
        page_path: '/a',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'b1',
        type: 'page_view',
        occurred_at: at,
        anonymous_id: 'v2',
        page_path: '/b',
      },
    ]

    await insertRaw('token-b1', rows)

    const events = () =>
      scalar(
        `SELECT sum(events) FROM metrics_15m WHERE site_id = '${site}' AND event_type = 'page_view'`,
      )
    const visitors = () =>
      scalar(
        `SELECT uniqMerge(visitors) FROM metrics_15m WHERE site_id = '${site}' AND event_type = 'page_view'`,
      )
    const pageViews = (path: string) =>
      scalar(`SELECT sum(views) FROM pages_15m WHERE site_id = '${site}' AND page_path = '${path}'`)

    expect(await events()).toBe(3)
    expect(await visitors()).toBe(2)
    expect(await pageViews('/a')).toBe(2)
    expect(await pageViews('/b')).toBe(1)
    // Day rollup answers the same question at the day grain.
    expect(
      await scalar(
        `SELECT sum(events) FROM metrics_1d WHERE site_id = '${site}' AND event_type = 'page_view'`,
      ),
    ).toBe(3)

    // Three more inserts of the identical block under the same token. The raw
    // block deduplicates on every retry; each rollup target's own window keeps
    // the view from firing twice. Without it, events would climb to 12.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await insertRaw('token-b1', rows)
    }

    expect(await scalar(`SELECT count() FROM events_raw WHERE site_id = '${site}'`)).toBe(3)
    expect(await events()).toBe(3)
    expect(await visitors()).toBe(2)
    expect(await pageViews('/a')).toBe(2)
    expect(await pageViews('/b')).toBe(1)
  })

  it('merges unique visitors across buckets rather than summing them', async () => {
    const site = newSite()
    // v1 appears in two different quarters of the same day; v2 in a third.
    // Per-quarter uniques sum to 3, but the true distinct count over the day is 2.
    await insertRaw('token-merge', [
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'm',
        type: 'page_view',
        occurred_at: '2026-07-23 10:30:00.000',
        anonymous_id: 'v1',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'm',
        type: 'page_view',
        occurred_at: '2026-07-23 10:45:00.000',
        anonymous_id: 'v2',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'm',
        type: 'page_view',
        occurred_at: '2026-07-23 11:30:00.000',
        anonymous_id: 'v1',
      },
    ])

    // Three quarter buckets exist.
    const quarterBuckets = await scalar(
      `SELECT count() FROM (SELECT bucket_start FROM metrics_15m WHERE site_id = '${site}' AND event_type = 'page_view' GROUP BY bucket_start)`,
    )
    expect(quarterBuckets).toBe(3)

    // The naive sum of per-quarter uniq counts would be 3.
    const summed = await scalar(
      `SELECT sum(u) FROM (
         SELECT uniqMerge(visitors) AS u FROM metrics_15m
          WHERE site_id = '${site}' AND event_type = 'page_view' GROUP BY bucket_start)`,
    )
    expect(summed).toBe(3)

    // Merged across the quarters it is 2 — the property that a bucket sum destroys.
    const merged = await scalar(
      `SELECT uniqMerge(visitors) FROM metrics_15m WHERE site_id = '${site}' AND event_type = 'page_view'`,
    )
    expect(merged).toBe(2)

    // And the day rollup, which buckets to the same day, also reports 2.
    expect(
      await scalar(
        `SELECT uniqMerge(visitors) FROM metrics_1d WHERE site_id = '${site}' AND event_type = 'page_view'`,
      ),
    ).toBe(2)
  })

  it('counts one identified person as a single visitor under the shipped page-view rule', async () => {
    const site = newSite()
    // Production reality (ADR-0036): the collector sets user_id on the identify
    // event ALONE. One person — anonymous id anonA — views two pages and calls
    // identify() mid-visit (the identify row carries both anonA and the hash
    // u1); a second, purely anonymous visitor anonC views one page.
    await insertRaw('token-identity', [
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'i',
        type: 'page_view',
        occurred_at: '2026-07-23 09:00:00.000',
        anonymous_id: 'anonA',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'i',
        type: 'identify',
        occurred_at: '2026-07-23 09:02:00.000',
        anonymous_id: 'anonA',
        user_id: 'u1',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'i',
        type: 'page_view',
        occurred_at: '2026-07-23 09:05:00.000',
        anonymous_id: 'anonA',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'i',
        type: 'page_view',
        occurred_at: '2026-07-23 09:10:00.000',
        anonymous_id: 'anonC',
      },
    ])

    // The shipped read: the merge filtered to the page-view state, exactly as
    // the gateway's timeseries and overview branches filter it. Two people.
    expect(
      await scalar(
        `SELECT uniqMergeIf(visitors, event_type = 'page_view') FROM metrics_15m WHERE site_id = '${site}'`,
      ),
    ).toBe(2)

    // The bare merge this replaced also counted the identify-typed state's
    // user hash — one person as two visitors. Pinned so the double count the
    // filter closes stays visible in the data, not only in prose.
    expect(
      await scalar(`SELECT uniqMerge(visitors) FROM metrics_15m WHERE site_id = '${site}'`),
    ).toBe(3)
  })

  it('keeps visitors <= pageviews per bucket when departure beacons land in the next one', async () => {
    const site = newSite()
    // The dominant real-world generator of the "2 visitors / 1 pageview"
    // symptom: a page opened at 09:58 whose engagement and web_vital fire at
    // departure, 10:03, landing in a LATER bucket (the events are
    // stamped when they happen, and that is correct — ADR-0036 changed the
    // definition, not the clock).
    await insertRaw('token-departure', [
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'd',
        type: 'page_view',
        occurred_at: '2026-07-23 09:58:00.000',
        anonymous_id: 'vd',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'd',
        type: 'engagement',
        occurred_at: '2026-07-23 10:03:00.000',
        anonymous_id: 'vd',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'd',
        type: 'web_vital',
        occurred_at: '2026-07-23 10:03:00.000',
        anonymous_id: 'vd',
      },
    ])

    const buckets = await queryRows<{ bucket: string; pageviews: string; visitors: string }>(
      `SELECT bucket_start AS bucket,
              sumIf(events, event_type = 'page_view') AS pageviews,
              uniqMergeIf(visitors, event_type = 'page_view') AS visitors
         FROM metrics_15m WHERE site_id = '${site}'
        GROUP BY bucket_start ORDER BY bucket_start`,
    )
    // Two buckets exist (the departure events are real rows in 10:00), and the
    // shipped rule holds in both: 09:45 is 1/1, 10:00 is 0 visitors beside 0
    // pageviews — not the 1-visitor/0-pageview bucket the bare merge produced.
    expect(buckets.map((row) => [Number(row.visitors), Number(row.pageviews)])).toEqual([
      [1, 1],
      [0, 0],
    ])
    for (const row of buckets) {
      expect(Number(row.visitors)).toBeLessThanOrEqual(Number(row.pageviews))
    }
  })

  it('rolls up custom events and conversions by name, and keeps page_views out', async () => {
    const site = newSite()
    await insertRaw('token-custom', [
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'c',
        type: 'page_view',
        occurred_at: '2026-07-23 12:00:00.000',
        anonymous_id: 'v1',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'c',
        type: 'custom_event',
        name: 'signup_started',
        occurred_at: '2026-07-23 12:01:00.000',
        anonymous_id: 'v1',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'c',
        type: 'custom_event',
        name: 'signup_started',
        occurred_at: '2026-07-23 12:02:00.000',
        anonymous_id: 'v2',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'c',
        type: 'conversion',
        name: 'purchase',
        occurred_at: '2026-07-23 12:03:00.000',
        anonymous_id: 'v1',
      },
    ])

    const rows = await queryRows<{
      event_name: string
      event_type: string
      events: string
      visitors: string
    }>(
      `SELECT event_name, event_type, sum(events) AS events, uniqMerge(visitors) AS visitors
         FROM custom_events_15m WHERE site_id = '${site}'
        GROUP BY event_name, event_type ORDER BY event_name`,
    )
    expect(
      rows.map((row) => [row.event_name, row.event_type, Number(row.events), Number(row.visitors)]),
    ).toEqual([
      ['purchase', 'conversion', 1, 1],
      ['signup_started', 'custom_event', 2, 2],
    ])
    // The page_view carried no name, so it never entered the custom-event rollup.
    expect(
      await scalar(
        `SELECT count() FROM custom_events_15m WHERE site_id = '${site}' AND event_name = ''`,
      ),
    ).toBe(0)
  })

  it('samples the newest event per name, by occurred_at and not by arrival', async () => {
    // ADR-0038 D5. The whole point of argMax over `occurred_at` rather than
    // anyLast: the newest event is inserted FIRST here and the older one second,
    // which is what a retried batch or a late arrival looks like from inside
    // ClickHouse. anyLast would answer `/old`.
    const site = newSite()
    const event = (name: string, at: string, path: string, properties: string): RawRow => ({
      site_id: site,
      event_id: newEvent(),
      batch_id: 's',
      type: 'custom_event',
      name,
      occurred_at: at,
      anonymous_id: 'v1',
      page_path: path,
      properties,
    })

    await insertRaw('token-sample-new', [
      event('signup', '2026-07-23 12:30:00.000', '/new', '{"section":"hero"}'),
    ])
    await insertRaw('token-sample-old', [
      event('signup', '2026-07-23 12:10:00.000', '/old', '{"section":"footer"}'),
      // A second name in the same bucket, so the argMax is per group rather
      // than per bucket.
      event('newsletter_joined', '2026-07-23 12:20:00.000', '/blog', '{}'),
    ])

    const rows = await queryRows<{
      event_name: string
      events: string
      last_seen_at: string
      sample_page_path: string
      sample_properties: string
    }>(
      // Qualified through `t` for the same reason the gateway operation is:
      // every alias here shares its source column's name. The unqualified form
      // passed on 26.3, so this mirrors the read rather than fixing it.
      `SELECT
         t.event_name                       AS event_name,
         sum(t.events)                      AS events,
         max(t.last_seen_at)                AS last_seen_at,
         argMaxMerge(t.sample_page_path)    AS sample_page_path,
         argMaxMerge(t.sample_properties)   AS sample_properties
       FROM custom_event_samples_15m AS t WHERE t.site_id = '${site}'
       GROUP BY event_name ORDER BY event_name`,
    )

    expect(
      rows.map((row) => [
        row.event_name,
        Number(row.events),
        row.last_seen_at,
        row.sample_page_path,
        row.sample_properties,
      ]),
    ).toEqual([
      ['newsletter_joined', 1, '2026-07-23 12:20:00.000', '/blog', '{}'],
      ['signup', 2, '2026-07-23 12:30:00.000', '/new', '{"section":"hero"}'],
    ])

    // Same filter as custom_events_15m: a row with no name never enters.
    await insertRaw('token-sample-pv', [
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 's',
        type: 'page_view',
        occurred_at: '2026-07-23 12:40:00.000',
        anonymous_id: 'v1',
        page_path: '/x',
      },
    ])
    expect(
      await scalar(
        `SELECT count() FROM custom_event_samples_15m WHERE site_id = '${site}' AND event_name = ''`,
      ),
    ).toBe(0)

    // The day twin answers the same question at the day grain, and the counts
    // agree with the rollup the read cuts its top-N by.
    expect(
      await scalar(`SELECT sum(events) FROM custom_event_samples_1d WHERE site_id = '${site}'`),
    ).toBe(await scalar(`SELECT sum(events) FROM custom_events_1d WHERE site_id = '${site}'`))

    // And a deduplicated retry does not double it (ADR-0005, the family rule).
    await insertRaw('token-sample-old', [
      event('signup', '2026-07-23 12:10:00.000', '/old', '{"section":"footer"}'),
      event('newsletter_joined', '2026-07-23 12:20:00.000', '/blog', '{}'),
    ])
    expect(
      await scalar(
        `SELECT sum(events) FROM custom_event_samples_15m
          WHERE site_id = '${site}' AND event_name = 'signup'`,
      ),
    ).toBe(2)
  })

  it('answers merged percentiles from the performance t-digest state', async () => {
    const site = newSite()
    const vital = (value: number, rating: string, at: string): RawRow => ({
      site_id: site,
      event_id: newEvent(),
      batch_id: 'p',
      type: 'web_vital',
      billable: 0,
      device_type: 'desktop',
      occurred_at: at,
      properties: JSON.stringify({ oa_metric: 'LCP', oa_value: value, oa_rating: rating }),
    })
    // Two different hours so the read has to merge several sketches.
    await insertRaw('token-perf', [
      vital(100, 'good', '2026-07-23 08:10:00.000'),
      vital(200, 'good', '2026-07-23 08:20:00.000'),
      vital(300, 'needs-improvement', '2026-07-23 09:10:00.000'),
      vital(400, 'poor', '2026-07-23 09:20:00.000'),
    ])

    const [row] = await queryRows<{
      samples: string
      value_sum: string
      good: string
      ni: string
      poor: string
      p50: string
      p95: string
    }>(
      `SELECT
         sum(samples) AS samples,
         sum(value_sum) AS value_sum,
         sum(good_samples) AS good,
         sum(needs_improvement_samples) AS ni,
         sum(poor_samples) AS poor,
         arrayElement(quantilesTDigestMerge(0.5, 0.75, 0.9, 0.95, 0.99)(value_quantiles), 1) AS p50,
         arrayElement(quantilesTDigestMerge(0.5, 0.75, 0.9, 0.95, 0.99)(value_quantiles), 4) AS p95
       FROM performance_15m WHERE site_id = '${site}' AND metric = 'LCP'`,
    )

    expect(Number(row?.samples)).toBe(4)
    expect(Number(row?.value_sum)).toBe(1000)
    expect(Number(row?.good)).toBe(2)
    expect(Number(row?.ni)).toBe(1)
    expect(Number(row?.poor)).toBe(1)
    // The median of {100,200,300,400} lies in [100,400]; the exact t-digest
    // value is not asserted, only that a merged percentile is answerable and
    // ordered. This is a percentile of the union, not an average of per-hour
    // percentiles.
    expect(Number(row?.p50)).toBeGreaterThanOrEqual(100)
    expect(Number(row?.p50)).toBeLessThanOrEqual(400)
    expect(Number(row?.p95)).toBeGreaterThanOrEqual(Number(row?.p50))
    expect(Number(row?.p95)).toBeLessThanOrEqual(400)
  })

  // Milestone 7 acceptance criterion 4 (DST through the composed-day path). The
  // read API composes a non-UTC day from metrics_15m (metrics_1h until ADR-0079) with
  // toStartOfDay(bucket_start, tz) — exactly the analytics.timeseries_day
  // operation. On a DST transition that local "day" is 23 or 25 UTC hours long,
  // and this proves the composition lands every one of those hours in the right
  // local day, so the 23h/25h day is neither short-changed nor padded.
  it('composes a 23h spring-forward and a 25h fall-back local day from the 15m rollup', async () => {
    const site = newSite()
    const NY = 'America/New_York'

    // One page_view at each UTC hour across a range that covers three NY local
    // days around each transition, so the composed grouping has neighbours to be
    // distinguished from.
    const hourlyPageViews = async (startUtc: string, hours: number, token: string) => {
      const start = Date.parse(`${startUtc}Z`)
      const rows: RawRow[] = []
      for (let h = 0; h < hours; h += 1) {
        const at = new Date(start + h * 3_600_000).toISOString().replace('T', ' ').replace('Z', '')
        rows.push({
          site_id: site,
          event_id: newEvent(),
          batch_id: token,
          type: 'page_view',
          occurred_at: at,
          anonymous_id: `v${h}`,
          page_path: '/',
        })
      }
      await insertRaw(token, rows)
    }

    // Spring forward: 2026-03-08 is a 23h NY day (local midnight 05:00Z → next
    // local midnight 04:00Z). Fall back: 2026-11-01 is a 25h NY day (04:00Z →
    // 05:00Z next day). Seed a wide UTC window around both so the composed
    // grouping includes the neighbouring days too.
    await hourlyPageViews('2026-03-07 00:00:00.000', 24 * 4, 'dst-spring')
    await hourlyPageViews('2026-10-31 00:00:00.000', 24 * 4, 'dst-fall')

    const composed = await queryRows<{ local_day: string; events: string }>(
      `SELECT
         toString(toStartOfDay(bucket_start, '${NY}')) AS local_day,
         sum(events) AS events
       FROM metrics_15m
       WHERE site_id = '${site}' AND event_type = 'page_view'
       GROUP BY local_day
       ORDER BY local_day`,
    )
    const eventsOn = (day: string): number =>
      Number(composed.find((r) => r.local_day.startsWith(day))?.events ?? -1)

    // The DST days have exactly their true local length; the surrounding days are
    // ordinary 24h days.
    expect(eventsOn('2026-03-08')).toBe(23)
    expect(eventsOn('2026-03-07')).toBe(24)
    expect(eventsOn('2026-11-01')).toBe(25)
    expect(eventsOn('2026-11-02')).toBe(24)

    // And the composed days partition the events: no hour is dropped or
    // double-counted across the local-day boundaries.
    const springTotal = eventsOn('2026-03-07') + eventsOn('2026-03-08')
    expect(springTotal).toBe(47) // 24 + 23, the first two full local days seeded
  })

  // ---------------------------------------------------------------------------
  // ADR-0079 — the fifteen-minute atom (migration 0025). Four proofs:
  //
  //   1. the family rule (invariant 1 above) applied to the 15m targets: a
  //      deduplicated raw retry leaves them unchanged;
  //   2. EQUALITY: a local day composed from the 15m rows equals the same day
  //      composed from events_raw by the view's own SELECT, family by family,
  //      row for row, across a DST transition (until migration 0029 this
  //      compared with the hour rows, which are gone);
  //   3. SUB-HOUR TRUTH: for +05:30 and +05:45 a local day composed from the
  //      15m rows equals the day computed directly from events_raw, while an
  //      hour composition does not — the reason the finer atom exists. This is
  //      the assertion that fails if the bucket expression is changed back to
  //      toStartOfHour, and it was watched failing before it was trusted;
  //   4. the backfill inserts exactly what the views insert, refuses to run
  //      twice, and proves itself against events_raw.
  // ---------------------------------------------------------------------------

  it('buckets the 15m family to the quarter hour and does not double it on a deduplicated retry', async () => {
    const site = newSite()
    const rows: RawRow[] = [
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'q',
        type: 'page_view',
        occurred_at: '2026-07-23 10:07:00.000',
        anonymous_id: 'v1',
        page_path: '/a',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'q',
        type: 'page_view',
        occurred_at: '2026-07-23 10:14:59.999',
        anonymous_id: 'v2',
        page_path: '/a',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'q',
        type: 'page_view',
        occurred_at: '2026-07-23 10:22:00.000',
        anonymous_id: 'v1',
        page_path: '/b',
      },
    ]
    await insertRaw('token-q', rows)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await insertRaw('token-q', rows)
    }

    const buckets = await queryRows<{ bucket: string; events: string; visitors: string }>(
      `SELECT toString(bucket_start) AS bucket, sum(events) AS events, uniqMerge(visitors) AS visitors
         FROM metrics_15m WHERE site_id = '${site}' AND event_type = 'page_view'
        GROUP BY bucket_start ORDER BY bucket_start`,
    )
    expect(buckets.map((row) => [row.bucket, Number(row.events), Number(row.visitors)])).toEqual([
      ['2026-07-23 10:00:00', 2, 2],
      ['2026-07-23 10:15:00', 1, 1],
    ])
    expect(
      await scalar(
        `SELECT sum(views) FROM pages_15m WHERE site_id = '${site}' AND page_path = '/a'`,
      ),
    ).toBe(2)
    // The day twin saw the same three rows once — the two grains agree.
    expect(
      await scalar(
        `SELECT sum(events) FROM metrics_1d WHERE site_id = '${site}' AND event_type = 'page_view'`,
      ),
    ).toBe(3)
  })

  /**
   * What a family's rows would be if its view had seen every raw row: the
   * view's own SELECT over events_raw, as a subquery a read can stand on.
   */
  const fromRaw = (family: string): string => {
    const spec = FIFTEEN_MINUTE_ROLLUPS.find((entry) => entry.table === `${family}_15m`)
    if (spec === undefined) throw new Error(`no 15m spec for ${family}`)
    const where = spec.where.length > 0 ? ` WHERE ${spec.where}` : ''
    return `(SELECT ${spec.select.replace('{bucket}', "toStartOfFifteenMinutes(toDateTime(occurred_at, 'UTC'))")} FROM events_raw${where} GROUP BY ${spec.groupBy})`
  }

  /** Every family's composed-day read, from the 15m tables or from raw, for one site and zone. */
  const composedDay = async (source: '15m' | 'raw', site: string, tz: string) => {
    const from = (family: string) => (source === '15m' ? `${family}_15m` : fromRaw(family))
    const day = `toString(toStartOfDay(bucket_start, '${tz}'))`
    const rows = async (query: string) =>
      (await queryRows<Record<string, string>>(query)).map((row) => Object.values(row))
    return {
      metrics: await rows(
        `SELECT ${day} AS d, sumIf(events, event_type = 'page_view') AS pv,
                sum(events) AS ev, sum(billable_events) AS bev,
                uniqMergeIf(visitors, event_type = 'page_view') AS vis
           FROM ${from('metrics')} AS t WHERE site_id = '${site}' GROUP BY d ORDER BY d`,
      ),
      pages: await rows(
        `SELECT ${day} AS d, page_path, sum(views) AS v, uniqMerge(visitors) AS vis
           FROM ${from('pages')} AS t WHERE site_id = '${site}' GROUP BY d, page_path ORDER BY d, page_path`,
      ),
      sources: await rows(
        `SELECT ${day} AS d, referrer_domain, utm_source, sum(views) AS v, uniqMerge(visitors) AS vis
           FROM ${from('sources')} AS t WHERE site_id = '${site}'
          GROUP BY d, referrer_domain, utm_source ORDER BY d, referrer_domain, utm_source`,
      ),
      geography: await rows(
        `SELECT ${day} AS d, country, city, sum(views) AS v, uniqMerge(visitors) AS vis
           FROM ${from('geography')} AS t WHERE site_id = '${site}' GROUP BY d, country, city ORDER BY d, country, city`,
      ),
      devices: await rows(
        `SELECT ${day} AS d, device_type, browser, sum(views) AS v, uniqMerge(visitors) AS vis
           FROM ${from('devices')} AS t WHERE site_id = '${site}'
          GROUP BY d, device_type, browser ORDER BY d, device_type, browser`,
      ),
      custom_events: await rows(
        `SELECT ${day} AS d, event_name, event_type, sum(events) AS ev, sum(billable_events) AS bev,
                uniqMerge(visitors) AS vis
           FROM ${from('custom_events')} AS t WHERE site_id = '${site}'
          GROUP BY d, event_name, event_type ORDER BY d, event_name, event_type`,
      ),
      performance: await rows(
        `SELECT ${day} AS d, metric, device_type, sum(samples) AS s, round(sum(value_sum), 6) AS vs,
                sum(good_samples) AS g, sum(needs_improvement_samples) AS ni, sum(poor_samples) AS p
           FROM ${from('performance')} AS t WHERE site_id = '${site}'
          GROUP BY d, metric, device_type ORDER BY d, metric, device_type`,
      ),
      custom_event_samples: await rows(
        `SELECT ${day} AS d, t.event_name AS event_name, sum(t.events) AS ev,
                toString(max(t.last_seen_at)) AS seen, argMaxMerge(t.sample_page_path) AS path
           FROM ${from('custom_event_samples')} AS t WHERE t.site_id = '${site}'
          GROUP BY d, event_name ORDER BY d, event_name`,
      ),
    }
  }

  /** One page view, one custom event and one web vital every fifteen minutes over a UTC window. */
  const seedQuarterHours = async (
    site: string,
    startUtc: string,
    quarters: number,
    token: string,
  ): Promise<void> => {
    const start = Date.parse(`${startUtc}Z`)
    const rows: RawRow[] = []
    for (let q = 0; q < quarters; q += 1) {
      // Seven-minute offset so nothing sits on a bucket boundary; visitors
      // rotate on a period that is not a multiple of four, so quarter-hour
      // uniq states have to be merged, not summed, to agree with the hour.
      const at = new Date(start + q * 900_000 + 7 * 60_000)
        .toISOString()
        .replace('T', ' ')
        .replace('Z', '')
      const visitor = `v${String(q % 7)}`
      rows.push(
        {
          site_id: site,
          event_id: newEvent(),
          batch_id: token,
          type: 'page_view',
          occurred_at: at,
          anonymous_id: visitor,
          page_path: q % 3 === 0 ? '/' : '/blog',
          referrer_domain: q % 2 === 0 ? 'google.com' : '',
          utm_source: q % 5 === 0 ? 'newsletter' : '',
          country: q % 2 === 0 ? 'DE' : 'IN',
          city: q % 2 === 0 ? 'Berlin' : 'Pune',
          device_type: q % 4 === 0 ? 'mobile' : 'desktop',
          browser: 'Chrome',
          os: 'Linux',
        },
        {
          site_id: site,
          event_id: newEvent(),
          batch_id: token,
          type: 'custom_event',
          name: q % 2 === 0 ? 'signup' : 'download',
          occurred_at: at,
          anonymous_id: visitor,
          page_path: `/step/${String(q % 5)}`,
          properties: `{"q":${String(q)}}`,
        },
        {
          site_id: site,
          event_id: newEvent(),
          batch_id: token,
          type: 'web_vital',
          billable: 0,
          occurred_at: at,
          anonymous_id: visitor,
          device_type: q % 4 === 0 ? 'mobile' : 'desktop',
          properties: JSON.stringify({
            oa_metric: 'LCP',
            oa_value: 100 + (q % 9) * 50,
            oa_rating: q % 3 === 0 ? 'good' : q % 3 === 1 ? 'needs-improvement' : 'poor',
          }),
        },
      )
    }
    await insertRaw(token, rows)
  }

  it('composes the same Europe/Berlin day from the 15m rows as from events_raw, across a DST transition', async () => {
    const site = newSite()
    // 2026-03-29 is Berlin's spring-forward day: local midnight 23:00Z on the
    // 28th, next local midnight 22:00Z on the 29th — a 23-hour day. Seed three
    // UTC days around it, one row set per quarter hour.
    await seedQuarterHours(site, '2026-03-28 00:00:00.000', 24 * 4 * 3, 'berlin')

    const fifteen = await composedDay('15m', site, 'Europe/Berlin')
    const raw = await composedDay('raw', site, 'Europe/Berlin')
    // Row for row, family by family: what the views wrote is what the raw rows
    // say, uniq states included.
    expect(fifteen).toEqual(raw)

    // And the DST day is really 23 hours long — 92 page views against
    // 96 on an ordinary day. (Column 1 of the metrics rows is `pv`.)
    const pageViewsOn = (day: string) =>
      Number(fifteen.metrics.find((row) => row[0]?.startsWith(day))?.[1] ?? -1)
    expect(pageViewsOn('2026-03-29')).toBe(23 * 4)
    expect(pageViewsOn('2026-03-30')).toBe(24 * 4)
  })

  it('composes a correct +05:30 and +05:45 local day from the 15m rows, where the hour rows cannot', async () => {
    // Local midnight is 18:30Z in Kolkata and 18:15Z in Kathmandu. Events a
    // minute either side of it must land on different local days, and a
    // one-hour bucket cannot tell them apart.
    const cases: Array<{ tz: string; before: string; after: string }> = [
      { tz: 'Asia/Kolkata', before: '18:29:00.000', after: '18:31:00.000' },
      { tz: 'Asia/Kathmandu', before: '18:14:00.000', after: '18:16:00.000' },
    ]
    for (const { tz, before, after } of cases) {
      const site = newSite()
      const rows: RawRow[] = []
      for (const day of ['2026-08-10', '2026-08-11', '2026-08-12']) {
        for (const [i, clock] of [before, after].entries()) {
          rows.push({
            site_id: site,
            event_id: newEvent(),
            batch_id: tz,
            type: 'page_view',
            occurred_at: `${day} ${clock}`,
            // Distinct visitors on each side of midnight, shared across days,
            // so the visitor count per local day is 1 and the naive union is 2.
            anonymous_id: `side${String(i)}`,
            page_path: '/',
          })
        }
        // Noon-local traffic, so every day also has an unambiguous row.
        rows.push({
          site_id: site,
          event_id: newEvent(),
          batch_id: tz,
          type: 'page_view',
          occurred_at: `${day} 06:30:00.000`,
          anonymous_id: 'noon',
          page_path: '/',
        })
      }
      await insertRaw(`token-${tz}`, rows)

      // The truth, straight from the rows: group by the local day of each event.
      const truth = await queryRows<{ d: string; pv: string; vis: string }>(
        `SELECT toString(toStartOfDay(toDateTime(occurred_at, 'UTC'), '${tz}')) AS d,
                count() AS pv, uniqExact(anonymous_id) AS vis
           FROM events_raw WHERE site_id = '${site}' AND type = 'page_view'
          GROUP BY d ORDER BY d`,
      )
      // Sanity on the seed itself: four local days — the 18:31Z row of the
      // 12th is the 13th locally — with 2, 3, 3 and 1 page views (a middle
      // day holds the previous UTC day's post-midnight row, its noon row and
      // its own pre-midnight row), each by a distinct visitor.
      expect(truth.map((row) => [Number(row.pv), Number(row.vis)])).toEqual([
        [2, 2],
        [3, 3],
        [3, 3],
        [1, 1],
      ])

      const composed = await queryRows<{ d: string; pv: string; vis: string }>(
        `SELECT toString(toStartOfDay(bucket_start, '${tz}')) AS d,
                sumIf(events, event_type = 'page_view') AS pv,
                uniqMergeIf(visitors, event_type = 'page_view') AS vis
           FROM metrics_15m WHERE site_id = '${site}' GROUP BY d ORDER BY d`,
      )
      // An hour atom, composed the same way — from the raw rows, since the
      // hour tables are gone (migration 0029).
      const byHour = await queryRows<{ d: string; pv: string; vis: string }>(
        `SELECT toString(toStartOfDay(toStartOfHour(toDateTime(occurred_at, 'UTC')), '${tz}')) AS d,
                count() AS pv, uniqExact(anonymous_id) AS vis
           FROM events_raw WHERE site_id = '${site}' AND type = 'page_view'
          GROUP BY d ORDER BY d`,
      )

      // The fifteen-minute composition IS the truth.
      expect(composed).toEqual(truth)
      // The hour composition is not: both sides of midnight fall in the 18:00Z
      // bucket, so it puts them on the same local day — the reason ADR-0011
      // refused these zones.
      expect(byHour).not.toEqual(truth)
    }
  })

  it('backfills the 15m family from events_raw to exactly what the views produced, once', async () => {
    // Everything every test above seeded is in events_raw, and the views put
    // it in the 15m tables as it arrived. Fingerprint the merged content per
    // table, empty the tables, run the production backfill, and compare.
    const fingerprint = async () => {
      const out: Record<string, unknown[]> = {}
      for (const spec of FIFTEEN_MINUTE_ROLLUPS) {
        const key = spec.groupBy
          .split(',')
          .map((column) => `t.${column.trim()}`)
          .join(', ')
        const measures = [
          ...spec.additiveColumns.map((column) => `sum(t.${column}) AS sum_${column}`),
          ...spec.floatAdditiveColumns.map(
            (column) => `round(sum(t.${column}), 6) AS sum_${column}`,
          ),
          ...(spec.hasVisitors ? ['uniqMerge(t.visitors) AS vis'] : []),
          ...(spec.table === 'custom_event_samples_15m'
            ? [
                'toString(max(t.last_seen_at)) AS seen',
                'argMaxMerge(t.sample_page_path) AS path',
                'argMaxMerge(t.sample_properties) AS props',
              ]
            : []),
        ].join(', ')
        out[spec.table] = await queryRows<Record<string, string>>(
          `SELECT ${key}, ${measures} FROM ${spec.table} AS t GROUP BY ${key} ORDER BY ${key}`,
        )
        expect(out[spec.table]?.length, `${spec.table} should hold seeded rows`).toBeGreaterThan(0)
      }
      return out
    }

    const fromViews = await fingerprint()

    const { logger } = createCapturedLogger()
    const options = {
      url,
      username: USERNAME,
      password: PASSWORD,
      database,
      logger,
      settleSeconds: 0,
    }

    // Guard 1: the targets are populated, so the backfill refuses before
    // writing a byte.
    await expect(backfillFifteenMinuteRollups(options)).rejects.toMatchObject({
      name: 'BackfillRefusedError',
      reason: 'target_not_empty',
    })

    for (const spec of FIFTEEN_MINUTE_ROLLUPS) {
      await client.command({ query: `TRUNCATE TABLE ${spec.table}` })
    }

    const result = await backfillFifteenMinuteRollups(options)
    expect(result.inserts).toBe(FIFTEEN_MINUTE_ROLLUPS.length * result.partitions.length)
    expect(result.partitions.length).toBeGreaterThan(1)
    // Every family agrees with events_raw pair by pair, and says so.
    for (const table of result.tables) {
      expect(table.comparedPairs, table.table).toBeGreaterThan(0)
      expect(table.mismatchedSites, table.table).toEqual([])
    }

    // The backfilled content is the view-produced content.
    expect(await fingerprint()).toEqual(fromViews)

    // And it cannot run again by accident.
    await expect(backfillFifteenMinuteRollups(options)).rejects.toBeInstanceOf(BackfillRefusedError)
  })

  // ---------------------------------------------------------------------------
  // `--if-needed` is a GAP FILL (v0.7.0 prework). The tests below run after the
  // backfill test above, so every seeded event is in events_raw and the 15m
  // tables are full. Each one builds a starting state an upgrade can meet, runs
  // the automated mode, and compares every table with the TRUTH: the view's
  // own SELECT run over the whole of events_raw right now.
  // ---------------------------------------------------------------------------

  /** Far enough ahead that no seeded event is in the live quarter hour. */
  const LATER = Date.parse('2100-01-01T00:00:00.000Z')

  const fingerprintOf = async (
    from: (spec: FifteenMinuteRollupSpec) => string,
  ): Promise<Record<string, unknown[]>> => {
    const out: Record<string, unknown[]> = {}
    for (const spec of FIFTEEN_MINUTE_ROLLUPS) {
      const key = spec.groupBy
        .split(',')
        .map((column) => `t.${column.trim()}`)
        .join(', ')
      const measures = [
        ...spec.additiveColumns.map((column) => `sum(t.${column}) AS sum_${column}`),
        ...spec.floatAdditiveColumns.map((column) => `round(sum(t.${column}), 6) AS sum_${column}`),
        ...(spec.hasVisitors ? ['uniqMerge(t.visitors) AS vis'] : []),
        ...(spec.table === 'custom_event_samples_15m'
          ? [
              'toString(max(t.last_seen_at)) AS seen',
              'argMaxMerge(t.sample_page_path) AS path',
              'argMaxMerge(t.sample_properties) AS props',
            ]
          : []),
      ].join(', ')
      out[spec.table] = await queryRows<Record<string, string>>(
        `SELECT ${key}, ${measures} FROM ${from(spec)} AS t GROUP BY ${key} ORDER BY ${key}`,
      )
    }
    return out
  }
  const stored = () => fingerprintOf((spec) => spec.table)
  const truth = () =>
    fingerprintOf((spec) => {
      const where = spec.where.length > 0 ? ` WHERE ${spec.where}` : ''
      return `(SELECT ${spec.select.replace('{bucket}', "toStartOfFifteenMinutes(toDateTime(occurred_at, 'UTC'))")} FROM events_raw${where} GROUP BY ${spec.groupBy})`
    })

  const truncateAll = async () => {
    for (const spec of FIFTEEN_MINUTE_ROLLUPS) {
      await client.command({ query: `TRUNCATE TABLE ${spec.table}` })
    }
  }

  const rowCounts = async () => {
    const counts: Record<string, number> = {}
    for (const spec of FIFTEEN_MINUTE_ROLLUPS) {
      counts[spec.table] = await scalar(`SELECT count() FROM ${spec.table}`)
    }
    return counts
  }

  const ifNeeded = (logger = createCapturedLogger().logger) => ({
    url,
    username: USERNAME,
    password: PASSWORD,
    database,
    logger,
    settleSeconds: 0,
    ifNeeded: true,
    nowMs: LATER,
  })

  it('(a, d) --if-needed over empty targets fills all of history, records it, and a second run writes nothing', async () => {
    await truncateAll()
    await client.command({ query: `TRUNCATE TABLE ${BACKFILL_LEDGER_TABLE}` })

    const filled = await backfillFifteenMinuteRollups(ifNeeded())
    expect(filled.noop).toBe(false)
    expect(filled.gapRows).toBeGreaterThan(0)
    for (const table of filled.tables) {
      expect(table.mismatchedSites, table.table).toEqual([])
      expect(table.comparedPairs, table.table).toBeGreaterThan(0)
      expect(table.seamPairs, table.table).toBe(0)
    }
    // Pair by pair against events_raw: no gap left, no seam (nothing was
    // writing), and not one event counted twice.
    expect(filled.witness).toEqual({
      gapPairs: 0,
      gapEvents: 0,
      seamPairs: 0,
      seamEvents: 0,
      overPairs: 0,
      overEvents: 0,
    })
    expect(await stored()).toEqual(await truth())

    // Evidence, one row, written by the run that filled.
    expect(filled.ledgerRecorded).toBe(true)
    const ledger = await readBackfillLedger(client)
    expect(ledger.map((entry) => entry.name)).toEqual(['rollups_15m'])
    expect(ledger[0]!.detail).toMatchObject({
      command: 'backfill-15m',
      mode: 'if-needed',
      noop: false,
    })

    // (d) Again: every statement runs and finds no gap. Not one row moves —
    // which is the whole claim, because a second additive pass is exactly how a
    // count doubles.
    const before = await rowCounts()
    const again = await backfillFifteenMinuteRollups(ifNeeded())
    expect(again.noop).toBe(true)
    expect(again.gapRows).toBe(0)
    expect(again.tables).toEqual([])
    expect(again.ledgerRecorded).toBe(false)
    expect(await rowCounts()).toEqual(before)
    expect(await stored()).toEqual(await truth())
  })

  it('(b) fills a family the install has no rows for yet, and leaves the full ones alone', async () => {
    // The state that stopped the whole stack before the rework: custom events
    // are rare, so `custom_events_15m` and its samples table are EMPTY on most
    // installs while the other six fill up. The old `--if-needed` called that
    // "partially populated", exited 2, and `depends_on:
    // service_completed_successfully` then kept every service down.
    await client.command({ query: 'TRUNCATE TABLE custom_events_15m' })
    await client.command({ query: 'TRUNCATE TABLE custom_event_samples_15m' })

    const result = await backfillFifteenMinuteRollups(ifNeeded())
    const rows = Object.fromEntries(result.tables.map((table) => [table.table, table.gapRows]))
    expect(rows['custom_events_15m']).toBeGreaterThan(0)
    expect(rows['custom_event_samples_15m']).toBeGreaterThan(0)
    for (const spec of FIFTEEN_MINUTE_ROLLUPS) {
      if (!spec.table.startsWith('custom_event')) expect(rows[spec.table], spec.table).toBe(0)
    }
    expect(await stored()).toEqual(await truth())
  })

  it('(c) fills history when the views kept writing through the upgrade, instead of skipping it', async () => {
    // Coolify/Dokploy redeploy, or `pull && up -d` by hand: the worker never
    // stopped, so 0025's views started filling every table with the NEW
    // traffic while all history stayed missing. The old `--if-needed` saw
    // eight non-empty tables, said `alreadyPopulated`, and exited 0 — every
    // pre-upgrade event silently absent from every 15m read.
    await truncateAll()

    const site = newSite()
    const at = '2026-09-18 12:03:00.000'
    await insertRaw('upgrade-traffic', [
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'u',
        type: 'page_view',
        occurred_at: at,
        anonymous_id: 'n1',
        page_path: '/new',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'u',
        type: 'custom',
        name: 'signup',
        occurred_at: at,
        anonymous_id: 'n1',
      },
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'u',
        type: 'web_vital',
        occurred_at: at,
        anonymous_id: 'n1',
        properties: JSON.stringify({ oa_metric: 'LCP', oa_value: 1200, oa_rating: 'good' }),
      },
    ])
    // The precondition the old code misread: nothing is empty.
    for (const [table, count] of Object.entries(await rowCounts())) {
      expect(count, table).toBeGreaterThan(0)
    }

    const result = await backfillFifteenMinuteRollups(ifNeeded())
    expect(result.noop).toBe(false)
    for (const table of result.tables) {
      expect(table.gapRows, table.table).toBeGreaterThan(0)
      expect(table.mismatchedSites, table.table).toEqual([])
    }
    expect(result.witness?.gapEvents).toBe(0)
    expect(result.witness?.overEvents).toBe(0)
    expect(await stored()).toEqual(await truth())
  })

  it('(e) a late event seams only its own quarter hour, fills the rest, and says so', async () => {
    // A table-level "fill below the oldest row" would let one late event — its
    // occurred_at before the views existed, delivered after — drag that
    // boundary back and silently leave everything between it and the upgrade
    // unfilled. Here the unit is the (site, quarter hour), so a late event
    // costs exactly its own pair.
    const site = newSite()
    const history = (occurredAt: string, anonymousId: string): RawRow => ({
      site_id: site,
      event_id: newEvent(),
      batch_id: 'h',
      type: 'page_view',
      occurred_at: occurredAt,
      anonymous_id: anonymousId,
      page_path: '/h',
    })
    // Before the upgrade: two events at 10:00, one at 11:00, one the next day.
    await insertRaw('late-history', [
      history('2026-06-01 10:01:00.000', 'h1'),
      history('2026-06-01 10:02:00.000', 'h2'),
      history('2026-06-01 11:01:00.000', 'h3'),
      history('2026-06-02 09:01:00.000', 'h4'),
    ])
    // ...which the 15m views never saw.
    await truncateAll()
    // After it: one late event in the 10:00 quarter.
    await insertRaw('late-event', [history('2026-06-01 10:05:00.000', 'late')])

    const captured = createCapturedLogger()
    const result = await backfillFifteenMinuteRollups(ifNeeded(captured.logger))

    // No refusal, no mismatch: the one short pair is one the site already
    // held before the run, which is the seam the gate allows and reports.
    for (const table of result.tables) expect(table.mismatchedSites, table.table).toEqual([])
    const metrics = result.tables.find((table) => table.table === 'metrics_15m')
    expect(metrics).toMatchObject({ seamPairs: 1, seamEvents: 2 })

    const events = (bucket: string) =>
      scalar(
        `SELECT sum(events) FROM metrics_15m WHERE site_id = '${site}' AND bucket_start = toDateTime('${bucket}', 'UTC')`,
      )
    // The seamed pair holds what the view saw: the late event alone.
    expect(await events('2026-06-01 10:00:00')).toBe(1)
    // Everything after it is filled — the part a moved boundary would lose.
    expect(await events('2026-06-01 11:00:00')).toBe(1)
    expect(await events('2026-06-02 09:00:00')).toBe(1)

    // And the loss is measured, not silent.
    expect(result.witness).toMatchObject({
      gapEvents: 0,
      seamPairs: 1,
      seamEvents: 2,
      overEvents: 0,
    })
    expect(captured.find('backfill_15m_witness')).toHaveLength(1)
  })

  it('reaches the live quarter hour only when events_raw is still', async () => {
    // A gap inside the quarter hour the run starts in: with nothing writing
    // (settle 0, no concurrent insert) the readings agree and it is filled.
    await truncateAll()
    const site = newSite()
    const nowMs = Date.parse('2026-06-03T08:07:00.000Z')
    await insertRaw('live-quarter', [
      {
        site_id: site,
        event_id: newEvent(),
        batch_id: 'l',
        type: 'page_view',
        occurred_at: '2026-06-03 08:01:00.000',
        anonymous_id: 'l1',
        page_path: '/l',
      },
    ])
    await truncateAll()

    const result = await backfillFifteenMinuteRollups({ ...ifNeeded(), nowMs })
    expect(result.rawReadings).toHaveLength(2)
    expect(result.liveIncluded).toBe(true)
    expect(
      await scalar(
        `SELECT sum(events) FROM metrics_15m WHERE site_id = '${site}' AND bucket_start = toDateTime('2026-06-03 08:00:00', 'UTC')`,
      ),
    ).toBe(1)
    expect(await stored()).toEqual(await truth())
  })

  // ---------------------------------------------------------------------------
  // v0.8.0 — the gate compares with events_raw. The first two cases are the
  // states that made the hour-twin gate cry "history fill failed" over data
  // that was right; the last two prove the new gate still fails when the data
  // is wrong, so green above is not a gate that cannot say no.
  // ---------------------------------------------------------------------------

  /** Page views for one site, one per quarter hour, from a UTC start. */
  const pageViews = (site: string, startUtc: string, quarters: number, tag: string): RawRow[] =>
    Array.from({ length: quarters }, (_, q) => ({
      site_id: site,
      event_id: newEvent(),
      batch_id: tag,
      type: 'page_view',
      occurred_at: new Date(Date.parse(`${startUtc}Z`) + q * 900_000 + 3 * 60_000)
        .toISOString()
        .replace('T', ' ')
        .replace('Z', ''),
      anonymous_id: `${tag}${String(q % 5)}`,
      page_path: `/${tag}`,
    }))

  it('stays green when a late event lands in a pair the fill just wrote (v0.7.0 scenario d)', async () => {
    // The upgrade with a queue backlog: history is filled, and the worker then
    // drains a late event whose occurred_at is in that history. The view writes
    // it to the 15m row the fill just wrote; the raw row is written in the same
    // insert. The hour-twin gate compared against a table 0027 had frozen, so
    // this was additive_mismatch on correct data — the red half is recorded in
    // the v0.8.0 notes (the old code, this scenario, exit 3). Against raw the
    // two sides move together.
    const site = newSite()
    await insertRaw('late-drain-history', pageViews(site, '2026-05-10 09:00:00.000', 12, 'd'))
    await truncateAll()

    const result = await backfillFifteenMinuteRollups({
      ...ifNeeded(),
      afterFill: async () => {
        await insertRaw('late-drain-event', [
          {
            site_id: site,
            event_id: newEvent(),
            batch_id: 'late',
            type: 'page_view',
            occurred_at: '2026-05-10 10:20:00.000',
            anonymous_id: 'late',
            page_path: '/d',
          },
        ])
      },
    })
    for (const table of result.tables) {
      expect(table.mismatchedSites, table.table).toEqual([])
      expect(table.acceptedMismatchSites, table.table).toEqual([])
    }
    // The late event is counted, once, in the pair it belongs to.
    expect(
      await scalar(
        `SELECT sum(events) FROM metrics_15m WHERE site_id = '${site}' AND bucket_start = toDateTime('2026-05-10 10:15:00', 'UTC')`,
      ),
    ).toBe(2)
    expect(await stored()).toEqual(await truth())
  })

  it('fills complete history while a worker keeps writing, and the gate stays green', async () => {
    // Every start of the migrate container runs this beside a live worker.
    // The writer below inserts current traffic and late events for the whole
    // length of the run.
    await truncateAll()
    const site = newSite()
    await insertRaw('busy-history', pageViews(site, '2026-04-01 00:00:00.000', 96 * 3, 'b'))

    let writing = true
    let batches = 0
    const writer = (async () => {
      while (writing) {
        batches += 1
        await insertRaw(`busy-${String(batches)}`, [
          ...pageViews(site, '2026-04-02 06:00:00.000', 2, `late${String(batches)}`),
          ...pageViews(site, '2026-06-20 12:00:00.000', 1, `now${String(batches)}`),
        ])
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    })()
    let result
    try {
      result = await backfillFifteenMinuteRollups(ifNeeded())
    } finally {
      writing = false
      await writer
    }
    expect(batches).toBeGreaterThan(1)
    for (const table of result.tables) {
      expect(table.mismatchedSites, table.table).toEqual([])
    }
    expect(result.witness).toMatchObject({ gapEvents: 0, overEvents: 0 })
    // History is whole: every raw row of the site is in exactly one 15m pair.
    expect(await scalar(`SELECT sum(events) FROM metrics_15m WHERE site_id = '${site}'`)).toBe(
      await scalar(`SELECT count() FROM events_raw WHERE site_id = '${site}'`),
    )
    expect(await stored()).toEqual(await truth())
  })

  it('fails a double count that lands between the fill and the proof', async () => {
    const metricsSpec = FIFTEEN_MINUTE_ROLLUPS[0]!
    const FIFTEEN = "toStartOfFifteenMinutes(toDateTime(occurred_at, 'UTC'))"
    const site = newSite()
    await insertRaw('double-history', pageViews(site, '2026-05-20 09:00:00.000', 4, 'x'))
    await truncateAll()

    const run = backfillFifteenMinuteRollups({
      ...ifNeeded(),
      afterFill: async () => {
        // The failure the gate exists for: a pair's events inserted a second
        // time, straight into the rollup (what a fill without its gap predicate
        // would do).
        await client.command({
          query: `INSERT INTO metrics_15m SELECT ${metricsSpec.select.replace('{bucket}', FIFTEEN)} FROM events_raw WHERE site_id = '${site}' GROUP BY ${metricsSpec.groupBy}`,
        })
      },
    })
    await expect(run).rejects.toMatchObject({
      name: 'BackfillRefusedError',
      reason: 'additive_mismatch',
    })
    // Named by family and site, so the operator knows what to look at.
    await expect(run).rejects.toThrow(`metrics_15m (${site})`)
  })

  it('fails a filled pair that went missing before the proof', async () => {
    const site = newSite()
    await insertRaw('gap-history', pageViews(site, '2026-05-21 09:00:00.000', 4, 'g'))
    await truncateAll()

    await expect(
      backfillFifteenMinuteRollups({
        ...ifNeeded(),
        afterFill: async () => {
          await client.command({
            query: `ALTER TABLE pages_15m DELETE WHERE site_id = '${site}' AND bucket_start = toDateTime('2026-05-21 09:15:00', 'UTC') SETTINGS mutations_sync = 2`,
          })
        },
      }),
    ).rejects.toMatchObject({ name: 'BackfillRefusedError', reason: 'additive_mismatch' })
  })
})
