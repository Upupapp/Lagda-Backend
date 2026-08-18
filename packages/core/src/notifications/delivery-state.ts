// The notification delivery lifecycle.
//
// ── What this machine is, and is not ───────────────────────────────────────
//
// It tracks TRANSPORT. Whether an email got out, whether a provider took it,
// whether it bounced. It has no opinion about signing, and no transition here
// may cause one: a bounce does not un-send a request, and a delivery does not
// make a recipient VIEWED (S269, S313).
//
// The intent that spawned a delivery has no state machine at all. An intent is
// a decision that was made — it exists or it does not. Giving it a mutable
// status would fold "we meant to tell them" and "the wire worked" into one
// enum, and the first question would then be unanswerable whenever the second
// went wrong (S54, S118).
//
// ── Why every state is declared before any provider exists ─────────────────
//
// BACKEND-45 will need `PROVIDER_ACCEPTED`, `DELIVERED` and the failure pair.
// Declaring them now fixes their MEANING while the definitions are being
// reasoned about rather than under the pressure of an integration, and spares
// a CHECK-constraint migration later.
//
// It also makes the honest subset explicit and testable. `producibleBy44`
// below is the set BACKEND-44 may write; a test asserts nothing outside it is
// ever produced (S267, S312). Declaring a vocabulary is not the same as
// claiming to speak it.

import { assertNever } from "../common/index.js";

/**
 * The provider-neutral transport states.
 *
 * `SENT` is absent on purpose (S117). It reads like a fact and means whichever
 * of queued / accepted / delivered the reader already believed — the single
 * word most likely to put "your document was delivered" in a UI backed by
 * nothing but a database insert.
 */
export const DELIVERY_STATES = [
  "PENDING",
  "PROCESSING",
  "PROVIDER_ACCEPTED",
  "DELIVERED",
  "BOUNCED",
  "FAILED_RETRYABLE",
  "FAILED_TERMINAL",
  "SUPPRESSED",
  "CANCELLED",
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/**
 * The only state a delivery may be created in.
 *
 * Durable work exists; nothing has touched it. Every other state requires
 * something to have happened, and nothing has.
 */
export const INITIAL_DELIVERY_STATE = "PENDING" as const;

/**
 * States BACKEND-44 can legitimately reach.
 *
 * `PENDING` on creation, and the two stops that need no provider: the reason
 * for the message disappeared (`CANCELLED`), or the credential it carries can
 * no longer work (`SUPPRESSED`). Both are decisions LAGDA makes on its own
 * evidence.
 */
export const PRODUCIBLE_BY_BACKEND_44 = [
  "PENDING",
  "CANCELLED",
  "SUPPRESSED",
] as const satisfies readonly DeliveryState[];

/**
 * Nothing more will happen to a delivery in these states.
 *
 * `BOUNCED` is terminal for the delivery and says nothing about the signing
 * request. A bounced invitation leaves the request exactly as SENT as it was —
 * the sender must be told, which is a product decision BACKEND-45 inherits,
 * but the workflow does not move (S269).
 */
export function isDeliveryTerminal(state: DeliveryState): boolean {
  switch (state) {
    case "DELIVERED":
    case "BOUNCED":
    case "FAILED_TERMINAL":
    case "SUPPRESSED":
    case "CANCELLED":
      return true;
    case "PENDING":
    case "PROCESSING":
    case "PROVIDER_ACCEPTED":
    case "FAILED_RETRYABLE":
      // PROVIDER_ACCEPTED is NOT terminal: a provider that accepted a message
      // may still report a bounce. Treating acceptance as the end is precisely
      // the mistake that turns "the queue took it" into "they received it".
      // FAILED_RETRYABLE is not terminal either — that is what retryable means.
      return false;
    default:
      return assertNever(state, "isDeliveryTerminal");
  }
}

/**
 * Whether transport may still be attempted.
 *
 * The reconciler and BACKEND-45's claim step both ask this before doing work,
 * so "should we send?" has one answer rather than one per caller.
 */
export function isDeliverySendable(state: DeliveryState): boolean {
  return state === "PENDING" || state === "FAILED_RETRYABLE";
}

export const DELIVERY_ACTIONS = [
  /** A worker claimed the row. BACKEND-45. */
  "claim",
  /** A provider took the message. BACKEND-45. */
  "acceptByProvider",
  /** A provider affirmed mailbox delivery. BACKEND-45. */
  "confirmDelivered",
  /** The destination rejected it. BACKEND-45. */
  "bounce",
  /** Transient failure; the retry budget still has room. BACKEND-45. */
  "failRetryable",
  /** Permanent failure, or the retry budget is spent. BACKEND-45. */
  "failTerminal",
  /** The reason for the message disappeared before transport. BACKEND-44. */
  "cancel",
  /** The credential it carries can no longer work. BACKEND-44. */
  "suppress",
] as const;
export type DeliveryAction = (typeof DELIVERY_ACTIONS)[number];

/**
 * The complete transition table. Anything absent is forbidden.
 *
 * Read the terminal rows carefully: they are empty, and that is the point.
 * `DELIVERED` has no outgoing action, so no code path can walk a delivered
 * message back to pending and re-send it. `CANCELLED` has none either — a
 * cancellation is not a pause.
 *
 * Note what `cancel` and `suppress` are reachable FROM: `PENDING` only. Once a
 * worker holds the row the decision is no longer purely LAGDA's, and once a
 * provider has the bytes nothing can retract them (S113). The remedy at that
 * point is credential invalidation in the owning domain (S114), which is a
 * different operation in a different package.
 */
const TRANSITIONS: Record<
  DeliveryState,
  Partial<Record<DeliveryAction, DeliveryState>>
> = {
  PENDING: {
    claim: "PROCESSING",
    cancel: "CANCELLED",
    suppress: "SUPPRESSED",
  },
  PROCESSING: {
    acceptByProvider: "PROVIDER_ACCEPTED",
    failRetryable: "FAILED_RETRYABLE",
    failTerminal: "FAILED_TERMINAL",
    // `suppress` is reachable here too: BACKEND-45 checks credential validity
    // after claiming and before rendering, and an expired one must stop the
    // send rather than deliver a dead link (S156, S157).
    suppress: "SUPPRESSED",
  },
  PROVIDER_ACCEPTED: {
    confirmDelivered: "DELIVERED",
    bounce: "BOUNCED",
  },
  FAILED_RETRYABLE: {
    claim: "PROCESSING",
    failTerminal: "FAILED_TERMINAL",
    suppress: "SUPPRESSED",
  },
  DELIVERED: {},
  BOUNCED: {},
  FAILED_TERMINAL: {},
  SUPPRESSED: {},
  CANCELLED: {},
};

/** Whether an action is legal from a state. */
export function canApplyDeliveryAction(state: DeliveryState, action: DeliveryAction): boolean {
  return TRANSITIONS[state][action] !== undefined;
}

/** The actions legal from a state. Terminal states return an empty list. */
export function availableDeliveryActions(state: DeliveryState): readonly DeliveryAction[] {
  return Object.keys(TRANSITIONS[state]) as DeliveryAction[];
}

/**
 * Applies an action, or returns null if the table forbids it.
 *
 * Null rather than a throw: an at-least-once queue means a worker will
 * routinely try to claim a row another worker already claimed, and that is
 * ordinary contention rather than a defect. The caller decides whether its own
 * case is exceptional.
 */
export function applyDeliveryAction(
  state: DeliveryState,
  action: DeliveryAction,
): DeliveryState | null {
  return TRANSITIONS[state][action] ?? null;
}
