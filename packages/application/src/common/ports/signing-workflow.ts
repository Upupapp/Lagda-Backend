// Signing workflow state ports (BACKEND-37).
//
// ── Two repositories, because there are two realms ─────────────────────────
//
//   RecipientWorkflowRepository   the recipient's OWN row, inside their own
//                                 transaction. Bound to one recipient at
//                                 construction; no method takes an id
//   ScopedSigningWorkflowRepository
//                                 the whole request, inside a workspace
//                                 transaction. The only place that can see who
//                                 is next
//
// The split is not organisational. Migration 022 binds the recipient realm to
// its own recipient row with RESTRICTIVE policies, so the first repository
// physically cannot answer the second's questions — and widening that policy so
// it could would trade the strongest tenancy control in the signing stack for
// the convenience of one transaction.
//
// ── Every method is a named transition ─────────────────────────────────────
//
// There is no `updateState(state)` and no `setStatus`. §16 and §157 ask for
// semantic operations, and the reason is that a generic setter is the shape a
// route eventually reaches: once `updateState` exists, `PATCH /signing-requests/
// :id { state }` is one careless handler away. Nothing here can express it.

import type { WorkspaceId } from "@lagda/contracts";
import type {
  RecipientWorkflowState, SigningDeclineReason,
} from "@lagda/contracts";
import type { RecipientType } from "@lagda/contracts";
import type {
  SigningRequestId, SigningRequestRecipientId,
} from "./signing-requests.js";
import type { RecipientSubmissionId } from "./signing-submission.js";

export type SigningWorkflowIntentId =
  string & { readonly __brand: "SigningWorkflowIntentId" };

/** What made a request's routing need re-evaluating. */
export type WorkflowAdvanceTrigger = "submission" | "decline";

// ── Records ──────────────────────────────────────────────────────────────────

/**
 * One recipient's workflow row, joined to the snapshot facts routing needs.
 *
 * `type`, `isRequired` and `routingOrder` come from
 * `signing_request_recipients` — the IMMUTABLE snapshot, never a preparation or
 * contact lookup (§43, §268). The join is here rather than in the use case so
 * there is no call site that could accidentally read the mutable originals.
 *
 * Deliberately carries no `name` and no `email`. Routing does not need them,
 * and the provisioner reads the recipient snapshot itself for the one place
 * that does.
 */
export interface WorkflowRecipientRecord {
  readonly recipientId: SigningRequestRecipientId;
  readonly type: RecipientType;
  readonly isRequired: boolean;
  readonly routingOrder: number;
  readonly state: RecipientWorkflowState;
  readonly activatedAt: number | null;
  /** From `recipient_submissions.accepted_at`. Never a separate clock. */
  readonly signedAt: number | null;
  readonly submissionId: RecipientSubmissionId | null;
  readonly declinedAt: number | null;
  readonly declineReason: SigningDeclineReason | null;
}

/** An outstanding advance, as the reconciler sees it: identifiers only. */
export interface WorkflowAdvanceIntentRef {
  readonly intentId: SigningWorkflowIntentId;
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: SigningRequestId;
  readonly recipientId: SigningRequestRecipientId;
  readonly trigger: WorkflowAdvanceTrigger;
  readonly attempts: number;
}

export interface NewWorkflowAdvanceIntent {
  readonly intentId: SigningWorkflowIntentId;
  readonly trigger: WorkflowAdvanceTrigger;
  /** Required for `submission`, forbidden for `decline`. A CHECK enforces it. */
  readonly submissionId: RecipientSubmissionId | null;
  readonly createdAt: number;
}

// ── The recipient realm ──────────────────────────────────────────────────────

/**
 * The recipient's own workflow row.
 *
 * Bound to one workspace, one request and one recipient at construction, from
 * the trusted session. No method takes an identifying argument, so "mark
 * somebody else signed" is not a question this interface can express — the same
 * property `RecipientCeremonyRepository` was built for.
 */
export interface RecipientWorkflowRepository {
  /** `null` when no row exists — read as "not yet activated", never as active. */
  getState(): Promise<RecipientWorkflowState | null>;

  /**
   * `active -> signed`, conditionally, carrying the submission's own instant.
   *
   * The condition is IN the statement. Two concurrent applications of the same
   * submission would otherwise both read `active` and both write; here the
   * second matches zero rows and the caller converges instead of duplicating a
   * transition (§29, §160).
   *
   * `signedAt` is a PARAMETER and the caller must pass
   * `RecipientSubmission.acceptedAt`. There is no overload that reads a clock,
   * because INV-548 forbids a second signing time and an optional parameter is
   * how one appears (§8, §32).
   *
   * Returns whether it applied. False means the recipient was not `active` —
   * already signed, declined, or still waiting — and the caller decides which
   * of those is an error.
   */
  markSignedFromSubmission(input: {
    readonly submissionId: RecipientSubmissionId;
    readonly signedAt: number;
  }): Promise<boolean>;

  /** `active -> declined`, conditionally. Same shape, same reasoning. */
  markDeclined(input: {
    readonly declinedAt: number;
    readonly reason: SigningDeclineReason;
  }): Promise<boolean>;

  /**
   * Records that this request needs its routing re-evaluated.
   *
   * Written in the SAME transaction as the state change it follows, so a
   * committed signature always has a committed instruction to act on it — which
   * is what makes "an accepted submission can never remain permanently
   * unapplied" (§296) true rather than hoped for.
   *
   * Returns whether THIS call created it. `false` means an intent for this
   * recipient and trigger already exists, which is a retry rather than an
   * error: the unique constraint is what stops a duplicate delivery producing a
   * second cohort activation (§59, §164).
   */
  enqueueAdvance(intent: NewWorkflowAdvanceIntent): Promise<boolean>;
}

// ── The workspace realm ──────────────────────────────────────────────────────

/**
 * The whole request's workflow, inside a workspace transaction.
 *
 * ── Methods that are deliberately absent ───────────────────────────────────
 *
 *   updateState / setStatus   §226. No generic transition exists at any layer
 *   markCompleted             BACKEND-38's, with the pipeline that earns it
 *   deleteIntent              an applied intent is history, not rubbish
 *   listAllIntents            the reconciler's, on the global path below
 */
export interface ScopedSigningWorkflowRepository {
  /**
   * Takes the request row's lock, and returns its state.
   *
   * `select ... for update`. OD-151 fixed the canonical order — request, then
   * recipient state, then progress, then submissions — and this is its
   * outermost link. Taking it first is what lets a terminal transition exclude
   * an advance in flight rather than racing it.
   *
   * Returns `null` when the request does not exist or belongs to another
   * tenant. The two are indistinguishable on purpose.
   */
  lockRequest(signingRequestId: SigningRequestId): Promise<{
    readonly state: string;
    readonly completionReadyAt: number | null;
  } | null>;

  /** Every recipient's workflow row, joined to the snapshot. Ordered in SQL. */
  listRecipientStates(
    signingRequestId: SigningRequestId,
  ): Promise<readonly WorkflowRecipientRecord[]>;

  /**
   * `waiting -> active` for exactly these recipients, conditionally.
   *
   * Returns how many rows moved. A caller that asked for three and got two has
   * a routing evaluation that disagrees with the database, and must not carry
   * on provisioning credentials for a cohort that did not activate (§56).
   */
  activateRecipients(input: {
    readonly signingRequestId: SigningRequestId;
    readonly recipientIds: readonly SigningRequestRecipientId[];
    readonly activatedAt: number;
  }): Promise<number>;

  /**
   * `sent -> partially-completed`, conditionally.
   *
   * Idempotent by construction: a request already `partially-completed`
   * matches zero rows, so re-evaluating does not bump `updated_at` or emit a
   * second transition.
   */
  markPartiallyCompleted(signingRequestId: SigningRequestId): Promise<boolean>;

  /**
   * `sent | partially-completed -> completion-ready`, conditionally.
   *
   * The `where` clause is what makes §176 true: two final signers racing both
   * evaluate readiness, both call this, and exactly one matches a row.
   */
  markCompletionReady(input: {
    readonly signingRequestId: SigningRequestId;
    readonly completionReadyAt: number;
  }): Promise<boolean>;

  /** `sent | partially-completed -> declined`, conditionally. */
  markDeclined(input: {
    readonly signingRequestId: SigningRequestId;
    readonly terminatedAt: number;
  }): Promise<boolean>;

  /** `sent | partially-completed -> cancelled`, conditionally. */
  markCancelled(input: {
    readonly signingRequestId: SigningRequestId;
    readonly terminatedAt: number;
    /** The sender's own words. Bounded by the column, never logged. */
    readonly note: string;
  }): Promise<boolean>;

  /**
   * Revokes every live access grant for a request. Returns how many.
   *
   * §85. A terminal request denies everyone by state check alone — that is the
   * load-bearing control — and revoking the credentials as well means a stolen
   * link stops resolving at the lookup rather than at the policy. Two layers,
   * neither relying on the other.
   */
  revokeActiveGrants(input: {
    readonly signingRequestId: SigningRequestId;
    readonly revokedAt: number;
  }): Promise<number>;

  /** The same, for established recipient sessions. §86. */
  revokeRecipientSessions(input: {
    readonly signingRequestId: SigningRequestId;
    readonly revokedAt: number;
  }): Promise<number>;

  /**
   * Claims an outstanding advance intent for this attempt.
   *
   * Increments `attempts` and returns the intent when it is still outstanding,
   * `null` when another attempt already applied it. Claim-then-apply rather
   * than apply-then-mark, so a crash between the two leaves the intent
   * outstanding and retryable rather than silently consumed.
   */
  claimAdvanceIntent(
    intentId: SigningWorkflowIntentId,
  ): Promise<WorkflowAdvanceIntentRef | null>;

  /** Every outstanding intent for this request. Ordered oldest first. */
  listOutstandingAdvances(
    signingRequestId: SigningRequestId,
  ): Promise<readonly WorkflowAdvanceIntentRef[]>;

  markAdvanceApplied(input: {
    readonly intentId: SigningWorkflowIntentId;
    readonly appliedAt: number;
  }): Promise<void>;

  /** Records a BOUNDED code. An exception message must never reach here. */
  recordAdvanceFailure(input: {
    readonly intentId: SigningWorkflowIntentId;
    readonly code: string;
  }): Promise<void>;
}

// ── The reconciler's view ────────────────────────────────────────────────────

/**
 * Outstanding advances across every tenant.
 *
 * ── Why this is not on a workspace unit of work ────────────────────────────
 *
 * "Which requests are stranded?" cannot be asked one workspace at a time,
 * because nothing knows which workspaces to ask. A cross-tenant scan of an RLS
 * table would need `BYPASSRLS`, which INV-334 rejects. So the intent table
 * carries no policy and this repository returns IDENTIFIERS ONLY — the caller
 * then enters each workspace properly and does the work under normal tenancy.
 *
 * `idempotency_records` is the precedent and the same argument applies: the
 * rows describe that work exists, never what the work is about.
 */
export interface SigningWorkflowReconciliationRepository {
  /**
   * The oldest outstanding intents, bounded.
   *
   * `attemptsBelow` keeps a permanently failing intent from starving the queue
   * — it stops being swept after enough attempts and stays visible in the table
   * with its failure code, which is a signal an operator can act on rather than
   * an infinite retry nobody notices.
   */
  listOutstanding(input: {
    readonly limit: number;
    readonly attemptsBelow: number;
  }): Promise<readonly WorkflowAdvanceIntentRef[]>;
}

export interface SigningWorkflowIdGenerator {
  nextSigningWorkflowIntentId(): SigningWorkflowIntentId;
}
