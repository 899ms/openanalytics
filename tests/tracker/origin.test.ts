import { describe, expect, it } from 'vitest'
import { isHostAllowed, isLocalHost, unallowedHostMessage } from '../../apps/tracker/src/index.ts'

/**
 * The tracker's copy of the server's origin rule (ADR-0081, D1).
 *
 * The tracker imports nothing, so `isOriginAllowed` from `packages/domain` is
 * copied into `apps/tracker/src/origin.ts` rather than reused. A copied rule is
 * only safe while it cannot disagree with the original, so the cases below
 * mirror `tests/unit/ingest-admission.test.ts` one for one — including
 * `notexample.com`, which is the case plain suffix matching gets wrong and the
 * reason the rule has a dot boundary at all.
 *
 * The two halves take different inputs and that is deliberate: the server parses
 * a hostname out of an `Origin` header, while the browser already has one in
 * `location.hostname`. Everything after that parse must be identical.
 */

describe('isHostAllowed (mirrors isOriginAllowed)', () => {
  it('allows everything when the site has configured no domains', () => {
    expect(isHostAllowed('shop.example.com', [])).toBe(true)
    expect(isHostAllowed('localhost', [])).toBe(true)
  })

  it('matches a configured domain and its subdomains', () => {
    const domains = ['example.com']
    expect(isHostAllowed('example.com', domains)).toBe(true)
    expect(isHostAllowed('www.example.com', domains)).toBe(true)
    expect(isHostAllowed('shop.example.com', domains)).toBe(true)
    expect(isHostAllowed('deep.shop.example.com', domains)).toBe(true)
  })

  it('does not match a domain that merely ends with the configured one', () => {
    expect(isHostAllowed('notexample.com', ['example.com'])).toBe(false)
    expect(isHostAllowed('example.com.evil.test', ['example.com'])).toBe(false)
  })

  it('ignores case on both sides', () => {
    expect(isHostAllowed('EXAMPLE.com', ['example.com'])).toBe(true)
    expect(isHostAllowed('shop.example.com', ['Shop.Example.COM'])).toBe(true)
  })

  it('strips a leading wildcard label from a configured entry', () => {
    // `*.example.com` is how a customer writes "and its subdomains"; the server
    // strips the label and matches the bare domain, so the tag must too, or a
    // page the collector accepts would be told it is refused.
    expect(isHostAllowed('shop.example.com', ['*.example.com'])).toBe(true)
    expect(isHostAllowed('example.com', ['*.example.com'])).toBe(true)
  })

  it('never matches an empty configured entry', () => {
    // A stray comma in the dashboard must not become an open door, and must not
    // match every host through `endsWith('.')` either.
    expect(isHostAllowed('shop.example.com', ['', '  '])).toBe(false)
  })

  it('refuses a host the list excludes, local or not', () => {
    expect(isHostAllowed('localhost', ['example.com'])).toBe(false)
    expect(isHostAllowed('my-app-git-main.vercel.app', ['example.com'])).toBe(false)
    expect(isHostAllowed('', ['example.com'])).toBe(false)
  })
})

describe('isLocalHost', () => {
  it('names the hosts a browser reports for a developer machine', () => {
    expect(isLocalHost('localhost')).toBe(true)
    expect(isLocalHost('LOCALHOST')).toBe(true)
    expect(isLocalHost('app.localhost')).toBe(true)
    expect(isLocalHost('127.0.0.1')).toBe(true)
    expect(isLocalHost('::1')).toBe(true)
    // `location.hostname` brackets an IPv6 literal.
    expect(isLocalHost('[::1]')).toBe(true)
  })

  it('is not fooled by a domain that merely contains the word', () => {
    expect(isLocalHost('localhost.example.com')).toBe(false)
    expect(isLocalHost('notlocalhost')).toBe(false)
    expect(isLocalHost('example.com')).toBe(false)
  })
})

describe('unallowedHostMessage', () => {
  it('tells a local host that it can never be listed', () => {
    const message = unallowedHostMessage({
      host: 'localhost:3000',
      hostname: 'localhost',
      allowedDomains: ['example.com'],
    })

    expect(message).toBe(
      '[oa] Tag loaded on localhost:3000, but visits are only counted from example.com. ' +
        'A local host cannot be allowed; open the deployed site to see data.',
    )
  })

  it('tells any other host how to add itself, and where to look instead', () => {
    const message = unallowedHostMessage({
      host: 'my-app-git-main.vercel.app',
      hostname: 'my-app-git-main.vercel.app',
      allowedDomains: ['example.com', 'example.org'],
    })

    expect(message).toBe(
      "[oa] Tag loaded on my-app-git-main.vercel.app, which is not on this site's allowed " +
        'domains (example.com, example.org). Add it under Settings → Domains, or open the ' +
        'site at example.com.',
    )
  })

  it('names the port the developer sees, not the host the rule compared', () => {
    // The verdict is taken on `location.hostname`; the line quotes
    // `location.host`, because `localhost:3000` is what is in the address bar.
    expect(
      unallowedHostMessage({
        host: '127.0.0.1:8080',
        hostname: '127.0.0.1',
        allowedDomains: ['example.com'],
      }),
    ).toContain('127.0.0.1:8080')
  })
})
