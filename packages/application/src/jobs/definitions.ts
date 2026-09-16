// The job registry.
//
// Every job LAGDA can run is declared here, once. Scattering queue-name strings
// through handlers is how a producer and a consumer end up disagreeing about a
// name that is already durable in production rows.

import {
  CleanupPayloadSchema, NotificationDeliveryPayloadSchema,
  CompletionProcessPayloadSchema, CompletionReconcilePayloadSchema,
  type CleanupPayload, type NotificationDeliveryPayload, type JobDefinition,
  type CompletionProcessPayload, type CompletionReconcilePayload,
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

/**
 * Expires signing requests whose deadline has passed.
 *
 * SYSTEM-scoped, and it has to be: a deadline passes with nobody watching, so
 * there is no workspace on whose behalf the sweep runs. It reads identifiers
 * from the unpoliced expiry index and enters each workspace properly.
 */
export const SigningRequestExpiryJob: JobDefinition<CleanupPayload> = {
  type: "signing-request.expiry",
  tenantScope: "system",
  // The same shape as the cleanups -- a batch size and nothing else. A payload
  // carrying a workspace or a request id would be a job an operator could
  // hand-write to expire somebody's contract.
  schema: CleanupPayloadSchema,
  maxAttempts: 3,
  retryBackoffSeconds: 60,
  // One at a time. Two sweeps would read overlapping batches and contend on the
  // same rows; `expireIfDue` makes the second a no-op rather than a double
  // expiry, so the cost is wasted work rather than a wrong outcome.
  concurrency: 1,
  idempotencyStrategy:
    "Naturally idempotent: `expireIfDue` carries its own conditions, so a "
    + "second run over the same batch matches zero rows. A request signed or "
    + "rescued between the index read and the write is skipped, not expired.",
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
 * delivery row records which. BACKEND-44 declared this `workspace` as the
 * stricter of the two; BACKEND-45 corrects it to `system`, because `workspace`
 * was a claim the payload cannot support and is simply false for an account
 * security message, which has no workspace at all.
 *
 * The handler resolves the real scope from the dispatch index and enters it,
 * so a hand-written job still cannot choose its own tenant — the guarantee
 * moved from the declaration to the lookup, where it can actually be kept.
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
 * Concurrency is 4, raised by BACKEND-45 now that claiming exists: the claim is
 * one conditional UPDATE, so parallel workers contend on a row rather than
 * duplicating a message. Four rather than a larger number because the
 * interesting bound is the PROVIDER's rate limit, not this process's CPU, and
 * BACKEND-61 benchmarks it properly (S207, S208).
 */
export const NotificationDeliveryJob: JobDefinition<NotificationDeliveryPayload> = {
  type: "notification.deliver",
  tenantScope: "system",
  schema: NotificationDeliveryPayloadSchema,
  maxAttempts: 3,
  retryBackoffSeconds: 60,
  concurrency: 4,
  idempotencyStrategy:
    "The payload is a delivery id. The handler re-reads the delivery row and "
    + "acts only on a sendable state, so a duplicate delivery of the job finds "
    + "the row already claimed or already terminal and does nothing. Provider-"
    + "level duplicate protection requires claiming, which BACKEND-45 adds with "
    + "the provider itself.",
};

/**
 * Finds transport work across every tenant and enqueues it.
 *
 * SYSTEM-scoped, and that is the whole reason it exists separately from the
 * delivery job: a dispatcher has no workspace by construction. It reads the
 * unpoliced dispatch index for identifiers, then every write happens inside the
 * scope that index named (OD-174).
 *
 * ── Why one at a time ─────────────────────────────────────────────────────
 *
 * Two concurrent dispatchers would enqueue the same delivery twice. That is
 * harmless — the claim rejects the second — but it is pure waste, and a sweep
 * is not the bottleneck in this system.
 *
 * ── Why retries are safe ──────────────────────────────────────────────────
 *
 * Enqueuing is idempotent in effect rather than in mechanism: a duplicate
 * delivery job finds the row already claimed or already terminal and returns
 * without touching a provider.
 */
export const NotificationDispatchJob: JobDefinition<CleanupPayload> = {
  type: "notification.dispatch",
  tenantScope: "system",
  schema: CleanupPayloadSchema,
  maxAttempts: 3,
  retryBackoffSeconds: 60,
  concurrency: 1,
  idempotencyStrategy:
    "Enqueues delivery jobs by identifier. A duplicate run enqueues duplicate "
    + "jobs, each of which loses the claim race and does nothing. The reclaim "
    + "half is a conditional UPDATE on expired leases, which a second run "
    + "finds already reclaimed.",
};

/**
 * Runs one completion attempt (BACKEND-38/41), enqueued the instant a
 * request becomes `completion-ready` (the "immediate" half of the hybrid
 * trigger — see `completion.reconcile` for the recovery half).
 *
 * SYSTEM-scoped like `notification.deliver`, even though the work is really
 * for one workspace: the payload already carries `workspaceId` alongside the
 * run id (the enqueuing site — the signing-workflow transition — already
 * knows both), so there is nothing a workspace-scoped context would add.
 */
export const CompletionProcessJob: JobDefinition<CompletionProcessPayload> = {
  type: "completion.process",
  tenantScope: "system",
  schema: CompletionProcessPayloadSchema,
  maxAttempts: 3,
  retryBackoffSeconds: 60,
  // `processCompletionRun`'s own claim (`UPDATE ... WHERE state IN
  // ('pending','waiting-retry')`) is what makes concurrent processing safe,
  // not this number — but concurrent workers racing the SAME run only ever
  // waste one side's attempt, so this stays conservative rather than
  // multiplying that waste under load.
  concurrency: 4,
  idempotencyStrategy:
    "The payload is a run id. processCompletionRun claims the run with a "
    + "conditional UPDATE before doing anything else, so a duplicate delivery "
    + "of this job finds the run already claimed (or already terminal) and "
    + "does nothing. A retry after a genuine mid-step failure resumes from "
    + "the last accepted step, per the step loop's own re-read of accepted "
    + "steps each pass — it never redoes finished work.",
};

/**
 * Recovers stranded completion work for ONE workspace (the "reconciliation"
 * half of the hybrid trigger) — a `completion-ready` request whose enqueue
 * was lost, or a `processing` run whose worker died.
 *
 * Self-scheduled with a singleton key (the workspace id) a few minutes after
 * `completion.process` is enqueued for that workspace, rather than run on a
 * fixed system-wide cron: there is no system-wide completion index the way
 * `signing-request.expiry` has one (`reconcileCompletionRuns` itself takes a
 * single workspace), so this targets exactly the workspace that just had
 * completion activity instead of sweeping every workspace in the system on a
 * schedule regardless of whether any of them have outstanding work.
 */
export const CompletionReconcileJob: JobDefinition<CompletionReconcilePayload> = {
  type: "completion.reconcile",
  tenantScope: "system",
  schema: CompletionReconcilePayloadSchema,
  maxAttempts: 3,
  retryBackoffSeconds: 60,
  concurrency: 1,
  idempotencyStrategy:
    "Naturally idempotent: creates a run only for a completion-ready request "
    + "that has none yet (a second run finds one already there and does "
    + "nothing), and abandons only a `processing` run whose attempt is "
    + "already stale by the configured threshold (a second run over an "
    + "already-abandoned or already-progressing run changes nothing).",
};

export const JOB_DEFINITIONS = [
  IdempotencyCleanupJob,
  SigningRequestExpiryJob,
  RateLimitCleanupJob,
  NotificationDeliveryJob,
  NotificationDispatchJob,
  CompletionProcessJob,
  CompletionReconcileJob,
] as const;
