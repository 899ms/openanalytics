/**
 * Whether this page's host is one the collector would accept events from
 * (ADR-0081, D1).
 *
 * The rule here is a **copy** of the server's, `isOriginAllowed` in
 * `packages/domain/src/ingest-admission.ts` (docs snapshot 02 §7.1 item 4). It
 * is copied rather than imported because the tracker imports nothing at all —
 * no workspace package, no bare specifier — and `pnpm run boundaries` fails the
 * build if that changes.
 *
 * A copy of a rule is a second opinion, and the only safe kind of second
 * opinion is one that cannot disagree. So the two halves must stay byte-for-byte
 * equivalent: the tracker must never refuse what the server would accept (it
 * would delete a paying customer's analytics with nobody watching), and never
 * accept what the server would refuse (it would promise data that is silently
 * dropped at the door). `tests/tracker/origin.test.ts` mirrors the server's own
 * cases for exactly that reason.
 *
 * The one deliberate difference is the input. The server is handed an `Origin`
 * header and parses a hostname out of it; here the hostname is already in hand
 * as `location.hostname`, so there is no URL to parse and no absent-header case
 * — a page always has a host.
 */

/**
 * Hosts a browser reports for a developer's own machine.
 *
 * They matter only for the wording of the warning, never for the verdict: a
 * local host is refused by `isHostAllowed` like any other host outside the
 * list. The list is closed on purpose — `localhost` and anything under it,
 * plus both loopback literals. `location.hostname` brackets an IPv6 literal
 * (`[::1]`), while a hand-written entry or a test may not, so both spellings
 * are here.
 */
const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]']

/** `*.localhost` resolves to the loopback by RFC 6761 and is used as such. */
const LOCAL_SUFFIX = '.localhost'

/** A leading wildcard label in a configured entry; the server strips it too. */
const WILDCARD_PREFIX = /^\*\./

/**
 * Whether this host can only ever be the developer's own machine.
 *
 * A local host cannot be put on a site's allowlist at all — the domain rule
 * requires a dot, so `localhost` is not a domain — which is why its message
 * says "open the deployed site" instead of "add it under Settings".
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase()
  return LOCAL_HOSTS.includes(host) || host.endsWith(LOCAL_SUFFIX)
}

/**
 * The server's admission rule, asked of this page's own host.
 *
 * An empty list means the customer has not configured one, which is not a deny
 * — a self-hosted deployment that never opened the setting keeps counting every
 * visit, local ones included. A configured list denies everything outside it.
 *
 * Matching is exact or under a dot boundary. Plain suffix matching would make
 * `notexample.com` count as `example.com`.
 */
export function isHostAllowed(hostname: string, allowedDomains: readonly string[]): boolean {
  if (allowedDomains.length === 0) return true

  const host = hostname.trim().toLowerCase()
  if (host === '') return false

  return allowedDomains.some((configured) => {
    const domain = configured.trim().toLowerCase().replace(WILDCARD_PREFIX, '')
    // An empty entry would otherwise match `host.endsWith('.')` on nothing and
    // turn a stray comma in the dashboard into an open door.
    if (domain === '') return false
    return host === domain || host.endsWith(`.${domain}`)
  })
}

/**
 * The one console line a page on an excluded host gets (ADR-0081, D1).
 *
 * Built here rather than at the call site so both wordings can be asserted
 * without booting a browser. `host` carries the port because that is what the
 * developer sees in their address bar (`localhost:3000`), while the verdict
 * above is taken on the port-less `hostname` the server would compare.
 *
 * This does not breach ADR-0057 F6, which keeps the tracker quiet in a
 * *visitor's* console: the line can only appear on a host the site's own list
 * excludes, which a visitor never reaches.
 */
export function unallowedHostMessage(input: {
  readonly host: string
  readonly hostname: string
  readonly allowedDomains: readonly string[]
}): string {
  const domains = input.allowedDomains.join(', ')

  if (isLocalHost(input.hostname)) {
    return (
      `[oa] Tag loaded on ${input.host}, but visits are only counted from ${domains}. ` +
      `A local host cannot be allowed; open the deployed site to see data.`
    )
  }

  return (
    `[oa] Tag loaded on ${input.host}, which is not on this site's allowed domains ` +
    `(${domains}). Add it under Settings → Domains, or open the site at ${input.allowedDomains[0] ?? ''}.`
  )
}
