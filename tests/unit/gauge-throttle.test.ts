import {
  DEFAULT_GAUGE_MIN_INTERVAL_MS,
  createLoggingMetrics,
  createRecordingMetrics,
  throttleGauges,
} from '@openanalytics/observability'
import { createCapturedLogger } from '@openanalytics/testkit'
import { describe, expect, it } from 'vitest'

/**
 * `throttleGauges` — the fix for a measured log flood: a worker whose log was
 * gigabytes a week, nearly every line of it `msg:"metric"`.
 *
 * The contract is two-sided and both sides are load-bearing: an unchanged
 * reading is suppressed so the flood stops, and a changed one — or one older
 * than the interval — is written so no alert rule ever reads a stale series.
 */

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('throttleGauges', () => {
  it('writes the first reading of a series and suppresses the repeats', () => {
    const inner = createRecordingMetrics()
    const time = clock()
    const metrics = throttleGauges(inner, { now: time.now })

    for (let i = 0; i < 20; i += 1) {
      metrics.gauge('worker_outbox_backlog', 0, { topic: 'email', status: 'pending' })
      time.advance(5_000)
    }

    // 20 ticks × 5 s = 100 s of wall time: the first reading, then one more once
    // the 60 s interval has passed.
    expect(inner.recorded.filter((entry) => entry.kind === 'gauge')).toHaveLength(2)
  })

  it('never holds back a reading that moved', () => {
    const inner = createRecordingMetrics()
    const time = clock()
    const metrics = throttleGauges(inner, { now: time.now })

    metrics.gauge('worker_queue_oldest_age_ms', 0)
    metrics.gauge('worker_queue_oldest_age_ms', 4_200)
    metrics.gauge('worker_queue_oldest_age_ms', 4_200)
    metrics.gauge('worker_queue_oldest_age_ms', 0)

    expect(inner.recorded.map((entry) => entry.value)).toEqual([0, 4_200, 0])
  })

  it('refreshes an unchanged series once the interval has passed', () => {
    const inner = createRecordingMetrics()
    const time = clock()
    const metrics = throttleGauges(inner, { now: time.now })

    metrics.gauge('worker_valkey_memory_ratio', 0.42)
    time.advance(DEFAULT_GAUGE_MIN_INTERVAL_MS - 1)
    metrics.gauge('worker_valkey_memory_ratio', 0.42)
    expect(inner.recorded).toHaveLength(1)

    time.advance(1)
    metrics.gauge('worker_valkey_memory_ratio', 0.42)
    expect(inner.recorded).toHaveLength(2)
  })

  it('throttles each label set independently', () => {
    const inner = createRecordingMetrics()
    const time = clock()
    const metrics = throttleGauges(inner, { now: time.now })

    for (const topic of ['email', 'webhook', 'digest']) {
      metrics.gauge('worker_outbox_backlog', 0, { topic, status: 'pending' })
      metrics.gauge('worker_outbox_backlog', 0, { topic, status: 'pending' })
    }

    expect(inner.recorded).toHaveLength(3)
  })

  it('keys on the label set, not on label order', () => {
    const inner = createRecordingMetrics()
    const time = clock()
    const metrics = throttleGauges(inner, { now: time.now })

    metrics.gauge('worker_outbox_backlog', 0, { topic: 'email', status: 'pending' })
    metrics.gauge('worker_outbox_backlog', 0, { status: 'pending', topic: 'email' })

    expect(inner.recorded).toHaveLength(1)
  })

  it('passes counters straight through', () => {
    const inner = createRecordingMetrics()
    const metrics = throttleGauges(inner, { now: clock().now })

    for (let i = 0; i < 10; i += 1) metrics.increment('worker_jobs_total', { job: 'digest' })

    expect(inner.countOf('worker_jobs_total')).toBe(10)
  })

  it('caps the log flood the outbox dispatcher produces in ten minutes', () => {
    // The measured shape of that flood: the dispatcher republishes
    // backlog and oldest-age for every topic × status every 5 s, almost always
    // the same zeroes. Ten minutes of that is 120 ticks.
    const captured = createCapturedLogger()
    const time = clock()
    const metrics = throttleGauges(createLoggingMetrics(captured.logger), { now: time.now })

    const topics = ['email', 'webhook', 'digest', 'export']
    const statuses = ['pending', 'processing', 'dead']

    for (let tick = 0; tick < 120; tick += 1) {
      for (const topic of topics) {
        for (const status of statuses) {
          metrics.gauge('worker_outbox_backlog', 0, { topic, status })
          metrics.gauge('worker_outbox_oldest_age_ms', 0, { topic, status })
        }
      }
      time.advance(5_000)
    }

    // Unthrottled this is 120 × 4 × 3 × 2 = 2880 lines. Throttled it is one per
    // series per minute: ≤ 10 per metric name over ten minutes and ten series.
    const lines = captured.find('metric')
    for (const name of ['worker_outbox_backlog', 'worker_outbox_oldest_age_ms']) {
      const perSeries = new Map<string, number>()
      for (const line of lines.filter((entry) => entry['metric'] === name)) {
        const key = `${String(line['topic'])}:${String(line['status'])}`
        perSeries.set(key, (perSeries.get(key) ?? 0) + 1)
      }
      expect(perSeries.size).toBe(topics.length * statuses.length)
      for (const count of perSeries.values()) expect(count).toBeLessThanOrEqual(10)
    }
    expect(lines.length).toBeLessThanOrEqual(240)
    expect(lines.length).toBeGreaterThan(0)
  })
})
