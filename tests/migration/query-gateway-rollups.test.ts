import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@clickhouse/client'
import { migrateClickHouse } from '@openanalytics/clickhouse'
import { createCapturedLogger } from '@openanalytics/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHttpClickHouseReader } from '../../apps/query-gateway/src/clickhouse-http.ts'
import { operationParamsFor } from '../../apps/api/src/analytics/resolve.ts'
import { findOperation } from '../../apps/query-gateway/src/operations.ts'
import type { QueryParameterValue } from '../../apps/query-gateway/src/clickhouse.ts'

/**
 * The Milestone 7 query gateway registry, proven end to end (plan items 1, 4, 7).
 *
 * Every assertion runs a real request path: `operation.bindParams(input)` →
 * `{name:Type}` placeholders + a bound parameter map → the HTTP read-only
 * reader → typed rows out of an actual migrated ClickHouse. What it proves that
 * the in-process contract suite cannot:
 *
 *   1. **Cross-site isolation** — site A's operation never returns site B's rows,
 *      because `site_id` is bound on every analytics operation.
 *   2. **Range bounds** — the half-open `[from, to)` filter includes and excludes
 *      the right buckets.
 *   3. **Timezone day composition agrees with the UTC day rollup** — for a UTC
 *      request, `timeseries_day` (composed from `metrics_15m` via
 *      `toStartOfDay(bucket, tz)`) returns the same buckets and numbers as
 *      `timeseries_day_utc` (read straight from `metrics_1d`). This is the golden
 *      check behind the non-UTC composition path.
 *   4. **uniqMerge / t-digest reads** answer distinct visitors and merged
 *      percentiles from the stored aggregate states.
 *   5. **The freshness watermark** returns the latest rolled-up bucket.
 *   6. **A timezone-local bucket is labelled by its instant, in UTC.** Every
 *      stored bucket column is DateTime/DateTime64 in UTC and the API serializes
 *      a bucket by appending "Z", so a re-bucketing expression that renders in
 *      the request's zone hands the API a local wall clock it then stamps as UTC.
 *      The cases below pin the exact returned strings for a +03:00 and a -03:00
 *      zone at minute, hour and local-day grain.
 *   7. **ISO weeks are Monday-started, timezone-local, and merged not summed.**
 *      The week grain has no rollup — it is grouped at read time — so both the
 *      Monday-start mode and the `uniqMerge` over a whole week (a visitor seen
 *      on two days of it counts once) are proven against real data.
 *
 * Cache hit/expiry is proven separately with a fake clock in
 * `tests/unit/query-gateway-cache.test.ts` — it needs no infrastructure.
 *
 * Skipped without TEST_CLICKHOUSE_URL; CI always provides one.
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

describeIfClickHouse('query gateway registry over the rollups', () => {
  const url = URL_ as string
  const database = `m7gw_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let client: ReturnType<typeof createClient>

  const reader = createHttpClickHouseReader({
    url,
    database,
    username: USERNAME,
    password: PASSWORD,
  })

  /**
   * Runs an operation exactly as the route does: bind, then read.
   *
   * "Exactly as the route does" now includes the parameters M11 CP3 made
   * **required** on most of this registry (ADR-0032, D2b/D4) — the cutover, the
   * published run id, and the request timezone the cutover boundary is rendered
   * in. They are filled in here from `operationParamsFor`, the same function the
   * api calls, with a **null pointer**: this suite's sites have published no
   * import, so it binds the nil run and the epoch cutover, which is what makes
   * every assertion below unchanged. The nil run matches no staged row, so every
   * imported branch is empty; the epoch cutover precedes every bucket, so no live
   * row is filtered out.
   *
   * Filled in rather than restated at ~20 call sites, and *under* the caller's
   * own input so an explicit timezone still wins. Deriving them from the api's
   * own helper is the point: a future operation that gains a bound parameter is
   * covered here the moment production is, instead of failing a CI round-trip.
   */
  const run = async (
    operationId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> => {
    const operation = findOperation(operationId)
    if (!operation) throw new Error(`no such operation ${operationId}`)
    const defaults = operationParamsFor(
      operationId,
      null,
      (input['timezone'] as string | undefined) ?? 'UTC',
    )
    const parameters = operation.bindParams({ ...defaults, ...input }) as Record<
      string,
      QueryParameterValue
    >
    const controller = new AbortController()
    const result = await reader.query({
      sql: operation.sql,
      parameters,
      signal: controller.signal,
      queryId: randomUUID(),
      settings: {
        max_execution_time: 20,
        max_result_rows: 200_000,
        result_overflow_mode: 'throw',
      },
    })
    return [...result.rows]
  }

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

  const siteA = randomUUID()
  const siteB = randomUUID()
  const siteTz = randomUUID()
  const siteWeek = randomUUID()
  /** ADR-0080: the multi-site card read, whose whole risk is merge-vs-sum. */
  const siteCards = randomUUID()

  /** +03:00 all year — no DST since 2016, so every case below is offset-stable. */
  const ISTANBUL = 'Europe/Istanbul'
  /** -03:00 all year — southern hemisphere, no DST since 2019. */
  const SAO_PAULO = 'America/Sao_Paulo'
  /** +05:30 all year: local midnight is 18:30Z, in the middle of a UTC hour. */
  const KOLKATA = 'Asia/Kolkata'
  /** +05:45 all year: local midnight is 18:15Z, in the middle of a UTC hour. */
  const KATHMANDU = 'Asia/Kathmandu'

  /**
   * Reads a returned bucket label as the UTC instant it claims to be, exactly as
   * `bucketToIso` in the API does: the string carries no zone, so the API appends
   * "Z" to it.
   */
  const bucketMs = (row: Record<string, unknown>): number =>
    Date.parse(`${String(row['bucket']).replace(' ', 'T')}Z`)

  /** A read straight off `events_raw` — the truth a rollup answer is checked against. */
  const queryRows = async <T>(query: string): Promise<T[]> => {
    const resultSet = await client.query({ query, format: 'JSONEachRow' })
    return await resultSet.json<T>()
  }

  /** Both sides render a bucket as a UTC wall clock; only the precision differs. */
  const clock = (value: unknown): string => String(value).replace('.000', '')

  /**
   * Every bucket a half-open range read returns must fall inside that range. A
   * label rendered in a positive-offset zone runs past `to` — this is the
   * "yesterday's chart is empty and today's has hours that have not happened"
   * symptom, stated as an invariant.
   */
  const expectBucketsInsideRange = (
    rows: readonly Record<string, unknown>[],
    from: string,
    to: string,
  ): void => {
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(bucketMs(row)).toBeGreaterThanOrEqual(Date.parse(from))
      expect(bucketMs(row)).toBeLessThan(Date.parse(to))
    }
  }

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

    // Site A: page views across two July days, two visitors, two paths; one
    // custom event; one web vital. Site B: a single page view that must never
    // leak into a site A answer.
    await insertRaw('a1', [
      {
        site_id: siteA,
        event_id: randomUUID(),
        batch_id: 'a',
        type: 'page_view',
        occurred_at: '2026-07-01 09:00:00.000',
        anonymous_id: 'v1',
        page_path: '/home',
        country: 'US',
        city: 'NYC',
        device_type: 'desktop',
        browser: 'chrome',
        os: 'macos',
        referrer_domain: 'google.com',
        utm_source: 'google',
        utm_medium: 'cpc',
        utm_campaign: 'spring',
      },
      {
        site_id: siteA,
        event_id: randomUUID(),
        batch_id: 'a',
        type: 'page_view',
        occurred_at: '2026-07-01 15:00:00.000',
        anonymous_id: 'v1',
        page_path: '/home',
        country: 'US',
        city: 'NYC',
        device_type: 'desktop',
        browser: 'chrome',
        os: 'macos',
      },
      {
        site_id: siteA,
        event_id: randomUUID(),
        batch_id: 'a',
        type: 'page_view',
        occurred_at: '2026-07-01 20:00:00.000',
        anonymous_id: 'v2',
        page_path: '/pricing',
        country: 'GB',
        city: 'London',
        device_type: 'mobile',
        browser: 'safari',
        os: 'ios',
      },
      {
        site_id: siteA,
        event_id: randomUUID(),
        batch_id: 'a',
        type: 'page_view',
        occurred_at: '2026-07-02 10:00:00.000',
        anonymous_id: 'v2',
        page_path: '/home',
        country: 'GB',
        city: 'London',
        device_type: 'mobile',
        browser: 'safari',
        os: 'ios',
      },
      {
        site_id: siteA,
        event_id: randomUUID(),
        batch_id: 'a',
        type: 'custom_event',
        name: 'signup',
        occurred_at: '2026-07-01 16:00:00.000',
        anonymous_id: 'v1',
      },
      {
        site_id: siteA,
        event_id: randomUUID(),
        batch_id: 'a',
        type: 'web_vital',
        billable: 0,
        anonymous_id: 'v1',
        device_type: 'desktop',
        occurred_at: '2026-07-01 09:05:00.000',
        properties: JSON.stringify({ oa_metric: 'LCP', oa_value: 1200, oa_rating: 'good' }),
      },
      {
        site_id: siteA,
        event_id: randomUUID(),
        batch_id: 'a',
        type: 'web_vital',
        billable: 0,
        anonymous_id: 'v1',
        device_type: 'desktop',
        occurred_at: '2026-07-01 09:06:00.000',
        properties: JSON.stringify({ oa_metric: 'LCP', oa_value: 3000, oa_rating: 'poor' }),
      },
    ])
    await insertRaw('b1', [
      {
        site_id: siteB,
        event_id: randomUUID(),
        batch_id: 'b',
        type: 'page_view',
        occurred_at: '2026-07-01 09:00:00.000',
        anonymous_id: 'other',
        page_path: '/home',
      },
    ])
    // A site of its own for the timezone-label cases, so the July 1-2 fixtures
    // above keep their exact numbers. Three page views on 2026-07-12, at UTC
    // instants chosen so a +03:00 and a -03:00 zone each put them in a different
    // local hour — and a different local day — than UTC does.
    await insertRaw('tz1', [
      {
        site_id: siteTz,
        event_id: randomUUID(),
        batch_id: 'tz',
        type: 'page_view',
        occurred_at: '2026-07-12 10:30:00.000',
        anonymous_id: 'tzv1',
        page_path: '/home',
      },
      {
        site_id: siteTz,
        event_id: randomUUID(),
        batch_id: 'tz',
        type: 'page_view',
        occurred_at: '2026-07-12 10:45:00.000',
        anonymous_id: 'tzv1',
        page_path: '/home',
      },
      {
        site_id: siteTz,
        event_id: randomUUID(),
        batch_id: 'tz',
        type: 'page_view',
        occurred_at: '2026-07-12 18:15:00.000',
        anonymous_id: 'tzv2',
        page_path: '/pricing',
      },
    ])
    // A site of its own for the ISO-week cases, spanning two weeks so a week
    // boundary is actually crossed, and with one visitor deliberately active on
    // two *different days of the same week*. That last event is the whole point:
    // summing the day rollup's per-day visitor counts would count `wv1` twice,
    // and only a `uniqMerge` across the week gets it right.
    //
    // 2026-06-29 and 2026-07-06 are Mondays; 2026-06-30 is a Tuesday,
    // 2026-07-02 a Thursday, 2026-07-07 a Tuesday.
    await insertRaw('wk1', [
      {
        site_id: siteWeek,
        event_id: randomUUID(),
        batch_id: 'wk',
        type: 'page_view',
        occurred_at: '2026-06-30 09:00:00.000',
        anonymous_id: 'wv1',
        page_path: '/home',
      },
      {
        site_id: siteWeek,
        event_id: randomUUID(),
        batch_id: 'wk',
        type: 'page_view',
        occurred_at: '2026-07-02 09:00:00.000',
        anonymous_id: 'wv1',
        page_path: '/home',
      },
      {
        site_id: siteWeek,
        event_id: randomUUID(),
        batch_id: 'wk',
        type: 'page_view',
        occurred_at: '2026-07-02 10:00:00.000',
        anonymous_id: 'wv2',
        page_path: '/pricing',
      },
      {
        site_id: siteWeek,
        event_id: randomUUID(),
        batch_id: 'wk',
        type: 'page_view',
        occurred_at: '2026-07-07 09:00:00.000',
        anonymous_id: 'wv3',
        page_path: '/home',
      },
    ])

    // ADR-0080's site-card read. Four events, each placed to break a different
    // plausible-but-wrong implementation:
    //
    //   `cv0` in January — outside every window the card ever plots. It must
    //     appear in the all-time total, which is what "no lower bound" means,
    //     and in none of the weeks.
    //   `cv1` and `cv3` each on two different ISO weeks. The total must count
    //     each of them ONCE and each week must count them once, so the weekly
    //     visitor numbers add up to MORE than the total. Summing the sparkline
    //     to check the total is the check that must fail — and there are two
    //     such people rather than one because `cv0`, sitting outside the window,
    //     adds one to the total and would otherwise mask a single overlap
    //     exactly (the first version of this fixture did, and said 3 === 3).
    //   `cv2` in the second week only.
    //   a `custom` event with its own anonymous id — never a visitor, because
    //     the merge is filtered to the page-view population (ADR-0036).
    await insertRaw('cards1', [
      {
        site_id: siteCards,
        event_id: randomUUID(),
        batch_id: 'cards',
        type: 'page_view',
        occurred_at: '2026-01-05 09:00:00.000',
        anonymous_id: 'cv0',
        page_path: '/old',
      },
      {
        site_id: siteCards,
        event_id: randomUUID(),
        batch_id: 'cards',
        type: 'page_view',
        occurred_at: '2026-06-30 09:00:00.000',
        anonymous_id: 'cv1',
        page_path: '/home',
      },
      {
        site_id: siteCards,
        event_id: randomUUID(),
        batch_id: 'cards',
        type: 'page_view',
        occurred_at: '2026-07-07 09:00:00.000',
        anonymous_id: 'cv1',
        page_path: '/home',
      },
      {
        site_id: siteCards,
        event_id: randomUUID(),
        batch_id: 'cards',
        type: 'page_view',
        occurred_at: '2026-07-08 09:00:00.000',
        anonymous_id: 'cv2',
        page_path: '/pricing',
      },
      {
        site_id: siteCards,
        event_id: randomUUID(),
        batch_id: 'cards',
        type: 'page_view',
        occurred_at: '2026-06-30 11:00:00.000',
        anonymous_id: 'cv3',
        page_path: '/home',
      },
      {
        site_id: siteCards,
        event_id: randomUUID(),
        batch_id: 'cards',
        type: 'page_view',
        occurred_at: '2026-07-08 11:00:00.000',
        anonymous_id: 'cv3',
        page_path: '/home',
      },
      {
        site_id: siteCards,
        event_id: randomUUID(),
        batch_id: 'cards',
        type: 'custom',
        name: 'signup',
        occurred_at: '2026-07-08 10:00:00.000',
        anonymous_id: 'cv-custom-only',
        page_path: '/pricing',
      },
    ])
  }, 120_000)

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` })
      await client.close()
    }
  })

  const JULY = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-03T00:00:00.000Z' }

  it('overview totals a single site and never leaks another', async () => {
    const [rowA] = await run('analytics.overview_hour', { site_id: siteA, ...JULY })
    expect(Number(rowA?.['events'])).toBe(7) // 4 page_view + 1 custom + 2 web_vital
    expect(Number(rowA?.['pageviews'])).toBe(4)
    expect(Number(rowA?.['billable_events'])).toBe(5) // web vitals are non-billable
    expect(Number(rowA?.['visitors'])).toBe(2)

    const [rowB] = await run('analytics.overview_hour', { site_id: siteB, ...JULY })
    // Site B has exactly its own one page view — proof the site_id bind isolates.
    expect(Number(rowB?.['pageviews'])).toBe(1)
    expect(Number(rowB?.['visitors'])).toBe(1)
  })

  it('applies the half-open range bound', async () => {
    // A window that ends before July 2 excludes the July 2 page view.
    const [row] = await run('analytics.overview_hour', {
      site_id: siteA,
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-02T00:00:00.000Z',
    })
    expect(Number(row?.['pageviews'])).toBe(3)
  })

  it('composes a UTC day series that matches the day rollup exactly', async () => {
    const composed = await run('analytics.timeseries_day', {
      site_id: siteA,
      ...JULY,
      timezone: 'UTC',
    })
    const direct = await run('analytics.timeseries_day_utc', { site_id: siteA, ...JULY })

    // Compared as instants, not as strings: the composed read re-buckets by
    // timezone and so comes back as DateTime64(3, 'UTC'), while the day rollup's
    // own column is DateTime('UTC'). Same instant, two renderings — and it is the
    // instant that has to agree.
    const normalise = (rows: Record<string, unknown>[]) =>
      rows.map((row) => [
        bucketMs(row),
        Number(row['events']),
        Number(row['pageviews']),
        Number(row['visitors']),
      ])

    // Two July days; the composed-from-hours answer equals the day-rollup answer.
    expect(normalise(composed)).toEqual(normalise(direct))
    expect(normalise(composed)).toEqual([
      [Date.parse('2026-07-01T00:00:00.000Z'), 6, 3, 2],
      [Date.parse('2026-07-02T00:00:00.000Z'), 1, 1, 1],
    ])
    expect(composed.map((row) => String(row['bucket']))).toEqual([
      '2026-07-01 00:00:00.000',
      '2026-07-02 00:00:00.000',
    ])
    expect(direct.map((row) => String(row['bucket']))).toEqual([
      '2026-07-01 00:00:00',
      '2026-07-02 00:00:00',
    ])
  })

  it('ranks top pages with merged unique visitors', async () => {
    const rows = await run('analytics.pages_hour', { site_id: siteA, ...JULY, limit: 10 })
    expect(
      rows.map((row) => [String(row['page_path']), Number(row['views']), Number(row['visitors'])]),
    ).toEqual([
      ['/home', 3, 2],
      ['/pricing', 1, 1],
    ])
  })

  it('answers merged web-vital percentiles and the rating split', async () => {
    const [row] = await run('analytics.performance_hour', { site_id: siteA, ...JULY, limit: 10 })
    expect(Number(row?.['samples'])).toBe(2)
    expect(Number(row?.['good_samples'])).toBe(1)
    expect(Number(row?.['poor_samples'])).toBe(1)
    const percentiles = row?.['percentiles'] as unknown[]
    expect(Array.isArray(percentiles)).toBe(true)
    expect(percentiles).toHaveLength(5)
    // Median of {1200, 3000} lies in range; a percentile of the union.
    expect(Number(percentiles[0])).toBeGreaterThanOrEqual(1200)
    expect(Number(percentiles[0])).toBeLessThanOrEqual(3000)
  })

  // -------------------------------------------------------------------------
  // Timezone-local bucket labels.
  //
  // `bucket_start` is DateTime('UTC') in every rollup, so re-bucketing it with
  // `toStartOf*(bucket_start, tz)` returns the right *instant* — the start of the
  // local hour/day — but ClickHouse renders a DateTime in the timezone attached to
  // its type, which the re-bucketing sets to `tz`. The gateway therefore hands the
  // API a local wall clock with no zone on it, and the API's `bucketToIso` appends
  // "Z". For Istanbul (+03:00) that stamps every bucket three hours ahead of the
  // instant it names; for São Paulo (-03:00), three hours behind.
  //
  // These assert the label the API needs: the bucket instant rendered in UTC.
  // -------------------------------------------------------------------------

  it('labels a timezone-local hour bucket with the bucket instant in UTC', async () => {
    const from = '2026-07-12T10:00:00.000Z'
    const to = '2026-07-12T19:00:00.000Z'
    const rows = await run('analytics.timeseries_hour', {
      site_id: siteTz,
      from,
      to,
      timezone: ISTANBUL,
    })

    // Istanbul's local hours are UTC hours here (+03:00 is a whole-hour offset),
    // so the two buckets are the 10:00Z and 18:00Z hours — named by their instant.
    // Rendered in Istanbul they would read 13:00:00 and 21:00:00.
    expect(rows.map((row) => String(row['bucket']))).toEqual([
      '2026-07-12 10:00:00.000',
      '2026-07-12 18:00:00.000',
    ])
    expect(rows.map((row) => Number(row['pageviews']))).toEqual([2, 1])
    expect(rows.map((row) => Number(row['visitors']))).toEqual([1, 1])
    expectBucketsInsideRange(rows, from, to)
  })

  it('labels a timezone-local minute bucket with the bucket instant in UTC', async () => {
    const from = '2026-07-12T10:30:00.000Z'
    const to = '2026-07-12T11:00:00.000Z'
    const rows = await run('analytics.timeseries_minute', {
      site_id: siteTz,
      from,
      to,
      timezone: ISTANBUL,
    })

    expect(rows.map((row) => String(row['bucket']))).toEqual([
      '2026-07-12 10:30:00.000',
      '2026-07-12 10:45:00.000',
    ])
    expect(rows.map((row) => Number(row['events']))).toEqual([1, 1])
    expectBucketsInsideRange(rows, from, to)
  })

  it('labels an Istanbul local day by its 21:00Z start instant, not local midnight', async () => {
    // The Istanbul day 2026-07-12 begins at 2026-07-11T21:00:00Z. That instant is
    // the bucket; local midnight is only how Istanbul renders it.
    const from = '2026-07-11T21:00:00.000Z'
    const to = '2026-07-12T21:00:00.000Z'
    const rows = await run('analytics.timeseries_day', {
      site_id: siteTz,
      from,
      to,
      timezone: ISTANBUL,
    })

    expect(rows.map((row) => String(row['bucket']))).toEqual(['2026-07-11 21:00:00.000'])
    expect(Number(rows[0]?.['pageviews'])).toBe(3)
    expect(Number(rows[0]?.['visitors'])).toBe(2)
    expectBucketsInsideRange(rows, from, to)
  })

  it('labels a São Paulo local day by its 03:00Z start instant', async () => {
    // The mirror image, and the reason the label cannot simply be shifted back by
    // a constant: a negative offset puts the local day start *after* UTC midnight.
    const from = '2026-07-12T03:00:00.000Z'
    const to = '2026-07-13T03:00:00.000Z'
    const rows = await run('analytics.timeseries_day', {
      site_id: siteTz,
      from,
      to,
      timezone: SAO_PAULO,
    })

    expect(rows.map((row) => String(row['bucket']))).toEqual(['2026-07-12 03:00:00.000'])
    expect(Number(rows[0]?.['pageviews'])).toBe(3)
    expectBucketsInsideRange(rows, from, to)
  })

  it('still labels the UTC day rollup at UTC midnight (regression guard)', async () => {
    // The non-timezone bucket expressions read a UTC column straight through and
    // must keep their current wire format exactly — no timezone re-bucketing is
    // involved, so nothing about them may change.
    const from = '2026-07-12T00:00:00.000Z'
    const to = '2026-07-13T00:00:00.000Z'
    const rows = await run('analytics.timeseries_day_utc', { site_id: siteTz, from, to })

    expect(
      rows.map((row) => [
        String(row['bucket']),
        Number(row['events']),
        Number(row['pageviews']),
        Number(row['visitors']),
      ]),
    ).toEqual([['2026-07-12 00:00:00', 3, 3, 2]])
    expectBucketsInsideRange(rows, from, to)
  })

  // -------------------------------------------------------------------------
  // ISO weeks (CP3).
  //
  // A week is the one grain with no rollup behind it, and deliberately so: it
  // starts on the *request timezone's* Monday, which a stored UTC-week bucket
  // could only ever be right about for UTC. Both week operations therefore group
  // at read time — the UTC one over metrics_1d, the local one over metrics_15m —
  // and the two things worth proving against a real ClickHouse are that the
  // Monday is the ISO Monday (mode 1, not the default Sunday) and that weekly
  // unique visitors come from merging the stored states rather than adding up
  // days.
  // -------------------------------------------------------------------------

  /** Mon 2026-06-29 → Mon 2026-07-13, i.e. exactly two ISO weeks. */
  const TWO_WEEKS = { from: '2026-06-29T00:00:00.000Z', to: '2026-07-13T00:00:00.000Z' }

  it('buckets UTC weeks on the ISO Monday and merges a visitor seen on two of its days', async () => {
    const rows = await run('analytics.timeseries_week_utc', { site_id: siteWeek, ...TWO_WEEKS })

    expect(
      rows.map((row) => [
        String(row['bucket']),
        Number(row['events']),
        Number(row['pageviews']),
        Number(row['visitors']),
      ]),
    ).toEqual([
      // Week one holds three page views from two visitors — wv1 on Tuesday *and*
      // Thursday, wv2 on Thursday. Three events, two visitors: if the week were
      // summed from its days it would report three.
      ['2026-06-29 00:00:00.000', 3, 3, 2],
      ['2026-07-06 00:00:00.000', 1, 1, 1],
    ])
    // Monday, not Sunday: mode 0 would label these 2026-06-28 and 2026-07-05.
    for (const row of rows) {
      expect(new Date(bucketMs(row)).getUTCDay(), String(row['bucket'])).toBe(1)
    }
    expectBucketsInsideRange(rows, TWO_WEEKS.from, TWO_WEEKS.to)
  })

  it('agrees with the day rollup on additive measures and beats it on visitors', async () => {
    // The cross-check that says the week grouping is a regrouping of the same
    // data and nothing else: every additive measure is exactly the sum of the
    // days it covers, while visitors are strictly fewer than the daily sum
    // wherever a visitor came back on another day of the same week.
    const weeks = await run('analytics.timeseries_week_utc', { site_id: siteWeek, ...TWO_WEEKS })
    const days = await run('analytics.timeseries_day_utc', { site_id: siteWeek, ...TWO_WEEKS })

    const weekStartMs = (ms: number): number => {
      const date = new Date(ms)
      // getUTCDay: Sunday 0 … Saturday 6, so Monday-relative index is (d + 6) % 7.
      const offsetDays = (date.getUTCDay() + 6) % 7
      return ms - offsetDays * 86_400_000
    }

    const summed = new Map<number, { events: number; pageviews: number; visitors: number }>()
    for (const day of days) {
      const key = weekStartMs(bucketMs(day))
      const acc = summed.get(key) ?? { events: 0, pageviews: 0, visitors: 0 }
      acc.events += Number(day['events'])
      acc.pageviews += Number(day['pageviews'])
      acc.visitors += Number(day['visitors'])
      summed.set(key, acc)
    }

    expect(weeks).toHaveLength(summed.size)
    for (const week of weeks) {
      const expected = summed.get(bucketMs(week))
      expect(expected, String(week['bucket'])).toBeDefined()
      expect(Number(week['events'])).toBe(expected?.events)
      expect(Number(week['pageviews'])).toBe(expected?.pageviews)
      expect(Number(week['visitors'])).toBeLessThanOrEqual(expected?.visitors as number)
    }
    // And the inequality is strict somewhere, or the fixture is not exercising
    // the thing this test exists for.
    expect(
      weeks.some(
        (week) => Number(week['visitors']) < (summed.get(bucketMs(week))?.visitors as number),
      ),
    ).toBe(true)
  })

  it('labels an Istanbul week by its 21:00Z Monday-eve start instant', async () => {
    // The siteTz fixture is three page views on Sunday 2026-07-12 (UTC). The
    // Istanbul ISO week containing that Sunday begins Monday 2026-07-06 00:00
    // local, which *is* the instant 2026-07-05T21:00:00Z — and, per CP1, the
    // label is that instant rendered as UTC wall clock, never local midnight.
    const from = '2026-07-05T21:00:00.000Z'
    const to = '2026-07-12T21:00:00.000Z'
    const rows = await run('analytics.timeseries_week', {
      site_id: siteTz,
      from,
      to,
      timezone: ISTANBUL,
    })

    expect(rows.map((row) => String(row['bucket']))).toEqual(['2026-07-05 21:00:00.000'])
    expect(Number(rows[0]?.['events'])).toBe(3)
    expect(Number(rows[0]?.['pageviews'])).toBe(3)
    expect(Number(rows[0]?.['visitors'])).toBe(2)
    expectBucketsInsideRange(rows, from, to)
  })

  it('labels a São Paulo week by its 03:00Z Monday start instant', async () => {
    // The mirror image: a negative offset puts the local week start *after* UTC
    // midnight, so the label cannot be a constant shift of the UTC week's.
    const from = '2026-07-06T03:00:00.000Z'
    const to = '2026-07-13T03:00:00.000Z'
    const rows = await run('analytics.timeseries_week', {
      site_id: siteTz,
      from,
      to,
      timezone: SAO_PAULO,
    })

    expect(rows.map((row) => String(row['bucket']))).toEqual(['2026-07-06 03:00:00.000'])
    expect(Number(rows[0]?.['pageviews'])).toBe(3)
    expectBucketsInsideRange(rows, from, to)
  })

  it('lets a week bucket start before `from`, exactly as a composed local day does', async () => {
    // The filter is on *source* buckets and the group key is the period start,
    // so a range beginning mid-period yields a bucket labelled before `from`
    // carrying only the in-range hours. That is not new behaviour invented for
    // weeks — the local-day chart has always done it — so both are asserted
    // together, and neither is clamped to its period boundary.
    const from = '2026-07-12T00:00:00.000Z'
    const to = '2026-07-13T00:00:00.000Z'

    const weeks = await run('analytics.timeseries_week', {
      site_id: siteTz,
      from,
      to,
      timezone: ISTANBUL,
    })
    // Istanbul's week containing 2026-07-12 started six days before `from`.
    expect(weeks.map((row) => String(row['bucket']))).toEqual(['2026-07-05 21:00:00.000'])
    expect(bucketMs(weeks[0] as Record<string, unknown>)).toBeLessThan(Date.parse(from))
    // Only the in-range hours are counted: the 10:30/10:45 and 18:15 page views.
    expect(Number(weeks[0]?.['pageviews'])).toBe(3)

    const days = await run('analytics.timeseries_day', {
      site_id: siteTz,
      from,
      to,
      timezone: ISTANBUL,
    })
    // Same shape one grain down: the Istanbul day containing these hours started
    // at 2026-07-11T21:00Z, three hours before `from`.
    expect(days.map((row) => String(row['bucket']))).toEqual(['2026-07-11 21:00:00.000'])
    expect(bucketMs(days[0] as Record<string, unknown>)).toBeLessThan(Date.parse(from))
  })

  // -------------------------------------------------------------------------
  // Quarter-hour offsets (ADR-0079, step 3).
  //
  // These zones' local midnight — 18:30Z for +05:30, 18:15Z for +05:45 — falls
  // in the middle of a UTC hour, which is why every operation below refused
  // them from M7 until the atom moved to fifteen minutes. What is asserted is
  // not that the SQL runs: it is that its answer equals what `events_raw` says
  // when grouped by the same local day. The seed puts a page view a minute
  // either side of local midnight on every day, so an answer composed from hour
  // buckets would put both on the same local day and this suite would say so.
  // -------------------------------------------------------------------------

  const QUARTER_RANGE = { from: '2026-08-09T18:30:00.000Z', to: '2026-08-12T18:30:00.000Z' }

  it.each([
    // `days` is how many local days the fixed range covers in this zone, and the
    // two differ on purpose: the range's edges are quarter-hour instants, and
    // +05:30 and +05:45 cut them into a different number of local days. Pinning
    // it per zone keeps the seed itself under assertion rather than trusting
    // whatever the query happens to return.
    { tz: KOLKATA, before: '18:29:00.000', after: '18:31:00.000', days: 3 },
    { tz: KATHMANDU, before: '18:14:00.000', after: '18:16:00.000', days: 4 },
  ])(
    'composes a correct $tz local day from the atom rollup',
    async ({ tz, before, after, days }) => {
      const site = randomUUID()
      const rows: RawRow[] = []
      for (const day of ['2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12']) {
        for (const [index, at] of [before, after].entries()) {
          rows.push({
            site_id: site,
            event_id: randomUUID(),
            batch_id: tz,
            type: 'page_view',
            occurred_at: `${day} ${at}`,
            // Distinct either side of midnight, shared across days: a local day
            // that swallowed its neighbour's edge row would show two visitors.
            anonymous_id: `side${String(index)}`,
            page_path: '/edge',
          })
        }
        rows.push({
          site_id: site,
          event_id: randomUUID(),
          batch_id: tz,
          type: 'page_view',
          occurred_at: `${day} 06:30:00.000`,
          anonymous_id: 'noon',
          page_path: '/noon',
        })
      }
      await insertRaw(`quarter-${tz}`, rows)

      // The truth, from the raw events: each one placed on its own local day, and
      // that day named by its start instant rendered in UTC — the same label the
      // gateway's `bucketUtc` produces.
      const truth = await queryRows<{ bucket: string; pageviews: string; visitors: string }>(
        `SELECT toString(toDateTime(toStartOfDay(toDateTime(occurred_at, 'UTC'), '${tz}'), 'UTC')) AS bucket,
              count() AS pageviews,
              uniqExact(anonymous_id) AS visitors
         FROM events_raw
        WHERE site_id = '${site}'
          AND type = 'page_view'
          AND occurred_at >= toDateTime64('2026-08-09 18:30:00.000', 3, 'UTC')
          AND occurred_at <  toDateTime64('2026-08-12 18:30:00.000', 3, 'UTC')
        GROUP BY bucket
        ORDER BY bucket`,
      )
      // The edge rows of each day sit on opposite sides of a local midnight —
      // the shape that makes the comparison below worth making at all.
      expect(truth).toHaveLength(days)

      const series = await run('analytics.timeseries_day', {
        site_id: site,
        ...QUARTER_RANGE,
        timezone: tz,
      })
      expect(
        series.map((row) => [
          clock(row['bucket']),
          Number(row['pageviews']),
          Number(row['visitors']),
        ]),
      ).toEqual(
        truth.map((row) => [clock(row.bucket), Number(row.pageviews), Number(row.visitors)]),
      )

      const expectedPageviews = truth.reduce((sum, row) => sum + Number(row.pageviews), 0)

      // The range totals sum the same population the chart plots.
      const [totals] = await run('analytics.overview_hour', {
        site_id: site,
        ...QUARTER_RANGE,
        timezone: tz,
      })
      expect(Number(totals?.['pageviews'])).toBe(expectedPageviews)

      // And the breakdown, which reads its own `*_15m` table rather than metrics.
      const pages = await run('analytics.pages_hour', {
        site_id: site,
        ...QUARTER_RANGE,
        limit: 10,
        timezone: tz,
      })
      expect(pages.reduce((sum, row) => sum + Number(row['views']), 0)).toBe(expectedPageviews)
    },
  )

  /**
   * The multi-site card read (ADR-0080), against a real ClickHouse.
   *
   * This is the one assertion in the suite that cannot be made anywhere else: a
   * `uniqMerge` over stored states is not arithmetic the api can check, and the
   * failure it guards against — a total computed by summing the weeks — produces
   * a *larger and entirely plausible* number rather than an error.
   */
  const CARD_WINDOW = { from: '2026-06-29T00:00:00.000Z', to: '2026-07-13T00:00:00.000Z' }

  const cardRows = async (siteIds: string[]) =>
    await run('analytics.sites_all_time', { site_ids: siteIds, ...CARD_WINDOW })

  it('answers a total that is a merge of visitors, not a sum of the weeks', async () => {
    const rows = await cardRows([siteCards])

    const total = rows.find((row) => Number(row['is_total']) === 1)
    const weeks = rows
      .filter((row) => Number(row['is_total']) === 0)
      .sort((a, b) => String(a['week']).localeCompare(String(b['week'])))

    // Six page views all time, four people. January's is included — the total
    // branch carries no lower bound, which is what "all time" has to mean.
    expect(Number(total?.['pageviews'])).toBe(6)
    expect(Number(total?.['visitors'])).toBe(4)

    // The window holds two ISO weeks, Monday-started.
    expect(weeks.map((row) => clock(row['week']))).toEqual([
      '2026-06-29 00:00:00',
      '2026-07-06 00:00:00',
    ])
    expect(weeks.map((row) => Number(row['pageviews']))).toEqual([2, 3])
    expect(weeks.map((row) => Number(row['visitors']))).toEqual([2, 3])

    // The point of the fixture: `cv1` and `cv3` each visited in both weeks, so
    // the weekly visitor numbers add up to MORE than the all-time figure. A
    // total computed by summing the sparkline would say 5 here and be wrong by
    // two people — and wrong in the flattering direction, which is why that
    // mistake survives review.
    const summed = weeks.reduce((sum, row) => sum + Number(row['visitors']), 0)
    expect(summed).toBe(5)
    expect(Number(total?.['visitors'])).toBeLessThan(summed)

    // And `visitors <= pageviews` on every row, total included (ADR-0036 D1) —
    // the invariant the page-view filter on the merge exists to keep.
    for (const row of rows) {
      expect(Number(row['visitors']), String(row['week'])).toBeLessThanOrEqual(
        Number(row['pageviews']),
      )
    }
  })

  it('never counts a custom-event-only identity as a visitor', async () => {
    // `cv-custom-only` has a stored `uniq` state under the `custom` event type.
    // A bare `uniqMerge(visitors)` would merge it in and mint a fifth visitor
    // with zero page views — the ADR-0036 defect, here over a real rollup.
    const [total] = (await cardRows([siteCards])).filter((row) => Number(row['is_total']) === 1)
    expect(Number(total?.['visitors'])).toBe(4)
  })

  it('returns rows only for the sites it was given, and for all of them', async () => {
    const one = await cardRows([siteCards])
    expect(new Set(one.map((row) => String(row['site_id'])))).toEqual(new Set([siteCards]))

    // The widened invariant in its positive form: naming two sites answers for
    // two sites, in one statement — which is the whole reason the operation
    // exists — while naming one still answers for exactly one.
    const both = await cardRows([siteCards, siteWeek])
    expect(new Set(both.map((row) => String(row['site_id'])))).toEqual(
      new Set([siteCards, siteWeek]),
    )

    // A site with no rows at all is simply absent; the api reads that as zero
    // for a site it knows exists, never as a failure.
    const stranger = await cardRows([randomUUID()])
    expect(stranger).toEqual([])
  })

  it('agrees with the single-site all-time overview it has to match', async () => {
    // The live proof this feature ships with, made a test: the card's figure and
    // the dashboard's "All time" total are the same number, because they read
    // the same table with the same expression.
    const [total] = (await cardRows([siteCards])).filter((row) => Number(row['is_total']) === 1)
    const [overview] = await run('analytics.overview_day', {
      site_id: siteCards,
      from: '2025-01-01T00:00:00.000Z',
      to: CARD_WINDOW.to,
      timezone: 'UTC',
    })

    expect(Number(total?.['visitors'])).toBe(Number(overview?.['visitors']))
    expect(Number(total?.['pageviews'])).toBe(Number(overview?.['pageviews']))
  })

  it('refuses a window that is not whole ISO weeks', async () => {
    // Proven here as well as in the unit suite because the consequence is
    // invisible in the data: a Tuesday endpoint returns rows, and two of them
    // are short weeks the card draws at full width.
    await expect(
      run('analytics.sites_all_time', {
        site_ids: [siteCards],
        from: '2026-06-30T00:00:00.000Z',
        to: CARD_WINDOW.to,
      }),
    ).rejects.toThrow()
  })

  it('returns a freshness watermark from the finest rollup', async () => {
    const [row] = await run('analytics.freshness', { site_id: siteA })
    // The latest site A occurred_at bucket is the July 2 page view's minute.
    expect(String(row?.['watermark'])).toBe('2026-07-02 10:00:00')
    expect(Number(row?.['buckets'])).toBeGreaterThan(0)

    const [empty] = await run('analytics.freshness', { site_id: randomUUID() })
    expect(Number(empty?.['buckets'])).toBe(0)
  })
})
