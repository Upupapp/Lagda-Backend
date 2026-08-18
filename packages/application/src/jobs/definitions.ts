// The job registry.
//
// Every job LAGDA can run is declared here, once. Scattering queue-name strings
// through handlers is how a producer and a consumer end up disagreeing about a
// name that is already durable in production rows.

import {
  CleanupPayloadSchema, NotificationDeliveryPayloadSchema,
  type CleanupPayload, type NotificationDeliveryPayload, type JobDefinition,
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

/**
 * Delivers one notification.
 *
 * ── Workspace-scoped, and the payload does not say so ────────────────────
 *
 * A notification may be workspace-scoped or global-user-scoped, and the
 * delivery row records which. The job is declared `workspace` because that is
 * the stricter context to execute in; the handler reads the actual scope from
 * the row rather than trusting a payload field, which is what stops a job
 * written by hand from choosing its own tenant.
 *
 * ── Retries, and what they must not do ───────────────────────────────────
 *
 * Three attempts, backing off from a minute. A transport retry reuses the SAME
 * delivery, the same intent and the same credential (S40, S43); it never mints
 * a new OTP or a new signing link. That distinction is not enforceable from
 * here — it is a property of the handler BACKEND-45 writes — but the retry
 * budget is set here deliberately low, because an unbounded retry against a
 * secret-bearing message keeps trying to deliver a credential that is expiring
 * while it tries.
 *
 * Concurrency is 1 until a provider exists. BACKEND-45 raises it once it has
 * delivery claiming, without which parallel workers would send one message
 * twice.
 */
export const NotificationDeliveryJob: JobDefinition<NotificationDeliveryPayload> = {
  type: "notification.deliver",
  tenantScope: "workspace",
  schema: NotificationDeliveryPayloadSchema,
  maxAttempts: 3,
  retryBackoffSeconds: 60,
  concurrency: 1,
  idempotencyStrategy:
    "The payload is a delivery id. The handler re-reads the delivery row and "
    + "acts only on a sendable state, so a duplicate delivery of the job finds "
    + "the row already claimed or already terminal and does nothing. Provider-"
    + "level duplicate protection requires claiming, which BACKEND-45 adds with "
    + "the provider itself.",
};

export const JOB_DEFINITIONS = [
  IdempotencyCleanupJob,
  RateLimitCleanupJob,
  NotificationDeliveryJob,
] as const;
