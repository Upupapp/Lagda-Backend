// Signature submission rules (BACKEND-36).
//
// Pure. Given the recipient's immutable field assignments and what the client
// sent, decide what — if anything — may be accepted.
//
// ── The shape of the answer ────────────────────────────────────────────────
//
// All or nothing. Under the atomic model a submission is one legal act, so
// there is no partial success to represent: this returns either a complete set
// of resolved values or a list of problems (§83, §136).

import type { PreparationFieldType } from "@lagda/contracts";
import { fieldInputPolicy } from "./field-input-policy.js";

// ── What the caller supplies ─────────────────────────────────────────────────

/** One field assignment, from the immutable snapshot. */
export interface AssignedField {
  readonly fieldId: string;
  readonly type: PreparationFieldType;
  readonly required: boolean;
}

/** One value, already schema-validated at the edge. */
export type SubmittedValue =
  | { readonly fieldId: string; readonly kind: "signature" }
  | { readonly fieldId: string; readonly kind: "initials" }
  | { readonly fieldId: string; readonly kind: "text"; readonly text: string }
  | { readonly fieldId: string; readonly kind: "checkbox"; readonly checked: boolean };

/** The immutable recipient facts server-derived fields are filled from. */
export interface RecipientDerivationSource {
  readonly name: string;
  readonly email: string;
  readonly organization: string | null;
}

// ── What comes back ──────────────────────────────────────────────────────────

export type ResolvedValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "boolean"; readonly checked: boolean }
  | { readonly kind: "instant"; readonly at: number }
  | { readonly kind: "representation"; readonly purpose: "signature" | "initials" };

export interface ResolvedFieldValue {
  readonly fieldId: string;
  readonly type: PreparationFieldType;
  readonly source: "RECIPIENT_PROVIDED" | "SERVER_DERIVED";
  readonly value: ResolvedValue;
}

/**
 * Why a submission was refused.
 *
 * A BOUNDED vocabulary. `field-not-available` deliberately covers both "not
 * yours" and "does not exist", because distinguishing them tells a caller
 * whether a field id they guessed is real — which is exactly the ownership
 * information §207 says not to reveal.
 */
export type SubmissionProblemCode =
  | "field-not-available"
  | "field-duplicated"
  | "field-type-mismatch"
  | "field-required"
  | "field-value-invalid"
  | "field-server-owned"
  | "signature-missing"
  | "initials-missing";

export interface SubmissionProblem {
  readonly code: SubmissionProblemCode;
  /** Only ever a field the caller is authorized for, or absent. */
  readonly fieldId?: string;
}

export type SubmissionResolution =
  | { readonly ok: true; readonly values: readonly ResolvedFieldValue[];
      readonly needsSignature: boolean; readonly needsInitials: boolean }
  | { readonly ok: false; readonly problems: readonly SubmissionProblem[] };

// ── Text normalization ───────────────────────────────────────────────────────

/**
 * Trim the ends, keep the middle, refuse control characters.
 *
 * §73 warns against trimming meaningful internal whitespace: a signer typing an
 * address across two lines means both lines. Leading and trailing whitespace is
 * an artefact of a text box, so it goes.
 *
 * Control characters other than newline and tab are refused rather than
 * stripped — silently altering what somebody signed is worse than refusing it.
 */
/**
 * A code-point test rather than a character class.
 *
 * A regex of control characters means either literal control bytes in the
 * source - which lint rightly refuses, because they are invisible to a
 * reviewer - or a wall of escapes. Comparing code points says the same thing
 * in a form somebody can actually check: everything below space is refused
 * except tab, newline and carriage return, and DEL is refused too.
 */
function isDisallowedControlCharacter(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) return false;
  return codePoint < 0x20 || codePoint === 0x7f;
}

export function normalizeSigningText(raw: string): string | null {
  for (const character of raw) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isDisallowedControlCharacter(codePoint)) {
      return null;
    }
  }
  // `trim` rather than a whitespace regex: same effect at the ends, no
  // escaped whitespace in the source, and it handles the Unicode spaces a
  // hand-written class would miss. The MIDDLE is untouched, which is the
  // part that matters - a signer typing an address across two lines meant
  // both lines.
  return raw.trim();
}

// ── The resolution ───────────────────────────────────────────────────────────

/**
 * Match what was submitted against what was assigned, and fill in the rest.
 *
 * ── The server decides the field set, not the client ───────────────────────
 *
 * `assigned` comes from the immutable snapshot. A client cannot say "these are
 * all my fields" (§81), cannot add one that is not theirs (§84), and cannot
 * omit a required one (§83).
 */
export function resolveSubmission(input: {
  readonly assigned: readonly AssignedField[];
  readonly submitted: readonly SubmittedValue[];
  readonly recipient: RecipientDerivationSource;
  readonly acceptedAt: number;
}): SubmissionResolution {
  const problems: SubmissionProblem[] = [];
  const assignedById = new Map(input.assigned.map(f => [f.fieldId, f]));

  // Duplicates first: a payload that names one field twice is malformed, and
  // deduplicating it silently would pick a winner nobody chose (§88).
  const seen = new Set<string>();
  for (const value of input.submitted) {
    if (seen.has(value.fieldId)) {
      problems.push({ code: "field-duplicated", fieldId: value.fieldId });
    }
    seen.add(value.fieldId);
  }

  const submittedById = new Map<string, SubmittedValue>();
  for (const value of input.submitted) {
    const field = assignedById.get(value.fieldId);
    if (field === undefined) {
      // Not assigned to this recipient, or not a field at all. One code for
      // both — see the vocabulary note above.
      problems.push({ code: "field-not-available", fieldId: value.fieldId });
      continue;
    }
    submittedById.set(value.fieldId, value);
  }

  const values: ResolvedFieldValue[] = [];
  let needsSignature = false;
  let needsInitials = false;

  for (const field of input.assigned) {
    const policy = fieldInputPolicy(field.type);

    if (policy.authority === "SERVER_DERIVED") {
      // REJECT a client value here, never ignore one.
      //
      // The contract has no member that fits these types, so a value for one
      // means a client that is broken or lying. Ignoring it would hide that
      // and let the client keep believing it set the signing date; refusing
      // makes the disagreement visible while there is still time to fix it
      // (§70, §329).
      if (submittedById.has(field.fieldId)) {
        problems.push({ code: "field-server-owned", fieldId: field.fieldId });
        continue;
      }
      const derived = deriveServerValue(field.type, input);
      if (derived === null) {
        problems.push({ code: "field-value-invalid", fieldId: field.fieldId });
        continue;
      }
      values.push({
        fieldId: field.fieldId, type: field.type,
        source: "SERVER_DERIVED", value: derived,
      });
      continue;
    }

    const submitted = submittedById.get(field.fieldId);
    if (submitted === undefined) {
      if (field.required) {
        problems.push({ code: "field-required", fieldId: field.fieldId });
      }
      // An omitted optional field produces NO ROW. Absence is the record that
      // nothing was entered; a row holding "" would claim the signer typed an
      // empty string (§86, §87).
      continue;
    }

    const resolved = resolveOne(field, submitted);
    if (resolved === null) {
      problems.push({ code: "field-type-mismatch", fieldId: field.fieldId });
      continue;
    }
    if (resolved === "invalid") {
      problems.push({ code: "field-value-invalid", fieldId: field.fieldId });
      continue;
    }
    if (resolved.kind === "representation") {
      if (resolved.purpose === "signature") needsSignature = true;
      else needsInitials = true;
    }
    values.push({
      fieldId: field.fieldId, type: field.type,
      source: "RECIPIENT_PROVIDED", value: resolved,
    });
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, values, needsSignature, needsInitials };
}

function deriveServerValue(
  type: PreparationFieldType,
  input: {
    readonly recipient: RecipientDerivationSource;
    readonly acceptedAt: number;
  },
): ResolvedValue | null {
  switch (type) {
    // The submission instant itself. One act, one time — never a browser's
    // idea of today, and never a second clock reading (§68, §69, §169).
    case "date-signed":
      return { kind: "instant", at: input.acceptedAt };
    // The IMMUTABLE snapshot, not the current contact and not an account.
    case "full-name":
      return { kind: "text", text: input.recipient.name };
    case "email":
      return { kind: "text", text: input.recipient.email };
    default:
      return null;
  }
}

/** `null` = wrong kind for this field. `"invalid"` = right kind, bad value. */
function resolveOne(
  field: AssignedField,
  submitted: SubmittedValue,
): ResolvedValue | null | "invalid" {
  switch (field.type) {
    case "signature":
      return submitted.kind === "signature"
        ? { kind: "representation", purpose: "signature" } : null;
    case "initials":
      return submitted.kind === "initials"
        ? { kind: "representation", purpose: "initials" } : null;
    case "checkbox": {
      if (submitted.kind !== "checkbox") return null;
      // A REQUIRED checkbox must be TRUE. "Required" on an acknowledgment is
      // not "you must tell us either way" — an acknowledgment nobody ticked is
      // not an acknowledgment (§76).
      if (field.required && !submitted.checked) return "invalid";
      return { kind: "boolean", checked: submitted.checked };
    }
    case "text":
    case "title":
    case "company": {
      if (submitted.kind !== "text") return null;
      const normalized = normalizeSigningText(submitted.text);
      if (normalized === null) return "invalid";
      const max = fieldInputPolicy(field.type).maxLength;
      if (max !== null && normalized.length > max) return "invalid";
      if (field.required && normalized.length === 0) return "invalid";
      return { kind: "text", text: normalized };
    }
    // Server-derived types never reach here.
    case "date-signed":
    case "full-name":
    case "email":
      return null;
  }
}

// ── Idempotency fingerprint ──────────────────────────────────────────────────

/**
 * The canonical logical submission, for fingerprinting.
 *
 * ── What is IN ─────────────────────────────────────────────────────────────
 *
 * The request, the recipient, and the submitted values sorted by field id.
 * §34: input array order must not make two logically identical submissions
 * look different, because a client that reorders its own array on retry would
 * otherwise get a spurious conflict.
 *
 * ── What is OUT, and why each one ──────────────────────────────────────────
 *
 * The signature PAYLOAD. A drawn signature is a canvas rasterisation, and a
 * retry that re-renders the same strokes can differ by a byte. Fingerprinting
 * it would turn every drawn-signature retry into a 409. The signature's
 * PRESENCE and METHOD are included, because switching from typed to drawn is a
 * different act; the pixels are not.
 *
 * Also out, per §33: the HTTP correlation id, the session token, the CSRF
 * token, the IP, the user agent, the generated submission id, and every
 * backend timestamp — all of which differ between two attempts at the same act.
 */
export function canonicalSubmissionFingerprint(input: {
  readonly signingRequestId: string;
  readonly recipientId: string;
  readonly submitted: readonly SubmittedValue[];
  readonly signatureMethod: string | null;
  readonly initialsMethod: string | null;
}): string {
  const values = [...input.submitted]
    .sort((a, b) => (a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0))
    .map(value => {
      switch (value.kind) {
        case "text": return [value.fieldId, "text", value.text];
        case "checkbox": return [value.fieldId, "checkbox", String(value.checked)];
        case "signature": return [value.fieldId, "signature"];
        case "initials": return [value.fieldId, "initials"];
      }
    });

  return JSON.stringify({
    v: 1,
    signingRequestId: input.signingRequestId,
    recipientId: input.recipientId,
    signatureMethod: input.signatureMethod,
    initialsMethod: input.initialsMethod,
    values,
  });
}
