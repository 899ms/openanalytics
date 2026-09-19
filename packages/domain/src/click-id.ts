import { canonicalReferrerHost } from './referrer.ts'
import type { SanitizedUrl } from './event-sanitize.ts'

/**
 * The acquisition source a paid click id implies (ADR-0075, D-C1).
 *
 * ## The problem this solves
 *
 * A visitor who clicks a Google or Meta ad arrives with **no referrer**. The ad
 * platform's click interstitial is cross-origin and `strict-origin-when-cross-
 * origin` — every Chromium and Firefox default since 2020 — strips the header
 * down to an origin or removes it entirely, and for the ad domains it is removed
 * entirely. Measured on production over 90 days: 8,921 events carried a `gclid`
 * and 8,302 of them had `referrer_domain = ''`. Every one of those was reported
 * as **Direct**, which is not a small inaccuracy — it is the customer's paid
 * channel reporting as their organic one.
 *
 * The landing URL still carries the platform's own click id, because the
 * platform put it there to be read. So the source is knowable, and this module
 * is where it is read.
 *
 * ## Presence, never the value (D-C2)
 *
 * The click id's **value** is `[redacted]` in storage: `sanitizeUrl` runs every
 * surviving query value through `redactSensitiveText`, and a click id is long,
 * spaceless and mixed-alphabet — exactly `looksLikeOpaqueToken`. That is not a
 * defect to route around. `gclid=[redacted]` proves the visit came from Google
 * Ads just as completely as the raw id does, because the **key** is the signal
 * and the value only identifies the individual click. So this module reads
 * `SanitizedUrl.query`'s KEY SET and never dereferences a value beyond checking
 * that the parameter was present with something in it.
 *
 * That property is pinned by a test rather than left to convention: a `fbclid`
 * whose stored value is `[redacted]` must still derive `facebook.com`, so a
 * future edit to the redaction rules cannot silently switch attribution off.
 *
 * ## Why the mapped value goes through `canonicalReferrerHost`
 *
 * `referrer_domain` is a **grouping key** — the ORDER BY prefix of
 * `sources_15m`/`sources_1d`, the first-touch dimension of a session fact, a
 * column of the visitor trail (ADR-0028's module header states the rule). A
 * second spelling of one host silently splits one acquisition source into two
 * rollup rows that no reader can merge back, and the rollups are additive and
 * never rewritten. So the mapped host is canonicalised on the way out with the
 * same function every reported referrer goes through, and the table below is
 * written in the canonical form already — the call is the guard that keeps it
 * that way, not a transformation anyone is relying on.
 */

/**
 * Click-id query key → the canonical host of the platform that minted it.
 *
 * Every key here is also in `ATTRIBUTION_QUERY_KEYS`, or the collector would
 * never see it: the default redaction rule drops a query key it does not
 * recognise before this module is ever asked. A test pins the two lists against
 * each other.
 *
 * `gclsrc` is Google's companion parameter (it names which Google surface the
 * click came from) and appears on some Ads links without `gclid`, so it maps to
 * the same host rather than being ignored.
 */
export const CLICK_ID_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  gclid: 'google.com',
  gclsrc: 'google.com',
  fbclid: 'facebook.com',
  msclkid: 'bing.com',
  twclid: 'x.com',
  ttclid: 'tiktok.com',
  li_fat_id: 'linkedin.com',
  igshid: 'instagram.com',
  yclid: 'yandex.com',
})

/** The click-id keys, in the order they are tried. */
const CLICK_ID_KEYS: readonly string[] = Object.keys(CLICK_ID_SOURCES)

/** A source derived from a click id, and the key that proved it. */
export interface ClickIdSource {
  /** Canonical host, spelled the way `resolveReferrer` would have spelled it. */
  readonly domain: string
  /** The query key that produced it — stored so an inference stays auditable. */
  readonly key: string
}

/**
 * The click id on a sanitized landing URL, or `null`.
 *
 * Deterministic when a URL carries more than one: the first key of
 * `CLICK_ID_SOURCES` wins, and the order is the declaration order above. A URL
 * with both a `gclid` and an `fbclid` is a stitched-together link rather than two
 * clicks, and picking by a fixed order means two identical URLs always attribute
 * the same way — which is what a grouping key requires.
 *
 * A key present with an **empty** value is not a click. `?gclid=` is what a
 * broken template or a stripped parameter leaves behind, and inferring a paid
 * source from it would move real Direct traffic into a channel the customer is
 * paying for.
 */
export function clickIdSourceOf(sanitized: SanitizedUrl | null): ClickIdSource | null {
  if (sanitized === null) return null

  // Query keys are matched case-insensitively: the platforms all mint lowercase,
  // but a customer's own link shortener or CMS may re-case a parameter on the
  // way through, and a re-cased `FBCLID` is the same click.
  const present = new Map<string, string>()
  for (const [key, value] of Object.entries(sanitized.query)) {
    if (value !== '') present.set(key.toLowerCase(), value)
  }

  for (const key of CLICK_ID_KEYS) {
    if (!present.has(key)) continue
    const domain = canonicalReferrerHost(CLICK_ID_SOURCES[key] as string)
    if (domain === '') continue
    return { domain, key }
  }
  return null
}
