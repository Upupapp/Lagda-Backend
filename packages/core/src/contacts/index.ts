// Contact domain rules.
//
// ── The boundary this file defends ──────────────────────────────────────────
//
// A contact is a name and an email somebody typed into an address book. LAGDA
// has verified none of it. The domain therefore has exactly one job beyond
// tidying input: to keep contact data from being mistaken for identity data.
//
// Concretely, and these are the rules a reviewer should check this file against:
//
//   1. Nothing here produces a `NormalizedEmail`. That brand is the ACCOUNT
//      lookup key, and a value carrying it can be handed to
//      `findUserByNormalizedEmail`. A contact address must never reach that
//      function — it would turn "someone typed an address" into "we found an
//      account", which is the whole class of bug this domain guards against.
//      Contacts get their own brand, `ContactEmailKey`, and the two are
//      mutually unassignable.
//
//   2. There is no `verify`, `confirm` or `link` operation, and no `userId`.
//      A contact that matches a LAGDA user's email is still a contact.
//
//   3. The comparison key exists for DUPLICATE DETECTION and exact-match
//      search. Nothing else may read it.
//
// Pure: no clock, no persistence, no HTTP.

import { hasEmailSyntax, MAX_EMAIL_LENGTH } from "../common/index.js";
import {
  CONTACT_NAME_MAX_LENGTH, CONTACT_NAME_MIN_LENGTH,
  CONTACT_PHONE_MAX_LENGTH, CONTACT_ORGANIZATION_MAX_LENGTH,
  CONTACT_TITLE_MAX_LENGTH, CONTACT_SEARCH_MAX_LENGTH,
  CONTACT_SORT_FIELDS, CONTACT_STATES,
  type ContactSortField, type ContactState,
} from "@lagda/contracts";

export {
  CONTACT_NAME_MAX_LENGTH, CONTACT_NAME_MIN_LENGTH,
  CONTACT_PHONE_MAX_LENGTH, CONTACT_ORGANIZATION_MAX_LENGTH,
  CONTACT_TITLE_MAX_LENGTH, CONTACT_SEARCH_MAX_LENGTH,
  CONTACT_SORT_FIELDS, CONTACT_STATES,
};
export type { ContactSortField, ContactState };

// ── Text fields ──────────────────────────────────────────────────────────────

/**
 * The same control/format character rule as workspace names and profile text.
 *
 * One expression for every human-entered name in the system. `Cc` catches NUL
 * and newline — a contact name containing one breaks a log line, a CSV export
 * and a PDF recipient block. `Cf` catches zero-width and bidirectional-override
 * characters, which matter more here than anywhere else in LAGDA: a recipient
 * name rendered with an RTL override can display as a different person's name
 * than the one stored, on a document someone is about to sign.
 *
 * Everything else is permitted. An ASCII allowlist would reject `José Ramírez`,
 * `株式会社`, and Baybayin — a large share of this product's own customers.
 */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

export type ContactTextRejection = "empty" | "too-long" | "control-characters";

export type ContactTextResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: ContactTextRejection };

/**
 * Trims the OUTSIDE only, then validates.
 *
 * Interior spacing is the customer's. Collapsing `Reyes  &  Co.` to
 * `Reyes & Co.` is the system deciding it knows a business name better than the
 * person who typed it. Leading and trailing whitespace is a paste artefact and
 * is invisible in every UI that renders it.
 *
 * Length is counted in CODE POINTS via the string iterator, not `.length`,
 * which counts UTF-16 units — so a name in a supplementary plane is not charged
 * double against a limit expressed in characters.
 *
 * The control-character check runs BEFORE the length check, so a long string
 * full of NULs is reported as the problem it actually has.
 */
export function validateContactName(raw: string): ContactTextResult {
  const trimmed = raw.trim();
  if (trimmed.length < CONTACT_NAME_MIN_LENGTH) return { ok: false, reason: "empty" };
  if (CONTROL_CHARACTERS.test(trimmed)) {
    return { ok: false, reason: "control-characters" };
  }
  if ([...trimmed].length > CONTACT_NAME_MAX_LENGTH) {
    return { ok: false, reason: "too-long" };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validates an OPTIONAL text field — phone, organization or title.
 *
 * `null` in, `null` out. So is a string that trims to empty: a form submitting
 * `""` for an untouched field means "not provided", and storing an empty string
 * would create a second representation of absent that every reader then has to
 * handle. One representation, chosen here.
 */
export function validateOptionalContactText(
  raw: string | null | undefined,
  maxLength: number,
): { ok: true; value: string | null } | { ok: false; reason: ContactTextRejection } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (CONTROL_CHARACTERS.test(trimmed)) {
    return { ok: false, reason: "control-characters" };
  }
  if ([...trimmed].length > maxLength) return { ok: false, reason: "too-long" };
  return { ok: true, value: trimmed };
}

// ── Email ────────────────────────────────────────────────────────────────────

/**
 * A contact email folded for COMPARISON. Not an account key.
 *
 * Branded distinctly from `NormalizedEmail` on purpose, and the brands are
 * mutually unassignable, so the compiler refuses:
 *
 * ```ts
 * findUserByNormalizedEmail(contact.emailKey)  // ← type error, and rightly so
 * ```
 *
 * That single type error is the strongest guarantee in this domain: it makes
 * "look up the LAGDA account for this contact" impossible to write by accident
 * rather than merely discouraged in a document.
 */
export type ContactEmailKey = string & { readonly __brand: "ContactEmailKey" };

export type ContactEmailRejection = "empty" | "too-long" | "malformed";

export type ContactEmailResult =
  | {
      readonly ok: true;
      /** Exactly what the user typed, trimmed. This is what gets displayed. */
      readonly display: string;
      /** Folded, for duplicate detection only. */
      readonly key: ContactEmailKey;
    }
  | { readonly ok: false; readonly reason: ContactEmailRejection };

/**
 * Validates a contact email and derives its comparison key.
 *
 * ── Two values, and why both are stored ────────────────────────────────────
 *
 * `display` preserves the case the user typed. A contact card that shows
 * `Maria.Santos@Ayala.com.ph` back as `maria.santos@ayala.com.ph` has quietly
 * rewritten someone's business card, and address-book data is exactly where
 * that is noticed and resented.
 *
 * `key` is lowercased so duplicate detection can work. The SAME conservative
 * fold as account identity — trim and lowercase, nothing else. No Gmail
 * dot-stripping and no plus-tag removal: those merge mailboxes that different
 * people may control. In an authentication system that is an account-takeover
 * primitive; in an address book it is quieter but still wrong — it would report
 * `billing+ph@acme.com` and `billing+sg@acme.com` as the same contact, and they
 * are deliberately two.
 *
 * The fold is locale-independent. `toLowerCase()` is affected by the ambient
 * locale for a few characters — Turkish dotless i being the known case — and a
 * comparison key that changes with the server's locale is a key that produces
 * different duplicate results on different machines.
 *
 * ── What this does NOT do ──────────────────────────────────────────────────
 *
 * It does not check that the mailbox exists, that it accepts mail, or that
 * anyone at that address has consented to anything. Syntax is the only claim.
 */
export function validateContactEmail(raw: string): ContactEmailResult {
  const display = raw.trim();
  if (display.length === 0) return { ok: false, reason: "empty" };
  if (display.length > MAX_EMAIL_LENGTH) return { ok: false, reason: "too-long" };
  if (!hasEmailSyntax(display)) return { ok: false, reason: "malformed" };

  return {
    ok: true,
    display,
    key: display.toLocaleLowerCase("en-US") as ContactEmailKey,
  };
}

// ── State ────────────────────────────────────────────────────────────────────

/**
 * A contact's state, derived from `archivedAt`.
 *
 * Never a stored column, for the reason invitation state is never one: two
 * representations of a single fact drift, and the one that drifts is always the
 * denormalised copy. Here the derivation is a null check, which makes storing a
 * status column purely a way to be wrong.
 */
export function deriveContactState(archivedAt: number | null): ContactState {
  return archivedAt === null ? "active" : "archived";
}

/**
 * Whether a contact may be edited.
 *
 * An archived contact is read-only: it is out of the address book, and editing
 * it would be maintaining a record nobody can select. Restore it first. This is
 * one predicate rather than an `archivedAt !== null` check repeated in update
 * and archive, so the two cannot disagree.
 */
export function isContactEditable(archivedAt: number | null): boolean {
  return archivedAt === null;
}
