import type { components } from '@openanalytics/contracts'
import {
  assembleSparkline,
  roleHasCapability,
  siteCardWindow,
  type SiteCardWindow,
  type SiteRole,
} from '@openanalytics/domain'
import type { Database } from '@openanalytics/postgres'
import { listSitesWithRevenueCredential } from '@openanalytics/postgres'
import type { AnalyticsGateway } from '../gateway-client.ts'

/**
 * The figures `GET /v1/sites` puts on a site card (ADR-0080).
 *
 * The whole point of this module is that it is **one read per account**, not one
 * per site. The sites grid renders a card per site with all-time totals and a
 * 40-week sparkline; done the obvious way that is `2N` analytics requests on
 * every dashboard load, which is the frontend's N+1 moved one hop down rather
 * than removed. So the two gateway operations it calls take a *list* of site ids
 * (the registry's first, ADR-0080 D2) and the api does the fan-out arithmetic —
 * indexing rows by site, filling week gaps, attaching currencies — in memory.
 *
 * Three rules run through everything below, and each one has a wrong answer that
 * looks plausible:
 *
 * - **`null` is not zero.** Zero says "we measured, and nothing happened". `null`
 *   says "there is no measurement in this response". A card that renders a
 *   failed load as `0 visitors` is telling the customer something false about
 *   their traffic, so the two never share a representation (AGENTS.md: a
 *   provider failure is never an empty result, and an empty result must stay
 *   interpretable).
 * - **The list never fails because of this.** `GET /v1/sites` is the dashboard
 *   shell's own load and these figures decorate it. Every failure path here ends
 *   in `null` figures and a `warn`, never in a non-2xx (D6).
 * - **Authorization is upstream and unchanged.** Only sites the caller is
 *   already a member of are named, and `revenue:read` is re-checked per site
 *   through the capability matrix rather than by comparing a role string, so a
 *   change to that matrix moves this surface with it (D4).
 */

type CardStats = components['schemas']['SiteCardStats']
type CardTotals = components['schemas']['SiteCardTotals']

/** What this module needs to know about one of the caller's sites. */
export interface SiteCardSubject {
  readonly siteId: string
  readonly role: SiteRole
  /** `'active'`, or anything else — see `isComputable`. */
  readonly status: string
  readonly firstEventAt: Date | null
  readonly reportingCurrency: string
}

/** Row shape of `analytics.sites_all_time`. */
interface AllTimeRow {
  readonly site_id: string
  readonly is_total: number | string
  readonly week: string
  readonly pageviews: number | string
  readonly visitors: number | string
}

/** Row shape of `analytics.sites_all_time_revenue`. */
interface RevenueRow {
  readonly site_id: string
  readonly net_minor: number | string
}

/** ClickHouse renders UInt64 as a JSON string; everything here is a count. */
function toCount(value: number | string | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * `2026-09-07 00:00:00.000` → `2026-09-07T00:00:00.000Z`.
 *
 * The column is `DateTime64(3, 'UTC')`, so the wire form is UTC wall clock with
 * no offset attached to say so — the same reading every other bucket in this api
 * gets.
 */
function weekInstant(value: string): string {
  return `${value.replace(' ', 'T')}Z`
}

/** The stats every site gets when nothing could be computed for it. */
const UNAVAILABLE: CardStats = Object.freeze({ all_time: null, sparkline: null })

export interface SiteCardStatsOptions {
  readonly db: Database
  /** `0` disables the cache entirely. */
  readonly cacheTtlMs: number
  /** The short deadline the gateway calls get — never the dashboard's (D6). */
  readonly gatewayTimeoutMs: number
  /** Fan-out ceiling; sites past it get `null` figures. */
  readonly maxSites: number
  readonly logger?: {
    warn(message: string, fields?: Record<string, unknown>): void
  }
  /** Injectable for tests. */
  readonly now?: () => Date
  /** Cap on cached accounts, so an unbounded number of callers cannot grow the map. */
  readonly maxCacheKeys?: number
}

interface CacheEntry {
  readonly expiresAt: number
  readonly value: ReadonlyMap<string, CardStats>
}

export class SiteCardStatsReader {
  readonly #gateway: AnalyticsGateway
  readonly #options: SiteCardStatsOptions
  readonly #now: () => Date
  readonly #maxCacheKeys: number
  readonly #cache = new Map<string, CacheEntry>()

  constructor(gateway: AnalyticsGateway, options: SiteCardStatsOptions) {
    this.#gateway = gateway
    this.#options = options
    this.#now = options.now ?? (() => new Date())
    this.#maxCacheKeys = options.maxCacheKeys ?? 10_000
  }

  /**
   * Figures for every site in `subjects`, keyed by site id.
   *
   * Never throws and never returns a short map: a site that could not be
   * computed is present with `null` figures, because the caller maps this over
   * the site list and an absent key would become an absent field.
   */
  async read(
    userId: string,
    subjects: readonly SiteCardSubject[],
  ): Promise<ReadonlyMap<string, CardStats>> {
    if (subjects.length === 0) return new Map()

    const key = cacheKey(userId, subjects)
    const nowMs = this.#now().getTime()
    if (this.#options.cacheTtlMs > 0) {
      const hit = this.#cache.get(key)
      if (hit && hit.expiresAt > nowMs) return hit.value
    }

    const { stats, complete } = await this.#compute(subjects)

    // A failure is never cached: the next request is the retry, and pinning a
    // dead gateway's answer for five minutes would turn a two-second blip into a
    // five-minute one (D5).
    if (this.#options.cacheTtlMs > 0 && complete) {
      if (this.#cache.size >= this.#maxCacheKeys) this.#sweep(nowMs)
      this.#cache.set(key, { expiresAt: nowMs + this.#options.cacheTtlMs, value: stats })
    }
    return stats
  }

  async #compute(subjects: readonly SiteCardSubject[]): Promise<{
    stats: ReadonlyMap<string, CardStats>
    complete: boolean
  }> {
    const stats = new Map<string, CardStats>()
    let complete = true

    // A suspended site's analytics are refused everywhere else (the site-scoped
    // read middleware rejects them outright), and a list that answered them
    // anyway would be a way around that rule rather than an exception to it. A
    // `deleting` site stays in the list — the existing behaviour — and is
    // likewise not computed (D1, D8).
    const computable: SiteCardSubject[] = []
    for (const subject of subjects) {
      if (subject.status === 'active') computable.push(subject)
      else stats.set(subject.siteId, UNAVAILABLE)
    }

    // The cap is a partial answer, not a refusal: the first N in list order get
    // figures and the rest are honestly `null`. Prod's largest account has 4
    // sites, so this is a guard against a future shape, not a live limit.
    const considered = computable.slice(0, this.#options.maxSites)
    if (computable.length > considered.length) {
      for (const subject of computable.slice(this.#options.maxSites)) {
        stats.set(subject.siteId, UNAVAILABLE)
      }
      complete = false
      this.#options.logger?.warn('sites_card_stats_unavailable', {
        reason: 'site_count_over_cap',
        site_count: computable.length,
        max_sites: this.#options.maxSites,
      })
    }
    if (considered.length === 0) return { stats, complete }

    const window = siteCardWindow(this.#now())

    // Which sites need which query. A site whose tracker has never fired has
    // nothing for the traffic query to find — `first_event_at` is the pipeline's
    // own record of that — so it is answered with zeros directly. It may still
    // have revenue: money arrives through a provider webhook, not through the
    // tracker, so a site that connected billing before installing the snippet is
    // a real and correct case for a figure (D1 read together with D4).
    const traffic = considered.filter((subject) => subject.firstEventAt !== null)
    const revenueCandidates = considered.filter((subject) =>
      roleHasCapability(subject.role, 'revenue:read'),
    )

    // Which of the candidates have ever connected a provider — one statement for
    // the whole account. `null` means the read itself failed, which is not the
    // same as "none did" and must not be rendered as it (D4).
    let connected: Set<string> | null = new Set()
    if (revenueCandidates.length > 0) {
      try {
        connected = await listSitesWithRevenueCredential(
          this.#options.db,
          revenueCandidates.map((subject) => subject.siteId),
        )
      } catch (err) {
        connected = null
        complete = false
        this.#options.logger?.warn('sites_card_stats_unavailable', {
          reason: 'revenue_credentials_unreadable',
          err,
        })
      }
    }
    const connectedIds = connected
    const revenueSites =
      connectedIds === null
        ? []
        : revenueCandidates.filter((subject) => connectedIds.has(subject.siteId))
    const revenueSiteIds = new Set(revenueSites.map((subject) => subject.siteId))

    const [trafficRows, revenueRows] = await Promise.all([
      this.#query<AllTimeRow>('analytics.sites_all_time', traffic, {
        site_ids: traffic.map((subject) => subject.siteId),
        from: window.from,
        to: window.to,
      }),
      this.#query<RevenueRow>('analytics.sites_all_time_revenue', revenueSites, {
        site_ids: revenueSites.map((subject) => subject.siteId),
        from: window.from,
        to: window.to,
      }),
    ])
    if (trafficRows === null || revenueRows === null) complete = false

    const indexed = trafficRows === null ? null : indexTraffic(trafficRows)
    const netBySite =
      revenueRows === null
        ? null
        : new Map(revenueRows.map((row) => [row.site_id, toCount(row.net_minor)]))

    for (const subject of considered) {
      stats.set(
        subject.siteId,
        this.#statsFor(subject, {
          window,
          indexed,
          netBySite,
          needsTraffic: subject.firstEventAt !== null,
          needsRevenue: revenueSiteIds.has(subject.siteId),
          revenueUnresolved: connected === null && roleHasCapability(subject.role, 'revenue:read'),
        }),
      )
    }

    return { stats, complete }
  }

  #statsFor(
    subject: SiteCardSubject,
    context: {
      window: SiteCardWindow
      indexed: ReadonlyMap<string, SiteTraffic> | null
      netBySite: ReadonlyMap<string, number> | null
      needsTraffic: boolean
      needsRevenue: boolean
      revenueUnresolved: boolean
    },
  ): CardStats {
    // Every dependency this site actually has must have resolved. A site whose
    // revenue figure is missing is not "a site with no revenue" — that is what
    // an unconnected provider looks like — so the honest answer is no figures at
    // all rather than a card that reads as "traffic yes, money zero".
    if (context.revenueUnresolved) return UNAVAILABLE
    if (context.needsTraffic && context.indexed === null) return UNAVAILABLE
    if (context.needsRevenue && context.netBySite === null) return UNAVAILABLE

    const traffic = context.indexed?.get(subject.siteId)
    const totals: CardTotals = {
      visitors: traffic?.visitors ?? 0,
      pageviews: traffic?.pageviews ?? 0,
      revenue: context.needsRevenue
        ? {
            // Absent from the rollup is a genuine zero here, not a gap: the site
            // has a provider connected and this query covers all time, so "no
            // buckets" means no money moved.
            net_minor: context.netBySite?.get(subject.siteId) ?? 0,
            currency: subject.reportingCurrency,
          }
        : null,
    }
    // Frozen, because the same object is handed to every later request served
    // from the cache: a caller that mutated a response in place would be editing
    // the cached answer for the next five minutes (D5).
    if (totals.revenue !== null) Object.freeze(totals.revenue)
    return Object.freeze({
      all_time: Object.freeze(totals),
      sparkline: Object.freeze(
        assembleSparkline({
          window: context.window,
          firstEventAt: subject.firstEventAt,
          weekly: traffic?.weekly ?? new Map(),
        }),
      ) as number[],
    })
  }

  /**
   * One gateway call, or `null` if it could not be made.
   *
   * `[]` when no site needs this operation — an empty `site_ids` is refused by
   * the operation's own schema, and "nothing to ask about" is not a failure.
   */
  async #query<TRow>(
    operation: string,
    subjects: readonly SiteCardSubject[],
    params: Record<string, unknown>,
  ): Promise<readonly TRow[] | null> {
    if (subjects.length === 0) return []
    try {
      const result = await this.#gateway.query<TRow>(operation, params, {
        timeoutMs: this.#options.gatewayTimeoutMs,
      })
      return result.rows
    } catch (err) {
      // Typed and logged, never rethrown: the list itself is not in doubt.
      this.#options.logger?.warn('sites_card_stats_unavailable', {
        reason: 'gateway_query_failed',
        operation,
        site_count: subjects.length,
        err,
      })
      return null
    }
  }

  #sweep(nowMs: number): void {
    for (const [key, entry] of this.#cache) {
      if (entry.expiresAt <= nowMs) this.#cache.delete(key)
    }
  }
}

interface SiteTraffic {
  visitors: number
  pageviews: number
  weekly: Map<string, number>
}

/** Folds the union's two row kinds into one record per site. */
function indexTraffic(rows: readonly AllTimeRow[]): ReadonlyMap<string, SiteTraffic> {
  const indexed = new Map<string, SiteTraffic>()
  for (const row of rows) {
    let entry = indexed.get(row.site_id)
    if (!entry) {
      entry = { visitors: 0, pageviews: 0, weekly: new Map() }
      indexed.set(row.site_id, entry)
    }
    if (toCount(row.is_total) === 1) {
      entry.visitors = toCount(row.visitors)
      entry.pageviews = toCount(row.pageviews)
    } else {
      // Visitors, not page views. The sparkline is "unique visitors a week"
      // (ADR-0080 D3) — the same ADR-0036 population the total counts, which is
      // what makes the weekly numbers add up to MORE than the all-time figure
      // rather than being a different measure altogether. `pageviews` is
      // projected on this row too and is deliberately unread here.
      entry.weekly.set(weekInstant(row.week), toCount(row.visitors))
    }
  }
  return indexed
}

/**
 * The cache key: the caller, and every input that decides their answer.
 *
 * ADR-0080 D5 keys on the membership set, so a role change or a site joining or
 * leaving the account cannot be served from the previous answer. Two more inputs
 * belong in it for the same reason and are cheap to carry: a site's `status`
 * (suspending one must blank its figures now, not in five minutes) and whether
 * it has ever received an event (a tracker that starts working must stop the
 * card saying zero). None of those change often, so the key is stable in
 * practice; what it rules out is a stale answer that outlives the fact that
 * produced it.
 */
function cacheKey(userId: string, subjects: readonly SiteCardSubject[]): string {
  const parts = subjects
    .map(
      (subject) =>
        `${subject.siteId}:${subject.role}:${subject.status}:${subject.firstEventAt === null ? 0 : 1}`,
    )
    .sort()
  return `${userId}\u0000${parts.join('\u0000')}`
}
