import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetBrowser } from './harness.ts'

/**
 * Booting on a host the site's allowlist excludes (ADR-0081, D1).
 *
 * The whole claim is about a page that *is* installed: the tag loads, the first
 * pageview leaves before configuration arrives and is refused at the door as it
 * always was, and then the tracker reads the list it has been handed all along
 * and stands the page down — saying so exactly once, in a console the site's own
 * developer is looking at.
 *
 * Shaped like `gone-boot.test.ts`: a real `<script>` tag, stubbed browser
 * capabilities, the entry module imported so its top-level `boot()` runs. The
 * happy-dom page is `https://shop.example.com/` and its host cannot be changed
 * from inside a test, so the allowlist a test hands back from the config
 * endpoint is what decides the verdict here. The local-host *wording* — the one
 * branch that needs a `localhost` page — is proven against every spelling in
 * `origin.test.ts` instead.
 */

const TRACKING_KEY = 'oa_pub_live_abcdef123456'
const COLLECTOR_URL = 'https://collect.example.com'

let sent: { url: string }[] = []
let allowedDomains: string[] | undefined = []

const originalFetch = globalThis.fetch
const originalSendBeacon = globalThis.navigator.sendBeacon

function stubCapabilities(): void {
  const globals = globalThis as unknown as Record<string, unknown>
  globals['fetch'] = (url: string) => {
    sent.push({ url })
    if (url.includes('/v1/tracker/config')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            config_version: 1,
            ...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
          }),
          { status: 200, headers: { 'content-type': 'application/json', etag: '"cfg-1"' } },
        ),
      )
    }
    return Promise.resolve(new Response(null, { status: 202 }))
  }
  ;(globalThis.navigator as unknown as Record<string, unknown>)['sendBeacon'] = (url: string) => {
    sent.push({ url })
    return true
  }
}

async function boot(): Promise<void> {
  const script = document.createElement('script')
  script.setAttribute('data-key', TRACKING_KEY)
  script.setAttribute('data-collector', COLLECTOR_URL)
  document.head.appendChild(script)

  vi.resetModules()
  await import('../../apps/tracker/src/browser.ts')
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const batches = (): { url: string }[] =>
  sent.filter((request) => request.url.endsWith('/v1/events'))

beforeEach(() => {
  resetBrowser()
  sent = []
  allowedDomains = []
  stubCapabilities()
})

afterEach(() => {
  const globals = globalThis as unknown as Record<string, unknown>
  const tracker = globals['oa'] as { stop(): void } | undefined
  tracker?.stop()
  delete globals['oa']
  for (const node of Array.from(document.head.querySelectorAll('script'))) node.remove()
  resetBrowser()
  vi.restoreAllMocks()
  globals['fetch'] = originalFetch
  ;(globalThis.navigator as unknown as Record<string, unknown>)['sendBeacon'] = originalSendBeacon
})

describe('boot on a host the allowlist excludes (ADR-0081 D1)', () => {
  it('warns once across two config applies and sends nothing further', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Not `example.com`: the page is `shop.example.com`, which that entry
    // covers at the dot boundary, exactly as the collector would.
    allowedDomains = ['example.org']

    await boot()
    await settle()

    // The first pageview left before configuration arrived, which is the design
    // (a pageview that waited for a config round-trip would be lost on every
    // fast bounce). It is refused by the collector exactly as before.
    expect(batches()).toHaveLength(1)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toBe(
      "[oa] Tag loaded on shop.example.com, which is not on this site's allowed domains " +
        '(example.org). Add it under Settings → Domains, or open the site at example.org.',
    )

    // A route change re-applies configuration (ADR-0034 D4). The patch is
    // applied again; the line is not written again.
    window.history.pushState(null, '', '/pricing/teams')
    await settle()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(batches()).toHaveLength(1)
  })

  it('says nothing on a host the list covers, and keeps counting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A listed domain covers its subdomains, which is the server's rule too.
    allowedDomains = ['example.com', 'shop.example.com']

    await boot()
    await settle()

    expect(warn).not.toHaveBeenCalled()

    window.history.pushState(null, '', '/pricing/teams')
    await settle()

    expect(batches()).toHaveLength(2)
  })

  it('says nothing when the site has configured no domains', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A self-hosted deployment with an empty list keeps counting every visit,
    // local ones included. Unchanged by D1, and silent about it.
    allowedDomains = []

    await boot()
    await settle()

    expect(warn).not.toHaveBeenCalled()
    expect(batches()).toHaveLength(1)
  })

  it('says nothing when the response carries no allowlist at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // An older cached body, or a deployment that does not send the field. A
    // missing list must never silence a tracker the server would have counted.
    allowedDomains = undefined

    await boot()
    await settle()

    expect(warn).not.toHaveBeenCalled()

    window.history.pushState(null, '', '/pricing/teams')
    await settle()

    expect(batches()).toHaveLength(2)
  })
})
