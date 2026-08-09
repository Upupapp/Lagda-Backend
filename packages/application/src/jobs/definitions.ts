// The job registry.
//
// Every job LAGDA can run is declared here, once. Scattering queue-name strings
// through handlers is how a producer and a consumer end up disagreeing about a
// name that is already durable in production rows.

import {
  CleanupPayloadSchema, type CleanupPayload, type JobDefinition,
} from "../common/ports/jobs.js";

/**
 * Deletes idempotency records past their retention.
 *
 * SYSTEM-scoped: idempotency spans workspace, user, recipient and system
 * scopes, so there is no workspace to act on behalf of.
 */
export const IdempotencyCleanupJob: JobDefinition<CleanupPayload> = {
  type: "idempotency.cleanup",
  tenantScope: "system",
  schema: CleanupPayloadSchema,
  maxAttempts: 3,
  retryBackoffSeconds: 60,
  // One at a time. Two concurrent sweeps would contend on the same rows for no
  // throughput gain — this is bookkeeping, not user-facing work.
  concurrency: 1,
  idempotencyStrategy:
    "Naturally idempotent: deletes only rows already past expires_at. A second "
    + "run finds nothing left and deletes nothing.",
};

/** Deletes rate-limit counters whose window has fully lapsed. */
export const RateLimitCleanupJob: JobDefinition<CleanupPayload> = {
  type: "rate-limit.cleanup",
  tenantScope: "system",
  schema: CleanupPayloadSchema,
  maxAttempts: 3,
  retryBackoffSeconds: 60,
  concurrency: 1,
  idempotencyStrategy:
    "Naturally idempotent: deletes only counters past expires_at, which are a "
    // Deleting a LIVE counter would reset an attacker's attempt count, so the
    // predicate matters more than it looks.
    + "full window past their reset. A live counter is never touched.",
};

export const JOB_DEFINITIONS = [
  IdempotencyCleanupJob,
  RateLimitCleanupJob,
] as const;
