// Signing recipient domain rules.
//
// Pure: no clock, no persistence, no HTTP. The interesting rules are the two
// boundaries — a recipient is not a contact, and a recipient's email is not an
// identity — and both are enforced by types rather than by care.

import { hasEmailSyntax, MAX_EMAIL_LENGTH } from "../common/index.js";
import {
  RECIPIENT_TYPES, RECIPIENT_NAME_MAX_LENGTH, RECIPIENT_NAME_MIN_LENGTH,
  RECIPIENT_ORGANIZATION_MAX_LENGTH, MAX_RECIPIENTS_PER_PREPARATION,
  type RecipientType, type PreparationFieldType,
} from "@lagda/contracts";

export {
  RECIPIENT_TYPES, RECIPIENT_NAME_MAX_LENGTH, RECIPIENT_NAME_MIN_LENGTH,
  RECIPIENT_ORGANIZATION_MAX_LENGTH, MAX_RECIPIENTS_PER_PREPARATION,
};
export type { RecipientType };

/**
 * The same control/format rule as every other human-entered name in LAGDA.
 *
 * It matters more here than anywhere: a recipient name is what a signer is told
 * they are, and what a completion certificate will eventually carry. A
 * bidirectional override can make "Maria Santos" render as a different name on
 * the one screen where that is legally material.
 */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

export type RecipientTextRejection = "empty" | "too-long" | "control-characters";

export type RecipientTextResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: RecipientTextRejection };

/**
 * Validates a recipient's name.
 *
 * Trims the outside only. Interior spacing belongs to whoever typed it — and a
 * person's name is the last place to apply a normalizer's opinion. Length is
 * counted in CODE POINTS, so a name in Baybayin or Han is not charged double.
 *
 * Everything else is permitted: `José Ramírez`, `株式会社トヨタ`, `Ñoño Dela
 * Cruz`. §19 forbids ASCII-only validation, and it would exclude a large share
 * of this product's own signers.
 */
export function validateRecipientName(raw: string): RecipientTextResult {
  const trimmed = raw.trim();
  if (trimmed.length < RECIPIENT_NAME_MIN_LENGTH) return { ok: false, reason: "empty" };
  if (CONTROL_CHARACTERS.test(trimmed)) {
    return { ok: false, reason: "control-characters" };
  }
  if ([...trimmed].length > RECIPIENT_NAME_MAX_LENGTH) {
    return { ok: false, reason: "too-long" };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validates an optional organization.
 *
 * `null`, `undefined` and blank all become `null` — one representation of
 * absent, so no reader has to handle two.
 */
export function validateRecipientOrganization(
  raw: string | null | undefined,
): { ok: true; value: string | null } | { ok: false; reason: RecipientTextRejection } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (CONTROL_CHARACTERS.test(trimmed)) {
    return { ok: false, reason: "control-characters" };
  }
  if ([...trimmed].length > RECIPIENT_ORGANIZATION_MAX_LENGTH) {
    return { ok: false, reason: "too-long" };
  }
  return { ok: true, value: trimmed };
}

// ── Email ────────────────────────────────────────────────────────────────────

/**
 * A recipient email folded for DUPLICATE COMPARISON. Not an identity.
 *
 * A third brand alongside `NormalizedEmail` (the account key) and
 * `ContactEmailKey` (the address-book key), and all three are mutually
 * unassignable. The same fold, three meanings:
 *
 *   NormalizedEmail      authenticates an account
 *   ContactEmailKey      finds duplicate address-book entries
 *   RecipientEmailKey    finds duplicate participants in ONE preparation
 *
 * So `findUserByNormalizedEmail(recipient.emailKey)` is a compile error, and
 * so is passing a recipient key where a contact key belongs. That is the
 * guarantee §94 and §170 need — "do not auto-resolve a recipient to a LAGDA
 * account" is not a rule someone has to remember.
 */
export type RecipientEmailKey = string & { readonly __brand: "RecipientEmailKey" };

export type RecipientEmailRejection = "empty" | "too-long" | "malformed";

export type RecipientEmailResult =
  | {
      readonly ok: true;
      /** Exactly what was entered, trimmed. This is the DELIVERY address. */
      readonly display: string;
      /** Folded, for the duplicate rule only. */
      readonly key: RecipientEmailKey;
    }
  | { readonly ok: false; readonly reason: RecipientEmailRejection };

/**
 * Validates a recipient email and derives its comparison key.
 *
 * ── Syntax only ────────────────────────────────────────────────────────────
 *
 * It checks the shape and nothing else. It does not check that the mailbox
 * exists, that anyone reads it, or that the person named controls it. §162 is
 * explicit: the backend validates syntax; possession is proved later or never.
 *
 * ── The same conservative fold as everywhere else ──────────────────────────
 *
 * Trim and lowercase. No Gmail dot-stripping, no plus-tag removal (§22): both
 * merge mailboxes different people may control, and here that would silently
 * refuse a second legitimate recipient as a duplicate.
 *
 * The DISPLAY address is preserved separately, because it is what an invitation
 * is actually sent to — rewriting a delivery address to satisfy a comparison
 * would be changing where mail goes (§23).
 */
export function validateRecipientEmail(raw: string): RecipientEmailResult {
  const display = raw.trim();
  if (display.length === 0) return { ok: false, reason: "empty" };
  if (display.length > MAX_EMAIL_LENGTH) return { ok: false, reason: "too-long" };
  if (!hasEmailSyntax(display)) return { ok: false, reason: "malformed" };

  return {
    ok: true,
    display,
    // Locale-independent: `toLowerCase()` varies with the ambient locale for a
    // few characters, and a comparison key that changes with the server's
    // locale is a key that finds different duplicates on different machines.
    key: display.toLocaleLowerCase("en-US") as RecipientEmailKey,
  };
}

// ── Field eligibility ────────────────────────────────────────────────────────

/**
 * Whether a recipient of this type may be assigned preparation fields.
 *
 * ── The product's answer, not mine ─────────────────────────────────────────
 *
 * `FIELD_ELIGIBLE_ROLES` in the frontend lists `viewer` and `carbon-copy` for
 * NO field type, and the role descriptions say why: both "do not block
 * completion". A viewer with a required signature field would be a participant
 * the workflow simultaneously waits for and does not.
 *
 * The other four are eligible. Which SPECIFIC field types each may hold is a
 * finer question the product answers per type, and BACKEND-37 will need it when
 * it knows what an approver's approval is. Today the coarse rule is the one
 * that can be enforced honestly.
 */
export function canHoldFields(type: RecipientType): boolean {
  return type !== "viewer" && type !== "carbon-copy";
}

/**
 * Whether a field type needs a recipient before the preparation is complete.
 *
 * Every implemented field type asks a PARTICIPANT for something — there is no
 * sender-filled or system-filled type in BACKEND-30's nine (`sender-text` was
 * deferred precisely because it is sender-filled). So all nine require an
 * assignee at readiness.
 *
 * Declared as a function rather than assumed, because the moment `sender-text`
 * or a system-populated field arrives this is where the answer changes (§65).
 */
export function fieldRequiresRecipient(_type: PreparationFieldType): boolean {
  return true;
}

// ── Ordering ─────────────────────────────────────────────────────────────────

/**
 * Normalizes display order to a dense 0-based sequence.
 *
 * ── Dense, not sparse ──────────────────────────────────────────────────────
 *
 * §81 offers gaps (10, 20, 30) or normalization. Normalization is chosen: the
 * client sends the order it wants and the server renumbers, so there is exactly
 * one representation of a given order and no drift between clients that
 * renumber differently.
 *
 * Gaps would be worth it if reordering were a single-row update. It is not —
 * recipients are saved as a set — so the argument for gaps does not apply.
 */
export function normalizeOrder<T>(items: readonly T[]): readonly { item: T; orderIndex: number }[] {
  return items.map((item, index) => ({ item, orderIndex: index }));
}

/**
 * Whether a routing plan is coherent.
 *
 * ── What this checks, and what it deliberately does not ────────────────────
 *
 * Routing orders must be positive integers. Equal values are ALLOWED and mean
 * parallel within a step — the meaning §38 requires to be stated.
 *
 * It does NOT require a contiguous 1..N sequence. A sender who deletes the
 * only recipient at step 2 leaves 1 and 3, and refusing to save that would
 * block ordinary editing to enforce tidiness. What a gap means for the ceremony
 * is BACKEND-37's question; storing intent is this command's.
 */
export function isValidRoutingOrder(routingOrder: number): boolean {
  return Number.isInteger(routingOrder) && routingOrder >= 1;
}
