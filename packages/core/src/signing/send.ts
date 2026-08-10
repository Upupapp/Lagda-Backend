// Send: eligibility and routing activation.
//
// Both are pure functions over already-loaded snapshot rows. Send is the point
// at which a document leaves the building, so the decisions that govern it
// should be evaluable without a database and testable exhaustively.

import { canHoldFields, type RecipientType } from "../recipients/index.js";
import type { SigningRequestState } from "@lagda/contracts";

// ── Eligibility ──────────────────────────────────────────────────────────────

/**
 * Why a request cannot be sent.
 *
 * A closed union, so a caller maps each to a status and a test asserts the
 * exact reason rather than a substring.
 */
export type SendBlocker =
  /** Already sent. The one a UI is most likely to hit, via a double click. */
  | { readonly kind: "already-sent" }
  /** No recipients at all. Unreachable through creation; checked anyway. */
  | { readonly kind: "no-recipients" }
  /**
   * Nobody the workflow waits for.
   *
   * A request addressed only to viewers and carbon-copies could never
   * complete. BACKEND-32's readiness gate refuses to create one, so this is a
   * corruption check rather than a user-facing rule.
   */
  | { readonly kind: "no-deliverable-recipient" }
  /** A recipient with no delivery address. Unstorable; checked anyway. */
  | { readonly kind: "recipient-without-address"; readonly recipientIndex: number }
  /** A routing order the domain does not accept. */
  | { readonly kind: "invalid-routing"; readonly recipientIndex: number }
  /** No fields. Same as above: refused at creation, checked here. */
  | { readonly kind: "no-fields" };

/** The minimum an eligibility check needs to know about a recipient. */
export interface SendableRecipient {
  readonly recipientId: string;
  readonly email: string;
  readonly type: RecipientType;
  readonly routingOrder: number;
}

export type SendEligibility =
  | { readonly ready: true }
  | { readonly ready: false; readonly blockers: readonly SendBlocker[] };

/**
 * Whether this request may be sent.
 *
 * ── Why it re-checks things creation already enforced ──────────────────────
 *
 * BACKEND-32 refuses to create a request with no recipients, no fields or a
 * dangling assignee, and BACKEND-31's CHECK constraints make an address-less
 * recipient unstorable. Most of the list below should therefore be
 * unreachable.
 *
 * It is checked anyway because Send is irreversible in a way creation is not:
 * creation writes a row, Send puts a document in front of counterparties. The
 * cost of the check is one pass over rows already in memory; the cost of
 * skipping it is discovering corruption after the emails are out.
 */
export function assessSendEligibility(
  state: SigningRequestState,
  recipients: readonly SendableRecipient[],
  fieldCount: number,
): SendEligibility {
  const blockers: SendBlocker[] = [];

  if (state !== "draft") blockers.push({ kind: "already-sent" });
  if (recipients.length === 0) blockers.push({ kind: "no-recipients" });
  if (fieldCount === 0) blockers.push({ kind: "no-fields" });

  recipients.forEach((recipient, recipientIndex) => {
    if (recipient.email.trim().length === 0) {
      blockers.push({ kind: "recipient-without-address", recipientIndex });
    }
    if (!Number.isInteger(recipient.routingOrder) || recipient.routingOrder < 1) {
      blockers.push({ kind: "invalid-routing", recipientIndex });
    }
  });

  if (recipients.length > 0 && !recipients.some(r => needsSigningAccess(r.type))) {
    blockers.push({ kind: "no-deliverable-recipient" });
  }

  return blockers.length === 0 ? { ready: true } : { ready: false, blockers };
}

/** Names the RULE and an INDEX. Never an address, a name or a title. */
export function describeSendBlocker(blocker: SendBlocker): string {
  switch (blocker.kind) {
    case "already-sent":
      return "state: this request has already been sent";
    case "no-recipients":
      return "recipients: at least one is required";
    case "no-deliverable-recipient":
      return "recipients: at least one must be able to act on the document";
    case "recipient-without-address":
      return `recipients[${String(blocker.recipientIndex)}]: has no delivery address`;
    case "invalid-routing":
      return `recipients[${String(blocker.recipientIndex)}]: routing order must be 1 or greater`;
    case "no-fields":
      return "fields: at least one is required";
  }
}

// ── Who gets a signing credential ────────────────────────────────────────────

/**
 * Whether this participant type receives a SIGNING-access credential.
 *
 * Exactly the types that can hold fields — signer, approver, reviewer,
 * acknowledgment-recipient. `viewer` and `carbon-copy` cannot, and giving them
 * a signing credential would hand a bearer key for a signing ceremony to
 * someone the ceremony does not involve (§101).
 *
 * They are still ACTIVATED, so their routing position is recorded and a later
 * command can find them. What they need is a document-VIEW credential, which
 * is a different thing that does not exist yet — OD-135.
 *
 * Delegating to `canHoldFields` rather than restating the list is deliberate:
 * "can be asked to do something" and "needs a way in" are the same question,
 * and two lists would drift.
 */
export function needsSigningAccess(type: RecipientType): boolean {
  return canHoldFields(type);
}

// ── Routing activation ───────────────────────────────────────────────────────

export interface ActivationPlan {
  /** Activated now: eligible, and in the earliest cohort. */
  readonly active: readonly string[];
  /** A later cohort. No credential is minted for these (§47). */
  readonly waiting: readonly string[];
  /**
   * Active AND of a type that needs signing access.
   *
   * A subset of `active`. The separation is the point: a viewer in the first
   * cohort is activated and receives nothing.
   */
  readonly provision: readonly string[];
  /** The cohort that activated. For telemetry and for the docs' worked examples. */
  readonly cohort: number;
}

/**
 * Which recipients become active at send.
 *
 * ── One integer expresses all three routing shapes ─────────────────────────
 *
 * BACKEND-31 persists `routing_order` per recipient, where EQUAL VALUES MEAN
 * PARALLEL within a step. There is no mode flag, because no backend command
 * persists one — the frontend's richer `PrepRoutingConfig` is in-memory
 * preparation state that nothing writes down.
 *
 * That single integer is enough:
 *
 *   1,1,1   every recipient at step 1      → all three activate. PARALLEL
 *   1,2,3   three distinct steps           → only the first. SEQUENTIAL
 *   1,1,2   two in parallel, then one      → the first two. MIXED
 *
 * So "which mode is this product in" is not a question with an answer. The
 * product's default is `routingOrder: 1` for everyone, which makes the common
 * case parallel, and a sender who sets distinct values gets sequencing without
 * anything else changing.
 *
 * ── The earliest cohort, not the first row ─────────────────────────────────
 *
 * The minimum routing order present, and EVERY recipient holding it. Not
 * `recipients[0]`, and not `routingOrder === 1`: deleting the only recipient at
 * step 1 leaves 2 and 3, which BACKEND-31 permits deliberately, and the
 * earliest cohort is then 2. Assuming 1 would activate nobody.
 *
 * Deterministic: same input, same plan, every time.
 */
export function planActivation(
  recipients: readonly SendableRecipient[],
): ActivationPlan {
  if (recipients.length === 0) {
    return { active: [], waiting: [], provision: [], cohort: 0 };
  }

  const cohort = Math.min(...recipients.map(recipient => recipient.routingOrder));

  const active: string[] = [];
  const waiting: string[] = [];
  const provision: string[] = [];

  for (const recipient of recipients) {
    if (recipient.routingOrder === cohort) {
      active.push(recipient.recipientId);
      if (needsSigningAccess(recipient.type)) provision.push(recipient.recipientId);
    } else {
      waiting.push(recipient.recipientId);
    }
  }

  return { active, waiting, provision, cohort };
}

/**
 * A bounded label for telemetry, derived rather than stored.
 *
 * Three values, so it is safe as a metric label where a cohort number or a
 * recipient count would not be.
 */
export function routingShape(
  recipients: readonly SendableRecipient[],
): "parallel" | "sequential" | "mixed" {
  const orders = new Set(recipients.map(recipient => recipient.routingOrder));
  if (orders.size <= 1) return "parallel";
  // Every recipient in a step of their own.
  if (orders.size === recipients.length) return "sequential";
  return "mixed";
}

/**
 * Deliberately absent from this module.
 *
 * **advanceRouting / nextCohort** — activating the NEXT cohort when the
 * current one finishes needs to know what "finishes" means, which is ceremony
 * state. BACKEND-37. The seam is `ProvisionSigningRecipientAccess`, which
 * BACKEND-33 already calls once per active recipient and BACKEND-37 will call
 * again.
 *
 * **isExpired / shouldRemind** — BACKEND-46.
 *
 * **canRecipientSign** — BACKEND-34 and BACKEND-36.
 */
export type SendRulesDeferred = never;
