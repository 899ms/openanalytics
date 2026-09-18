import { describe, expect, it } from 'vitest'
import {
  floorToUtcBoundary,
  overviewOperationFor,
  reportOperationFor,
  resolveAggregate,
  resolveSession,
  resolveTimeseries,
} from '../../apps/api/src/analytics/resolve.ts'

/**
 * The API-side adapter that names a gateway operation and snaps the requested
 * range to the source rollup's UTC boundary (plan Milestone 7 items 6/7). The
 * shared timezone brain is proven in the domain golden tests; this pins the
 * operation choice and the requested-vs-effective snapping.
 */

const NY = 'America/New_York' // whole-hour, DST
const KOLKATA = 'Asia/Kolkata' // +05:30 all year
const ISTANBUL = 'Europe/Istanbul' // whole-hour, +03:00 all year (no DST since 2016)
const KATHMANDU = 'Asia/Kathmandu' // +05:45 all year
// -10:40 until 1979-10-01 - the last offset the fifteen-minute atom cannot
// express, and so the only zone/range pair these resolvers still refuse.
const OLD_KIRITIMATI = 'Pacific/Kiritimati'
const PRE_1979 = { from: '1975-01-01T00:00:00.000Z', to: '1975-01-08T00:00:00.000Z' }

describe('floorToUtcBoundary', () => {
  it('floors to minute, hour and day', () => {
    expect(floorToUtcBoundary('2026-07-23T14:37:42.500Z', 'minute')).toBe(
      '2026-07-23T14:37:00.000Z',
    )
    expect(floorToUtcBoundary('2026-07-23T14:37:42.500Z', 'quarter')).toBe(
      '2026-07-23T14:30:00.000Z',
    )
    expect(floorToUtcBoundary('2026-07-23T14:37:42.500Z', 'day')).toBe('2026-07-23T00:00:00.000Z')
  })
})

describe('resolveTimeseries', () => {
  it('routes a today range to the minute operation, snapping to the minute', () => {
    const r = resolveTimeseries({
      from: '2026-07-23T00:00:00.000Z',
      to: '2026-07-23T14:37:42.000Z',
      timezone: 'UTC',
    })
    expect(r.servable).toBe(true)
    if (!r.servable) return
    expect(r.operation).toBe('analytics.timeseries_minute')
    expect(r.effectiveTo).toBe('2026-07-23T14:37:00.000Z')
    expect(r.withTimezone).toBe(true)
  })

  it('routes a UTC quarter to the day-utc operation without a timezone param', () => {
    const r = resolveTimeseries({
      from: '2026-04-24T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: 'UTC',
    })
    expect(r.servable).toBe(true)
    if (!r.servable) return
    expect(r.operation).toBe('analytics.timeseries_day_utc')
    expect(r.withTimezone).toBe(false)
  })

  it('routes a non-UTC multi-month day range to the composed-day operation', () => {
    const r = resolveTimeseries({
      from: '2026-01-01T05:00:00.000Z',
      to: '2026-06-01T04:00:00.000Z',
      timezone: NY,
    })
    expect(r.servable).toBe(true)
    if (!r.servable) return
    expect(r.operation).toBe('analytics.timeseries_day')
    expect(r.withTimezone).toBe(true)
  })

  it('serves a quarter-hour zone at hour grain, from the atom rollup', () => {
    const r = resolveTimeseries({
      from: '2026-07-16T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: KOLKATA,
    })
    expect(r.servable).toBe(true)
    if (!r.servable) return
    expect(r.operation).toBe('analytics.timeseries_hour')
    expect(r.sourceRollup).toBe('15m')
    expect(r.alignment).toBe('local')
  })

  it('snaps a quarter-hour range to the quarter, never to the hour', () => {
    // The gateway checks the endpoints against the atom's own boundary, so a
    // range floored to the hour would be a range the 15m operations reject.
    const r = resolveTimeseries({
      from: '2026-07-16T00:37:42.000Z',
      to: '2026-07-23T09:52:00.000Z',
      timezone: KOLKATA,
    })
    expect(r.servable).toBe(true)
    if (!r.servable) return
    expect(r.effectiveFrom).toBe('2026-07-16T00:30:00.000Z')
    expect(r.effectiveTo).toBe('2026-07-23T09:45:00.000Z')
  })

  it('still refuses an offset that is not a multiple of fifteen minutes', () => {
    const r = resolveTimeseries({ ...PRE_1979, timezone: OLD_KIRITIMATI })
    expect(r.servable).toBe(false)
  })
})

/**
 * The forced-grain surface (CP3): `?resolution=…`.
 *
 * Two properties are under test, and they pull in opposite directions. A caller
 * may force a grain the span-based ladder would not have chosen — hour buckets
 * over a quarter, week buckets at all — but may not force one the range or
 * timezone cannot honestly carry, and the refusals must be exactly the ones the
 * automatic path already makes for the same (range, timezone) pair. So the
 * matrix below walks every grain against a UTC, a whole-hour and a quarter-hour
 * zone at a short and a long span, and asserts the operation or the refusal.
 */
describe('resolveTimeseries with a forced resolution', () => {
  /** Six hours: inside every span cap, shorter than a single day bucket. */
  const SHORT = { from: '2026-07-23T00:00:00.000Z', to: '2026-07-23T06:00:00.000Z' }
  /** ~90 days: past the minute cap, inside the hour cap. */
  const QUARTER = { from: '2026-04-24T00:00:00.000Z', to: '2026-07-23T00:00:00.000Z' }
  /** ~500 days: past the 400d hour cap, inside the 3660d day cap. */
  const LONG = { from: '2025-03-11T00:00:00.000Z', to: '2026-07-23T00:00:00.000Z' }
  /** ~4000 days: past the day cap too. */
  const HUGE = { from: '2015-08-11T00:00:00.000Z', to: '2026-07-23T00:00:00.000Z' }

  const operationFor = (
    range: { from: string; to: string },
    timezone: string,
    resolution: 'minute' | 'hour' | 'day' | 'week',
  ): string | null => {
    const r = resolveTimeseries({ ...range, timezone, resolution })
    return r.servable ? r.operation : null
  }

  it('serves minute at any zone within the 48h minute-rollup cap, and refuses past it', () => {
    for (const timezone of ['UTC', ISTANBUL, KATHMANDU]) {
      // Every IANA offset is a whole number of minutes, so even +05:45 is honest
      // at minute grain — the automatic path says the same.
      expect(operationFor(SHORT, timezone, 'minute')).toBe('analytics.timeseries_minute')
      expect(operationFor(QUARTER, timezone, 'minute')).toBeNull()
    }
    // 48h exactly is the cap and is served; a minute past it is not.
    expect(
      operationFor(
        { from: '2026-07-21T00:00:00.000Z', to: '2026-07-23T00:00:00.000Z' },
        'UTC',
        'minute',
      ),
    ).toBe('analytics.timeseries_minute')
    expect(
      operationFor(
        { from: '2026-07-20T23:59:00.000Z', to: '2026-07-23T00:00:00.000Z' },
        'UTC',
        'minute',
      ),
    ).toBeNull()
  })

  it('serves hour for every zone up to the 400d cap, quarter-hour offsets included', () => {
    for (const range of [SHORT, QUARTER]) {
      expect(operationFor(range, 'UTC', 'hour')).toBe('analytics.timeseries_hour')
      expect(operationFor(range, ISTANBUL, 'hour')).toBe('analytics.timeseries_hour')
      expect(operationFor(range, KATHMANDU, 'hour')).toBe('analytics.timeseries_hour')
    }
    // Past the hour rollup's own scan cap, no zone can force it.
    expect(operationFor(LONG, 'UTC', 'hour')).toBeNull()
    expect(operationFor(LONG, ISTANBUL, 'hour')).toBeNull()
  })

  it('serves day from the day rollup for UTC and composes it from hours elsewhere', () => {
    // Short ranges included: forcing a coarse grain over a narrow window is
    // allowed — the caps are maxima, not minima.
    for (const range of [SHORT, QUARTER, LONG]) {
      expect(operationFor(range, 'UTC', 'day')).toBe('analytics.timeseries_day_utc')
    }
    expect(operationFor(QUARTER, ISTANBUL, 'day')).toBe('analytics.timeseries_day')
    expect(operationFor(QUARTER, KATHMANDU, 'day')).toBe('analytics.timeseries_day')
    // A non-UTC day composes from metrics_15m, so it inherits the atom cap even
    // though a UTC day of the same length is fine.
    expect(operationFor(LONG, ISTANBUL, 'day')).toBeNull()
    expect(operationFor(LONG, KATHMANDU, 'day')).toBeNull()
    expect(operationFor(HUGE, 'UTC', 'day')).toBeNull()
  })

  it('serves week from the same sources as day, under the same class rules', () => {
    const utc = resolveTimeseries({ ...QUARTER, timezone: 'UTC', resolution: 'week' })
    expect(utc.servable).toBe(true)
    if (!utc.servable) return
    expect(utc.operation).toBe('analytics.timeseries_week_utc')
    expect(utc.grain).toBe('week')
    expect(utc.sourceRollup).toBe('1d')
    // No zone parameter: a UTC week is a whole number of metrics_1d buckets.
    expect(utc.withTimezone).toBe(false)

    const local = resolveTimeseries({ ...QUARTER, timezone: ISTANBUL, resolution: 'week' })
    expect(local.servable).toBe(true)
    if (!local.servable) return
    expect(local.operation).toBe('analytics.timeseries_week')
    expect(local.grain).toBe('week')
    expect(local.sourceRollup).toBe('15m')
    expect(local.withTimezone).toBe(true)

    // Same caps as the day family, and a quarter-hour zone takes the same path.
    expect(operationFor(LONG, ISTANBUL, 'week')).toBeNull()
    expect(operationFor(LONG, 'UTC', 'week')).toBe('analytics.timeseries_week_utc')
    expect(operationFor(HUGE, 'UTC', 'week')).toBeNull()
    for (const range of [SHORT, QUARTER]) {
      expect(operationFor(range, KATHMANDU, 'week')).toBe('analytics.timeseries_week')
    }
  })

  it('names the reason a forced grain was refused, precisely enough to act on', () => {
    const unservable = resolveTimeseries({
      ...PRE_1979,
      timezone: OLD_KIRITIMATI,
      resolution: 'week',
    })
    expect(unservable.servable).toBe(false)
    if (unservable.servable) return
    expect(unservable.alignment).toBe('unservable')
    expect(unservable.reason).toMatch(/week/)
    expect(unservable.reason).toMatch(/multiple of fifteen minutes/)

    const tooLong = resolveTimeseries({ ...LONG, timezone: ISTANBUL, resolution: 'week' })
    expect(tooLong.servable).toBe(false)
    if (tooLong.servable) return
    expect(tooLong.reason).toMatch(/hour rollup/)
  })

  it('snaps the effective range to the source rollup, never to a week boundary', () => {
    // 2026-07-23 is a Thursday. The week grouping happens after the `[from, to)`
    // filter, exactly as a composed local day already does at a range edge — so
    // the effective range is the caller's, floored to the source bucket, and a
    // week bucket may legitimately be labelled before `from`.
    const utc = resolveTimeseries({
      from: '2026-07-23T13:37:42.000Z',
      to: '2026-08-20T09:15:00.000Z',
      timezone: 'UTC',
      resolution: 'week',
    })
    expect(utc.servable).toBe(true)
    if (!utc.servable) return
    expect(utc.effectiveFrom).toBe('2026-07-23T00:00:00.000Z')
    expect(utc.effectiveTo).toBe('2026-08-20T00:00:00.000Z')

    const local = resolveTimeseries({
      from: '2026-07-23T13:37:42.000Z',
      to: '2026-08-20T09:15:00.000Z',
      timezone: ISTANBUL,
      resolution: 'week',
    })
    expect(local.servable).toBe(true)
    if (!local.servable) return
    expect(local.effectiveFrom).toBe('2026-07-23T13:30:00.000Z')
    expect(local.effectiveTo).toBe('2026-08-20T09:15:00.000Z')
  })

  it('leaves the automatic path untouched when no resolution is asked for', () => {
    // The same four expectations the automatic suite above pins, restated here
    // against an explicitly-undefined parameter: passing the field through as
    // `undefined` must be indistinguishable from never having it.
    const cases: [
      { from: string; to: string; timezone: string },
      string,
      'minute' | 'hour' | 'day',
    ][] = [
      [{ ...SHORT, timezone: 'UTC' }, 'analytics.timeseries_minute', 'minute'],
      [{ ...QUARTER, timezone: 'UTC' }, 'analytics.timeseries_day_utc', 'day'],
      [{ ...QUARTER, timezone: NY }, 'analytics.timeseries_day', 'day'],
      [
        { from: '2026-07-16T00:00:00.000Z', to: '2026-07-23T00:00:00.000Z', timezone: 'UTC' },
        'analytics.timeseries_hour',
        'hour',
      ],
    ]
    for (const [input, operation, grain] of cases) {
      const bare = resolveTimeseries(input)
      const explicit = resolveTimeseries({ ...input, resolution: undefined })
      expect(bare).toEqual(explicit)
      expect(bare.servable).toBe(true)
      if (!bare.servable) continue
      expect(bare.operation).toBe(operation)
      expect(bare.grain).toBe(grain)
    }
    // And week is never chosen on its own — it only exists when asked for.
    for (const range of [SHORT, QUARTER, LONG]) {
      for (const timezone of ['UTC', ISTANBUL, NY]) {
        const r = resolveTimeseries({ ...range, timezone })
        if (r.servable) expect(r.grain).not.toBe('week')
      }
    }
  })
})

describe('resolveAggregate (overview & reports)', () => {
  it('uses the atom rollup for a non-UTC zone of any length up to the cap', () => {
    const r = resolveAggregate({
      from: '2026-01-01T05:00:00.000Z',
      to: '2026-06-01T04:00:00.000Z',
      timezone: NY,
    })
    expect(r.servable).toBe(true)
    if (!r.servable) return
    expect(r.sourceRollup).toBe('15m')
    expect(overviewOperationFor(r.sourceRollup)).toBe('analytics.overview_hour')
    expect(reportOperationFor('pages', r.sourceRollup)).toBe('analytics.pages_hour')
  })

  it('uses the day rollup for a long UTC range', () => {
    const r = resolveAggregate({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-06-01T00:00:00.000Z',
      timezone: 'UTC',
    })
    expect(r.servable).toBe(true)
    if (!r.servable) return
    expect(r.sourceRollup).toBe('1d')
    expect(overviewOperationFor(r.sourceRollup)).toBe('analytics.overview_day')
    expect(reportOperationFor('geography', r.sourceRollup)).toBe('analytics.geography_day')
  })

  it('uses the atom rollup for a short UTC range', () => {
    const r = resolveAggregate({
      from: '2026-07-16T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: 'UTC',
    })
    expect(r.servable).toBe(true)
    if (!r.servable) return
    expect(r.sourceRollup).toBe('15m')
  })

  it('serves a quarter-hour zone from the atom rollup, under the same operations', () => {
    const r = resolveAggregate({
      from: '2026-07-16T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: KOLKATA,
    })
    expect(r.servable).toBe(true)
    if (!r.servable) return
    expect(r.sourceRollup).toBe('15m')
    expect(r.alignment).toBe('local')
    expect(overviewOperationFor(r.sourceRollup)).toBe('analytics.overview_hour')
    expect(reportOperationFor('pages', r.sourceRollup)).toBe('analytics.pages_hour')
  })

  it('refuses an offset that is not a multiple of fifteen minutes', () => {
    const r = resolveAggregate({ ...PRE_1979, timezone: OLD_KIRITIMATI })
    expect(r.servable).toBe(false)
    if (r.servable) return
    expect(r.reason).toMatch(/multiple of fifteen minutes/)
  })

  it('refuses an inverted range', () => {
    const r = resolveAggregate({
      from: '2026-07-23T00:00:00.000Z',
      to: '2026-07-22T00:00:00.000Z',
      timezone: 'UTC',
    })
    expect(r.servable).toBe(false)
  })

  describe('with a forced resolution (CP3)', () => {
    const WEEK = { from: '2026-07-16T00:00:00.000Z', to: '2026-07-23T00:00:00.000Z' }
    const QUARTER = { from: '2026-04-24T00:00:00.000Z', to: '2026-07-23T00:00:00.000Z' }

    it('forces the day rollup on a short UTC range the ladder would have read hourly', () => {
      const r = resolveAggregate({ ...WEEK, timezone: 'UTC', resolution: 'day' })
      expect(r.servable).toBe(true)
      if (!r.servable) return
      expect(r.sourceRollup).toBe('1d')
      expect(r.grain).toBe('day')
      expect(overviewOperationFor(r.sourceRollup)).toBe('analytics.overview_day')
    })

    it('forces the hour rollup on a long UTC range the ladder would have read daily', () => {
      const r = resolveAggregate({ ...QUARTER, timezone: 'UTC', resolution: 'hour' })
      expect(r.servable).toBe(true)
      if (!r.servable) return
      expect(r.sourceRollup).toBe('15m')
      expect(overviewOperationFor(r.sourceRollup)).toBe('analytics.overview_hour')
    })

    it('refuses a forced day for a non-UTC zone: the day rollup buckets on UTC midnight', () => {
      const r = resolveAggregate({ ...QUARTER, timezone: ISTANBUL, resolution: 'day' })
      expect(r.servable).toBe(false)
      if (r.servable) return
      expect(r.reason).toMatch(/UTC-day rollup/)
    })

    it('serves a forced hour for a quarter-hour zone, and still refuses a forced day', () => {
      // The day refusal is not about the zone's offset - it is the UTC-day
      // rollup's own bucketing, which no non-UTC request can read.
      expect(resolveAggregate({ ...WEEK, timezone: KATHMANDU, resolution: 'hour' })).toMatchObject({
        servable: true,
        sourceRollup: '15m',
      })
      const day = resolveAggregate({ ...WEEK, timezone: KATHMANDU, resolution: 'day' })
      expect(day.servable).toBe(false)
      if (day.servable) return
      expect(day.reason).toMatch(/UTC-day rollup/)
    })

    it('still refuses an offset that is not a multiple of fifteen minutes', () => {
      for (const resolution of ['hour', 'day'] as const) {
        expect(
          resolveAggregate({ ...PRE_1979, timezone: OLD_KIRITIMATI, resolution }).servable,
        ).toBe(false)
      }
    })

    it('refuses minute and week, which range totals have no source for', () => {
      // Unreachable through the route (its enum is [hour, day]); asserted so the
      // resolver stays total on its own parameter type rather than relying on a
      // validation layer above it.
      for (const resolution of ['minute', 'week'] as const) {
        const r = resolveAggregate({ ...WEEK, timezone: 'UTC', resolution })
        expect(r.servable).toBe(false)
        if (r.servable) return
        expect(r.reason).toMatch(new RegExp(resolution))
      }
    })

    it('leaves the automatic path untouched when no resolution is asked for', () => {
      // Pinned to literals rather than compared against the same function with
      // `resolution: undefined` — that comparison would follow any regression.
      const week = resolveAggregate({ ...WEEK, timezone: 'UTC' })
      expect(week).toMatchObject({ servable: true, grain: 'hour', sourceRollup: '15m' })
      const quarter = resolveAggregate({ ...QUARTER, timezone: 'UTC' })
      expect(quarter).toMatchObject({ servable: true, grain: 'day', sourceRollup: '1d' })
      const quarterNy = resolveAggregate({ ...QUARTER, timezone: NY })
      expect(quarterNy).toMatchObject({ servable: true, grain: 'hour', sourceRollup: '15m' })
    })
  })
})

describe('resolveSession (finalized + provisional layer operations)', () => {
  it('serves a short range at hour grain from the 15m layers', () => {
    const r = resolveSession({
      from: '2026-07-23T00:00:00.000Z',
      to: '2026-07-23T14:00:00.000Z',
      timezone: 'UTC',
    })
    expect(r.servable).toBe(true)
    if (!r.servable) return
    expect(r.grain).toBe('hour')
    expect(r.finalizedOperation).toBe('analytics.sessions_finalized_hour')
    expect(r.provisionalOperation).toBe('analytics.sessions_provisional_hour')
    expect(r.splitUnit).toBe('quarter')
    expect(r.withTimezone).toBe(true)
  })

  it('serves a long UTC range at day grain from the 1d layers, splitting on the day', () => {
    const r = resolveSession({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-06-01T00:00:00.000Z',
      timezone: 'UTC',
    })
    expect(r.servable).toBe(true)
    if (!r.servable) return
    expect(r.grain).toBe('day')
    expect(r.finalizedOperation).toBe('analytics.sessions_finalized_day')
    expect(r.provisionalOperation).toBe('analytics.sessions_provisional_day')
    expect(r.splitUnit).toBe('day')
    expect(r.withTimezone).toBe(false)
  })

  it('composes local days from the 15m layers for a non-UTC long range, splitting on the quarter', () => {
    const r = resolveSession({
      from: '2026-01-01T05:00:00.000Z',
      to: '2026-06-01T04:00:00.000Z',
      timezone: NY,
    })
    expect(r.servable).toBe(true)
    if (!r.servable) return
    expect(r.grain).toBe('day')
    expect(r.finalizedOperation).toBe('analytics.sessions_finalized_day_local')
    expect(r.provisionalOperation).toBe('analytics.sessions_provisional_day_local')
    expect(r.splitUnit).toBe('quarter')
    expect(r.withTimezone).toBe(true)
  })

  it('serves a quarter-hour zone: the session rollups have a 15m grain now', () => {
    const r = resolveSession({
      from: '2026-07-23T00:00:00.000Z',
      to: '2026-07-23T06:00:00.000Z',
      timezone: KOLKATA,
    })
    expect(r.servable).toBe(true)
    if (!r.servable) return
    expect(r.grain).toBe('hour')
    expect(r.finalizedOperation).toBe('analytics.sessions_finalized_hour')
    expect(r.splitUnit).toBe('quarter')
  })

  it('still refuses an offset that is not a multiple of fifteen minutes', () => {
    const r = resolveSession({ ...PRE_1979, timezone: OLD_KIRITIMATI })
    expect(r.servable).toBe(false)
    if (r.servable) return
    expect(r.reason).toMatch(/multiple of fifteen minutes/)
  })
})
