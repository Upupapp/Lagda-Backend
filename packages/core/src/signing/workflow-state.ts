// The canonical signing workflow state policy (BACKEND-37).
//
// ── Why this file exists ───────────────────────────────────────────────────
//
// Before it, "may this recipient act?" was answered in three places:
// BACKEND-34's bootstrap check, BACKEND-35's `assessCeremonyAccess`, and
// BACKEND-36's revalidation. Three answers that happened to agree is not one
// answer, and the day they stop agreeing the disagreement is a security bug —
// the loosest one wins, because the caller only has to find it.
//
// So this module is the single source, and the other three delegate to it.
// `assessCeremonyAccess` is now a thin projection of `assessSigningEligibility`
// rather than a second implementation.
//
// ── State is a projection, never a substitute ──────────────────────────────
//
// `signed` means "an accepted RecipientSubmission exists". The submission is
// the fact; the state is a denormalization of it that routing can read without
// joining. Nothing here reconstructs signing evidence from a state value, and
// the transition carries the submission's own `acceptedAt` rather than a clock
// reading, because one signing act with two timestamps is a scheduling artefact
// presented as a fact (INV-548).
//
// Pure. No I/O, no clock, no repository — every function is a deterministic
// function of facts the caller has already loaded.

import {
  RECIPIENT_WORKFLOW_STATES, type RecipientWorkflowState,
  type SigningRequestState,
} from "@lagda/contracts";
import { canHoldFields, type RecipientType } from "../recipients/index.js";
import { InvalidStateTransitionError, assertNever } from "../common/index.js";

export { RECIPIENT_WORKFLOW_STATES };
export type { RecipientWorkflowState };

// ── The recipient state machine ──────────────────────────────────────────────

/**
 * What can happen to a recipient.
 *
 * Three, and every one of them is caused by a durable fact somewhere else:
 * `activate` by a routing advance, `sign` by an accepted submission, `decline`
 * by an accepted decline. There is no `markSigned` a caller can simply decide
 * to perform, which is the shape §16 and §134 are asking for.
 */
export const RECIPIENT_WORKFLOW_ACTIONS = ["activate", "sign", "decline"] as const;
export type RecipientWorkflowAction = (typeof RECIPIENT_WORKFLOW_ACTIONS)[number];

/**
 * The complete transition table. Anything absent is forbidden.
 *
 * Note the two deliberate absences:
 *
 *   waiting -> signed    §28. A recipient whose turn has not come holds no
 *                        credential, so an accepted submission for them means
 *                        something is wrong with provisioning or with the
 *                        routing evaluation — not that they signed early.
 *   waiting -> declined  the same argument. You cannot refuse a document you
 *                        have never been given access to.
 *
 * Terminal states carry an explicitly empty action set rather than being
 * omitted, so adding a fifth state is a compile error instead of a silent hole.
 */
const RECIPIENT_TRANSITIONS: Record<
  RecipientWorkflowState,
  Partial<Record<RecipientWorkflowAction, RecipientWorkflowState>>
> = {
  waiting: { activate: "active" },
  active: { sign: "signed", decline: "declined" },
  signed: {},
  declined: {},
};

/** Once a recipient has signed or refused, nothing moves them again. */
export function isRecipientTerminal(state: RecipientWorkflowState): boolean {
  switch (state) {
    case "signed":
    case "declined":
      return true;
    case "waiting":
    case "active":
      return false;
    default:
      return assertNever(state, "isRecipientTerminal");
  }
}

export function canTransitionRecipient(
  from: RecipientWorkflowState,
  action: RecipientWorkflowAction,
): boolean {
  return RECIPIENT_TRANSITIONS[from][action] !== undefined;
}

/**
 * The state resulting from a recipient action.
 *
 * @throws InvalidStateTransitionError when the transition is not permitted.
 *         Throwing rather than returning a result: an accepted submission for a
 *         `waiting` recipient is an integrity failure to be surfaced, not a
 *         form for somebody to correct (§28, §30).
 */
export function transitionRecipient(
  from: RecipientWorkflowState,
  action: RecipientWorkflowAction,
): RecipientWorkflowState {
  const next = RECIPIENT_TRANSITIONS[from][action];
  if (next === undefined) {
    throw new InvalidStateTransitionError("SigningRequestRecipient", from, action);
  }
  return next;
}

// ── Who the workflow actually waits for ──────────────────────────────────────

/** The minimum the policy needs to know about one recipient. */
export interface WorkflowRecipient {
  readonly recipientId: string;
  readonly type: RecipientType;
  /** From the immutable snapshot. Never a live preparation lookup. */
  readonly isRequired: boolean;
  readonly routingOrder: number;
  readonly state: RecipientWorkflowState;
}

/**
 * Whether completion waits for this participant.
 *
 * TWO conditions, and both come from the snapshot:
 *
 *   `canHoldFields`  a viewer or a carbon-copy has nothing to submit, ever.
 *                    They are activated, they receive the document, and they
 *                    can no more complete a request than they can block one.
 *   `isRequired`     BACKEND-31 persists it per recipient. An optional
 *                    participant may act and is counted when they do, but the
 *                    request does not wait for them.
 *
 * §39 is explicit that `signedCount === recipientCount` is the wrong test, and
 * this is why: on a request with one signer and two carbon-copies it would
 * never be true, and the transaction would hang forever waiting for people who
 * were never asked for anything.
 */
export function isRequiredSigningParticipant(
  recipient: Pick<WorkflowRecipient, "type" | "isRequired">,
): boolean {
  return canHoldFields(recipient.type) && recipient.isRequired;
}

/** Whether this participant is permitted to submit at all, required or not. */
export function canParticipantSubmit(type: RecipientType): boolean {
  return canHoldFields(type);
}

// ── Signability: the one answer ──────────────────────────────────────────────

/**
 * The request states in which recipients may still act.
 *
 * A closed set of what IS allowed rather than a list of what is denied. A
 * denial list cannot forget to deny a state added later; an allow list cannot
 * accidentally permit one.
 *
 * `completion-ready` is NOT here, and that is the §96 rule made structural:
 * once every required obligation is satisfied the workflow is closed to further
 * signing even though the document has not been produced.
 */
export const SIGNABLE_REQUEST_STATES: readonly SigningRequestState[] = [
  "sent",
  "partially-completed",
];

export function isRequestSignableState(state: SigningRequestState): boolean {
  return SIGNABLE_REQUEST_STATES.includes(state);
}

/**
 * Whether a request has finished, one way or another.
 *
 * `completion-ready` is NOT terminal — BACKEND-38 moves it to `completed`, and
 * calling it terminal now would make that transition illegal.
 */
export function isRequestTerminal(state: SigningRequestState): boolean {
  switch (state) {
    case "completed":
    case "declined":
    case "cancelled":
    case "expired":
      return true;
    case "draft":
    case "ready-to-send":
    case "sent":
    case "partially-completed":
    case "completion-ready":
      return false;
    default:
      return assertNever(state, "isRequestTerminal");
  }
}

/**
 * Why a recipient may not proceed.
 *
 * A bounded vocabulary, and every value is safe to hand to the recipient who
 * asked. They have already authenticated as themselves, so "the sender
 * cancelled this" discloses nothing they are not entitled to — and is the
 * difference between a usable product and a mysterious one.
 */
export type SigningBlocker =
  | "request-not-signable"
  | "routing-waiting"
  | "recipient-cannot-act"
  | "already-signed"
  | "already-declined";

export interface SigningEligibilityInput {
  readonly requestState: SigningRequestState;
  /** `null` when no workflow row exists — read as "not yet activated". */
  readonly recipientState: RecipientWorkflowState | null;
  readonly recipientType: RecipientType;
}

export interface SigningEligibility {
  /** May reach the ceremony at all — including to read their own outcome. */
  readonly mayEnter: boolean;
  /** May submit an accepted signing act. The gate BACKEND-36 revalidates. */
  readonly maySubmit: boolean;
  /** May refuse. The same gate, with the same states. */
  readonly mayDecline: boolean;
  /** `null` exactly when `mayEnter` is true. */
  readonly blocker: SigningBlocker | null;
}

/**
 * What this recipient may do right now. THE canonical answer.
 *
 * ── Order matters, and it is deliberate ────────────────────────────────────
 *
 * What the RECIPIENT already did is checked first, then the request.
 *
 * Every branch here is a denial, so the order cannot widen access — it only
 * decides which true sentence the recipient is told. And "you have already
 * signed this" is the more useful one: after the last required signature the
 * request becomes `completion-ready`, so a request-first order would tell the
 * person who just signed that the document is not signable, which is true of
 * the request and misleading about them. The product has a real confirmation
 * screen for exactly this moment (§191).
 *
 * Terminal requests still refuse everyone. A recipient who has NOT acted gets
 * `request-not-signable` from the next check, and neither a live session nor an
 * unexpired grant can talk past it (§83, §84).
 */
export function assessSigningEligibility(
  input: SigningEligibilityInput,
): SigningEligibility {
  const deny = (blocker: SigningBlocker): SigningEligibility => ({
    mayEnter: false, maySubmit: false, mayDecline: false, blocker,
  });

  switch (input.recipientState) {
    case "signed":
      return deny("already-signed");
    case "declined":
      return deny("already-declined");
    case null:
    case "waiting":
    case "active":
      break;
    default:
      return assertNever(input.recipientState, "assessSigningEligibility");
  }

  if (!isRequestSignableState(input.requestState)) {
    return deny("request-not-signable");
  }
  if (input.recipientState !== "active") {
    // A missing row is `waiting`, not an error: the send predates this
    // recipient or the row was never written, and either way it is not their
    // turn.
    return deny("routing-waiting");
  }

  const canAct = canParticipantSubmit(input.recipientType);
  return {
    mayEnter: true,
    maySubmit: canAct,
    // A viewer cannot decline either. Refusing requires having been asked for
    // something, and a viewer was not.
    mayDecline: canAct,
    blocker: null,
  };
}

// ── Routing advance ──────────────────────────────────────────────────────────

/**
 * What the workflow should do next, given every recipient's current state.
 *
 * A closed union rather than a set of booleans, because the outcomes are
 * mutually exclusive and a caller that had to combine flags could produce a
 * combination the domain never intended — activating a cohort AND marking the
 * request complete, say.
 */
export type WorkflowAdvance =
  /**
   * Someone required refused. The request ends for everyone.
   *
   * OD-017 is settled by the product rather than by preference:
   * `status-map.ts` describes `declined` as "A recipient declined to sign or
   * approve" and marks it `isTerminal: true`, and the C37 resolver's terminal
   * reason is the bare sentence "A participant declined."
   */
  | { readonly kind: "declined"; readonly declinedBy: string }
  /** The current cohort is not finished. Nothing to do. */
  | { readonly kind: "waiting"; readonly outstandingRequired: number }
  /** Activate these. `provision` is the subset needing a credential. */
  | {
      readonly kind: "activate";
      readonly cohort: number;
      readonly active: readonly string[];
      readonly provision: readonly string[];
    }
  /** Every required obligation is satisfied. BACKEND-38's trigger. */
  | { readonly kind: "completion-ready" }
  /**
   * The snapshot cannot be reasoned about.
   *
   * §139: fail safely and alert rather than guess who is next. A request with
   * a non-integer routing order is corruption, and picking a recipient anyway
   * would send a legal document to somebody nobody chose.
   */
  | { readonly kind: "invalid"; readonly reason: WorkflowIntegrityProblem };

export type WorkflowIntegrityProblem =
  | "no-recipients"
  | "invalid-routing-order"
  | "no-required-participants";

/**
 * The routing decision, from the immutable snapshot and the current states.
 *
 * ── Cohorts are one integer ────────────────────────────────────────────────
 *
 * BACKEND-31 persists `routing_order`, where EQUAL VALUES MEAN PARALLEL. That
 * single integer expresses all three shapes — `1,1,1` parallel, `1,2,3`
 * sequential, `1,1,2` mixed — so there is no mode flag to read and no fourth
 * shape to handle.
 *
 * ── A cohort is complete when its REQUIRED signers are done ────────────────
 *
 * Not "when every member is done". A carbon-copy sitting in cohort 1 can never
 * finish anything, and waiting for them would stall the request permanently
 * (§36, §44). Optional participants are treated the same way: they may act,
 * and the workflow does not wait.
 *
 * ── Cohorts with nobody to wait for are skipped through ────────────────────
 *
 * A cohort holding only viewers activates and then, having nothing that could
 * ever complete it, would leave the request stuck with no future trigger. So
 * the plan walks forward until it reaches a cohort that contains at least one
 * required participant, activating each barren cohort on the way. Every one of
 * them is genuinely activated — a viewer at step 2 does receive the document —
 * they just do not become a wall.
 *
 * Deterministic: same states in, same plan out, every time (§137).
 */
export function planWorkflowAdvance(
  recipients: readonly WorkflowRecipient[],
): WorkflowAdvance {
  if (recipients.length === 0) {
    return { kind: "invalid", reason: "no-recipients" };
  }
  for (const recipient of recipients) {
    if (!Number.isInteger(recipient.routingOrder) || recipient.routingOrder < 1) {
      return { kind: "invalid", reason: "invalid-routing-order" };
    }
  }

  // A decline outranks everything, including a cohort that would otherwise be
  // ready to advance. Checked FIRST so a request cannot activate its next
  // cohort on the same evaluation that discovers it is over.
  const declined = recipients.find(recipient => recipient.state === "declined");
  if (declined !== undefined) {
    return { kind: "declined", declinedBy: declined.recipientId };
  }

  const required = recipients.filter(isRequiredSigningParticipant);
  if (required.length === 0) {
    // BACKEND-32's readiness gate refuses to create one and BACKEND-33's send
    // eligibility refuses to send one, so this is a corruption check rather
    // than a product case (§140). Answering "completion-ready" would mean a
    // request completing with nobody having signed anything.
    return { kind: "invalid", reason: "no-required-participants" };
  }

  const outstanding = required.filter(recipient => recipient.state !== "signed");
  if (outstanding.length === 0) return { kind: "completion-ready" };

  // The cohort in play is the earliest one that still owes something. Not
  // `recipients[0]`, and not the literal 1: BACKEND-31 permits a
  // non-contiguous sequence, so deleting the only recipient at step 1 leaves 2
  // and 3, and assuming 1 would advance nobody.
  const currentCohort = Math.min(...outstanding.map(r => r.routingOrder));

  // Anyone required at or before that cohort who has not signed means the
  // cohort is still open. `<=` rather than `===` so a straggler left behind by
  // an earlier partial state cannot be stepped over (§48).
  const stillOpen = outstanding.filter(r => r.routingOrder <= currentCohort);
  if (stillOpen.some(r => r.state === "active")) {
    return { kind: "waiting", outstandingRequired: stillOpen.length };
  }

  // Nobody required at this cohort is active, and nobody has signed it either
  // — so the cohort is waiting to be activated. Walk forward through any
  // cohorts that contain nothing the workflow would wait for.
  const waitingOrders = [...new Set(
    recipients.filter(r => r.state === "waiting").map(r => r.routingOrder),
  )].sort((a, b) => a - b);

  const active: string[] = [];
  const provision: string[] = [];
  let cohort = 0;

  for (const order of waitingOrders) {
    const members = recipients.filter(
      r => r.state === "waiting" && r.routingOrder === order);
    cohort = order;
    for (const member of members) {
      active.push(member.recipientId);
      // Exactly the types that can act. A viewer is activated and receives
      // nothing, because a signing credential is not what a viewer needs.
      if (canParticipantSubmit(member.type)) provision.push(member.recipientId);
    }
    if (members.some(isRequiredSigningParticipant)) break;
  }

  if (active.length === 0) {
    // Required work outstanding, nobody active, nobody waiting. The only way
    // to reach this is a state combination the transitions cannot produce.
    return { kind: "waiting", outstandingRequired: outstanding.length };
  }
  return { kind: "activate", cohort, active, provision };
}

// ── The request state that follows ───────────────────────────────────────────

/**
 * The request state implied by its recipients.
 *
 * §15 asks that `request.state` agree with durable recipient facts. This is
 * that agreement, expressed as a function so a test can assert it rather than a
 * reader having to trust it.
 *
 * Returns `null` when the current state already says everything there is to
 * say — no write, and therefore no spurious `updated_at`, no duplicate event
 * and no second transition to converge (§176).
 *
 * It never returns `completed`. That state belongs to the completion pipeline
 * and BACKEND-37 holds no path to it (§12, §69).
 */
export function deriveRequestState(
  current: SigningRequestState,
  advance: WorkflowAdvance,
): SigningRequestState | null {
  if (!isRequestSignableState(current)) return null;

  switch (advance.kind) {
    case "declined":
      return current === "declined" ? null : "declined";
    case "completion-ready":
      return "completion-ready";
    case "activate":
    case "waiting":
      // Somebody has signed and somebody has not. The product calls this
      // `partially-completed` — "Some but not all recipients have completed
      // their actions" (status-map.ts). It is a real product status with real
      // copy, so it is used rather than invented around (§13, §14).
      return current === "partially-completed" ? null : "partially-completed";
    case "invalid":
      // A snapshot that cannot be reasoned about does not get a state change.
      return null;
    default:
      return assertNever(advance, "deriveRequestState");
  }
}

/**
 * Deliberately absent from this module.
 *
 * **Anything that reads a clock.** Every timestamp BACKEND-37 writes comes
 * from a durable fact — `RecipientSubmission.acceptedAt` for a signature, the
 * decline's own accepted instant for a refusal — and a pure module that could
 * not read a clock even if it wanted to is the strongest form of that rule.
 *
 * **Any path to `completed`.** BACKEND-38.
 *
 * **Expiry evaluation.** `isExpired` is in `lifecycle.ts` and BACKEND-46 owns
 * whether a scheduled job acts on it (OD-014).
 *
 * **Skip, reassign and recipient correction.** §149, §150, §151 — each needs
 * amendment semantics for a workflow people have already signed.
 */
export type WorkflowStateOperationsDeferred = never;
