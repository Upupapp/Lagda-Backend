// Participant actions and what each one demands.
//
// PROMOTED FROM THE FRONTEND. These rules are currently declared in
// `src/app/models/signing-workflow.ts` (C37) and enforced in
// `src/app/services/signing-workflow.validation.ts`. They are real business
// rules, not display logic — and until they exist here, an API call that
// bypasses the UI bypasses them entirely.
//
// The frontend keeps its copies for immediate feedback. Backend authority and
// client-side UX are not in competition.

import { InvariantViolationError, assertNever } from "../common/index.js";

/**
 * What a participant is asked to do. Canonical values from
 * `StageParticipantAction`.
 */
export const PARTICIPANT_ACTIONS = [
  "sign", "approve", "review", "acknowledge", "view", "receive-copy",
] as const;
export type ParticipantAction = (typeof PARTICIPANT_ACTIONS)[number];

/**
 * Whether an action holds up completion.
 *
 * `view` and `receive-copy` never block: a viewer who never opens the document
 * must not be able to stall a transaction indefinitely. Everything else does.
 *
 * Written as an exhaustive switch rather than a lookup so that adding a seventh
 * action fails compilation here — someone then has to decide whether it blocks,
 * which is precisely the decision that must not be made by default.
 */
export function isBlockingAction(action: ParticipantAction): boolean {
  switch (action) {
    case "sign":
    case "approve":
    case "review":
    case "acknowledge":
      return true;
    case "view":
    case "receive-copy":
      return false;
    default:
      return assertNever(action, "isBlockingAction");
  }
}

/**
 * Whether the action REQUIRES the participant's own signature field.
 *
 * Only `sign` always does. Approve, review and acknowledge may optionally carry
 * a signature requirement, which is a per-assignment configuration rather than
 * a property of the action.
 *
 * The distinctions are deliberate and load-bearing: a review is not an
 * approval, and an acknowledgement is not a signature unless one was also
 * required. Collapsing them would let a transaction claim a signature it never
 * collected.
 */
export function actionAlwaysRequiresSignature(action: ParticipantAction): boolean {
  return action === "sign";
}

/** Whether an action may be configured to additionally require a signature. */
export function actionMayRequireSignature(action: ParticipantAction): boolean {
  switch (action) {
    case "approve":
    case "review":
    case "acknowledge":
      return true;
    case "sign":        // already mandatory, not optional
    case "view":
    case "receive-copy":
      return false;
    default:
      return assertNever(action, "actionMayRequireSignature");
  }
}

/**
 * Whether this assignment ends up needing a signature field.
 *
 * @throws InvariantViolationError if a signature is requested for an action
 *         that cannot carry one — a viewer with a signature requirement is not
 *         a stricter configuration, it is an impossible one.
 */
export function requiresSignatureField(
  action: ParticipantAction,
  signatureRequested: boolean,
): boolean {
  if (actionAlwaysRequiresSignature(action)) return true;
  if (!signatureRequested) return false;

  if (!actionMayRequireSignature(action)) {
    throw new InvariantViolationError(
      "ParticipantAction",
      `"${action}" cannot require a signature.`,
    );
  }
  return true;
}
