// Snapshot readiness: the gate between authoring and workflow.
//
// Pure. The interesting content is `assessSnapshotReadiness`: the one place
// that decides whether an authoring state is coherent enough to become an
// immutable workflow.
//
// It is a pure function over already-loaded rows deliberately. Readiness is the
// gate on an irreversible act, and a gate that can be evaluated without a
// database is a gate that can be tested exhaustively and reasoned about
// without a transaction open.

import { canHoldFields, type RecipientType } from "../recipients/index.js";
import type { PreparationFieldType, SigningRequestState } from "@lagda/contracts";

/** The state every request starts in. Named, so no caller writes the literal. */
export const INITIAL_SIGNING_REQUEST_STATE: SigningRequestState = "draft";

// ── Readiness ────────────────────────────────────────────────────────────────

/**
 * Why a preparation cannot become a signing request.
 *
 * A closed union rather than free text, so the API can map each to a message
 * and a test can assert the exact reason rather than a substring.
 */
export type SnapshotBlocker =
  /** Nobody to send to. */
  | { readonly kind: "no-recipients" }
  /**
   * Recipients exist, but none of them blocks completion.
   *
   * A request addressed only to viewers and carbon-copy recipients can never
   * complete: there is no one whose action the workflow waits for. The product
   * says the same thing from the other end — "at least one signing field per
   * signer".
   */
  | { readonly kind: "no-blocking-participant" }
  /** No fields at all. */
  | { readonly kind: "no-fields" }
  /**
   * A field nobody was asked to fill.
   *
   * Legitimate while authoring — the editor places a box before deciding who
   * fills it — and impossible as a workflow. OD-127 deferred this rule to the
   * send flow; this is the send flow's gate.
   */
  | { readonly kind: "unassigned-field"; readonly fieldIndex: number }
  /**
   * A field assigned to a recipient that is not on this preparation.
   *
   * Should be unreachable: BACKEND-31's three-column foreign key refuses it at
   * write time. Checked anyway, because persisted state is untrusted input and
   * the alternative is a snapshot with a dangling assignee.
   */
  | { readonly kind: "dangling-assignment"; readonly fieldIndex: number }
  /**
   * A field assigned to a participant whose type may not hold fields.
   *
   * Also should be unreachable — BACKEND-31 refuses both the assignment and the
   * demotion. Same reasoning.
   */
  | { readonly kind: "ineligible-assignee"; readonly fieldIndex: number }
  /**
   * A recipient who blocks completion but was asked for nothing.
   *
   * The product's third rule, verbatim: "at least one signing field per
   * signer". A required signer with no field would stall the workflow forever
   * on an action they have no way to perform.
   */
  | { readonly kind: "participant-without-field"; readonly recipientIndex: number };

/** The minimum a readiness check needs to know about a recipient. */
export interface ReadinessRecipient {
  readonly recipientId: string;
  readonly type: RecipientType;
  readonly isRequired: boolean;
}

/** The minimum a readiness check needs to know about a field. */
export interface ReadinessField {
  readonly type: PreparationFieldType;
  readonly recipientId: string | null;
}

export type SnapshotReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly blockers: readonly SnapshotBlocker[] };

/**
 * Whether this authoring state can become an immutable signing workflow.
 *
 * ── Where the rules come from ──────────────────────────────────────────────
 *
 * `docs/backend-integration-handoff.md` §10, verbatim: *"Validates: all
 * participants have email, routing is valid, at least one signing field per
 * signer"*. The first two are already structural — BACKEND-31's CHECK
 * constraints make an email-less or badly-routed recipient unstorable — so what
 * is left to check here is the third, plus the assignment integrity that
 * becomes load-bearing the moment the snapshot is immutable.
 *
 * ── Every blocker, not the first ───────────────────────────────────────────
 *
 * A sender fixing one problem at a time, through a UI that does not exist yet,
 * is a bad experience to design for. Report the whole list.
 *
 * ── Indexes, not labels ────────────────────────────────────────────────────
 *
 * A blocker names `fields[3]`, never "Landlord signature". An error message is
 * a poor place for the name of a party to an agreement.
 */
export function assessSnapshotReadiness(
  recipients: readonly ReadinessRecipient[],
  fields: readonly ReadinessField[],
): SnapshotReadiness {
  const blockers: SnapshotBlocker[] = [];

  if (recipients.length === 0) blockers.push({ kind: "no-recipients" });
  if (fields.length === 0) blockers.push({ kind: "no-fields" });

  const byId = new Map(recipients.map(recipient => [recipient.recipientId, recipient]));

  // Who blocks completion: a required participant whose type is one the
  // workflow waits for. A viewer is never blocking whatever `isRequired` says,
  // which is exactly what "does not block completion" means in the product's
  // own role descriptions.
  const blocking = recipients.filter(
    recipient => recipient.isRequired && canHoldFields(recipient.type));
  if (recipients.length > 0 && blocking.length === 0) {
    blockers.push({ kind: "no-blocking-participant" });
  }

  const assigned = new Set<string>();
  fields.forEach((field, fieldIndex) => {
    if (field.recipientId === null) {
      blockers.push({ kind: "unassigned-field", fieldIndex });
      return;
    }
    const recipient = byId.get(field.recipientId);
    if (recipient === undefined) {
      blockers.push({ kind: "dangling-assignment", fieldIndex });
      return;
    }
    if (!canHoldFields(recipient.type)) {
      blockers.push({ kind: "ineligible-assignee", fieldIndex });
      return;
    }
    assigned.add(field.recipientId);
  });

  // "At least one signing field per signer." Checked only for participants who
  // block completion: an optional approver with nothing to fill is a coherent
  // configuration, and a required signer with nothing to fill is a workflow
  // that waits forever on an action nobody can perform.
  recipients.forEach((recipient, recipientIndex) => {
    if (!recipient.isRequired || !canHoldFields(recipient.type)) return;
    if (!assigned.has(recipient.recipientId)) {
      blockers.push({ kind: "participant-without-field", recipientIndex });
    }
  });

  return blockers.length === 0 ? { ready: true } : { ready: false, blockers };
}

/**
 * A blocker as a validation issue string.
 *
 * Names the RULE and the INDEX. Never a recipient's name, a field's label or an
 * email address — SIGNING_REQUEST_DATA_CLASSIFICATION.md.
 */
export function describeBlocker(blocker: SnapshotBlocker): string {
  switch (blocker.kind) {
    case "no-recipients":
      return "recipients: at least one is required";
    case "no-blocking-participant":
      return "recipients: at least one must be a required participant who can hold fields";
    case "no-fields":
      return "fields: at least one is required";
    case "unassigned-field":
      return `fields[${String(blocker.fieldIndex)}]: has no assigned recipient`;
    case "dangling-assignment":
      return `fields[${String(blocker.fieldIndex)}]: assigned to an unknown recipient`;
    case "ineligible-assignee":
      return `fields[${String(blocker.fieldIndex)}]: assigned to a recipient that cannot hold fields`;
    case "participant-without-field":
      return `recipients[${String(blocker.recipientIndex)}]: has no fields to complete`;
  }
}

/**
 * Deliberately absent from this module.
 *
 * **isExpired / shouldRemind** — BACKEND-46 owns expiry and reminders, and
 * neither is stored.
 *
 * **canRecipientSign / nextRoutingStep** — routing EXECUTION is BACKEND-37's.
 * This command stores the plan; it does not decide who is unblocked when.
 *
 * **validateSendMetadata** — a subject and a message are email copy. BACKEND-33
 * owns them along with the send that uses them.
 */
export type SigningRequestRulesDeferred = never;
