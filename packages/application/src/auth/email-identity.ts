// Canonical account identity.
//
// ONE normalization rule for the whole backend. Registration, login, password
// reset, email verification and invitation acceptance must all resolve an
// account through `normalizeEmail`, or two of them will disagree about who a
// user is — and the disagreement will surface as either a duplicate account or
// an authentication bypass (INV-231).
//
// This file is the reason `.toLowerCase()` must not appear next to an email
// anywhere else.

/**
 * Bounded, and matched to the database column.
 *
 * 254 is the practical maximum length of an addressable mailbox (RFC 5321's
 * path limit). Anything longer is not a mailbox anyone can receive at, and an
 * unbounded account identifier is an index problem and a hashing cost.
 */
export const MAX_EMAIL_LENGTH = 254;

/**
 * Structure only, deliberately.
 *
 * A regex cannot decide whether a mailbox exists or accepts mail — only
 * delivery can, which is what email verification is for. Attempting RFC 5322 in
 * a pattern produces something unreadable that still rejects valid addresses.
 * This checks that there is a local part, one `@`, a domain with a dot, and no
 * whitespace.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A normalized email, usable as an account lookup key. */
export type NormalizedEmail = string & { readonly __brand: "NormalizedEmail" };

export type EmailRejection = "empty" | "too-long" | "malformed";

export type EmailNormalization =
  | { readonly outcome: "ok"; readonly normalized: NormalizedEmail; readonly display: string }
  | { readonly outcome: "rejected"; readonly reason: EmailRejection };

/**
 * The canonical rule: TRIM, then LOWERCASE. Nothing else.
 *
 * Deliberately conservative. The rewrites LAGDA does NOT perform, and why:
 *
 *   - Gmail dot-stripping (`john.smith@` → `johnsmith@`). Correct for Gmail,
 *     wrong for every server that treats dots as significant. Applying it would
 *     merge two genuinely different mailboxes into one account.
 *   - Plus-address stripping (`user+tag@` → `user@`). Same hazard, and it is a
 *     legitimate way for a user to keep separate accounts.
 *   - `googlemail.com` → `gmail.com`. A provider-specific fact that will not
 *     stay true for every provider LAGDA's users have.
 *
 * Each of those turns a mailbox someone controls into one they may not, which
 * in an authentication system is an account takeover primitive, not a
 * convenience.
 *
 * Lowercasing is itself a choice with a trade-off: the local part of an address
 * is technically case-sensitive per RFC 5321, so `User@x.com` and `user@x.com`
 * are formally distinct mailboxes. In practice no mail provider distinguishes
 * them, users type their address inconsistently, and the frontend already
 * lowercases before submitting. Treating them as one account is what a user
 * expects; treating them as two would create silent duplicate accounts and
 * failed logins. Documented in EMAIL_IDENTITY.md rather than left implicit.
 */
export function normalizeEmail(raw: string): EmailNormalization {
  const display = raw.trim();
  if (display.length === 0) return { outcome: "rejected", reason: "empty" };
  if (display.length > MAX_EMAIL_LENGTH) return { outcome: "rejected", reason: "too-long" };
  if (!EMAIL_SHAPE.test(display)) return { outcome: "rejected", reason: "malformed" };

  // Locale-independent. `toLowerCase()` is affected by the ambient locale for a
  // few characters — Turkish dotless i being the well-known case — and an
  // account key that depends on the server's locale is a key that changes when
  // the server does.
  return {
    outcome: "ok",
    normalized: display.toLocaleLowerCase("en-US") as NormalizedEmail,
    display,
  };
}

/**
 * Asserts a value is already normalized.
 *
 * For repository boundaries: a repository must receive a canonical key, never
 * normalize one itself (INV-231). A DB adapter that lowercased independently
 * would be a second normalization rule, and the two would drift.
 */
export function assertNormalized(value: string): NormalizedEmail {
  const result = normalizeEmail(value);
  if (result.outcome !== "ok" || result.normalized !== value) {
    throw new TypeError(
      "Email must be normalized through normalizeEmail before reaching this boundary.",
    );
  }
  return result.normalized;
}
