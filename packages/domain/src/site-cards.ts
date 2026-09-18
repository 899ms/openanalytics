/**
 * The sites-grid card figures: the week window and the sparkline assembly
 * (ADR-0080).
 *
 * Pure, and here rather than in the api route, because everything difficult
 * about this feature is calendar arithmetic that has exactly one correct answer
 * per input and no infrastructure of any kind: which Mondays the window spans,
 * where a young site's series starts, and which gaps are zeros. A bug in any of
 * those is a wrong-shaped line on a card, which nobody reports and no integration
 * test notices.
 *
 * **Every boundary here is UTC**, which is the one place in the product that is
 * not the site's own reporting zone (ADR-0080 D3, a deliberate departure from
 * ADR-0079 D5). One statement answers the whole account and `toStartOfWeek` takes
 * a single constant timezone, so per-site week boundaries are not expressible in
 * it; the fifteen-minute path that could express them is capped at 400 days,
 * which is not "all time". The card draws an unlabelled line with no axis, so the
 * choice is not observable in it.
 */

const MS_PER_DAY = 86_400_000
const MS_PER_WEEK = 7 * MS_PER_DAY

/** How many weekly points a card's sparkline carries at most. */
export const SITE_CARD_SPARKLINE_WEEKS = 40

/**
 * The UTC Monday that starts the ISO week containing `at`.
 *
 * Mode 1 of ClickHouse's `toStartOfWeek` is the same reading — weeks begin on
 * Monday — so a bucket label this function computes and one the gateway groups
 * by are the same instant, which is what lets the api index rows by week without
 * re-parsing a calendar.
 */
export function startOfUtcIsoWeek(at: Date): Date {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 0, 0, 0, 0))
  // getUTCDay: 0 = Sunday. Monday-relative index is (day + 6) % 7.
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
  return day
}

export interface SiteCardWindow {
  /** Inclusive lower bound: the Monday `weeks - 1` weeks before the current one. */
  readonly from: string
  /** Exclusive upper bound: next Monday. Also the all-time totals' upper bound. */
  readonly to: string
  /** Every week start in `[from, to)`, oldest first — the sparkline's x axis. */
  readonly weekStarts: readonly string[]
}

/**
 * The trailing window the card plots, anchored on `now`.
 *
 * The current week is **included** as the last point, still filling. A card whose
 * newest point was last week would look a week stale to anyone who just watched
 * a visitor arrive, and the alternative — showing a partial bar differently —
 * needs an axis the card does not have.
 *
 * `to` is next Monday rather than `now`, so the window is a whole number of whole
 * weeks and the gateway can refuse anything else (its parameter schema requires
 * Monday endpoints). It doubles as the all-time upper bound: no data can exist
 * after it.
 */
export function siteCardWindow(
  now: Date,
  weeks: number = SITE_CARD_SPARKLINE_WEEKS,
): SiteCardWindow {
  const currentWeek = startOfUtcIsoWeek(now)
  const toMs = currentWeek.getTime() + MS_PER_WEEK
  const fromMs = toMs - weeks * MS_PER_WEEK
  const weekStarts: string[] = []
  for (let ms = fromMs; ms < toMs; ms += MS_PER_WEEK) {
    weekStarts.push(new Date(ms).toISOString())
  }
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), weekStarts }
}

/**
 * Lays weekly counts onto the window, starting where the site's history does.
 *
 * Two different kinds of missing week, and collapsing them is the defect this
 * function exists to prevent:
 *
 *   * **Before the site's history begins** there was nothing to measure, so
 *     those weeks are dropped entirely. A site collecting for three weeks gets
 *     three points, not three points behind 37 zeros — which would draw a flat
 *     line with a spike at the end and read as a traffic collapse that never
 *     happened.
 *   * **Inside that history** a week with no rows is a real zero: nobody came.
 *     It is filled in, because dropping it would compress the x axis and move
 *     every later point left (the `admin-pulse` precedent).
 *
 * **Where the history begins is the EARLIER of `first_event_at`'s week and the
 * oldest week the rollup actually has data in.** `first_event_at` alone was the
 * first answer and it is wrong for a specific, live population: ADR-0027 shipped
 * after some sites already had traffic and existing sites were never backfilled,
 * so for them the field records the first event to arrive *after* that release
 * rather than their real first one. Measured on production 2026-09-12, one site
 * in six had a rollup week (7 visitors) sitting before its `first_event_at`
 * week, and trimming on the field alone silently dropped it.
 *
 * Taking the minimum keeps both halves honest: the field still starts the series
 * for a site whose rollup is empty at the front (so a quiet first fortnight is
 * still plotted as zeros rather than cut off), and real data is never hidden
 * because a metadata field disagrees with it. Data wins where they conflict,
 * because data is the thing the card is about.
 *
 * A site with no first event and no data yields an empty series. That is not the
 * same as `null`, which the caller uses for "could not compute".
 */
export function assembleSparkline(input: {
  readonly window: SiteCardWindow
  readonly firstEventAt: Date | null
  /** Unique visitors per week start (ISO instant), as the gateway merged them. */
  readonly weekly: ReadonlyMap<string, number>
}): number[] {
  const candidates: number[] = []
  if (input.firstEventAt !== null) {
    candidates.push(startOfUtcIsoWeek(input.firstEventAt).getTime())
  }
  // `weekly` is already confined to the window, so its oldest key cannot pull
  // the series past the window's own left edge.
  for (const week of input.weekly.keys()) candidates.push(Date.parse(week))
  if (candidates.length === 0) return []

  const startsAt = Math.min(...candidates)
  const series: number[] = []
  for (const week of input.window.weekStarts) {
    if (Date.parse(week) < startsAt) continue
    series.push(input.weekly.get(week) ?? 0)
  }
  return series
}
