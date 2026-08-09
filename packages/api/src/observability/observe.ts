// Observing an operation without changing what it does.
//
// The rule this module exists to keep (§316): instrumentation must preserve the
// original result and the original error, exactly. A wrapper that swallows a
// failure to log it has converted an outage into a silent wrong answer.
//
// Application use cases are wrapped from the OUTSIDE, at composition, so
// `@lagda/application` keeps no logger and no metrics dependency and stays
// callable from the worker (INV-134).

import type { ApplicationErrorCategory } from "@lagda/application";
import { ApplicationError } from "@lagda/application";
import type { MetricName, MetricsRecorder, LabelsFor } from "./metrics.js";
import { withAddedContext } from "./context.js";

/** The minimum a logger must offer. Not a Pino type — see INV-134. */
export interface ObservabilityLogger {
  debug(object: Record<string, unknown>, message: string): void;
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
}

export interface ObserveOptions<N extends MetricName, E extends MetricName> {
  /** A stable name — `SubmitSignature`, never a route URL. */
  readonly operation: string;
  readonly logger: ObservabilityLogger;
  readonly metrics: MetricsRecorder;
  readonly durationMetric: N;
  readonly errorMetric: E;
  /** Extra bounded labels. Never an identifier. */
  readonly labels?: LabelsFor<N>;
  /** Above this, completion logs at warn. Slow is not the same as failed. */
  readonly slowMs?: number;
}

/** Category for anything that is not an `ApplicationError`. */
function categorize(error: unknown): ApplicationErrorCategory {
  return error instanceof ApplicationError ? error.category : "internal";
}

/**
 * Times an operation, records metrics, logs the outcome, and **rethrows**.
 *
 * Success logs at `debug`, not `info`: one info line per successful use case is
 * volume without information once metrics exist (§238). Failure logs at `error`
 * for internal and dependency categories and at `info` for the ordinary client
 * ones, so a mistyped email does not become a production incident.
 *
 * Timing uses `performance.now()` — monotonic. `Date.now()` subtraction is
 * affected by clock adjustments and can produce negative durations (§44).
 */
export async function observeOperation<T, N extends MetricName, E extends MetricName>(
  options: ObserveOptions<N, E>,
  execute: () => Promise<T>,
): Promise<T> {
  const { operation, logger, metrics, durationMetric, errorMetric, labels, slowMs } = options;
  const startedAt = performance.now();

  return withAddedContext({ operation }, async () => {
    try {
      const result = await execute();
      const durationMs = performance.now() - startedAt;

      metrics.observe(durationMetric, durationMs, {
        ...labels, result: "success",
      } as LabelsFor<N>);

      const slow = slowMs !== undefined && durationMs > slowMs;
      const line = { operation, durationMs: Math.round(durationMs), result: "success" };
      if (slow) logger.warn({ ...line, slowMs }, "operation slow");
      else logger.debug(line, "operation completed");

      return result;
    } catch (error) {
      const durationMs = performance.now() - startedAt;
      const errorCategory = categorize(error);

      metrics.observe(durationMetric, durationMs, {
        ...labels, result: "failure",
      } as LabelsFor<N>);
      metrics.increment(errorMetric, { ...labels, errorCategory } as LabelsFor<E>);

      const line: Record<string, unknown> = {
        operation,
        durationMs: Math.round(durationMs),
        result: "failure",
        errorCategory,
        ...(error instanceof ApplicationError ? { errorCode: error.code } : {}),
      };

      // 5xx-shaped failures are incidents and carry the error object. Ordinary
      // client-caused ones do not — and deliberately do NOT carry the error,
      // whose message may name a resource.
      if (errorCategory === "internal" || errorCategory === "dependency-unavailable") {
        logger.error({ ...line, err: error }, "operation failed");
      } else {
        logger.info(line, "operation failed");
      }

      // Rethrown unchanged. The caller's error handling must see exactly what it
      // would have seen without instrumentation.
      throw error;
    }
  });
}
