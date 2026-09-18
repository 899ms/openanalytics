"use client";

/**
 * One home for "which clock is this dashboard on".
 *
 * The stored preference (`GET/PATCH /v1/me/preferences`) arrives flattened on
 * the Better Auth session as `user.timezone`; `null` means the user has never
 * chosen — it does NOT mean UTC — and the browser's own zone stands in. The
 * resolved value is what every analytics read sends as its `timezone`
 * parameter; the server never applies the preference behind the frontend's
 * back.
 */

export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

/**
 * Whether this browser can actually cut a calendar in `zone`.
 *
 * The zone a board reports in is not always one this build knows. It can come
 * back from `sessionStorage`, where a reader's pick is a string anybody can
 * edit by hand; or off the site's own column, which the api accepted against a
 * tzdb newer than the reader's ICU — `Europe/Kyiv` is the standing example. An
 * unrecognised id is not a wrong answer, it is a `RangeError` out of the first
 * `Intl` that sees it, and the first one to see it is the range math every
 * panel on the screen waits for: the board does not degrade, it stops.
 */
export function isUsableTimezone(
  zone: string | null | undefined
): zone is string {
  if (typeof zone !== "string" || zone === "") return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone }).format();
    return true;
  } catch {
    return false;
  }
}

/** The zone the dashboard runs on: the stored choice, else the browser's. */
export function resolveTimezone(
  preferred: string | null | undefined
): string {
  return preferred ?? browserTimezone();
}

/** `user.timezone` off a Better Auth session object, tolerating absence. */
export function sessionTimezone(user: unknown): string | null {
  if (typeof user !== "object" || user === null) return null;
  const value = (user as { timezone?: unknown }).timezone;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Which clock a set of analytics windows is cut in (ADR-0079 D5).
 *
 * One rule, in one place, because three surfaces ask it and they used to
 * answer differently: the private dashboard took the reader's own zone, the
 * share board took the site's, and a widget takes the site's server-side. Two
 * people looking at one site should see the same day boundary unless one of
 * them asked for a different one — so the site's zone is the default, and a
 * reader's own preference is what happens when the site has not named one.
 *
 * In order:
 *
 * 1. `chosen` — this visit's explicit pick from the header pill. It moves the
 *    view and writes nothing.
 * 2. `remembered` — the same pick, read back after a refresh.
 * 3. `site` — `sites.reporting_timezone` (ADR-0044). The site's own clock, and
 *    the one every widget and share link already reports in. Since migration
 *    0046 every site has one (ADR-0079 D5), so on a loaded screen the chain
 *    ends here unless the reader asked for something else.
 * 4. `preference` — the account's stored zone (ADR-0026, amended by ADR-0079
 *    D5 from default to fallback). Absent on the anonymous surfaces, which is
 *    why the share board simply passes nothing here.
 * 5. the browser's zone, which is never null and ends the chain.
 *
 * Steps 4 and 5 are not dead code now that step 3 always answers: they are what
 * the share board renders while its identity read is still in flight, and what
 * a browser whose ICU does not know the site's zone falls back to.
 *
 * Each step has to be a zone this browser can *use*, not merely a non-null
 * string: a step that names something `Intl` refuses is a step that has no
 * answer, so the chain moves on to the next one rather than handing a
 * `RangeError` to the calendar math downstream. See `isUsableTimezone`.
 */
export function resolveViewingTimezone(picks: {
  chosen?: string | null;
  remembered?: string | null;
  site?: string | null;
  preference?: string | null;
}): string {
  const chain = [
    picks.chosen,
    picks.remembered,
    picks.site,
    picks.preference,
    browserTimezone(),
  ];
  for (const candidate of chain) {
    if (isUsableTimezone(candidate)) return candidate;
  }
  // Every step failed, the browser's own answer included — which takes a
  // browser with no usable zone at all. UTC is the one that cannot fail.
  return "UTC";
}
