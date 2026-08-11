// The signing workflow state machine (BACKEND-37).
//
// ── What this module turns into what ───────────────────────────────────────
//
//   accepted RecipientSubmission
//        -> recipient SIGNED, at the submission's own instant
//        -> a durable advance intent
//   [commit — the recipient's transaction ends here]
//
//   advance
//        -> lock the request
//        -> read every recipient's state, joined to the immutable snapshot
//        -> plan, in the pure domain
//        -> next cohort activated and provisioned  OR  completion-ready
//        -> mark the intents applied
//   commit
//
// ── Why it is two transactions and not one ─────────────────────────────────
//
// §24 prefers one. It cannot be one, and the reason is a security property
// rather than an engineering preference.
//
// Migration 022 bound the recipient realm to its OWN recipient row with
// RESTRICTIVE row-level security. A signer's transaction therefore cannot read
// the next recipient's type, routing order, name or address — and the delivery
// intent that invites them literally carries the address. Making the whole
// progression atomic would mean widening that policy so that any signer's own
// request can read every participant of the request, which trades the strongest
// tenancy control in the signing stack for the tidiness of one commit.
//
// So the split falls exactly where the realms do:
//
//   recipient realm    their own state. ALWAYS in the submission transaction,
//                      so an accepted signature is never left with the workflow
//                      claiming nothing happened
//   workspace realm    everyone else's. Driven by a durable intent, retried
//                      automatically, and recomputable from the same facts
//
// The property §296 asks for — that an accepted submission can never remain
// permanently unapplied — holds because the intent commits with the signature
// and because the advance is a pure function of durable rows. Running it twice
// changes nothing; never running it is the only failure, and the reconciler
// exists so that cannot be the end state.

import type { WorkspaceId, SigningDeclineReason } from "@lagda/contracts";
import { COMPLETION_PIPELINE_VERSION } from "@lagda/contracts";
import {
  planWorkflowAdvance, deriveRequestState, assessSigningEligibility,
  isRequestSignableState,
  type WorkflowAdvance, type WorkflowRecipient, type WorkspaceCapability,
} from "@lagda/core";
import type {
  Clock, TransactionManager, WorkspaceUnitOfWork,
  RecipientCeremonyUnitOfWork, RecipientSubmissionId,
  SigningRequestId, SigningRequestRecipientId, SigningRequestRecord,
  SigningWorkflowIdGenerator,
  RecipientSessionTokenFactory,
} from "../common/ports/index.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import type { CompletionIdGenerator } from "../common/ports/completion.js";
import {
  ApplicationError, ResourceNotFoundError,
} from "../common/errors/index.js";
import {
  provisionSigningRecipientAccess,
  type SigningAccessProvisioningDependencies,
} from "../signing-requests/send.js";
import { assertCapability, type WorkspaceAccessContext } from "../workspaces/workspace-access.js";
import {
  resolveRecipientSession,
  type RecipientSigningContext, type SigningAccessDependencies,
} from "../signing-access/signing-access.js";

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * The workflow row disagrees with a durable fact it is derived from.
 *
 * Always `internal`, never a 4xx. §28 and §30 both describe situations the
 * caller did not cause and cannot fix — an accepted submission for a recipient
 * whose turn never came, a second submission where the schema forbids one — and
 * a 409 would invite a client to retry into the same corruption.
 */
export class SigningWorkflowIntegrityError extends ApplicationError {
  readonly category = "internal" as const;
  readonly code = "signing_workflow_integrity";
  constructor(public readonly detail: string) {
    super("The signing workflow could not be advanced.");
  }
}

/** The recipient may not decline right now. */
export class SigningDeclineNotPermittedError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "signing_decline_not_permitted";
  constructor(readonly reason: string) {
    super(`This request can no longer be declined: ${reason}.`);
  }
}

/** The request is not in a state the sender may cancel. */
export class SigningRequestNotCancellableError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "signing_request_not_cancellable";
  constructor(readonly reason: string) {
    super(`This request can no longer be cancelled: ${reason}.`);
  }
}

// ── Telemetry ────────────────────────────────────────────────────────────────

/**
 * What an advance did, as a BOUNDED label.
 *
 * Five values, and none of them is an identifier. §196 asks for bounded metric
 * labels and §197 forbids PII; a result enum satisfies both, where "which
 * recipient activated" would satisfy neither.
 */
export type WorkflowAdvanceOutcome =
  | "cohort-activated"
  | "completion-ready"
  | "declined"
  | "no-change"
  | "not-advanceable"
  | "integrity-failure";

export interface WorkflowAdvanceResult {
  readonly outcome: WorkflowAdvanceOutcome;
  /** How many recipients moved to `active`. A count, never a list. */
  readonly activatedCount: number;
  /** How many were provisioned with a credential. A subset of the above. */
  readonly provisionedCount: number;
  /** How many durable intents this attempt cleared. */
  readonly intentsApplied: number;
}

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface SigningWorkflowDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly workflowIds: SigningWorkflowIdGenerator;
  /**
   * BACKEND-38. The completion run needs an identity like anything else.
   *
   * A REQUIRED dependency, not an optional one. An optional trigger is a
   * trigger that a future composition root forgets to wire, and the failure
   * mode is a signed request that silently never produces a document.
   */
  readonly completionIds: CompletionIdGenerator;
  /** The BACKEND-33 provisioner's slice. The same code, not a copy. */
  readonly access: SigningAccessProvisioningDependencies;
}

// ── The recipient-side transition ────────────────────────────────────────────

/**
 * Applies an accepted submission to the recipient's own workflow row.
 *
 * ── Called from INSIDE BACKEND-36's transaction ────────────────────────────
 *
 * Not a use case with its own transaction. It takes the ceremony unit of work
 * the submission is already holding, which is the whole point: the signature
 * and the state that says it happened commit together or neither does, and the
 * intermediate state BACKEND-36 documented (§23) stops existing.
 *
 * ── `signedAt` is the submission's ────────────────────────────────────────
 *
 * `acceptedAt` is passed in and never re-derived. There is no clock in this
 * function's signature, so a second signing time is not something a future
 * edit could add by accident — it would have to add the dependency first
 * (INV-548, §8, §32).
 */
export async function applyRecipientSubmissionToWorkflow(
  uow: RecipientCeremonyUnitOfWork,
  input: {
    readonly submissionId: RecipientSubmissionId;
    readonly acceptedAt: number;
    readonly intentId: ReturnType<SigningWorkflowIdGenerator["nextSigningWorkflowIntentId"]>;
  },
): Promise<void> {
  const moved = await uow.workflow.markSignedFromSubmission({
    submissionId: input.submissionId,
    signedAt: input.acceptedAt,
  });

  if (!moved) {
    // The UPDATE was conditional on `active`. Reaching here means the row was
    // waiting, already signed, already declined, or missing — and every one of
    // those contradicts a submission the same transaction just accepted.
    //
    // §28 is explicit that an accepted submission for a WAITING recipient is an
    // integrity failure rather than an early signature. Throwing rolls the
    // submission back with it, which is the honest outcome: the alternative is
    // an accepted signing act on a workflow that says it never happened.
    const state = await uow.workflow.getState();
    throw new SigningWorkflowIntegrityError(
      `submission accepted for a recipient in state "${state ?? "none"}"`);
  }

  // In the SAME transaction. A committed signature always has a committed
  // instruction to act on it.
  await uow.workflow.enqueueAdvance({
    intentId: input.intentId,
    trigger: "submission",
    submissionId: input.submissionId,
    createdAt: input.acceptedAt,
  });
}

// ── Decline ──────────────────────────────────────────────────────────────────

export interface DeclineSigningRequestInput {
  readonly rawSessionToken: string;
  /** A CLOSED code from the product's five categories. Never free text. */
  readonly reason: SigningDeclineReason;
}

export interface DeclineSigningRequestResult {
  readonly declinedAt: number;
  /** True when this call performed the decline rather than replaying one. */
  readonly applied: boolean;
}

export interface SigningDeclineDependencies extends SigningWorkflowDependencies {
  readonly sessionTokens: RecipientSessionTokenFactory;
}

/**
 * The recipient refuses.
 *
 * ── Why the clock is authoritative here and nowhere else ───────────────────
 *
 * A signature has an accepted submission whose `acceptedAt` is the fact; a
 * decline has no submission (§79 — no field values, no representation, nothing
 * to merge), so the moment the backend accepted the refusal IS the fact. The
 * clock is read once, in this function, and passed down.
 *
 * ── No free-text note ──────────────────────────────────────────────────────
 *
 * The product's page offers an optional textarea and this does not store it.
 * §78 warns that a free-text reason creates PII and content risk; the note is
 * recipient-authored, unbounded, would land in a legal record with no redaction
 * path, and the page's own copy tells the recipient nothing is persisted. The
 * closed code carries everything the sender's screen actually renders.
 */
export async function declineSigningRequest(
  input: DeclineSigningRequestInput,
  deps: SigningDeclineDependencies,
): Promise<DeclineSigningRequestResult> {
  const sessionDeps = {
    transactions: deps.transactions,
    clock: deps.clock,
    sessionTokens: deps.sessionTokens,
  } as SigningAccessDependencies;

  const context: RecipientSigningContext =
    await resolveRecipientSession(input.rawSessionToken, sessionDeps);

  const digest = deps.sessionTokens.digestToken(input.rawSessionToken);
  if (digest === null) throw new SigningDeclineNotPermittedError("session");

  const now = deps.clock.now();
  const intentId = deps.workflowIds.nextSigningWorkflowIntentId();

  return deps.transactions.runForRecipientSession(digest, sessionUow =>
    sessionUow.enterWorkspace(
      {
        workspaceId: context.workspaceId,
        signingRequestId: context.signingRequestId,
        recipientId: context.recipientId,
      },
      async uow => {
        // Revalidated AT COMMIT TIME through the canonical policy, not trusted
        // because the page rendered a Decline button (§77, §131).
        const request = await uow.ceremony.getRequest();
        const recipient = await uow.ceremony.getRecipient();
        if (request === null || recipient === null) {
          throw new SigningDeclineNotPermittedError("snapshot");
        }
        const state = await uow.workflow.getState();
        const eligibility = assessSigningEligibility({
          requestState: request.state,
          recipientState: state,
          recipientType: recipient.type,
        });
        if (!eligibility.mayDecline) {
          throw new SigningDeclineNotPermittedError(
            eligibility.blocker ?? "recipient-cannot-act");
        }

        const applied = await uow.workflow.markDeclined({
          declinedAt: now, reason: input.reason,
        });
        if (!applied) {
          // The policy said `active` and the conditional update disagreed. A
          // concurrent decline is the only way to get here, and it did the job.
          return { declinedAt: now, applied: false };
        }

        await uow.workflow.enqueueAdvance({
          intentId, trigger: "decline", submissionId: null, createdAt: now,
        });
        return { declinedAt: now, applied: true };
      },
    ));
}

// ── The workspace-side advance ───────────────────────────────────────────────

/**
 * Re-evaluates one request's routing and request state.
 *
 * ── Idempotent by construction, not by bookkeeping ─────────────────────────
 *
 * It reads every recipient's current state and decides what should be true. It
 * does not consume an event, does not increment a counter, and does not care
 * how many times it has run. Running it on a request that is already
 * `completion-ready` produces `no-change`; running it twice on a request whose
 * cohort just finished activates that cohort once, because the second run sees
 * the recipients as `active` rather than `waiting`.
 *
 * That is what makes §29, §59, §160, §236 and §239 true without a dedup table.
 *
 * ── The lock is taken first ────────────────────────────────────────────────
 *
 * `lockRequest` is a `select ... for update` on the request row, and OD-151's
 * canonical order starts there. Two advances serialize on it; a cancellation
 * takes the same lock, so the submission-versus-cancel race OD-151 recorded is
 * closed rather than narrowed.
 *
 * This is a SYSTEM transition. It asserts no capability and reads no
 * membership, because it is not a human operation: it derives entirely from
 * facts a recipient created (§152, §153). Faking an owner to satisfy an
 * authorization check would be inventing an actor.
 */
export async function advanceSigningWorkflow(
  input: {
    readonly workspaceId: WorkspaceId;
    readonly signingRequestId: SigningRequestId;
  },
  deps: SigningWorkflowDependencies,
): Promise<WorkflowAdvanceResult> {
  return deps.transactions.runForWorkspace(input.workspaceId, uow =>
    advanceInTransaction(uow, input.signingRequestId, deps));
}

async function advanceInTransaction(
  uow: WorkspaceUnitOfWork,
  signingRequestId: SigningRequestId,
  deps: SigningWorkflowDependencies,
): Promise<WorkflowAdvanceResult> {
  const locked = await uow.signingWorkflow.lockRequest(signingRequestId);
  if (locked === null) throw new ResourceNotFoundError("SigningRequest");

  const outstanding =
    await uow.signingWorkflow.listOutstandingAdvances(signingRequestId);

  const clearIntents = async (): Promise<number> => {
    const at = deps.clock.now();
    for (const intent of outstanding) {
      await uow.signingWorkflow.markAdvanceApplied({ intentId: intent.intentId, appliedAt: at });
    }
    return outstanding.length;
  };

  // A request that has already finished, been cancelled, or never left draft
  // has no routing to advance. The intents are still cleared: they describe
  // work that is no longer meaningful, and leaving them outstanding would make
  // the reconciler retry forever.
  if (!isRequestSignableState(locked.state as never)) {
    const intentsApplied = await clearIntents();
    return {
      outcome: "not-advanceable",
      activatedCount: 0, provisionedCount: 0, intentsApplied,
    };
  }

  const rows = await uow.signingWorkflow.listRecipientStates(signingRequestId);
  const recipients: WorkflowRecipient[] = rows.map(row => ({
    recipientId: String(row.recipientId),
    type: row.type,
    isRequired: row.isRequired,
    routingOrder: row.routingOrder,
    state: row.state,
  }));

  const plan = planWorkflowAdvance(recipients);

  if (plan.kind === "invalid") {
    // §139: fail safely and leave a signal. The intents stay OUTSTANDING with
    // a bounded failure code, because the snapshot may be repairable and
    // marking them applied would hide a corrupt request forever.
    for (const intent of outstanding) {
      await uow.signingWorkflow.recordAdvanceFailure({
        intentId: intent.intentId, code: `routing-${plan.reason}`,
      });
    }
    return {
      outcome: "integrity-failure",
      activatedCount: 0, provisionedCount: 0, intentsApplied: 0,
    };
  }

  const applied = await applyPlan(uow, signingRequestId, locked.state, plan, deps);
  const intentsApplied = await clearIntents();
  return { ...applied, intentsApplied };
}

async function applyPlan(
  uow: WorkspaceUnitOfWork,
  signingRequestId: SigningRequestId,
  currentState: string,
  plan: WorkflowAdvance,
  deps: SigningWorkflowDependencies,
): Promise<Omit<WorkflowAdvanceResult, "intentsApplied">> {
  const now = deps.clock.now();
  let activatedCount = 0;
  let provisionedCount = 0;

  if (plan.kind === "activate") {
    // ACTIVATE FIRST, and check the count.
    //
    // The request row is locked, so no concurrent advance can be in here — a
    // count that disagrees with the plan therefore means the states changed
    // under a lock that should have prevented it, and provisioning credentials
    // for a cohort that did not activate is exactly the partial state §56
    // forbids. Throwing rolls the whole transaction back.
    activatedCount = await uow.signingWorkflow.activateRecipients({
      signingRequestId,
      recipientIds: plan.active as readonly SigningRequestRecipientId[],
      activatedAt: now,
    });
    if (activatedCount !== plan.active.length) {
      throw new SigningWorkflowIntegrityError(
        `planned ${String(plan.active.length)} activations, applied ${String(activatedCount)}`);
    }

    if (plan.provision.length > 0) {
      const request = await requireRequest(uow, signingRequestId);
      const snapshot = await uow.signingRequests.listRecipients(signingRequestId);
      const byId = new Map(snapshot.map(row => [String(row.recipientId), row]));

      for (const recipientId of plan.provision) {
        const recipient = byId.get(recipientId);
        if (recipient === undefined) {
          throw new SigningWorkflowIntegrityError(
            "activation names a recipient the snapshot does not have");
        }
        // THE BACKEND-33 PROVISIONER. Not a copy of it. Credential generation,
        // sealing, the digest domain, the TTL and the never-persist-raw rule
        // are one implementation, so the sequential path and the send path
        // cannot drift (§49, §221, §271).
        await provisionSigningRecipientAccess(
          uow, { request, recipient, now }, deps.access);
        provisionedCount++;
      }
    }
  }

  if (plan.kind === "declined") {
    // Terminal. Grants and sessions are revoked as well as denied: the state
    // check is the load-bearing control, and revocation means a forwarded link
    // stops resolving at the lookup rather than at the policy (§85, §86).
    const moved = await uow.signingWorkflow.markDeclined({
      signingRequestId, terminatedAt: now,
    });
    if (moved) {
      await uow.signingWorkflow.revokeActiveGrants({ signingRequestId, revokedAt: now });
      await uow.signingWorkflow.revokeRecipientSessions({ signingRequestId, revokedAt: now });
    }
    return { outcome: "declined", activatedCount, provisionedCount };
  }

  const next = deriveRequestState(currentState as never, plan);
  if (next === "completion-ready") {
    const moved = await uow.signingWorkflow.markCompletionReady({
      signingRequestId, completionReadyAt: now,
    });
    // `moved === false` means another transaction got there first. Exactly one
    // transition, and this one converges rather than erroring (§176, §241).

    // ── THE COMPLETION TRIGGER (BACKEND-38 §49-§55) ─────────────────────────
    //
    // In the SAME transaction as the transition, and that is the entire point.
    // A request that becomes `completion-ready` acquires durable completion
    // work atomically, so there is no window in which every signature is
    // collected, the request looks finished, and nothing will ever produce a
    // document. An event, a best-effort enqueue or "the worker will notice"
    // would each leave exactly that window, and it fails SILENTLY.
    //
    // Called whether or not this transaction won the transition. It is
    // idempotent by uniqueness, and running it on a request that is already
    // `completion-ready` is how a request that reached readiness before this
    // pipeline existed acquires its run.
    await uow.completion.ensureRun({
      completionRunId: deps.completionIds.nextCompletionRunId(),
      signingRequestId,
      pipelineVersion: COMPLETION_PIPELINE_VERSION,
      createdAt: now,
    });

    return {
      outcome: moved ? "completion-ready" : "no-change",
      activatedCount, provisionedCount,
    };
  }
  if (next === "partially-completed") {
    await uow.signingWorkflow.markPartiallyCompleted(signingRequestId);
  }

  return {
    outcome: plan.kind === "activate" ? "cohort-activated" : "no-change",
    activatedCount, provisionedCount,
  };
}

async function requireRequest(
  uow: WorkspaceUnitOfWork,
  signingRequestId: SigningRequestId,
): Promise<SigningRequestRecord> {
  const request = await uow.signingRequests.find(signingRequestId);
  if (request === null) {
    throw new SigningWorkflowIntegrityError("the locked request vanished");
  }
  return request;
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export interface ReconcileResult {
  readonly examined: number;
  readonly advanced: number;
  readonly failed: number;
}

/**
 * Applies every outstanding advance, across every tenant.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * §175 forbids manual-only repair and §296 requires that an accepted submission
 * can never remain permanently unapplied. The synchronous advance covers the
 * ordinary case; this covers the process that died between committing a
 * signature and applying its consequences.
 *
 * It reads IDENTIFIERS from a table with no tenancy policy, then enters each
 * workspace properly and does the work under normal RLS. A failure on one
 * request does not stop the sweep — it is recorded as a bounded code on that
 * intent and the next one is attempted.
 */
export async function reconcileSigningWorkflow(
  deps: SigningWorkflowDependencies & {
    readonly policy: { readonly batchSize: number; readonly maxAttempts: number };
  },
): Promise<ReconcileResult> {
  const pending = await deps.transactions.runGlobal(uow =>
    uow.signingWorkflowReconciliation.listOutstanding({
      limit: deps.policy.batchSize,
      attemptsBelow: deps.policy.maxAttempts,
    }));

  // One request may have several outstanding intents — two parallel signers,
  // say. Advancing it once clears them all, so the same request is not swept
  // twice in one pass.
  const seen = new Set<string>();
  let advanced = 0;
  let failed = 0;

  for (const intent of pending) {
    const key = `${String(intent.workspaceId)}:${String(intent.signingRequestId)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const result = await advanceSigningWorkflow(
        { workspaceId: intent.workspaceId, signingRequestId: intent.signingRequestId },
        deps);
      if (result.outcome === "integrity-failure") failed++;
      else advanced++;
    } catch {
      // Deliberately swallowed, and deliberately without the error object: an
      // exception message is unbounded text that could carry a value from the
      // row it failed on, and this loop must not be the one place that leaks it
      // (§197, §199). The attempt counter already moved, which is the signal.
      failed++;
      await deps.transactions.runForWorkspace(intent.workspaceId, uow =>
        uow.signingWorkflow.recordAdvanceFailure({
          intentId: intent.intentId, code: "advance-failed",
        }));
    }
  }

  return { examined: seen.size, advanced, failed };
}

// ── Sender cancellation ──────────────────────────────────────────────────────

export interface CancelSigningRequestInput {
  readonly actor: AuthenticatedActor;
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: string;
  /** Required, as the product requires it. Bounded by the column at 200. */
  readonly reason: string;
}

export interface CancelSigningRequestResult {
  readonly signingRequestId: string;
  readonly state: "cancelled";
  readonly cancelledAt: number;
  /** Counts only. Never who held them. */
  readonly revokedGrantCount: number;
  readonly revokedSessionCount: number;
}

/**
 * The sender withdraws a request from its recipients.
 *
 * ── Read out of the product, including who and when ────────────────────────
 *
 * `transaction-detail.service.ts` computes `avail("cancel", isActive &&
 * canPrepare)`. Both halves are honoured: the capability is
 * `signing-request.cancel`, held by exactly the roles that hold
 * `document.prepare`, and the conditional update admits only the two active
 * states — so a request that reached `completion-ready` is refused, which is
 * §95's preferred answer arrived at from the product rather than from taste.
 *
 * The membership is read INSIDE the transaction. A sender demoted a moment ago
 * must not withdraw a document under authority they have lost.
 */
export async function cancelSigningRequest(
  input: CancelSigningRequestInput,
  deps: SigningWorkflowDependencies,
): Promise<CancelSigningRequestResult> {
  const signingRequestId = input.signingRequestId as SigningRequestId;

  return deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    await authorize(uow, input.actor, "signing-request.cancel");

    // The same lock, in the same order, as the advance takes. That is what
    // closes OD-151: a submission's advance and a cancellation can no longer
    // interleave, because both serialize on the request row.
    const locked = await uow.signingWorkflow.lockRequest(signingRequestId);
    if (locked === null) throw new ResourceNotFoundError("SigningRequest");

    const now = deps.clock.now();
    const cancelled = await uow.signingWorkflow.markCancelled({
      signingRequestId, terminatedAt: now, note: input.reason,
    });
    if (!cancelled) {
      throw new SigningRequestNotCancellableError(
        locked.state === "completion-ready" ? "all-signatures-collected" : "not-active");
    }

    const revokedGrantCount = await uow.signingWorkflow.revokeActiveGrants({
      signingRequestId, revokedAt: now,
    });
    const revokedSessionCount = await uow.signingWorkflow.revokeRecipientSessions({
      signingRequestId, revokedAt: now,
    });

    return {
      signingRequestId: input.signingRequestId,
      state: "cancelled" as const,
      cancelledAt: now,
      revokedGrantCount,
      revokedSessionCount,
    };
  });
}

async function authorize(
  uow: WorkspaceUnitOfWork,
  actor: AuthenticatedActor,
  capability: WorkspaceCapability,
): Promise<WorkspaceAccessContext> {
  const membership = await uow.memberships.findByUser(actor.userId);
  if (membership === null) throw new ResourceNotFoundError("Workspace");
  const access: WorkspaceAccessContext = {
    workspaceId: membership.workspaceId,
    userId: membership.userId,
    membershipId: membership.memberId,
    role: membership.role,
  };
  assertCapability(access, capability);
  return access;
}

/**
 * Deliberately absent from this module.
 *
 * **Any path to `completed`.** No PDF merge, no signed artifact, no completion
 * certificate, no `DocumentSealer`. BACKEND-38 owns every one of them, and an
 * architecture guard asserts none is imported here.
 *
 * **voidSigningRequest.** The product offers void only on a COMPLETED
 * transaction (`avail("void", isCompleted && canAudit)`), and nothing can
 * produce `completed` yet. Building it now would mean inventing the semantics
 * of invalidating a finished legal document.
 *
 * **expireSigningRequest.** The lifecycle table has the edge and BACKEND-46
 * owns the schedule. Nothing here reads a deadline (OD-014).
 *
 * **Skip, reassign, recipient correction.** §149, §150, §151 — each needs
 * amendment semantics for a workflow people have already signed.
 *
 * **Any evidence event.** Consistent with BACKEND-35 and BACKEND-36: nothing in
 * this codebase writes one, and an audit trail whose only entries are workflow
 * transitions reads as missing rather than as not yet built (OD-145).
 */
export type SigningWorkflowOperationsDeferred = never;
