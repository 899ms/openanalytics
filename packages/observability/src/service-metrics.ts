import type { Logger } from './logger.ts'
import {
  DEFAULT_GAUGE_MIN_INTERVAL_MS,
  createLoggingMetrics,
  throttleGauges,
  type Metrics,
} from './metrics.ts'
import { createRemoteWriteMetrics, type RemoteWriteMetrics } from './remote-write.ts'

/**
 * The G-006 service-metrics wiring, once, for every long-lived service.
 *
 * Docs snapshot 05, G-006; ADR-0010. The worker proved the shape — build the
 * Prometheus remote-write exporter only when all three credentials are present,
 * fall back to the structured-log floor when they are not, and stop the exporter
 * last on shutdown so the final seconds before a deploy are not a blind spot.
 * ADR-0015 unblocked the other services (a serverless collector had nowhere to
 * flush from; every service is a long-lived process now), so the block moved here
 * rather than being copied four more times.
 *
 * The logging sink is the floor for a deployment that has *no other sink*: stdout
 * is collected on every host, so a limit trigger is queryable from the first
 * deploy even where nothing else is provisioned. It is not a second copy
 * underneath the exporter. It used to be, and the cost was measured: a busy
 * worker wrote hundreds of megabytes of `metric` lines a day that no log reader
 * ever read, into a json-file log that only grows. A floor is worth its cost
 * where it is the only sink and worth nothing where it duplicates one that works;
 * so remote-write, when configured, is the sink, and one `metrics_sink` line at
 * startup says which of the two is live.
 */

/** The env fields this reads. Every `ServiceEnv` satisfies it structurally. */
export interface ServiceMetricsEnv {
  readonly METRICS_REMOTE_WRITE_URL?: string | undefined
  readonly METRICS_REMOTE_WRITE_USER?: string | undefined
  readonly METRICS_REMOTE_WRITE_TOKEN?: string | undefined
  readonly METRICS_FLUSH_INTERVAL_SECONDS: number
  readonly ENVIRONMENT: string
  readonly SERVICE_VERSION: string
}

export interface ServiceMetricsOptions {
  readonly env: ServiceMetricsEnv
  readonly logger: Logger
  /** The `service` label — the service name (`collector`, `api`, …). */
  readonly service: string
  /**
   * The `instance` label. Stable per process and low-cardinality — never a
   * per-request value, which would make every series unbounded. Callers pass a
   * per-process identity (e.g. `${service}-${GIT_COMMIT}` or the worker's
   * consumer name), mirroring the worker's own approach.
   */
  readonly instance: string
}

export interface ServiceMetrics {
  /** Combined sink: the logging floor, plus remote-write when configured. */
  readonly metrics: Metrics
  /** The exporter, or `null` when no remote-write credentials were present. */
  readonly remoteWrite: RemoteWriteMetrics | null
  /** Flushes and stops the exporter. A no-op when it was never built. */
  stop(): Promise<void>
}

/**
 * Builds the metrics sink for a service.
 *
 * When `METRICS_REMOTE_WRITE_URL`/`_USER`/`_TOKEN` are all present the returned
 * `metrics` is the remote-write exporter alone; otherwise it is the logging
 * floor, with repeated gauge readings throttled (`throttleGauges`), and a single
 * `metrics_remote_write_disabled` line records the degradation. Either way one
 * `metrics_sink` line names the sink that is live.
 */
export function createServiceMetrics(options: ServiceMetricsOptions): ServiceMetrics {
  const { env, logger, service, instance } = options

  const remoteWrite: RemoteWriteMetrics | null =
    env.METRICS_REMOTE_WRITE_URL && env.METRICS_REMOTE_WRITE_USER && env.METRICS_REMOTE_WRITE_TOKEN
      ? createRemoteWriteMetrics({
          url: env.METRICS_REMOTE_WRITE_URL,
          username: env.METRICS_REMOTE_WRITE_USER,
          password: env.METRICS_REMOTE_WRITE_TOKEN,
          defaultLabels: {
            service,
            environment: env.ENVIRONMENT,
            version: env.SERVICE_VERSION,
            instance,
          },
          flushIntervalMs: env.METRICS_FLUSH_INTERVAL_SECONDS * 1_000,
          logger,
        })
      : null

  if (remoteWrite === null) {
    logger.warn('metrics_remote_write_disabled', { reason: 'no remote-write credentials' })
  }

  // Exactly one sink. See the note above the module: the log floor underneath a
  // working exporter is a daily flood of writes nothing reads.
  const metrics: Metrics = remoteWrite ?? throttleGauges(createLoggingMetrics(logger))

  logger.info('metrics_sink', {
    sink: remoteWrite === null ? 'logging' : 'remote_write',
    gauge_min_interval_ms: remoteWrite === null ? DEFAULT_GAUGE_MIN_INTERVAL_MS : undefined,
  })

  return {
    metrics,
    remoteWrite,
    async stop(): Promise<void> {
      await remoteWrite?.stop()
    },
  }
}
