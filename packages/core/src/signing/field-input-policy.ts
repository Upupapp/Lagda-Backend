// Field input policy (BACKEND-35).
//
// One table saying, for every field type the request snapshot can contain,
// WHO supplies the final value and what shape it must have.
//
// ── Why this exists in BACKEND-35 at all ───────────────────────────────────
//
// BACKEND-35 persists no values. But the ceremony has to tell the frontend what
// each field expects, and BACKEND-36 has to decide what it will accept, and
// those are the same question. Answering it once here is what stops the two
// answers from drifting — which is exactly the duplication §161 warns about.
//
// ── The rule that matters most ─────────────────────────────────────────────
//
// SERVER_DERIVED fields have no client input at all. Not "validated input",
// not "input we overwrite" — no input. `date-signed` is the signing time,
// `full-name` and `email` are the immutable recipient snapshot, and a client
// that sends a value for one of them is either broken or lying. BACKEND-36
// must REJECT rather than ignore, because ignoring hides the bug.

import type { PreparationFieldType } from "@lagda/contracts";

/**
 * Where a field's authoritative value comes from.
 *
 * `RECIPIENT_SUPPLIED` — the person types, draws or ticks it.
 * `SERVER_DERIVED`     — the backend computes it; the client may not propose it.
 */
export type FieldValueAuthority = "RECIPIENT_SUPPLIED" | "SERVER_DERIVED";

/**
 * The shape a submitted value takes, once BACKEND-36 accepts one.
 *
 * `signature-representation` is deliberately vague HERE and precise LATER: the
 * product supports typed and drawn signatures and no upload path exists, but
 * whether the wire form is a data URL, a vector path or a reference is
 * BACKEND-36's decision. Naming the slot without filling it is the honest
 * position — pretending to know would produce a contract the next command has
 * to break.
 */
export type FieldValueKind =
  | "signature-representation"
  | "text"
  | "boolean"
  | "date"
  | "none";

export interface FieldInputPolicy {
  readonly authority: FieldValueAuthority;
  readonly valueKind: FieldValueKind;
  /** Maximum characters, for text-shaped values. `null` when not text. */
  readonly maxLength: number | null;
  /**
   * Whether the product renders an input for this type today.
   *
   * Four types are `false`, and that is a real gap rather than a formality:
   * a preparation can place a `title` field that no recipient screen can fill.
   * Recorded so BACKEND-36 does not discover it while building a submit path.
   */
  readonly hasRecipientRenderer: boolean;
  /** Why, in one line. Read by nobody at runtime; read by everybody later. */
  readonly note: string;
}

/**
 * Text ceilings.
 *
 * A bound now is worth more than a better bound later: §166 asks for
 * future-safe limits so BACKEND-36 does not inherit an unbounded payload, and
 * these are sized to the field's purpose rather than to a round number.
 */
export const CEREMONY_TEXT_MAX_LENGTH = 2_000;
export const CEREMONY_NAME_MAX_LENGTH = 200;
export const CEREMONY_EMAIL_MAX_LENGTH = 320;
export const CEREMONY_SHORT_TEXT_MAX_LENGTH = 200;

/**
 * The complete policy, keyed by every field type the snapshot can hold.
 *
 * `Record<PreparationFieldType, …>` rather than a partial map, so adding a
 * tenth field type to the contract fails THIS file to compile. A default case
 * would let a new type arrive with no decision made about who owns its value.
 */
export const FIELD_INPUT_POLICY: Record<PreparationFieldType, FieldInputPolicy> = {
  signature: {
    authority: "RECIPIENT_SUPPLIED",
    valueKind: "signature-representation",
    maxLength: null,
    hasRecipientRenderer: true,
    note: "Typed or drawn. No upload path exists in the product. BACKEND-36 "
      + "fixes the representation; BACKEND-35 persists nothing.",
  },
  initials: {
    authority: "RECIPIENT_SUPPLIED",
    valueKind: "signature-representation",
    maxLength: null,
    hasRecipientRenderer: true,
    note: "Same adoption machinery as `signature`, same deferral.",
  },
  "date-signed": {
    authority: "SERVER_DERIVED",
    valueKind: "date",
    maxLength: null,
    hasRecipientRenderer: true,
    note: "The moment the signature is accepted, from the backend Clock. The "
      + "frontend renders a date box, which is why this must be stated: a "
      + "client-supplied signing date is a client-chosen one.",
  },
  text: {
    authority: "RECIPIENT_SUPPLIED",
    valueKind: "text",
    maxLength: CEREMONY_TEXT_MAX_LENGTH,
    hasRecipientRenderer: true,
    note: "Free text. The frontend supports a multiline variant; the snapshot "
      + "has no multiline flag, so the ceremony cannot report one.",
  },
  checkbox: {
    authority: "RECIPIENT_SUPPLIED",
    valueKind: "boolean",
    maxLength: null,
    hasRecipientRenderer: true,
    note: "A required checkbox means it must be TRUE, not merely answered - "
      + "an acknowledgment nobody ticked is not an acknowledgment.",
  },
  "full-name": {
    authority: "SERVER_DERIVED",
    valueKind: "text",
    maxLength: CEREMONY_NAME_MAX_LENGTH,
    hasRecipientRenderer: false,
    note: "`signing_request_recipients.name`, frozen at request creation. Not "
      + "the current contact and not an account profile.",
  },
  email: {
    authority: "SERVER_DERIVED",
    valueKind: "text",
    maxLength: CEREMONY_EMAIL_MAX_LENGTH,
    hasRecipientRenderer: false,
    note: "`signing_request_recipients.email`, the delivery address as it was. "
      + "Unverified, and printing it on a document does not verify it.",
  },
  title: {
    authority: "RECIPIENT_SUPPLIED",
    valueKind: "text",
    maxLength: CEREMONY_SHORT_TEXT_MAX_LENGTH,
    hasRecipientRenderer: false,
    note: "Job title. NOT derivable server-side: the snapshot has no title "
      + "column, and `organization` is a different fact.",
  },
  company: {
    authority: "RECIPIENT_SUPPLIED",
    valueKind: "text",
    maxLength: CEREMONY_SHORT_TEXT_MAX_LENGTH,
    hasRecipientRenderer: false,
    note: "`signing_request_recipients.organization` exists and is nullable, "
      + "so it can seed a default - but the signer may correct it, which "
      + "makes the final value theirs and not the server's.",
  },
};

export function fieldInputPolicy(type: PreparationFieldType): FieldInputPolicy {
  return FIELD_INPUT_POLICY[type];
}

/** The types whose final value a client may never supply. */
export function isServerDerivedField(type: PreparationFieldType): boolean {
  return FIELD_INPUT_POLICY[type].authority === "SERVER_DERIVED";
}
