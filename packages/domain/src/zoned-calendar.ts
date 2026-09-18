import { timezoneOffsetMinutes } from '@openanalytics/contracts'

/**
 * Calendar arithmetic in an arbitrary IANA zone.
 *
 * Every window this product cuts starts and ends on a *site's* calendar
 * (ADR-0079 D5, migration 0046), and a calendar is not a duration: a local day
 * is 23 or 25 hours twice a year, and "the Monday that opens this week" is a
 * date before it is an instant. The two-pass offset conversion below is what
 * keeps those from being millisecond arithmetic that lands an hour out.
 *
 * It lives here rather than in `widget-range.ts` because it now has two
 * consumers with nothing else in common: the widget range resolver, which cuts
 * days, and the weekly digest, which cuts weeks and has to name the week it is
 * reporting on in every recipient's own site zone.
 */

/**
 * The zone's local calendar date at `instant`, as `[year, month, day]` with a
 * 1-based month.
 *
 * `en-CA` formats as `YYYY-MM-DD`, which is the one locale in wide use whose
 * default date order needs no part-by-part reassembly.
 */
export function localDateParts(instant: Date, timezone: string): [number, number, number] {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(instant)
    .split('-')
    .map(Number)
  return [year as number, month as number, day as number]
}

/**
 * The zone's local hour at `instant`, 0–23.
 *
 * `hourCycle: 'h23'` rather than `hour12: false`, because the latter renders
 * midnight as "24" in several locales — and a job that fires "at or after 09:00
 * local" would then fire at midnight too.
 */
export function localHour(instant: Date, timezone: string): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(instant),
  )
}

/**
 * The day of the week the local calendar date at `instant` falls on, `0` for
 * Sunday through `6` for Saturday — `Date`'s own numbering.
 *
 * Read off the local *date* rather than off the instant, because that is the
 * question: Monday in Auckland begins eleven hours before Monday in UTC, and a
 * job that asked `getUTCDay()` would fire on the wrong local day for a third of
 * the world.
 */
export function localWeekday(instant: Date, timezone: string): number {
  const [year, month, day] = localDateParts(instant, timezone)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/**
 * The UTC instant at which the calendar day containing `base` — shifted by whole
 * years, months or days **on that zone's calendar** — starts in `timezone`.
 *
 * The shift is applied through `Date.UTC`, so it is calendar arithmetic rather
 * than millisecond arithmetic: `{ days: -6 }` is six calendar days back even
 * across a 23- or 25-hour local day, and `{ months: -6 }` lands on the same day
 * of the month rather than 182 days earlier.
 *
 * **Two offset passes, and the second one is load-bearing.** The first converts
 * the target local midnight using the offset in force at the *UTC* instant of
 * that wall time, which is the wrong offset whenever the zone changes between
 * the two; the second re-reads the offset at the instant the first pass produced
 * and converges. Without it, a local midnight on the far side of a DST
 * transition lands an hour out — the error that moves a chart's first bucket
 * into the previous day. `timezoneOffsetMinutes` is the repository's existing
 * reader of the runtime tz database (it powers the gateway's own alignment
 * classification), so this cannot drift from what the query side believes.
 */
export function zonedDayStart(
  base: Date,
  timezone: string,
  shift: { years?: number; months?: number; days?: number } = {},
): Date {
  const [year, month, day] = localDateParts(base, timezone)
  const target = Date.UTC(
    year + (shift.years ?? 0),
    month - 1 + (shift.months ?? 0),
    day + (shift.days ?? 0),
  )
  const first = target - timezoneOffsetMinutes(new Date(target), timezone) * 60_000
  return new Date(target - timezoneOffsetMinutes(new Date(first), timezone) * 60_000)
}

/**
 * The UTC instant at which the ISO week containing `base` starts in `timezone`
 * — local Monday, 00:00 — shifted by whole weeks.
 *
 * Monday, matching `toStartOfWeek(…, 1, tz)`, which is the mode every week-grain
 * gateway operation uses (`analytics.timeseries_week`). A digest and a chart
 * that disagreed about where a week begins would be two products.
 *
 * The weekday is `localWeekday`'s, read off the local calendar date rather than
 * off the instant, so it cannot drift with the reader's own offset.
 */
export function zonedWeekStart(base: Date, timezone: string, shift: { weeks?: number } = {}): Date {
  // Days back to this local week's Monday; Sunday (0) is six days after it.
  const back = (localWeekday(base, timezone) + 6) % 7
  return zonedDayStart(base, timezone, { days: -back + (shift.weeks ?? 0) * 7 })
}

/**
 * The ISO week the local calendar date at `instant` belongs to, as `2026-W33`.
 *
 * Used as an idempotency key and as a label, which is why the year comes from
 * the ISO rule (the Thursday of the week decides it) rather than from the date's
 * own year: 1 January 2027 is `2026-W53`, and a key that called it `2027-W01`
 * would let the same week be sent twice.
 */
export function localIsoWeekKey(instant: Date, timezone: string): string {
  const [year, month, day] = localDateParts(instant, timezone)
  const d = new Date(Date.UTC(year, month - 1, day))
  // Thursday decides the year an ISO week belongs to.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${String(d.getUTCFullYear())}-W${String(week).padStart(2, '0')}`
}

/** The local calendar date at `instant` as `YYYY-MM-DD`, for a label a reader
 * checks against their own calendar rather than against a UTC clock. */
export function localDay(instant: Date, timezone: string): string {
  const [year, month, day] = localDateParts(instant, timezone)
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
