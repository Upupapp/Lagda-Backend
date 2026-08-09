// The signing request lifecycle.
//
// A FINDING FIRST, because it shapes everything here. The frontend's canonical
// `TransactionStatus` has 14 values:
//
//   draft · ready-to-send · sent · delivered · viewed ·
//   authentication-completed · awaiting-signature · awaiting-approval ·
//   partially-completed · completed · declined · cancelled · expired ·
//   failed-delivery
//
// Several of those are not lifecycle STATES. `delivered`, `viewed` and
// `authentication-completed` are FACTS THAT OCCURRED. A request whose recipient
// has viewed it is still awaiting signature — "viewed" and "awaiting-signature"
// are not mutually exclusive, so they cannot both be values of one status field
// without losing information. Storing `viewed` overwrites the knowledge that
// the request is still waiting.
//
// This is the state-versus-event confusion: a status field with one slot cannot
// hold a history. The domain therefore models a smaller lifecycle and treats
// the rest as events (see `events.ts`). The contract union is NOT redefined
// here — parallel status ownership would be worse than the confusion. Recorded
// as OD-013.

import {
  InvalidStateTransitionError, hasPassed, assertNever,
  type Instant,
} from "../common/index.js";

// ── Lifecycle states ─────────────────────────────────────────────────────────

/**
 * States a signing request can actually be IN, as opposed to things that have
 * happened to it. Every value is drawn from the canonical union; none is
 * invented.
 */
export const SIGNING_REQUEST_STATES = [
  "draft",
  "ready-to-send",
  "sent",
  "partially-completed",
  "completed",
  "declined",
  "cancelled",
  "expired",
] as const;
export type SigningRequestState = (typeof SIGNING_REQUEST_STATES)[number];

/**
 * Canonical values deliberately NOT modelled as lifecycle states, with the
 * reason. Listed explicitly so a future reader can see they were considered
 * rather than missed (§201).
 */
export const NON_LIFECYCLE_STATUSES = {
  delivered: "An event. Delivery does not change what the request is waiting for.",
  viewed: "An event. A viewed request is still awaiting its recipients.",
  "authentication-completed": "An event about one recipient, not the request.",
  "awaiting-signature": "Derived from which participants remain outstanding.",
  "awaiting-approval": "Derived, as above.",
  "failed-delivery": "A delivery-channel outcome, not a lifecycle state. Belongs to notification infrastructure.",
} as const;

// ── Terminal states ──────────────────────────────────────────────────────────

/**
 * Once terminal, a request never becomes active again.
 *
 * A completed transaction is legally significant history. Reopening one would
 * mean a document that was signed under one configuration silently acquires
 * another. Corrections create a new transaction — they never edit a finished
 * one.
 */
export function isTerminal(state: SigningRequestState): boolean {
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
      return false;
    default:
      return assertNever(state, "isTerminal");
  }
}

/** Still being configured — the only states where setup may change. */
export function isEditable(state: SigningRequestState): boolean {
  return state === "draft" || state === "ready-to-send";
}

/** Sent and not finished: recipients may act. */
export function isActive(state: SigningRequestState): boolean {
  return state === "sent" || state === "partially-completed";
}

// ── Transitions ──────────────────────────────────────────────────────────────

export const SIGNING_ACTIONS = [
  "markReadyToSend", "returnToDraft", "send", "recordParticipantCompletion",
  "complete", "decline", "cancel", "expire",
] as const;
export type SigningAction = (typeof SIGNING_ACTIONS)[number];

/**
 * The complete transition table. Anything absent is forbidden.
 *
 * A table rather than scattered `if` statements so that the whole machine can
 * be read — and tested — in one place. Every state appears, including terminal
 * ones with an empty action set, so a missing state is a compile error rather
 * than an accidental omission.
 */
const TRANSITIONS: Record<
  SigningRequestState,
  Partial<Record<SigningAction, SigningRequestState>>
> = {
  draft: {
    markReadyToSend: "ready-to-send",
    cancel: "cancelled",
  },
  "ready-to-send": {
    returnToDraft: "draft",
    send: "sent",
    cancel: "cancelled",
  },
  sent: {
    recordParticipantCompletion: "partially-completed",
    // Direct completion is legitimate: a single-participant request is finished
    // by one action without ever being partially complete.
    complete: "completed",
    decline: "declined",
    cancel: "cancelled",
    expire: "expired",
  },
  "partially-completed": {
    recordParticipantCompletion: "partially-completed",
    complete: "completed",
    decline: "declined",
    cancel: "cancelled",
    expire: "expired",
  },
  // Terminal. Deliberately empty rather than omitted.
  completed: {},
  declined: {},
  cancelled: {},
  expired: {},
};

export function canTransition(from: SigningRequestState, action: SigningAction): boolean {
  return TRANSITIONS[from][action] !== undefined;
}

/**
 * The state resulting from an action.
 *
 * @throws InvalidStateTransitionError when the transition is not permitted.
 *         Throwing rather than returning a result: a caller asking a cancelled
 *         request to complete has a bug, not a form to correct.
 */
export function transition(
  from: SigningRequestState,
  action: SigningAction,
): SigningRequestState {
  const next = TRANSITIONS[from][action];
  if (next === undefined) {
    throw new InvalidStateTransitionError("SigningRequest", from, action);
  }
  return next;
}

/** Every action valid from a state. Useful for tests and for building UI affordances. */
export function allowedActions(from: SigningRequestState): readonly SigningAction[] {
  return Object.keys(TRANSITIONS[from]) as SigningAction[];
}

// ── Expiry ───────────────────────────────────────────────────────────────────

/**
 * Whether a request has passed its deadline.
 *
 * `now` is a parameter, never a clock read. A terminal request is never
 * "expired" by the passage of time — a completed transaction does not stop
 * being completed at midnight.
 *
 * NOTE: this is DERIVED. Whether a stored status is also transitioned to
 * `expired` by a scheduled job is a separate question, unresolved — OD-014.
 */
export function isExpired(
  state: SigningRequestState,
  expiresAt: Instant | null,
  now: Instant,
): boolean {
  if (expiresAt === null) return false;
  if (isTerminal(state)) return false;
  return hasPassed(expiresAt, now);
}
