// Pure business policies for the signing request aggregate.
//
// Every function here takes its whole world as arguments. Nothing reads a
// clock, a database, a config value, or a random source, so every rule is
// reproducible from its inputs alone.
//
// These answer DOMAIN readiness only. External questions — does the stored
// artifact exist, is the workspace within quota, is the sender's email verified
// — need I/O and belong to BACKEND-05.

import {
  policyOk, policyFailed, type PolicyResult, type Instant,
} from "../common/index.js";
import { isBlockingAction, requiresSignatureField, type ParticipantAction } from "./participants.js";
import { isActive, isExpired, type SigningRequestState } from "./lifecycle.js";

// ── Shapes ───────────────────────────────────────────────────────────────────
//
// Deliberately minimal read models, not entities. A policy needs to know what a
// participant is asked to do and whether they have done it — not their name,
// email, avatar, or notification preferences. Keeping the input small is what
// keeps these functions testable without fixtures.

export interface ParticipantView {
  readonly assignmentId: string;
  readonly action: ParticipantAction;
  /** Whether a signature was additionally requested for a non-`sign` action. */
  readonly signatureRequested: boolean;
  /** Count of signature fields assigned to this participant. */
  readonly assignedSignatureFieldCount: number;
  /** 1-based position. Participants sharing a position act in parallel. */
  readonly order: number;
  readonly completed: boolean;
  readonly declined: boolean;
}

export interface SigningRequestView {
  readonly state: SigningRequestState;
  readonly hasDocument: boolean;
  readonly participants: readonly ParticipantView[];
  readonly expiresAt: Instant | null;
}

// ── Send readiness ───────────────────────────────────────────────────────────

export const SEND_READINESS_ISSUES = [
  "not-editable",
  "no-document",
  "no-blocking-participant",
  "missing-signature-field",
  "invalid-signing-order",
  "duplicate-assignment-id",
] as const;
export type SendReadinessIssue = (typeof SEND_READINESS_ISSUES)[number];

/**
 * Whether a request is internally complete enough to send.
 *
 * Returns EVERY unmet condition rather than the first, because the caller is
 * populating a form: reporting one problem at a time turns a single fix into
 * four round trips.
 *
 * `no-blocking-participant` rather than "no recipients": a request addressed
 * only to viewers and copy recipients has nobody who can advance it, so it
 * would be sent and then wait forever.
 */
export function evaluateSendReadiness(
  request: SigningRequestView,
): PolicyResult<SendReadinessIssue> {
  const issues: { code: SendReadinessIssue; detail: string }[] = [];

  if (!isEditableForSend(request.state)) {
    issues.push({
      code: "not-editable",
      detail: `A request in state "${request.state}" cannot be sent.`,
    });
  }

  if (!request.hasDocument) {
    issues.push({ code: "no-document", detail: "No document is attached." });
  }

  const blocking = request.participants.filter(p => isBlockingAction(p.action));
  if (blocking.length === 0) {
    issues.push({
      code: "no-blocking-participant",
      detail:
        "At least one participant must sign, approve, review or acknowledge. " +
        "Viewers and copy recipients cannot advance a request.",
    });
  }

  // Sign always needs the participant's own signature field; approve/review/
  // acknowledge need one only when a signature was additionally requested.
  for (const participant of request.participants) {
    const needsSignature = requiresSignatureField(
      participant.action,
      participant.signatureRequested,
    );
    if (needsSignature && participant.assignedSignatureFieldCount < 1) {
      issues.push({
        code: "missing-signature-field",
        detail:
          `Participant ${participant.assignmentId} must "${participant.action}" ` +
          `but has no signature field assigned.`,
      });
    }
  }

  const orderIssue = checkSigningOrder(request.participants);
  if (orderIssue) issues.push(orderIssue);

  const seen = new Set<string>();
  for (const participant of request.participants) {
    if (seen.has(participant.assignmentId)) {
      issues.push({
        code: "duplicate-assignment-id",
        detail: `Assignment ${participant.assignmentId} appears more than once.`,
      });
    }
    seen.add(participant.assignmentId);
  }

  return issues.length === 0 ? policyOk() : policyFailed(issues);
}

const isEditableForSend = (state: SigningRequestState): boolean =>
  state === "draft" || state === "ready-to-send";

/**
 * Signing order is **1-based and contiguous**.
 *
 * Participants sharing a position act in parallel — that is the mechanism for
 * "these three can sign in any order". A gap is rejected because it is
 * ambiguous: order [1, 3] could mean two sequential steps or a deleted middle
 * step whose participants should have been renumbered, and guessing either way
 * silently changes who waits for whom.
 */
function checkSigningOrder(
  participants: readonly ParticipantView[],
): { code: SendReadinessIssue; detail: string } | null {
  const blocking = participants.filter(p => isBlockingAction(p.action));
  if (blocking.length === 0) return null;

  const positions = [...new Set(blocking.map(p => p.order))].sort((a, b) => a - b);

  if (positions[0] !== 1) {
    return {
      code: "invalid-signing-order",
      detail: `Signing order must start at 1; found ${String(positions[0])}.`,
    };
  }
  for (let i = 0; i < positions.length; i++) {
    if (positions[i] !== i + 1) {
      return {
        code: "invalid-signing-order",
        detail: `Signing order must be contiguous; found a gap before ${String(positions[i])}.`,
      };
    }
  }
  return null;
}

// ── Recipient eligibility ────────────────────────────────────────────────────

export const RECIPIENT_BLOCKED_REASONS = [
  "request-not-active",
  "request-expired",
  "already-completed",
  "already-declined",
  "waiting-for-earlier-participant",
  "action-does-not-block",
] as const;
export type RecipientBlockedReason = (typeof RECIPIENT_BLOCKED_REASONS)[number];

/**
 * Whether a participant may act right now.
 *
 * The order rule is the important one: a participant may act only once every
 * blocking participant at an EARLIER position has finished. Same-position
 * participants do not wait for each other.
 *
 * A declined participant at an earlier position does not block — a decline
 * terminates the whole request (see `evaluateCompletionEligibility`), so
 * reaching this check with one implies the request is already terminal.
 */
export function evaluateRecipientEligibility(
  request: SigningRequestView,
  assignmentId: string,
  now: Instant,
): PolicyResult<RecipientBlockedReason> {
  const participant = request.participants.find(p => p.assignmentId === assignmentId);
  if (!participant) {
    return policyFailed([
      { code: "request-not-active", detail: "Participant is not part of this request." },
    ]);
  }

  const issues: { code: RecipientBlockedReason; detail: string }[] = [];

  if (!isActive(request.state)) {
    issues.push({
      code: "request-not-active",
      detail: `The request is in state "${request.state}".`,
    });
  }
  if (isExpired(request.state, request.expiresAt, now)) {
    issues.push({ code: "request-expired", detail: "The request has passed its deadline." });
  }
  if (participant.completed) {
    issues.push({ code: "already-completed", detail: "This participant has already acted." });
  }
  if (participant.declined) {
    issues.push({ code: "already-declined", detail: "This participant declined." });
  }
  if (!isBlockingAction(participant.action)) {
    issues.push({
      code: "action-does-not-block",
      detail: `"${participant.action}" is not an action that advances the request.`,
    });
  }

  const earlierOutstanding = request.participants.filter(
    p => isBlockingAction(p.action) && p.order < participant.order && !p.completed && !p.declined,
  );
  if (earlierOutstanding.length > 0) {
    issues.push({
      code: "waiting-for-earlier-participant",
      detail: `${String(earlierOutstanding.length)} participant(s) at an earlier position have not acted.`,
    });
  }

  return issues.length === 0 ? policyOk() : policyFailed(issues);
}

// ── Completion eligibility ───────────────────────────────────────────────────

export const COMPLETION_BLOCKED_REASONS = [
  "request-not-active",
  "request-expired",
  "participant-declined",
  "blocking-participant-outstanding",
] as const;
export type CompletionBlockedReason = (typeof COMPLETION_BLOCKED_REASONS)[number];

/**
 * Whether the request may complete.
 *
 * Answers BUSINESS eligibility only. It does not merge a PDF, generate a
 * certificate, compute a hash, write to a database, or notify anyone — the
 * order is: this policy, then application orchestration, then the sealer, then
 * evidence. Core never calls the sealer.
 *
 * Only blocking participants count. A viewer who never opened the document does
 * not prevent completion.
 */
export function evaluateCompletionEligibility(
  request: SigningRequestView,
  now: Instant,
): PolicyResult<CompletionBlockedReason> {
  const issues: { code: CompletionBlockedReason; detail: string }[] = [];

  if (!isActive(request.state)) {
    issues.push({
      code: "request-not-active",
      detail: `The request is in state "${request.state}".`,
    });
  }
  if (isExpired(request.state, request.expiresAt, now)) {
    issues.push({ code: "request-expired", detail: "The request has passed its deadline." });
  }
  if (request.participants.some(p => p.declined)) {
    issues.push({
      code: "participant-declined",
      detail: "A participant declined, so the request cannot complete.",
    });
  }

  const outstanding = request.participants.filter(
    p => isBlockingAction(p.action) && !p.completed && !p.declined,
  );
  if (outstanding.length > 0) {
    issues.push({
      code: "blocking-participant-outstanding",
      detail: `${String(outstanding.length)} required participant(s) have not acted.`,
    });
  }

  return issues.length === 0 ? policyOk() : policyFailed(issues);
}

// ── Progress ─────────────────────────────────────────────────────────────────

/**
 * Derived progress over blocking participants only.
 *
 * Derived rather than stored: a persisted counter and the participant list are
 * two representations of one fact, and they drift.
 */
export function computeProgress(request: SigningRequestView): {
  readonly completed: number;
  readonly total: number;
} {
  const blocking = request.participants.filter(p => isBlockingAction(p.action));
  return {
    completed: blocking.filter(p => p.completed).length,
    total: blocking.length,
  };
}
