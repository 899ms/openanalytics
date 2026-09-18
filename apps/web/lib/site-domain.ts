/**
 * A site's domain, and what the two waiting screens make of where its tag was
 * seen (ADR-0081, D3/D4).
 *
 * Deliberately import-free. `cleanDomain` used to live in the add-site dialog
 * and the sighting helpers imported it from there, which pulled a component
 * tree into what is a handful of string rules — and put the rules out of reach
 * of the unit project, whose compiler resolves imports the Node way and this
 * app's the bundler way. A module with no imports typechecks under both, so
 * `tests/unit/web-site-domain.test.ts` can pin every rule here without a
 * second vitest project or a path alias.
 *
 * On the sightings: a site with no events is two completely different
 * situations wearing one face — the script is not on the page at all, or it is
 * on the page and the origin allowlist is refusing everything it sends. Until
 * the collector began recording where the tag fetched its configuration, the
 * product could not tell them apart, and so said the same useless sentence to
 * both ("nothing has reached us yet") while a developer stood on
 * `localhost:3000` watching a network tab full of requests.
 *
 * Everything here is pure, and deliberately so: the screens differ in voice and
 * typography and should keep differing, but they must not differ about which
 * host was seen, whether it counts, or what can be done about it. Nothing in
 * here re-derives `allowed`. That flag is the collector's own verdict from
 * `isOriginAllowed`, taken at the moment of the sighting against the list the
 * ingest gate uses, and recomputing it in a browser could only ever produce a
 * second opinion that disagrees with the door.
 */

/**
 * A bare hostname with at least one dot — what the domains allowlist takes.
 *
 * The same shape `PATCH /v1/sites/{id} {domains}` validates on the server, so
 * a value that passes here is one the write will accept; `localhost` never
 * does, because a single label is not a domain.
 */
export function cleanDomain(value: string): string | null {
  const bare = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
    bare
  )
    ? bare
    : null;
}

/**
 * One row of `SiteSummary.tag_sightings`, spelled structurally so this module
 * needs no import: the generated `SiteSummary` is assignable to
 * `SightingCarrier` and the compiler checks that at every call site.
 */
export type TagSighting = {
  readonly origin: string;
  readonly seen_at: string;
  readonly allowed: boolean;
};

/** The slice of a site read these helpers look at. */
export type SightingCarrier = {
  readonly tag_sightings?: readonly TagSighting[] | null;
};

/**
 * Which of the three things a sighting says.
 *
 * `allowed` is the happy wait: the tag is on a page whose events the collector
 * takes, so the first one is in flight. The other two are both "nothing will
 * ever arrive from here", split by whether anything can be done about it —
 * `local` cannot be allowed at all, `foreign` is one PATCH away.
 */
export type SightingKind = "allowed" | "local" | "foreign";

/**
 * Hosts a browser reports for the developer's own machine.
 *
 * The same closed list the tracker carries (`apps/tracker/src/origin.ts`), for
 * the same reason: it decides wording, never admission. `location.hostname`
 * brackets an IPv6 literal and a hand-written one may not, so both spellings
 * are here.
 */
const LOCAL_HOSTS: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
];

/** `*.localhost` resolves to the loopback by RFC 6761 and is used as such. */
const LOCAL_SUFFIX = ".localhost";

/** The origin the collector records when the request carried no `Origin`. */
const NO_ORIGIN = "(none)";

/**
 * Whether this host can only ever be the developer's own machine.
 *
 * It matters because a local host cannot be put on the allowlist at all — the
 * domain rule requires a dot — so the only honest advice is "open the
 * deployed site", never "add it under Settings".
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return LOCAL_HOSTS.includes(host) || host.endsWith(LOCAL_SUFFIX);
}

/**
 * The host to print for a sighting — with its port, because `localhost:3000`
 * is what the developer sees in their address bar and `localhost` is not.
 *
 * `null` for anything that is not a parseable origin, which is the `(none)`
 * row: a request with no `Origin` header is a server render or a `curl`, and
 * neither is a page the tag is running on. Callers treat `null` as "no
 * sighting to show" rather than printing a literal nobody can act on.
 */
export function sightingHost(origin: string): string | null {
  if (origin === NO_ORIGIN) return null;
  try {
    return new URL(origin).host || null;
  } catch {
    return null;
  }
}

/** The same origin's host without its port — what the allowlist compares. */
function sightingHostname(origin: string): string | null {
  if (origin === NO_ORIGIN) return null;
  try {
    return new URL(origin).hostname || null;
  } catch {
    return null;
  }
}

/**
 * The newest sighting worth showing, or `null` when there is none.
 *
 * The contract sends the list newest first, so this is the head of it — with
 * the nameless rows stepped over. A `(none)` row can be the most recent thing
 * that happened to a site (somebody `curl`ed the config endpoint) while a real
 * browser sighting sits behind it, and hiding the browser behind the `curl`
 * would answer the question nobody asked.
 *
 * `undefined`, `null` and `[]` all arrive here as "nothing to show", but they
 * are not the same claim upstream (D3): `null` means the site read did not
 * compute the field, `[]` means it did and nothing has loaded the tag in 24
 * hours. Neither is a sighting, which is all this function is asked.
 */
export function newestSighting(
  site: SightingCarrier | null | undefined
): TagSighting | null {
  const sightings = site?.tag_sightings;
  if (!sightings) return null;
  return (
    sightings.find((sighting) => sightingHost(sighting.origin) !== null) ?? null
  );
}

/**
 * What the screens should say about this sighting.
 *
 * `allowed` comes straight off the row and is never recomputed here. The split
 * below it is about the wording only.
 */
export function sightingKind(sighting: TagSighting): SightingKind {
  if (sighting.allowed) return "allowed";
  const hostname = sightingHostname(sighting.origin);
  return hostname !== null && isLocalHost(hostname) ? "local" : "foreign";
}

/**
 * The hostname to append to the allowlist so this origin starts counting, or
 * `null` when there is nothing to append.
 *
 * It goes through `cleanDomain`, the add-site dialog's rule and the one the
 * server will apply to the PATCH, rather than a second regexp that could
 * accept something the write then refuses. A local host never survives it —
 * `localhost` has no dot — and the explicit check above it is there so the
 * reason is stated rather than inferred from a regexp's failure.
 *
 * The port is dropped on purpose: the allowlist is a list of hostnames, and
 * `preview.example.com:3000` is not one.
 */
export function allowableDomain(origin: string): string | null {
  const hostname = sightingHostname(origin);
  if (hostname === null || isLocalHost(hostname)) return null;
  return cleanDomain(hostname);
}
