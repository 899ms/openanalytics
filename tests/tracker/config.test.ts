import {
  CONFIG_CACHE_TTL_MS,
  SITE_GONE_TTL_MS,
  isSiteGone,
  loadTrackerConfig,
  safeStorage,
  toRuntimeConfig,
} from '../../apps/tracker/src/index.ts'
import { beforeEach, describe, expect, it } from 'vitest'
import { createHarness, resetBrowser, settle } from './harness.ts'

/**
 * The tracker's side of the configuration contract (docs snapshot 02 §11).
 *
 * Two caches: the CDN's, keyed by `ETag`, and this local one. Inside the soft
 * TTL there is no request at all; after it, the request is conditional. A failed
 * fetch is never fatal.
 */

const RESPONSE = {
  config_version: 7,
  site_timezone: 'Asia/Baku',
  allowed_domains: ['shop.example.com'],
  redact_query_keys: ['Order_Ref'],
  interaction_sampling: 0.25,
  heartbeat_interval_seconds: 30,
  features: { web_vitals: true, engagement: true, interactions: false, heartbeat: true },
}

interface FetchCall {
  url: string
  headers: Record<string, string> | undefined
}

function loader(calls: FetchCall[], respond: () => Response, now: () => number) {
  return {
    collectorUrl: 'https://collect.example.com',
    trackingKey: 'oa_pub_live_abcdef123456',
    storage: safeStorage(window.localStorage),
    now,
    fetchImpl: (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> | undefined })
      return Promise.resolve(respond())
    },
  }
}

const okResponse = () =>
  new Response(JSON.stringify(RESPONSE), {
    status: 200,
    headers: { ETag: '"oa-site_1-7"', 'Content-Type': 'application/json' },
  })

beforeEach(() => {
  resetBrowser()
})

describe('tracker config loader', () => {
  it('fetches, caches and normalizes the response', async () => {
    const calls: FetchCall[] = []
    const config = await loadTrackerConfig(loader(calls, okResponse, () => 1_000))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(
      'https://collect.example.com/v1/tracker/config?key=oa_pub_live_abcdef123456',
    )
    expect(config?.heartbeatIntervalSeconds).toBe(30)
    expect(config?.interactionSampling).toBe(0.25)
    expect(config?.features?.interactions).toBe(false)
    // Redaction keys are matched case-insensitively, so they are normalized once.
    expect(config?.redactQueryKeys).toEqual(['order_ref'])
  })

  it('makes no request at all inside the soft TTL', async () => {
    const calls: FetchCall[] = []
    await loadTrackerConfig(loader(calls, okResponse, () => 1_000))
    await loadTrackerConfig(loader(calls, okResponse, () => 1_000 + CONFIG_CACHE_TTL_MS - 1))

    expect(calls).toHaveLength(1)
  })

  it('revalidates with If-None-Match once the TTL lapses', async () => {
    const calls: FetchCall[] = []
    await loadTrackerConfig(loader(calls, okResponse, () => 1_000))

    const config = await loadTrackerConfig(
      loader(
        calls,
        () => new Response(null, { status: 304 }),
        () => 1_000 + CONFIG_CACHE_TTL_MS + 1,
      ),
    )

    expect(calls).toHaveLength(2)
    expect(calls[1]?.headers?.['If-None-Match']).toBe('"oa-site_1-7"')
    // A 304 keeps the cached configuration rather than falling back to defaults.
    expect(config?.heartbeatIntervalSeconds).toBe(30)
  })

  it('keeps the last known good configuration when the fetch fails', async () => {
    const calls: FetchCall[] = []
    await loadTrackerConfig(loader(calls, okResponse, () => 1_000))

    const config = await loadTrackerConfig(
      loader(
        calls,
        () => new Response(null, { status: 500 }),
        () => 1_000 + CONFIG_CACHE_TTL_MS + 1,
      ),
    )

    expect(config?.interactionSampling).toBe(0.25)
  })

  it('returns nothing rather than throwing when there is no cache and no network', async () => {
    const config = await loadTrackerConfig({
      collectorUrl: 'https://collect.example.com',
      trackingKey: 'oa_pub_live_abcdef123456',
      storage: safeStorage(window.localStorage),
      now: () => 1_000,
      fetchImpl: () => Promise.reject(new Error('offline')),
    })

    expect(config).toBeNull()
  })

  it('clamps values a malformed configuration might carry', async () => {
    const runtime = toRuntimeConfig({
      interaction_sampling: 4,
      heartbeat_interval_seconds: 1,
    })

    expect(runtime.interactionSampling).toBe(1)
    expect(runtime.heartbeatIntervalSeconds).toBe(5)
  })
})

describe('a gone site stands the tracker down (ADR-0074)', () => {
  const gone = () => new Response(null, { status: 404 })

  it('a 404 disables the tracker and arms the marker', async () => {
    const calls: FetchCall[] = []
    const config = await loadTrackerConfig(loader(calls, gone, () => 1_000))

    expect(config?.disabled).toBe(true)
    expect(isSiteGone(safeStorage(window.localStorage), 1_000)).toBe(true)
  })

  it('inside the gone TTL there is no request at all, well past the soft TTL', async () => {
    const calls: FetchCall[] = []
    await loadTrackerConfig(loader(calls, gone, () => 1_000))

    const config = await loadTrackerConfig(
      loader(calls, okResponse, () => 1_000 + CONFIG_CACHE_TTL_MS + 1),
    )

    expect(config?.disabled).toBe(true)
    expect(calls.length).toBe(1)
  })

  it('does not fall back to the last known good configuration on a 404', async () => {
    // The last known good configuration is precisely what keeps a dead site
    // sending; a 404 must replace it, not preserve it.
    const calls: FetchCall[] = []
    await loadTrackerConfig(loader(calls, okResponse, () => 1_000))

    const config = await loadTrackerConfig(
      loader(calls, gone, () => 1_000 + CONFIG_CACHE_TTL_MS + 1),
    )

    expect(config?.disabled).toBe(true)
  })

  it('past the gone TTL a healthy answer clears the marker and resumes', async () => {
    const calls: FetchCall[] = []
    await loadTrackerConfig(loader(calls, gone, () => 1_000))

    const revived = await loadTrackerConfig(
      loader(calls, okResponse, () => 1_000 + SITE_GONE_TTL_MS + 1),
    )

    expect(revived?.disabled).toBe(false)
    expect(revived?.interactionSampling).toBe(0.25)
    expect(isSiteGone(safeStorage(window.localStorage), 1_000 + SITE_GONE_TTL_MS + 2)).toBe(false)
  })

  it('a 500 still keeps the last known good configuration, as it always did', async () => {
    // The boundary the 404 branch must not blur: transient server faults keep
    // the old behaviour, or every deploy blip would silence healthy sites.
    const calls: FetchCall[] = []
    await loadTrackerConfig(loader(calls, okResponse, () => 1_000))

    const config = await loadTrackerConfig(
      loader(
        calls,
        () => new Response(null, { status: 500 }),
        () => 1_000 + CONFIG_CACHE_TTL_MS + 1,
      ),
    )

    expect(config?.disabled).toBe(false)
    expect(config?.interactionSampling).toBe(0.25)
  })
})

describe('the paused light (ADR-0074, amendment 2)', () => {
  const pausedResponse = () =>
    new Response(JSON.stringify({ ...RESPONSE, collection_paused: true }), {
      status: 200,
      headers: { ETag: '"oa-site_1-7-paused"', 'Content-Type': 'application/json' },
    })

  it('a paused configuration disables sending', async () => {
    const calls: FetchCall[] = []
    const config = await loadTrackerConfig(loader(calls, pausedResponse, () => 1_000))

    expect(config?.disabled).toBe(true)
    // Not the gone-marker: the site is alive, so the ordinary five-minute
    // cadence stays — that cadence IS the resume pulse.
    expect(isSiteGone(safeStorage(window.localStorage), 1_000)).toBe(false)
  })

  it('the next ordinary configuration clears the pause — absence is the resume signal', async () => {
    const calls: FetchCall[] = []
    await loadTrackerConfig(loader(calls, pausedResponse, () => 1_000))

    const resumed = await loadTrackerConfig(
      loader(calls, okResponse, () => 1_000 + CONFIG_CACHE_TTL_MS + 1),
    )

    expect(resumed?.disabled).toBe(false)
  })
})

describe('applying configuration to a running tracker', () => {
  it('uses per-site redaction keys on the next pageview', () => {
    const harness = createHarness()
    harness.tracker.applyConfig({ redactQueryKeys: ['order_ref'] })

    window.history.pushState(null, '', '/thanks?order_ref=A100&utm_source=google')

    const page = harness.eventsOfType('page_view').at(-1)?.['page'] as Record<string, unknown>
    expect(String(page['url'])).not.toContain('A100')
    expect(String(page['url'])).toContain('utm_source=google')
    harness.stop()
  })

  it('turns a signal off without restating the rest of the features', () => {
    const harness = createHarness()
    harness.tracker.applyConfig({ features: { heartbeat: false } })

    const before = harness.heartbeats().length
    harness.fireHeartbeatInterval()
    expect(harness.heartbeats().length).toBe(before)
    harness.stop()
  })

  it('disabled drops every signal at the emit gate (ADR-0074)', () => {
    const harness = createHarness()
    harness.tracker.applyConfig({ disabled: true })

    const before = harness.sent.length
    window.history.pushState(null, '', '/next-page')
    harness.tracker.track('signup')
    harness.fireHeartbeatInterval()
    harness.tracker.flush()
    harness.runTimers()

    expect(harness.sent.length).toBe(before)
    harness.stop()
  })

  it('disabled also stops the retry queue being drained (ADR-0081, D1)', async () => {
    // The `emit` gate empties the buffer, but not the queue: an event stranded
    // by an earlier failure would still be carried out by the next flush — the
    // unload one included — to a door the tracker now knows is shut. On an
    // excluded host that would be one last refused batch after the line that
    // said nothing further would be sent.
    const harness = createHarness()
    harness.respondWith(500)
    harness.tracker.track('signup')
    harness.runTimers()
    await settle()

    harness.respondWith(202)
    harness.tracker.applyConfig({ disabled: true })

    const before = harness.sent.length
    harness.tracker.flush()
    harness.runTimers()
    await settle()

    expect(harness.sent.length).toBe(before)
    harness.stop()
  })
})
