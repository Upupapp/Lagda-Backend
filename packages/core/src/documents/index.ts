// Document domain rules.
//
// ── Small on purpose ───────────────────────────────────────────────────────
//
// A document has exactly one mutable field — its title — and no lifecycle
// state. That is not a stub: it is what the product has. Every status LAGDA
// displays is a `TransactionStatus`, and a document-level state machine would
// be a second, staler answer to a question the signing request already answers.
//
// So this file validates a title and nothing else, and the absence of a
// `deriveDocumentState` here is the finding rather than the gap.
//
// Pure: no clock, no persistence, no HTTP, and — importantly — no PDF library.
// The document domain never touches bytes.

import {
  DOCUMENT_TITLE_MAX_LENGTH, DOCUMENT_TITLE_MIN_LENGTH,
  DOCUMENT_FILENAME_MAX_LENGTH, DOCUMENT_SORT_FIELDS,
  type DocumentSortField,
} from "@lagda/contracts";

export {
  DOCUMENT_TITLE_MAX_LENGTH, DOCUMENT_TITLE_MIN_LENGTH,
  DOCUMENT_FILENAME_MAX_LENGTH, DOCUMENT_SORT_FIELDS,
};
export type { DocumentSortField };

/**
 * The same control/format rule as every other human-entered name in LAGDA.
 *
 * `Cc` catches NUL and newline — a title containing one breaks a log line, a
 * CSV export and a PDF recipient block. `Cf` catches zero-width and
 * bidirectional overrides, which matter here for a specific reason: a document
 * title is what a signer is told they are signing. A title rendered with an RTL
 * override can display as something other than what is stored, on the one
 * screen where that difference is legally material.
 */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

export type DocumentTitleRejection = "empty" | "too-long" | "control-characters";

export type DocumentTitleResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: DocumentTitleRejection };

/**
 * Normalizes and validates a document title.
 *
 * Trims the OUTSIDE only. Interior spacing belongs to whoever typed it, and
 * collapsing `Deed of Sale  —  Lot 42` is the system deciding it knows a legal
 * document's name better than the lawyer who named it.
 *
 * Length is counted in CODE POINTS, so a Baybayin or CJK title is not charged
 * double against a limit expressed in characters. The control-character check
 * runs first, so a long string full of NULs is reported as the problem it has.
 */
export function validateDocumentTitle(raw: string): DocumentTitleResult {
  const trimmed = raw.trim();
  if (trimmed.length < DOCUMENT_TITLE_MIN_LENGTH) return { ok: false, reason: "empty" };
  if (CONTROL_CHARACTERS.test(trimmed)) {
    return { ok: false, reason: "control-characters" };
  }
  if ([...trimmed].length > DOCUMENT_TITLE_MAX_LENGTH) {
    return { ok: false, reason: "too-long" };
  }
  return { ok: true, value: trimmed };
}

/**
 * Derives an initial title from an original filename.
 *
 * ── Why a filename and not the PDF's own metadata ──────────────────────────
 *
 * A PDF carries an embedded `/Title`, and using it would be the obvious
 * convenience. It is attacker-controlled text inside an untrusted file: it can
 * be blank, can be a previous customer's matter name left in a reused template,
 * and can be crafted. §228 rules it out, and so does the fact that reading it
 * would put a PDF parser in the document domain.
 *
 * ── What this does ─────────────────────────────────────────────────────────
 *
 * Strips a single trailing extension and nothing else. `lease-v4-final.pdf`
 * becomes `lease-v4-final`, which is what a person would call it. Underscores
 * and hyphens are NOT turned into spaces and the result is NOT title-cased:
 * both are guesses that make `SPA_2026_v3` worse, and the user can rename.
 *
 * Returns null when there is nothing usable, so the caller has to decide what
 * an untitled document is called rather than receiving `"untitled"` from a
 * layer that has no product opinion.
 */
export function titleFromFilename(filename: string | null): string | null {
  if (filename === null) return null;
  // The extension only. A leading-dot file like `.hidden` has no name to take.
  const withoutExtension = filename.replace(/\.[A-Za-z0-9]{1,8}$/u, "");
  const candidate = withoutExtension.trim();
  if (candidate.length === 0) return null;

  const validated = validateDocumentTitle(candidate);
  // A filename that fails the title rules yields null rather than a repaired
  // string. Silently sanitizing untrusted display text into something that
  // passes is how a crafted name reaches a signer's screen looking legitimate.
  return validated.ok ? validated.value : null;
}
