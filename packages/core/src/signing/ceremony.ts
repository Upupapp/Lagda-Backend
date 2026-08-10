// Signing ceremony rules (BACKEND-35).
//
// Pure. No I/O, no clock of its own, no repository. Everything here is a
// function of facts the caller has already fetched, which is what makes the
// whole access decision testable without a database.
//
// ── The one question this file answers ─────────────────────────────────────
//
// "This authenticated recipient, this request, right now — what may they do?"
//
// Not "did they authenticate" (BACKEND-34 answered that), and not "what did
// they submit" (BACKEND-36 will). Only what the current state permits.

import type { SigningRequestState } from "@lagda/contracts";
import type { RecipientType } from "../recipients/index.js";
import { canHoldFields } from "../recipients/index.js";
import {
  assessSigningEligibility,
  type RecipientWorkflowState, type SigningBlocker,
} from "./workflow-state.js";

// ── Signable request states ──────────────────────────────────────────────────
//
// BACKEND-37 REMOVED the list that used to live here.
//
// It held one value, `sent`, with a comment explaining that
// `partially-completed` was omitted because nothing could produce it yet. Both
// of those are now false: `partially-completed` and `completion-ready` are
// reachable, and a second list of signable states is exactly the drift §128
// forbids — three modules each deciding whether a recipient may act, and the
// loosest one winning because a caller only has to find it.
//
// `SIGNABLE_REQUEST_STATES` in `workflow-state.ts` is the one list.

// ── Consent ──────────────────────────────────────────────────────────────────

/**
 * The single consent the product presents.
 *
 * `ConsentPage.tsx` renders one disclosure and one checkbox. §73 warns against
 * collapsing several distinct consents into one boolean; the inverse warning
 * applies just as much, and modelling four types where the product shows one
 * would be inventing product.
 */
export const CEREMONY_CONSENT_TYPE = "electronic-records-and-signature";

/**
 * Whether this recipient must accept the e-signature disclosure.
 *
 * ── Derived from the product, then found to already exist ──────────────────
 *
 * The six shipped scenarios set `consentRequired` true for signer, approver,
 * reviewer and acknowledgment-recipient, and false for viewer and
 * copy-recipient. That is exactly `canHoldFields` — BACKEND-31's existing
 * predicate, arrived at from the other direction.
 *
 * So this reuses it rather than declaring a second list that would have to be
 * kept in step. Someone who is asked to put something on the document consents
 * to doing it electronically; someone who is only shown the document does not.
 */
export function requiresElectronicSignatureConsent(type: RecipientType): boolean {
  return canHoldFields(type);
}

// ── The access decision ──────────────────────────────────────────────────────

/**
 * Why a ceremony is not available.
 *
 * BACKEND-37 made this an ALIAS of `SigningBlocker` rather than a second
 * vocabulary. It previously had three members and the canonical policy has
 * five; two lists meant the ceremony could not say "you already signed", which
 * is the one answer a returning recipient most needs (§191).
 */
export type CeremonyBlocker = SigningBlocker;

export interface CeremonyAccessInput {
  readonly requestState: SigningRequestState;
  /**
   * The recipient's workflow state. `null` when no row exists — treated as not
   * yet activated.
   *
   * Widened by BACKEND-37 from `"waiting" | "active"` to the full four-value
   * union. A recipient who has signed or declined reaches the ceremony page
   * again all the time, by reopening the link they were emailed, and the
   * ceremony has to be able to tell them so.
   */
  readonly recipientState: RecipientWorkflowState | null;
  readonly recipientType: RecipientType;
  /** Whether an acceptance of the CURRENTLY required version exists. */
  readonly consentAccepted: boolean;
}

/**
 * What this recipient may do right now.
 *
 * Four separate answers rather than one boolean, because the ceremony has
 * genuinely different gates at different depths and a single `allowed` flag
 * would force the caller to re-derive them.
 */
export interface CeremonyAccess {
  readonly mayEnter: boolean;
  readonly mayViewDocument: boolean;
  readonly mayViewAssignedFields: boolean;
  readonly mayAcceptConsent: boolean;
  /**
   * Whether BACKEND-36 would be permitted to accept a submission.
   *
   * Computed here and acted on nowhere in BACKEND-35 — the ceremony returns it
   * so the frontend can disable a button, and BACKEND-36 must recompute it
   * transactionally rather than trust a value that was true when the page
   * loaded.
   */
  readonly mayProceedToInput: boolean;
  readonly consentRequired: boolean;
  /** `null` exactly when `mayEnter` is true. */
  readonly blocker: CeremonyBlocker | null;
}

/**
 * ── Gating order, taken from the product ───────────────────────────────────
 *
 * `RequestAccessPage.handleBegin()` goes access → consent → review, and
 * `CONSENT_ACCEPT` is what sets `step: "review"`. So LAGDA gates the DOCUMENT
 * behind consent: model B in §84's terms, chosen because that is what the
 * product does and not because it is the stricter option.
 *
 * A viewer needs no consent and therefore reaches the document immediately,
 * which falls out of the rule rather than needing a special case.
 */
export function assessCeremonyAccess(input: CeremonyAccessInput): CeremonyAccess {
  const consentRequired = requiresElectronicSignatureConsent(input.recipientType);

  // THE canonical decision. This function no longer decides whether a recipient
  // may act — it decides what the ceremony SHOWS them once the policy has
  // ruled, which is the only part that is genuinely the ceremony's business.
  const eligibility = assessSigningEligibility({
    requestState: input.requestState,
    recipientState: input.recipientState,
    recipientType: input.recipientType,
  });

  if (!eligibility.mayEnter) {
    return {
      mayEnter: false,
      mayViewDocument: false,
      mayViewAssignedFields: false,
      mayAcceptConsent: false,
      mayProceedToInput: false,
      consentRequired,
      blocker: eligibility.blocker,
    };
  }

  const consentSatisfied = !consentRequired || input.consentAccepted;

  return {
    mayEnter: true,
    // Gated behind consent, per the product's own step order.
    mayViewDocument: consentSatisfied,
    mayViewAssignedFields: consentSatisfied,
    // Only ask for consent from someone it applies to, and only while it is
    // still outstanding. Re-accepting converges anyway, but offering the screen
    // again would tell the recipient the first acceptance did not take.
    mayAcceptConsent: consentRequired && !input.consentAccepted,
    // Consent is the ceremony's own extra gate on top of the policy's
    // `maySubmit`; `canHoldFields` is already inside that answer.
    mayProceedToInput: consentSatisfied && eligibility.maySubmit,
    consentRequired,
    blocker: null,
  };
}

// ── Field ordering ───────────────────────────────────────────────────────────

/** The minimum a field must expose to be ordered. Structural, not the DTO. */
export interface OrderableCeremonyField {
  readonly pageNumber: number;
  readonly y: number;
  readonly x: number;
  readonly layer: number;
  readonly requestFieldId: string;
}

/**
 * Reading order: page, then down, then across, then layer, then id.
 *
 * §110 asks for determinism and §111 asks for enough ordering metadata that a
 * "Next field" button needs no server round trip. Both are satisfied by
 * returning the fields already in the order a person reads them, so the
 * frontend's "next" is `index + 1`.
 *
 * The final tiebreak on id is what makes it TOTAL. Two fields at identical
 * coordinates on the same layer are unusual but perfectly legal, and without a
 * last resort their relative order would depend on how the rows came back.
 */
export function compareCeremonyFields(
  a: OrderableCeremonyField,
  b: OrderableCeremonyField,
): number {
  if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
  if (a.y !== b.y) return a.y - b.y;
  if (a.x !== b.x) return a.x - b.x;
  if (a.layer !== b.layer) return a.layer - b.layer;
  return a.requestFieldId < b.requestFieldId ? -1
    : a.requestFieldId > b.requestFieldId ? 1 : 0;
}

export function orderCeremonyFields<T extends OrderableCeremonyField>(
  fields: readonly T[],
): readonly T[] {
  return [...fields].sort(compareCeremonyFields);
}
