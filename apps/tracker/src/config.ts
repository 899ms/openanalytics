import type { TrackerConfigPatch, TrackerRuntimeConfig } from './core.ts'
import type { SafeStorage } from './storage.ts'

/**
 * Tracker configuration fetch (docs snapshot 02 §11).
 *
 * The response is public, cacheable and version-stamped. Two caches sit in front
 * of it: the CDN's, keyed by `ETag`, and this one in `localStorage`. Inside the
 * soft TTL the tracker makes no request at all; after it, the request is a
 * conditional `If-None-Match`, so the common answer is a 304 with no body.
 *
 * The tracking key is a query parameter here because a `<script>`-driven GET has
 * nowhere else to put it. It stays write-only: this endpoint returns
 * configuration, never data, and the response carries no credential of any kind.
 *
 * A failed or malformed config is never fatal — the tracker keeps its defaults.
 */

const CONFIG_KEY = 'oa.config'

/**
 * Skip the network entirely for this long after a successful fetch.
 *
 * Five minutes, aligned with the endpoint's own `max-age=300` (ADR-0034, D4).
 * It was six hours, which made this a second and much longer staleness layer
 * stacked on the HTTP cache: a rule published in the dashboard reached an
 * already-cached browser up to six hours later, and a publish a customer cannot
 * observe is not a publish. At five minutes the `localStorage` copy is what it
 * is actually useful as — a de-dupe across rapid page loads — and the worst case
 * from Publish to a browser evaluating the rule is the ~600 s D4 states.
 *
 * The cost is at most one conditional `GET` per visitor per five minutes,
 * answered `304` with no body. A session shorter than five minutes — most of
 * them — makes no extra request at all.
 */
export const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000

/**
 * How long a `404` on the config endpoint silences this browser (ADR-0074).
 *
 * A 404 there has exactly one meaning — no live site matches the key: the site
 * was deleted, or its tracking key was expired by an operator block. Unknown,
 * revoked and expired are deliberately indistinguishable on the wire, and the
 * tracker needs no distinction either: in every one of those states each event
 * it sends will be refused, so sending is only load. The first large blocked
 * customer kept ~66 requests/second of refused batches coming for days, enough
 * to OOM the edge proxy — the fix is that the tracker itself stands down.
 *
 * One hour, matching the `oa.js` asset cache: after a block, a visitor costs at
 * most one config probe per hour instead of a batch per pageview. Kept finite so
 * a site that comes back — a key rotation, an unblock, a config-store blip that
 * answered 404 for a moment — resumes within the hour on its own.
 */
export const SITE_GONE_TTL_MS = 60 * 60 * 1000

/** The whole configuration a gone site needs: send nothing. */
const DISABLED_PATCH: TrackerConfigPatch = { disabled: true }

interface TrackerConfigResponse {
  config_version?: number
  collection_paused?: boolean
  /**
   * The site's origin allowlist, as the collector holds it (ADR-0081, D1).
   *
   * It has always been on the wire (`toTrackerConfig` in
   * `ingest-config-store.ts`) and was parsed by nobody. The tracker reads it to
   * tell the developer, once, that this host is not one the server counts.
   */
  allowed_domains?: string[]
  redact_query_keys?: string[]
  interaction_sampling?: number
  heartbeat_interval_seconds?: number
  features?: Partial<TrackerRuntimeConfig['features']>
  attributed_revenue?: boolean
  no_code_rules?: TrackerRuntimeConfig['noCodeRules']
}

interface CachedConfig {
  etag: string | null
  at: number
  body: TrackerConfigResponse
  /** Set when the last answer was a 404: no live site matches the key. */
  gone?: true
}

export function toRuntimeConfig(response: TrackerConfigResponse): TrackerConfigPatch {
  const runtime: {
    allowedDomains?: readonly string[]
    redactQueryKeys?: readonly string[]
    interactionSampling?: number
    heartbeatIntervalSeconds?: number
    features?: TrackerRuntimeConfig['features']
    attributedRevenue?: boolean
    noCodeRules?: TrackerRuntimeConfig['noCodeRules']
  } = {}

  // Carried through as the server spells them: the verdict lowercases and trims
  // each entry itself, and the console line quotes them back to the person who
  // typed them into the dashboard.
  //
  // Absent — an older cached body, or a deployment that does not send the field
  // — leaves the runtime value alone, and the runtime default is the empty list,
  // which admits every host. That is the direction this has to fail in: a
  // missing list must never silence a tracker that the server would have
  // counted.
  if (Array.isArray(response.allowed_domains)) {
    runtime.allowedDomains = response.allowed_domains.filter(
      (domain): domain is string => typeof domain === 'string',
    )
  }
  if (Array.isArray(response.redact_query_keys)) {
    runtime.redactQueryKeys = response.redact_query_keys
      .filter((key): key is string => typeof key === 'string')
      .map((key) => key.toLowerCase())
  }
  if (typeof response.interaction_sampling === 'number') {
    runtime.interactionSampling = Math.min(1, Math.max(0, response.interaction_sampling))
  }
  if (typeof response.heartbeat_interval_seconds === 'number') {
    runtime.heartbeatIntervalSeconds = Math.min(
      300,
      Math.max(5, Math.round(response.heartbeat_interval_seconds)),
    )
  }
  if (Array.isArray(response.no_code_rules)) {
    // Passed through as received. Every rule was validated server-side at save
    // time (ADR-0034, D2), and a second, smaller validator in the bundle would
    // be a second opinion that could disagree with the first — the direction
    // that disagreement fails in is a rule the dashboard shows as live and the
    // browser silently ignores.
    runtime.noCodeRules = response.no_code_rules
  }
  // `=== true` rather than `!== false`, which is how every flag in `features` is
  // read. The difference is the default a malformed or older response falls back
  // to, and for this one that has to be off: a cached body from before the field
  // existed must not read as an opt-in nobody made.
  if (typeof response.attributed_revenue === 'boolean') {
    runtime.attributedRevenue = response.attributed_revenue === true
  }
  if (response.features) {
    runtime.features = {
      web_vitals: response.features.web_vitals !== false,
      engagement: response.features.engagement !== false,
      interactions: response.features.interactions !== false,
      heartbeat: response.features.heartbeat !== false,
    }
  }

  return {
    ...runtime,
    // Set on every response, in both directions (ADR-0074, amendment 2): the
    // paused light must clear the moment a configuration without it arrives,
    // and "absent means leave it alone" — the rule for every other field —
    // would leave a tracker paused after the window reopened. The server only
    // emits `true`; absence IS the resume signal.
    disabled: response.collection_paused === true,
  } as TrackerConfigPatch
}

export interface ConfigLoaderDeps {
  readonly collectorUrl: string
  readonly trackingKey: string
  readonly storage: SafeStorage
  readonly now: () => number
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
}

function readCache(storage: SafeStorage): CachedConfig | null {
  const raw = storage.get(CONFIG_KEY)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && typeof (parsed as CachedConfig).at === 'number') {
      return parsed as CachedConfig
    }
  } catch {
    /* corrupt entry; treated as absent */
  }
  return null
}

/**
 * Whether a fresh gone-marker says this site has no live key (ADR-0074).
 *
 * Synchronous on purpose: the boot path asks before installing anything, so a
 * page on a blocked site arms no listeners, starts no timers and opens no
 * connection. Past the TTL the answer flips back to `false` and the ordinary
 * boot re-probes.
 */
export function isSiteGone(storage: SafeStorage, nowMs: number): boolean {
  const cached = readCache(storage)
  return cached?.gone === true && nowMs - cached.at < SITE_GONE_TTL_MS
}

export async function loadTrackerConfig(
  deps: ConfigLoaderDeps,
): Promise<TrackerConfigPatch | null> {
  const cached = readCache(deps.storage)

  if (cached?.gone === true) {
    // Its own, longer TTL: a gone site's browsers should probe hourly, not
    // every five minutes. A stale marker falls through to the fetch below.
    if (deps.now() - cached.at < SITE_GONE_TTL_MS) return DISABLED_PATCH
  } else if (cached && deps.now() - cached.at < CONFIG_CACHE_TTL_MS) {
    return toRuntimeConfig(cached.body)
  }

  const fetchImpl = deps.fetchImpl
  if (!fetchImpl) return cached ? toRuntimeConfig(cached.body) : null

  const url = `${deps.collectorUrl.replace(/\/+$/, '')}/v1/tracker/config?key=${encodeURIComponent(
    deps.trackingKey,
  )}`

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      credentials: 'omit',
      mode: 'cors',
      ...(cached?.etag ? { headers: { 'If-None-Match': cached.etag } } : {}),
    })

    if (response.status === 304 && cached) {
      deps.storage.set(CONFIG_KEY, JSON.stringify({ ...cached, at: deps.now() }))
      return toRuntimeConfig(cached.body)
    }

    // 404 is the one failure with a defined meaning — `SITE_NOT_FOUND`, the
    // endpoint's only 404 — and the one that must not fall back to the last
    // known good configuration: that configuration is what keeps a dead site
    // sending. Arm the marker and stand down (ADR-0074).
    if (response.status === 404) {
      deps.storage.set(
        CONFIG_KEY,
        JSON.stringify({ etag: null, at: deps.now(), body: {}, gone: true } satisfies CachedConfig),
      )
      return DISABLED_PATCH
    }

    if (!response.ok) return cached ? toRuntimeConfig(cached.body) : null

    const body = (await response.json()) as TrackerConfigResponse
    deps.storage.set(
      CONFIG_KEY,
      JSON.stringify({ etag: response.headers.get('etag'), at: deps.now(), body }),
    )
    return toRuntimeConfig(body)
  } catch {
    // Offline, blocked or malformed: the tracker keeps working on defaults or
    // the last known good configuration.
    return cached ? toRuntimeConfig(cached.body) : null
  }
}
