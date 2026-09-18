import { describe, expect, it } from 'vitest'
import {
  chooseResolution,
  classifyTimezoneAlignment,
  derivePreviousPeriod,
  timezoneOffsetMinutes,
} from '@openanalytics/domain'
import { isHalfOpenContained } from '@openanalytics/contracts'

/**
 * Milestone 7 acceptance criterion 4 (docs snapshot 04): "the timezone, DST,
 * half-open range and comparison golden tests pass."
 *
 * These are the frozen numeric cases behind the resolution selector and the
 * comparison-range derivation. They are deliberately concrete — real IANA zones,
 * real DST dates, exact instants — so a change to the timezone maths that moves a
 * bucket by an hour, or a comparison window off by a period, fails here with a
 * legible diff rather than in a dashboard.
 */

const NY = 'America/New_York'
const LORD_HOWE = 'Australia/Lord_Howe'
const LONDON = 'Europe/London'

describe('interior sampling (the flagged classify defect)', () => {
  // The defect this pins is *sampling only the endpoints*. Europe/London is the
  // case that still has teeth after ADR-0079 step 3: it is offset zero at both
  // ends of a calendar year and +01:00 through the summer between. An end-only
  // classifier calls the year `utc`, reads `metrics_1d` straight, and gives
  // every British summer day the wrong twenty-four hours. The interior walk is
  // what demotes it to `local` and routes it through the composed-day path.
  const winter2026 = new Date('2026-01-15T00:00:00.000Z')
  const summer2026 = new Date('2026-07-15T00:00:00.000Z')
  const winter2027 = new Date('2027-01-15T00:00:00.000Z')

  it('both endpoints are UTC but the interior is not', () => {
    expect(timezoneOffsetMinutes(winter2026, LONDON)).toBe(0)
    expect(timezoneOffsetMinutes(winter2027, LONDON)).toBe(0)
    expect(timezoneOffsetMinutes(summer2026, LONDON)).toBe(60) // BST
  })

  it('classifies the winter-to-winter range as local, not by its ends', () => {
    expect(classifyTimezoneAlignment(winter2026, winter2027, LONDON)).toBe('local')
  })

  it('chooseResolution composes that range rather than reading the UTC day table', () => {
    const decision = chooseResolution({
      from: '2026-01-15T00:00:00.000Z',
      to: '2027-01-15T00:00:00.000Z',
      timezone: LONDON,
    })
    expect(decision.servable).toBe(true)
    expect(decision.timezoneAlignment).toBe('local')
    expect(decision.sourceRollup).toBe('15m')
    expect(decision.composeDayFromHour).toBe(true)
  })

  // Lord Howe is +11:00 in the austral summer (Oct–Apr) and +10:30 through the
  // standard-time months between. Before ADR-0079 that half hour was the reason
  // a summer-to-summer range was refused; fifteen-minute buckets fall wholly
  // inside a +10:30 local day, so the same range is now served — by the same
  // interior walk, which still sees both offsets and now approves both.
  it('serves the summer-to-summer Lord Howe range the hour atom refused', () => {
    const summer2027 = new Date('2027-01-15T00:00:00.000Z')
    expect(timezoneOffsetMinutes(summer2026, LORD_HOWE) % 60).not.toBe(0) // +10:30
    expect(classifyTimezoneAlignment(winter2026, summer2027, LORD_HOWE)).toBe('local')

    const decision = chooseResolution({
      from: '2026-01-15T00:00:00.000Z',
      to: '2027-01-15T00:00:00.000Z',
      timezone: LORD_HOWE,
    })
    expect(decision.servable).toBe(true)
    expect(decision.sourceRollup).toBe('15m')
  })
})

describe('DST days route through the composed-day path', () => {
  // The composed day path (composeDayFromHour) is what makes a 23h spring-forward
  // day and a 25h fall-back day come out right: ClickHouse's toStartOfDay(tz)
  // groups the atom rollup by local day, so a short/long day gets exactly its own
  // hours. The domain selector's job is to *route* a non-UTC day there and to keep
  // the range bucket-aligned; the 23/25h arithmetic itself is proven in the
  // ClickHouse rollup suite.
  it('a US spring-forward local day composes from the atom rollup', () => {
    // 2026-03-08 is the US spring-forward day (02:00 → 03:00 local). The local day
    // starts at 05:00Z (EST, -05:00) and the next local day starts at 04:00Z
    // (EDT, -04:00) — a 23-hour UTC span, both endpoints UTC-hour aligned.
    const decision = chooseResolution({
      from: '2026-03-08T05:00:00.000Z',
      to: '2026-03-09T04:00:00.000Z',
      timezone: NY,
    })
    expect(decision.grain).toBe('minute') // 23h ≤ the 24h minute band
    // Non-UTC zone: even at minute grain the range is bucket-aligned and servable.
    expect(decision.servable).toBe(true)
    expect(decision.timezoneAlignment).toBe('local')
  })

  it('a multi-month non-UTC day range composes from the atom rollup across DST', () => {
    const decision = chooseResolution({
      from: '2026-01-01T05:00:00.000Z',
      to: '2026-06-01T04:00:00.000Z',
      timezone: NY,
    })
    expect(decision.grain).toBe('day')
    expect(decision.sourceRollup).toBe('15m')
    expect(decision.composeDayFromHour).toBe(true)
    expect(decision.servable).toBe(true)
  })
})

describe('half-open boundary exactness', () => {
  const range = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' }

  it('includes from, excludes to', () => {
    expect(isHalfOpenContained(range, '2026-07-01T00:00:00.000Z')).toBe(true)
    expect(isHalfOpenContained(range, '2026-07-07T23:59:59.999Z')).toBe(true)
    // An event exactly at `to` belongs to the next range, never this one.
    expect(isHalfOpenContained(range, '2026-07-08T00:00:00.000Z')).toBe(false)
  })
})

describe('comparison-range derivation', () => {
  it('previous period is the equal-length window ending where the current begins', () => {
    const previous = derivePreviousPeriod({
      from: '2026-07-08T00:00:00.000Z',
      to: '2026-07-15T00:00:00.000Z',
    })
    expect(previous).toEqual({
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-07-08T00:00:00.000Z',
    })
  })

  it('is contiguous and non-overlapping with the current range', () => {
    const current = { from: '2026-07-08T00:00:00.000Z', to: '2026-07-15T00:00:00.000Z' }
    const previous = derivePreviousPeriod(current)
    expect(previous?.to).toBe(current.from) // touches at the boundary
    // Half-open, so the shared instant is in the current range only.
    expect(isHalfOpenContained(current, previous!.to)).toBe(true)
    expect(isHalfOpenContained(previous!, previous!.to)).toBe(false)
  })

  it('keeps an equal UTC span across a DST boundary (span-based, not calendar)', () => {
    // A 7-day current range whose previous period crosses the US spring-forward.
    const previous = derivePreviousPeriod({
      from: '2026-03-11T00:00:00.000Z',
      to: '2026-03-18T00:00:00.000Z',
    })
    const spanMs = Date.parse(previous!.to) - Date.parse(previous!.from)
    expect(spanMs).toBe(7 * 86_400_000)
  })

  it('returns null for a malformed or inverted range', () => {
    expect(derivePreviousPeriod({ from: 'not-a-date', to: '2026-07-01T00:00:00.000Z' })).toBeNull()
    expect(
      derivePreviousPeriod({ from: '2026-07-15T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' }),
    ).toBeNull()
  })
})

describe('UTC and non-UTC agree where they must', () => {
  it('a whole number of UTC days is day-aligned and served directly for UTC', () => {
    const decision = chooseResolution({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-04-01T00:00:00.000Z',
      timezone: 'UTC',
    })
    expect(decision.sourceRollup).toBe('1d')
    expect(decision.composeDayFromHour).toBe(false)
  })

  it('the same span for a UTC-offset-zero IANA zone classifies as utc too', () => {
    // Etc/UTC and UTC are distinct identifiers that must resolve identically.
    const a = classifyTimezoneAlignment(
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-04-01T00:00:00.000Z'),
      'UTC',
    )
    const b = classifyTimezoneAlignment(
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-04-01T00:00:00.000Z'),
      'Etc/UTC',
    )
    expect(a).toBe('utc')
    expect(b).toBe('utc')
  })
})
