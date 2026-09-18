import type { Logger } from './logger.ts'

/**
 * Counter port.
 *
 * G-005 requires every limit trigger to emit a metric and an alert; G-006 — the
 * gate that picks the metric backend, the error tracker and the notification
 * channel — is still open, and closes before Milestone 6. So this is the seam,
 * not the vendor: services call `increment`, and which pipeline that reaches is
 * a deployment decision no service code names.
 *
 * The default implementation writes a structured log line. That is deliberately
 * the *weakest* useful backend: every host this system runs on collects stdout,
 * so a limit trigger is queryable from the first deploy rather than from the day
 * G-006 closes — and an alert rule keyed on `metric` is a rule the eventual
 * pipeline can adopt unchanged.
 *
 * Labels are low-cardinality by contract. A metric labelled with a site id is a
 * time series per customer; one labelled with an IP or a user agent is an
 * unbounded series and a privacy problem in a store that has no redaction.
 */

export interface MetricLabels {
  readonly [label: string]: string | number | boolean | undefined
}

export interface Metrics {
  /**
   * Add to a counter. `value` defaults to 1.
   *
   * Never throws: a metrics backend that can fail a request converts an
   * observable problem into an outage, which is the opposite of the point.
   */
  increment(name: string, labels?: MetricLabels, value?: number): void

  /**
   * Record the current value of a gauge.
   *
   * Distinct from a counter because some of the things that have to be alerted
   * on do not accumulate. Queue oldest-age is the case that forced this
   * (docs snapshot 05, G-006 and 02 §26): it goes up while a worker is stalled
   * and back down when it catches up, and expressing it as a counter would make
   * "the queue is 40 seconds behind" indistinguishable from "the queue has been
   * behind for a total of 40 seconds since the process started".
   *
   * Latency is deliberately *not* a third method. A duration is reported as a
   * `_ms` counter alongside a `_total` counter, so the ratio is the average and
   * both halves survive a backend that only understands counters. A real
   * histogram is a decision for the milestone that needs percentiles from the
   * backend rather than from a measurement harness.
   */
  gauge(name: string, value: number, labels?: MetricLabels): void
}

/** Discards everything. For tests and for a service with no sink configured. */
export const NOOP_METRICS: Metrics = { increment: () => undefined, gauge: () => undefined }

/**
 * Emits each counter as one structured log line at `info`.
 *
 * The `metric` field is what an alert rule keys on, so it stays a stable name
 * rather than being folded into the message. Labels pass through the logger's
 * redaction like any other field.
 */
export function createLoggingMetrics(logger: Logger): Metrics {
  const emit = (kind: 'counter' | 'gauge', name: string, value: number, labels: MetricLabels) => {
    try {
      logger.info('metric', { metric: name, metric_kind: kind, value, ...labels })
    } catch {
      // A counter must never be the reason a request fails.
    }
  }

  return {
    increment(name, labels = {}, value = 1) {
      emit('counter', name, value, labels)
    },
    gauge(name, value, labels = {}) {
      emit('gauge', name, value, labels)
    },
  }
}

/** Records every increment in memory, so a test can assert what was emitted. */
export interface RecordedMetric {
  readonly name: string
  readonly labels: MetricLabels
  readonly value: number
  readonly kind: 'counter' | 'gauge'
}

export function createRecordingMetrics(): Metrics & {
  readonly recorded: readonly RecordedMetric[]
  countOf(name: string): number
  /** Latest recorded value of a gauge, or null if it was never set. */
  gaugeOf(name: string): number | null
  reset(): void
} {
  const recorded: RecordedMetric[] = []

  return {
    increment(name, labels = {}, value = 1) {
      recorded.push({ name, labels, value, kind: 'counter' })
    },
    gauge(name, value, labels = {}) {
      recorded.push({ name, labels, value, kind: 'gauge' })
    },
    recorded,
    countOf(name) {
      return recorded
        .filter((entry) => entry.name === name && entry.kind === 'counter')
        .reduce((total, entry) => total + entry.value, 0)
    },
    gaugeOf(name) {
      const entries = recorded.filter((entry) => entry.name === name && entry.kind === 'gauge')
      return entries.length === 0 ? null : (entries[entries.length - 1]?.value ?? null)
    },
    reset() {
      recorded.length = 0
    },
  }
}

/** Default: a repeated gauge reading is written at most once a minute. */
export const DEFAULT_GAUGE_MIN_INTERVAL_MS = 60_000

/** Distinct gauge series remembered for throttling. Past this, nothing is held
 * back — a caller with unbounded labels loses the saving, never a reading. */
const MAX_THROTTLED_GAUGE_SERIES = 2_000

export interface ThrottleGaugesOptions {
  /** How long an unchanged reading may be suppressed. Default 60 s. */
  readonly minIntervalMs?: number
  readonly now?: () => number
}

/**
 * Drops a gauge emission whose value has not moved and whose series was written
 * less than `minIntervalMs` ago.
 *
 * The loops that publish gauges tick far faster than the reading changes — the
 * outbox dispatcher republishes backlog and oldest-age for every topic × status
 * every 5 s (`DEFAULT_INTERVAL_MS`), almost always the same zeroes. Against a
 * remote-write backend that costs nothing (the exporter holds the last value and
 * pushes on its own flush), but against the structured-log floor every one of
 * those readings is a line on disk. Measured on a busy worker it was hundreds
 * of megabytes a day, read by nobody, into a Docker log file that grows until
 * the disk is full.
 *
 * So this wraps the *floor*, not the exporter (see `createServiceMetrics`).
 * Suppression is bounded in both directions: a value that changes is written
 * immediately, and an unchanged one is still written every `minIntervalMs`, so
 * the series never goes stale — an alert rule written as a Prometheus instant
 * query looks back five minutes, and a one-minute floor clears that with room
 * to spare.
 *
 * Counters pass straight through. A counter's value is the sum of its
 * emissions; skipping one would lose the measurement rather than repeat it.
 */
export function throttleGauges(inner: Metrics, options: ThrottleGaugesOptions = {}): Metrics {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_GAUGE_MIN_INTERVAL_MS
  const now = options.now ?? (() => Date.now())
  const lastWritten = new Map<string, { value: number; at: number }>()

  const keyOf = (name: string, labels: MetricLabels): string => {
    const parts = Object.keys(labels)
      .sort()
      .map((label) => `${label}=${String(labels[label])}`)
    return `${name}{${parts.join(',')}}`
  }

  return {
    increment(name, labels, value) {
      inner.increment(name, labels, value)
    },
    gauge(name, value, labels = {}) {
      try {
        const key = keyOf(name, labels)
        const previous = lastWritten.get(key)
        const at = now()

        if (previous && previous.value === value && at - previous.at < minIntervalMs) return

        if (previous || lastWritten.size < MAX_THROTTLED_GAUGE_SERIES) {
          lastWritten.set(key, { value, at })
        }
      } catch {
        // Bookkeeping must never cost a reading: fall through and emit.
      }
      inner.gauge(name, value, labels)
    },
  }
}
