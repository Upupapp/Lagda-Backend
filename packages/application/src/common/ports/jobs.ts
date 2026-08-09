// Durable background work.
//
// Application requests follow-up work through this port and never imports
// pg-boss. That keeps use cases callable from a test, from the API and from the
// worker itself without a queue running.

import { Type, type Static } from "@sinclair/typebox";
import type { WorkspaceId } from "@lagda/contracts";

/**
 * Job names. A closed union, and once a name has been written to a durable
 * queue row it is a **persistence contract** — renaming it strands every job
 * already enqueued under the old name.
 *
 * `dot.case`, matching the metric and security-event vocabularies.
 */
export const JOB_TYPES = [
  "idempotency.cleanup",
  "rate-limit.cleanup",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/**
 * Whether a job acts on one workspace or on system-wide infrastructure.
 *
 * An explicit discriminant, never an optional `workspaceId` where `undefined`
 * means "global" — that is the shape BACKEND-07 rejected, because the most
 * dangerous value becomes the easiest to produce by accident.
 */
export type JobTenantScope = "workspace" | "system";

// ── Payload schemas ──────────────────────────────────────────────────────────
//
// Validated at RUNTIME by the handler, not trusted because LAGDA produced them.
// A queue holds rows written by a PREVIOUS deployment, and may hold rows written
// by an operator by hand.

/**
 * Cleanup jobs carry a batch size and nothing else.
 *
 * `before` is deliberately absent: the handler reads the clock at execution
 * time. A timestamp baked in at enqueue would make a job delayed by an outage
 * delete using a stale horizon.
 */
export const CleanupPayloadSchema = Type.Object(
  { batchSize: Type.Integer({ minimum: 1, maximum: 10_000 }) },
  { additionalProperties: false },
);
export type CleanupPayload = Static<typeof CleanupPayloadSchema>;

/** Everything a job definition declares. */
export interface JobDefinition<TPayload> {
  readonly type: JobType;
  readonly tenantScope: JobTenantScope;
  readonly schema: unknown;
  /** Bounded. Nothing retries forever. */
  readonly maxAttempts: number;
  /** Seconds before the first retry; grows exponentially from here. */
  readonly retryBackoffSeconds: number;
  /** Conservative by default. A feature job tunes it deliberately. */
  readonly concurrency: number;
  /** How a duplicate delivery stays safe. Required — never left implicit. */
  readonly idempotencyStrategy: string;
  readonly __payload?: TPayload;
}

// ── Scheduling ───────────────────────────────────────────────────────────────

export interface JobScheduleOptions {
  /** UTC instant. Never a local-time expression. */
  readonly startAfter?: number;
  /**
   * Collapses duplicates within a window.
   *
   * Queue-level deduplication is a convenience, **not** a substitute for a
   * handler that is safe to run twice — an operator can always replay a job.
   */
  readonly singletonKey?: string;
  readonly singletonSeconds?: number;
}

/** What was scheduled. Deliberately not pg-boss's internal ID type. */
export interface JobReference {
  readonly jobId: string | null;
  readonly type: JobType;
}

/**
 * Schedules durable work.
 *
 * The `transaction` parameter is what makes atomicity possible: passing the
 * business transaction inserts the job row **inside it**, so state and intent
 * commit or roll back together. Omitting it is correct for work with no
 * accompanying business write — a maintenance sweep, say.
 */
export interface JobScheduler {
  enqueue<TPayload>(
    definition: JobDefinition<TPayload>,
    payload: TPayload,
    options?: JobScheduleOptions & { readonly transaction?: unknown },
  ): Promise<JobReference>;
}

// ── Execution context ────────────────────────────────────────────────────────

/**
 * What a handler is told about its own execution.
 *
 * `originatingRequestId` is correlation only — the HTTP request that caused the
 * job is long finished, and this is NOT the worker's own identity. `jobId` is.
 */
export interface JobContext {
  readonly jobId: string;
  readonly jobType: JobType;
  /** 1 on first execution. Retries increment it. */
  readonly attempt: number;
  readonly originatingRequestId?: string;
}

/** A workspace job's execution context. The workspace is never optional here. */
export interface WorkspaceJobContext extends JobContext {
  readonly tenantScope: "workspace";
  readonly workspaceId: WorkspaceId;
}

export interface SystemJobContext extends JobContext {
  readonly tenantScope: "system";
}

// ── Failures ─────────────────────────────────────────────────────────────────

/**
 * A failure that will not succeed on retry.
 *
 * Malformed payload, unsupported version, tenant mismatch. Retrying burns the
 * attempt budget and delays the dead-letter signal that would tell an operator
 * something is actually wrong.
 */
export class TerminalJobError extends Error {
  readonly retryable = false as const;
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "TerminalJobError";
  }
}

/** A failure that may succeed later — a dependency outage, a timeout. */
export class RetryableJobError extends Error {
  readonly retryable = true as const;
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "RetryableJobError";
  }
}
