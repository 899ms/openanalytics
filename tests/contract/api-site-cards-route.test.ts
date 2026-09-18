import { loadServiceEnv } from '@openanalytics/domain'
import type { Auth } from '@openanalytics/auth'
import type { Database } from '@openanalytics/postgres'
import type * as PostgresModule from '@openanalytics/postgres'
import { createServiceMetadata } from '@openanalytics/observability'
import { createCapturedLogger, testEnv } from '@openanalytics/testkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalyticsGateway, GatewayQueryOptions } from '../../apps/api/src/gateway-client.ts'

/**
 * `GET /v1/sites` and the card figures it carries (ADR-0080).
 *
 * Driven through the real app and the real route so the composition is what is
 * asserted — the summary and the figures in one response, the figures computed
 * from at most two gateway calls no matter how many sites there are.
 *
 * What most of these cases are really pinning is the **difference between zero
 * and null**, because every failure mode of this feature produces a number that
 * looks fine. A site whose figures timed out and a site with no visitors are one
 * pixel apart on a card and a world apart as claims about a customer's business.
 */

const sitesForUser = { value: [] as unknown[] }
const credentialSites = { value: new Set<string>() }
const credentialError = { value: null as Error | null }

vi.mock('@openanalytics/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof PostgresModule>()
  return {
    ...actual,
    listSitesForUser: async () => sitesForUser.value,
    listSitesWithRevenueCredential: async () => {
      if (credentialError.value) throw credentialError.value
      return credentialSites.value
    },
  }
})

const { createApp } = await import('../../apps/api/src/app.ts')
const { SiteCardStatsReader } = await import('../../apps/api/src/analytics/site-cards.ts')

const OWNED = '3f2a1c64-9a1a-4e2f-9c1e-2a0f1d3b5c77'
const ADMINED = '7c4e9a12-0b55-4d31-8f6a-1e2d3c4b5a60'
const WAITING = '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d'
const SUSPENDED = '9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b'

/** A Saturday inside the ISO week beginning 2026-09-07. */
const NOW = new Date('2026-09-12T18:30:00.000Z')

function site(overrides: Record<string, unknown>) {
  return {
    siteId: OWNED,
    slug: 'one',
    name: 'One',
    status: 'active',
    role: 'owner',
    isBillingOwner: true,
    domains: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    firstEventAt: new Date('2026-08-26T11:04:00.000Z'),
    suspendedAt: null,
    reportingCurrency: 'USD',
    reportingTimezone: 'UTC',
    ...overrides,
  }
}

function sessionAuthStub(): Auth {
  return {
    api: {
      getSession: async () => ({
        user: {
          id: 'user-1',
          email: 'a@b.test',
          emailVerified: true,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        session: { createdAt: new Date('2026-09-01T00:00:00.000Z') },
      }),
    },
    handler: async () => new Response(null),
  } as unknown as Auth
}

interface GatewayScript {
  /** Rows per operation; a thrown value is thrown instead. */
  readonly rows?: Record<string, unknown[] | Error>
}

let gatewayCalls: { operation: string; params: Record<string, unknown> }[] = []
let gatewayOptions: GatewayQueryOptions[] = []

function buildApp(script: GatewayScript = {}, options: { cacheTtlMs?: number } = {}) {
  gatewayCalls = []
  gatewayOptions = []
  const gateway: AnalyticsGateway = {
    query: <TRow = Record<string, unknown>>(
      operation: string,
      params?: unknown,
      queryOptions?: GatewayQueryOptions,
    ) => {
      gatewayCalls.push({ operation, params: (params ?? {}) as Record<string, unknown> })
      gatewayOptions.push(queryOptions ?? {})
      const scripted = script.rows?.[operation]
      if (scripted instanceof Error) return Promise.reject(scripted)
      const rows = scripted ?? []
      return Promise.resolve({
        operation,
        rows: rows as unknown as readonly TRow[],
        meta: { row_count: rows.length, truncated: false, elapsed_ms: 1, cached: false },
      })
    },
  }
  const { logger } = createCapturedLogger()
  const db = {} as Database
  return createApp({
    service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
    logger,
    env: loadServiceEnv('api', testEnv()),
    auth: sessionAuthStub(),
    db,
    siteCards: new SiteCardStatsReader(gateway, {
      db,
      cacheTtlMs: options.cacheTtlMs ?? 0,
      gatewayTimeoutMs: 3_000,
      maxSites: 100,
      now: () => NOW,
      logger,
    }),
  })
}

async function listSites(app: { fetch: (request: Request) => Response | Promise<Response> }) {
  const res = await app.fetch(new Request('http://api.test/v1/sites'))
  expect(res.status).toBe(200)
  return (await res.json()) as {
    items: {
      site_id: string
      reporting_currency: string
      all_time: { visitors: number; pageviews: number; revenue: unknown } | null
      sparkline: number[] | null
    }[]
  }
}

/** The union's two row kinds, as ClickHouse renders UInt64 (strings). */
function totalRow(siteId: string, visitors: number, pageviews: number) {
  return {
    site_id: siteId,
    is_total: 1,
    week: '1970-01-01 00:00:00.000',
    pageviews: String(pageviews),
    visitors: String(visitors),
  }
}
/**
 * A week row carries BOTH measures and the api must plot `visitors`.
 *
 * They are deliberately different numbers in every case below: a fixture that
 * set them equal would pass whichever column the api happened to read, which is
 * exactly the defect this argument order exists to catch.
 */
function weekRow(siteId: string, week: string, visitors: number, pageviews: number) {
  return {
    site_id: siteId,
    is_total: 0,
    week: `${week} 00:00:00.000`,
    pageviews: String(pageviews),
    visitors: String(visitors),
  }
}

beforeEach(() => {
  sitesForUser.value = [site({})]
  credentialSites.value = new Set()
  credentialError.value = null
})

describe('GET /v1/sites carries the card figures (ADR-0080)', () => {
  it('answers one list with the figures attached to each summary', async () => {
    const app = buildApp({
      rows: {
        'analytics.sites_all_time': [
          totalRow(OWNED, 41, 96),
          weekRow(OWNED, '2026-08-24', 18, 40),
          weekRow(OWNED, '2026-09-07', 7, 12),
        ],
      },
    })
    const body = await listSites(app)

    expect(body.items).toHaveLength(1)
    const [item] = body.items
    // The summary is untouched — the figures are additive.
    expect(item?.site_id).toBe(OWNED)
    expect(item?.reporting_currency).toBe('USD')
    expect(item?.all_time).toEqual({ visitors: 41, pageviews: 96, revenue: null })
    // Three points: the site's first event is in the week of 2026-08-24, the
    // middle week is a real zero, and the current week is the last point.
    //
    // **Visitors, not page views** — 18 and 7, the `visitors` column of those
    // rows, never the 40 and 12 sitting beside them. The sparkline is the same
    // ADR-0036 population `all_time.visitors` counts, cut per week (ADR-0080
    // D3), and the two columns differ here so that reading the wrong one fails.
    expect(item?.sparkline).toEqual([18, 0, 7])
  })

  it('plots weekly VISITORS, never the page views beside them', async () => {
    // The divergence this pins actually happened: the contract, the ADR and the
    // frontend note all said "visitors a week" while the api filled the series
    // from `row.pageviews`. Both columns are on every week row, so nothing about
    // the shape of the response made it visible — only a fixture whose two
    // columns disagree can.
    const app = buildApp({
      rows: {
        'analytics.sites_all_time': [
          totalRow(OWNED, 9, 300),
          weekRow(OWNED, '2026-08-31', 3, 100),
          weekRow(OWNED, '2026-09-07', 5, 200),
        ],
      },
    })
    const body = await listSites(app)

    // Three points, because the series starts at the week of the site's first
    // event (2026-08-24) and that week has no row — a real zero inside the
    // site's life, not a dropped point.
    expect(body.items[0]?.sparkline).toEqual([0, 3, 5])
    // Pointedly NOT [_, 100, 200], and not anything derived from them.
    expect(body.items[0]?.sparkline).not.toContain(100)
    expect(body.items[0]?.sparkline).not.toContain(200)
  })

  it('keeps visitors at or below pageviews (ADR-0036 D1)', async () => {
    const app = buildApp({
      rows: { 'analytics.sites_all_time': [totalRow(OWNED, 41, 96)] },
    })
    const body = await listSites(app)
    const totals = body.items[0]?.all_time
    expect(totals?.visitors).toBeLessThanOrEqual(totals?.pageviews ?? 0)
  })

  it('asks about every site in one call, not one call per site', async () => {
    sitesForUser.value = [
      site({}),
      site({ siteId: ADMINED, slug: 'two', role: 'admin', isBillingOwner: false }),
    ]
    const app = buildApp({ rows: { 'analytics.sites_all_time': [] } })
    await listSites(app)

    // The whole reason the operation binds a list: the alternative is 2N calls
    // on every dashboard load.
    const traffic = gatewayCalls.filter((call) => call.operation === 'analytics.sites_all_time')
    expect(traffic).toHaveLength(1)
    expect(traffic[0]?.params['site_ids']).toEqual([OWNED, ADMINED])
  })

  it('passes the short deadline, never the dashboard read one (D6)', async () => {
    const app = buildApp({ rows: { 'analytics.sites_all_time': [] } })
    await listSites(app)
    expect(gatewayOptions[0]?.timeoutMs).toBe(3_000)
  })

  it('sends a Monday-aligned forty-week window ending next Monday', async () => {
    const app = buildApp({ rows: { 'analytics.sites_all_time': [] } })
    await listSites(app)
    const params = gatewayCalls[0]?.params
    expect(params?.['from']).toBe('2025-12-08T00:00:00.000Z')
    expect(params?.['to']).toBe('2026-09-14T00:00:00.000Z')
  })
})

describe('a site with nothing to measure, and a site that could not be measured', () => {
  it('starts the series at real data older than first_event_at (ADR-0080 D3)', async () => {
    // The population this exists for: ADR-0027 shipped after some sites already
    // had traffic and existing sites were never backfilled, so `first_event_at`
    // is later than their real first event. Measured on production 2026-09-12,
    // one site in six had a rollup week sitting before that field's week — and
    // the first version of this code trimmed on the field alone and dropped it.
    // A card silently starting a week late is a claim about when the customer's
    // traffic began, so the series starts at whichever is earlier.
    const app = buildApp({
      rows: {
        'analytics.sites_all_time': [
          totalRow(OWNED, 30, 60),
          // A week BEFORE the first-event week (2026-08-24), with real visitors.
          weekRow(OWNED, '2026-08-17', 7, 9),
          weekRow(OWNED, '2026-08-24', 11, 20),
          weekRow(OWNED, '2026-09-07', 12, 31),
        ],
      },
    })
    const body = await listSites(app)

    // Four points, not three: the 08-17 week is kept, 08-31 is a real zero
    // inside the site's life, and the last point is still the current week.
    expect(body.items[0]?.sparkline).toEqual([7, 11, 0, 12])
  })

  it('answers a never-installed site with zeros and an empty series, asking nothing', async () => {
    sitesForUser.value = [site({ siteId: WAITING, slug: 'new', firstEventAt: null })]
    const app = buildApp()
    const body = await listSites(app)

    // Zero, not null: `first_event_at === null` is the pipeline's own record
    // that nothing has ever arrived, which is a measurement.
    expect(body.items[0]?.all_time).toEqual({ visitors: 0, pageviews: 0, revenue: null })
    expect(body.items[0]?.sparkline).toEqual([])
    // And nothing was asked, because there is nothing to find.
    expect(gatewayCalls).toHaveLength(0)
  })

  it('answers null — not zero — when the gateway refuses, and still returns 200', async () => {
    const app = buildApp({
      rows: { 'analytics.sites_all_time': new Error('gateway is down') },
    })
    const body = await listSites(app)

    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.all_time).toBeNull()
    expect(body.items[0]?.sparkline).toBeNull()
    // The list itself is never in doubt: the summary is intact.
    expect(body.items[0]?.site_id).toBe(OWNED)
  })

  it('answers null when the deadline expires', async () => {
    // The client turns an abort into a typed ApiError; what matters here is that
    // a rejection of any kind lands on null figures rather than on a 5xx.
    const timeout = Object.assign(new Error('The analytics service is unreachable'), {
      name: 'ApiError',
    })
    const app = buildApp({ rows: { 'analytics.sites_all_time': timeout } })
    const body = await listSites(app)
    expect(body.items[0]?.all_time).toBeNull()
  })

  it('never computes a suspended site, so the list cannot go round the read rule', async () => {
    sitesForUser.value = [
      site({}),
      site({
        siteId: SUSPENDED,
        slug: 'blocked',
        status: 'suspended',
        suspendedAt: new Date('2026-09-01T00:00:00.000Z'),
      }),
    ]
    const app = buildApp({ rows: { 'analytics.sites_all_time': [totalRow(OWNED, 1, 2)] } })
    const body = await listSites(app)

    const blocked = body.items.find((item) => item.site_id === SUSPENDED)
    expect(blocked?.all_time).toBeNull()
    expect(blocked?.sparkline).toBeNull()
    // And it was never named in the query — the site-scoped read middleware
    // refuses this site everywhere else, and this route must not be the way in.
    expect(gatewayCalls[0]?.params['site_ids']).toEqual([OWNED])
  })
})

describe('revenue follows the tile rule, literally (D4)', () => {
  const withRevenue = {
    rows: {
      'analytics.sites_all_time': [totalRow(OWNED, 3, 9), totalRow(ADMINED, 5, 11)],
      'analytics.sites_all_time_revenue': [{ site_id: OWNED, net_minor: '128450' }],
    },
  }

  it('gives an owner with a provider connected the figure, in the site currency', async () => {
    credentialSites.value = new Set([OWNED])
    sitesForUser.value = [site({ reportingCurrency: 'EUR' })]
    const app = buildApp(withRevenue)
    const body = await listSites(app)

    expect(body.items[0]?.all_time?.revenue).toEqual({ net_minor: 128_450, currency: 'EUR' })
  })

  it('gives an owner with no provider connected null, never zero', async () => {
    credentialSites.value = new Set()
    const app = buildApp(withRevenue)
    const body = await listSites(app)

    // Zero would claim the site earned nothing. It has no provider: there is no
    // figure to give, which is a different sentence.
    expect(body.items[0]?.all_time?.revenue).toBeNull()
    expect(gatewayCalls.some((call) => call.operation === 'analytics.sites_all_time_revenue')).toBe(
      false,
    )
  })

  it('gives a non-owner null however the site is connected', async () => {
    credentialSites.value = new Set([OWNED, ADMINED])
    sitesForUser.value = [
      site({ siteId: ADMINED, slug: 'two', role: 'admin', isBillingOwner: false }),
    ]
    const app = buildApp(withRevenue)
    const body = await listSites(app)

    // `revenue:read` is an owner capability, read through the matrix rather than
    // by comparing the role string — so this follows the matrix if it changes.
    expect(body.items[0]?.all_time?.revenue).toBeNull()
    const revenueCall = gatewayCalls.find(
      (call) => call.operation === 'analytics.sites_all_time_revenue',
    )
    expect(revenueCall).toBeUndefined()
  })

  it('reports zero for a connected site with no money yet', async () => {
    credentialSites.value = new Set([OWNED])
    const app = buildApp({
      rows: {
        'analytics.sites_all_time': [totalRow(OWNED, 3, 9)],
        'analytics.sites_all_time_revenue': [],
      },
    })
    const body = await listSites(app)
    // Here zero IS the measurement: a provider is connected and all time holds
    // no money, which is not the same as having no provider.
    expect(body.items[0]?.all_time?.revenue).toEqual({ net_minor: 0, currency: 'USD' })
  })

  it('blanks an owner site when it cannot tell whether a provider is connected', async () => {
    credentialError.value = new Error('postgres is unreachable')
    const app = buildApp(withRevenue)
    const body = await listSites(app)

    // Answering `revenue: null` here would state "no provider connected" on the
    // strength of a failed read. The honest answer is that nothing was computed.
    expect(body.items[0]?.all_time).toBeNull()
    expect(body.items[0]?.sparkline).toBeNull()
  })
})

describe('the per-account cache (D5)', () => {
  const rows = { rows: { 'analytics.sites_all_time': [totalRow(OWNED, 7, 21)] } }

  it('serves a second call inside the TTL without touching the gateway', async () => {
    const app = buildApp(rows, { cacheTtlMs: 300_000 })
    const first = await listSites(app)
    const callsAfterFirst = gatewayCalls.length
    const second = await listSites(app)

    expect(gatewayCalls).toHaveLength(callsAfterFirst)
    expect(second.items[0]?.all_time).toEqual(first.items[0]?.all_time)
  })

  it('re-reads when the membership set changes', async () => {
    const app = buildApp(rows, { cacheTtlMs: 300_000 })
    await listSites(app)
    const before = gatewayCalls.length

    // A role change is a different answer — `revenue:read` turns on and off with
    // it — so it must not be served from the previous one.
    sitesForUser.value = [site({ role: 'viewer', isBillingOwner: false })]
    await listSites(app)
    expect(gatewayCalls.length).toBeGreaterThan(before)
  })

  it('re-reads when a site suspends, rather than serving figures it may no longer show', async () => {
    const app = buildApp(rows, { cacheTtlMs: 300_000 })
    await listSites(app)
    const before = gatewayCalls.length

    sitesForUser.value = [site({ status: 'suspended' })]
    const body = await listSites(app)
    expect(gatewayCalls.length).toBeGreaterThanOrEqual(before)
    expect(body.items[0]?.all_time).toBeNull()
  })

  it('never caches a failure', async () => {
    const app = buildApp(
      { rows: { 'analytics.sites_all_time': new Error('gateway is down') } },
      { cacheTtlMs: 300_000 },
    )
    await listSites(app)
    const before = gatewayCalls.length
    await listSites(app)

    // The next request is the retry. Pinning a dead gateway's answer for five
    // minutes would turn a two-second blip into a five-minute one.
    expect(gatewayCalls.length).toBeGreaterThan(before)
  })
})

describe('a deployment with no query gateway', () => {
  it('still answers the list, with figures that say they were not computed', async () => {
    const { logger } = createCapturedLogger()
    const app = createApp({
      service: createServiceMetadata({ name: 'api', version: '0.0.0-test', environment: 'test' }),
      logger,
      env: loadServiceEnv('api', testEnv()),
      auth: sessionAuthStub(),
      db: {} as Database,
    })
    const body = await listSites(app)

    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.all_time).toBeNull()
    expect(body.items[0]?.sparkline).toBeNull()
  })
})
