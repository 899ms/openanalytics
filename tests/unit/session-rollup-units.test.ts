import {
  SESSION_ROLLUP_15M_TABLE,
  SESSION_ROLLUP_1D_TABLE,
  SESSION_ROLLUP_BUCKET_FN,
  type SessionRollupUnit,
} from '@openanalytics/clickhouse'
import { describe, expect, it } from 'vitest'
import { REVENUE_ROLLUP_UNIT_MS } from '../../apps/worker/src/revenue/rollup-plan.ts'
import { dayBucketMs, quarterBucketMs } from '../../apps/worker/src/sessions/plan.ts'

/**
 * The unit dispatch of the two SWAP rollups (ADR-0079, steps 2 and 4).
 *
 * ## The bug this exists to make impossible
 *
 * Before step 2, `SessionRollupUnit` was `'1h' | '1d'` and the bucket function
 * was chosen by a ternary:
 *
 * ```ts
 * unit === '1h' ? 'toStartOfHour' : 'toStartOfDay'
 * ```
 *
 * Adding `'15m'` to that union is a one-line change that compiles, passes every
 * existing test, and is **silently wrong**: `'15m'` is not `'1h'`, so it takes
 * the else branch and every fifteen-minute aggregate is grouped by
 * `toStartOfDay`. The finalizer would then write DAY totals into
 * `session_rollups_15m` at day-aligned bucket starts. Nothing throws, no query
 * fails, and the table looks populated — the hour-equals-four-quarters check
 * would be the first thing to notice, long after the data was written.
 *
 * The fix was to make the mapping a total `Record` over the union, so the
 * omission is a compile error.
 *
 * ## And the direction it protects now
 *
 * Step 4 took `'1h'` back out: the hour views were dropped (migration 0027) and
 * the finalizer and the attribution job stopped writing `session_rollups_1h`
 * and `revenue_1h`. The `Record` earns its keep the other way round for that —
 * an entry left behind by the removal is as much a compile error as a missing
 * one — and the union is now the thing that makes "nothing writes the hour
 * grain" enforceable rather than merely believed. That claim is the reason the
 * tables can be left in place as frozen history.
 *
 * A compile error cannot be asserted from a passing test file, so what is
 * asserted here is the property that replaced it: every unit the code still
 * writes has its own bucket function and its own table, all distinct, and the
 * hour is not among them.
 */

const UNITS: readonly SessionRollupUnit[] = ['15m', '1d']

describe('session rollup unit dispatch (ADR-0079 steps 2 and 4)', () => {
  it('maps every unit to its own bucket function', () => {
    expect(SESSION_ROLLUP_BUCKET_FN).toEqual({
      '15m': 'toStartOfFifteenMinutes',
      '1d': 'toStartOfDay',
    })
  })

  it('gives the fifteen-minute unit an answer the old ternary got wrong', () => {
    // The exact expression step 2 replaced. Kept as a local so the claim is
    // demonstrated rather than asserted in a comment — and typed loosely,
    // because `'1h'` is not a unit any more and the point is what the ternary
    // did with a string it had no case for.
    const oldTernary = (unit: string): string => (unit === '1h' ? 'toStartOfHour' : 'toStartOfDay')

    expect(oldTernary('15m')).toBe('toStartOfDay')
    expect(SESSION_ROLLUP_BUCKET_FN['15m']).toBe('toStartOfFifteenMinutes')
    expect(SESSION_ROLLUP_BUCKET_FN['15m']).not.toBe(oldTernary('15m'))

    // The day, which both versions always got right, is untouched by either
    // the widening or the narrowing.
    expect(SESSION_ROLLUP_BUCKET_FN['1d']).toBe(oldTernary('1d'))
  })

  it('covers the union with no duplicate bucket function', () => {
    const functions = UNITS.map((unit) => SESSION_ROLLUP_BUCKET_FN[unit])
    expect(functions).toHaveLength(UNITS.length)
    expect(new Set(functions).size).toBe(UNITS.length)
    // Every key of the record is a member of the union and vice versa: a stale
    // entry left behind by a later removal is as wrong as a missing one, and
    // `'1h'` is exactly such an entry since step 4.
    expect(Object.keys(SESSION_ROLLUP_BUCKET_FN).sort()).toEqual([...UNITS].sort())
    expect(Object.keys(SESSION_ROLLUP_BUCKET_FN)).not.toContain('1h')
  })

  it('keeps the rollup table names distinct', () => {
    // The hour table outlived the hour unit by one release (0027 froze it) and
    // left with ClickHouse migration 0029, together with its constant.
    const tables = [SESSION_ROLLUP_15M_TABLE, SESSION_ROLLUP_1D_TABLE]
    expect(tables).toEqual(['session_rollups_15m', 'session_rollups_1d'])
    expect(new Set(tables).size).toBe(2)
  })

  it('widths the revenue units the same way, and in the same order of size', () => {
    // `REVENUE_ROLLUP_UNIT_MS` was already a Record, so the compiler caught the
    // missing `'15m'` the moment the union grew — the good outcome the session
    // side had to be converted to reach. Pinned anyway, because the value is
    // what `bucketSecondsOf` floors with.
    expect(REVENUE_ROLLUP_UNIT_MS).toEqual({
      '15m': 900_000,
      '1d': 86_400_000,
    })
    // Ninety-six quarters to the day. The hour used to sit between them, and
    // its removal must not have disturbed the nesting the grain rests on.
    expect(REVENUE_ROLLUP_UNIT_MS['1d']).toBe(REVENUE_ROLLUP_UNIT_MS['15m'] * 96)
  })

  it('floors a quarter-hour the way ClickHouse does, and nests inside the day', () => {
    // 2026-09-03T04:07:31.250Z — deliberately not on any boundary.
    const ms = Date.UTC(2026, 8, 3, 4, 7, 31, 250)
    expect(new Date(quarterBucketMs(ms)).toISOString()).toBe('2026-09-03T04:00:00.000Z')
    expect(new Date(quarterBucketMs(ms + 8 * 60_000)).toISOString()).toBe(
      '2026-09-03T04:15:00.000Z',
    )

    // The nesting the whole grain rests on, now that the hour is gone from
    // between them: the ninety-six quarters of a day floor to that day, all
    // distinct, and the next one does not.
    const day = dayBucketMs(ms)
    const quarters = Array.from({ length: 96 }, (_, n) => quarterBucketMs(day + n * 900_000))
    expect(new Set(quarters).size).toBe(96)
    for (const quarter of quarters) expect(dayBucketMs(quarter)).toBe(day)
    expect(dayBucketMs(quarterBucketMs(day + 96 * 900_000))).not.toBe(day)
  })
})
