import { describe, expect, it } from 'vitest'
import {
  AnalyticsQueryConfigError,
  DEFAULT_ANALYTICS_QUERY_CONFIG,
  chooseResolution,
  classifyTimezoneAlignment,
  isUtcDayAligned,
  isUtcHourAligned,
  isUtcMinuteAligned,
  loadAnalyticsQueryConfig,
  timezoneOffsetMinutes,
} from '@openanalytics/domain'

/**
 * Rollup selection (docs snapshot 02 §15, plan Milestone 7 items 2 and 7).
 *
 * The invariant under test is that the function never hands back a resolution
 * that would misattribute buckets: a non-UTC day composes from the atom rollup,
 * and an offset the atom cannot express is refused at hour/day grain rather than
 * answered wrong. Since ADR-0079 step 3 the atom is fifteen minutes, so every
 * offset in force since 1972 composes and only a historical range can be
 * refused.
 */

const UTC = 'UTC'
const NY = 'America/New_York' // whole-hour, DST
const BERLIN = 'Europe/Berlin' // whole-hour, DST
const KOLKATA = 'Asia/Kolkata' // +05:30, no DST
const KATHMANDU = 'Asia/Kathmandu' // +05:45, no DST
// -10:40 until 1979-10-01: the last offset in the tz database that is not a
// multiple of fifteen minutes, and so the only way to reach `unservable`.
const OLD_KIRITIMATI = 'Pacific/Kiritimati'

describe('timezoneOffsetMinutes', () => {
  it('reads whole-hour, half-hour and quarter-hour offsets from the tz database', () => {
    const winter = new Date('2026-01-15T12:00:00.000Z')
    const summer = new Date('2026-07-15T12:00:00.000Z')

    expect(timezoneOffsetMinutes(winter, UTC)).toBe(0)
    // New York shifts -300 (EST) → -240 (EDT) across the year; both whole-hour.
    expect(timezoneOffsetMinutes(winter, NY)).toBe(-300)
    expect(timezoneOffsetMinutes(summer, NY)).toBe(-240)
    expect(timezoneOffsetMinutes(winter, KOLKATA)).toBe(330)
    expect(timezoneOffsetMinutes(winter, KATHMANDU)).toBe(345)
  })
})

describe('the offsets an hour atom could not express', () => {
  /**
   * `isSubHourTimezone` used to live in the contracts package and answer this
   * for the interim wrapper: is this zone on a fraction of an hour, and so
   * refused? ADR-0079 step 3 made the atom fifteen minutes and step 5 deleted
   * the question with the wrapper that asked it. What is worth keeping is the
   * assertion the deletion rests on — those zones are served — pinned against
   * the authority, which walks the whole range rather than one instant.
   */
  it('are servable at every instant the old question named', () => {
    const at = new Date('2026-07-15T12:00:00.000Z')
    const to = new Date('2026-07-16T12:00:00.000Z')

    for (const zone of [UTC, NY, BERLIN, KOLKATA, KATHMANDU, 'Australia/Lord_Howe']) {
      expect(classifyTimezoneAlignment(at, to, zone)).not.toBe('unservable')
    }
    // Lord Howe is +10:30 in the austral winter and +11:00 in its DST: the
    // half-hour half was the one the hour atom could not hold, and both halves
    // are ordinary now.
    const winter = new Date('2026-06-01T00:00:00.000Z')
    const summer = new Date('2026-01-01T00:00:00.000Z')
    expect(timezoneOffsetMinutes(winter, 'Australia/Lord_Howe') % 60).toBe(30)
    expect(timezoneOffsetMinutes(summer, 'Australia/Lord_Howe') % 60).toBe(0)
  })
})

describe('classifyTimezoneAlignment', () => {
  const from = new Date('2026-07-01T00:00:00.000Z')
  const to = new Date('2026-07-31T00:00:00.000Z')

  it('separates utc from every other offset the atom can express', () => {
    expect(classifyTimezoneAlignment(from, to, UTC)).toBe('utc')
    expect(classifyTimezoneAlignment(from, to, NY)).toBe('local')
    expect(classifyTimezoneAlignment(from, to, BERLIN)).toBe('local')
    expect(classifyTimezoneAlignment(from, to, KOLKATA)).toBe('local')
    expect(classifyTimezoneAlignment(from, to, KATHMANDU)).toBe('local')
  })

  it('calls an offset that is not a multiple of fifteen minutes unservable', () => {
    // Kiritimati ran -10:40 until 1979-10-01. Forty minutes is not a whole
    // number of atoms, so no bucket in any family falls wholly inside one of its
    // local days — the one class of range this classifier still refuses, and the
    // most recent zone that can produce it.
    expect(
      classifyTimezoneAlignment(
        new Date('1975-01-01T00:00:00.000Z'),
        new Date('1975-02-01T00:00:00.000Z'),
        OLD_KIRITIMATI,
      ),
    ).toBe('unservable')
  })

  it('classifies a DST-spanning range by its worst end', () => {
    // Lord Howe is +11:00 in the austral summer and +10:30 in winter. Both are
    // multiples of the atom, so a range across the change stays servable — and
    // the walk is what makes that a measured fact rather than an assumption.
    const summer = new Date('2026-01-01T00:00:00.000Z')
    const winter = new Date('2026-06-01T00:00:00.000Z')
    expect(classifyTimezoneAlignment(summer, winter, 'Australia/Lord_Howe')).toBe('local')
  })
})

describe('chooseResolution — grain by span (§15)', () => {
  it('uses minute grain for today and shorter', () => {
    const decision = chooseResolution({
      from: '2026-07-23T00:00:00.000Z',
      to: '2026-07-23T18:00:00.000Z',
      timezone: UTC,
    })
    expect(decision.grain).toBe('minute')
    expect(decision.sourceRollup).toBe('1m')
    expect(decision.servable).toBe(true)
  })

  it('uses hour grain for a week', () => {
    const decision = chooseResolution({
      from: '2026-07-16T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: UTC,
    })
    expect(decision.grain).toBe('hour')
    expect(decision.sourceRollup).toBe('15m')
  })

  it('uses day grain for a quarter', () => {
    const decision = chooseResolution({
      from: '2026-04-24T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: UTC,
    })
    expect(decision.grain).toBe('day')
    expect(decision.sourceRollup).toBe('1d')
    expect(decision.composeDayFromHour).toBe(false)
  })
})

describe('chooseResolution — timezone composition', () => {
  it('reads the day rollup directly only for UTC', () => {
    const decision = chooseResolution({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
      timezone: UTC,
    })
    expect(decision.sourceRollup).toBe('1d')
    expect(decision.composeDayFromHour).toBe(false)
  })

  it('composes a non-UTC day from the atom rollup, never the day rollup', () => {
    // A DST zone over six months: day grain, but the *_1d table is UTC-bucketed
    // and would be wrong, so it composes from *_15m.
    const decision = chooseResolution({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
      timezone: NY,
    })
    expect(decision.grain).toBe('day')
    expect(decision.sourceRollup).toBe('15m')
    expect(decision.composeDayFromHour).toBe(true)
    expect(decision.servable).toBe(true)
  })

  it('serves a non-UTC zone at hour grain from the atom rollup', () => {
    const decision = chooseResolution({
      from: '2026-07-16T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: BERLIN,
    })
    expect(decision.grain).toBe('hour')
    expect(decision.sourceRollup).toBe('15m')
    expect(decision.composeDayFromHour).toBe(false)
  })
})

describe('chooseResolution — a quarter-hour offset is served like any other (ADR-0079)', () => {
  it('serves a quarter-hour zone at minute grain', () => {
    const decision = chooseResolution({
      from: '2026-07-23T00:00:00.000Z',
      to: '2026-07-23T12:00:00.000Z',
      timezone: KATHMANDU,
    })
    expect(decision.grain).toBe('minute')
    expect(decision.sourceRollup).toBe('1m')
    expect(decision.servable).toBe(true)
  })

  it('serves +05:30 at hour grain from the atom rollup', () => {
    const decision = chooseResolution({
      from: '2026-07-16T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: KOLKATA,
    })
    expect(decision.servable).toBe(true)
    expect(decision.grain).toBe('hour')
    expect(decision.sourceRollup).toBe('15m')
    expect(decision.timezoneAlignment).toBe('local')
  })

  it('serves +05:45 at day grain, composed from the atom rollup', () => {
    const decision = chooseResolution({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
      timezone: KATHMANDU,
    })
    expect(decision.servable).toBe(true)
    expect(decision.grain).toBe('day')
    expect(decision.sourceRollup).toBe('15m')
    expect(decision.composeDayFromHour).toBe(true)
  })

  it('still refuses an offset that is not a multiple of fifteen minutes', () => {
    const decision = chooseResolution({
      from: '1975-01-01T00:00:00.000Z',
      to: '1975-01-08T00:00:00.000Z',
      timezone: OLD_KIRITIMATI,
    })
    expect(decision.servable).toBe(false)
    expect(decision.timezoneAlignment).toBe('unservable')
    expect(decision.reason).toMatch(/multiple of fifteen minutes/)
  })
})

describe('chooseResolution — cost caps and bad input', () => {
  it('refuses a day range longer than the day-rollup cap', () => {
    const decision = chooseResolution({
      from: '1990-01-01T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
      timezone: UTC,
    })
    expect(decision.servable).toBe(false)
    expect(decision.reason).toMatch(/day-rollup cap/)
  })

  it('refuses a non-UTC day range past the hour-rollup cap', () => {
    // 2 years composed from hours exceeds the 400-day hour cap.
    const decision = chooseResolution({
      from: '2024-01-01T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z',
      timezone: NY,
    })
    expect(decision.servable).toBe(false)
    expect(decision.reason).toMatch(/hour-rollup cap/)
  })

  it('refuses an inverted range without throwing', () => {
    const decision = chooseResolution({
      from: '2026-07-23T00:00:00.000Z',
      to: '2026-07-22T00:00:00.000Z',
      timezone: UTC,
    })
    expect(decision.servable).toBe(false)
    expect(decision.reason).toMatch(/half-open/)
  })

  it('refuses an invalid timezone without throwing', () => {
    const decision = chooseResolution({
      from: '2026-07-23T00:00:00.000Z',
      to: '2026-07-23T12:00:00.000Z',
      timezone: 'Mars/Phobos',
    })
    expect(decision.servable).toBe(false)
  })
})

describe('analytics query config invariants', () => {
  it('defaults are internally consistent', () => {
    expect(DEFAULT_ANALYTICS_QUERY_CONFIG.MINUTE_GRAIN_MAX_HOURS).toBe(24)
    expect(DEFAULT_ANALYTICS_QUERY_CONFIG.HOUR_GRAIN_MAX_DAYS).toBe(31)
  })

  it('rejects a grain threshold that outruns its source cap', () => {
    expect(() => loadAnalyticsQueryConfig({ MINUTE_GRAIN_MAX_HOURS: '100' })).toThrow(
      AnalyticsQueryConfigError,
    )
  })

  it('rejects unordered source caps', () => {
    expect(() =>
      loadAnalyticsQueryConfig({ MAX_SPAN_HOUR_DAYS: '900', MAX_SPAN_DAY_DAYS: '400' }),
    ).toThrow(AnalyticsQueryConfigError)
  })
})

describe('UTC alignment helpers', () => {
  it('recognises minute, hour and day boundaries', () => {
    expect(isUtcMinuteAligned('2026-07-23T10:30:00.000Z')).toBe(true)
    expect(isUtcMinuteAligned('2026-07-23T10:30:15.000Z')).toBe(false)

    expect(isUtcHourAligned('2026-07-23T10:00:00.000Z')).toBe(true)
    expect(isUtcHourAligned('2026-07-23T10:30:00.000Z')).toBe(false)

    expect(isUtcDayAligned('2026-07-23T00:00:00.000Z')).toBe(true)
    expect(isUtcDayAligned('2026-07-23T01:00:00.000Z')).toBe(false)
  })
})
