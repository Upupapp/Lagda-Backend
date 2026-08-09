// Registration.
//
// ── Order, and why ─────────────────────────────────────────────────────────
//
//   1. normalize the email        cheap, and decides identity
//   2. check the password policy  cheap, deterministic
//   3. (rate limiting already ran at the route, before any of this)
//   4. HASH the password          expensive — Argon2id, deliberately slow
//   5. open a SHORT transaction   user + verification challenge together
//
// Hashing sits after every cheap check and BEFORE the transaction. Both
// placements matter:
//
//   * after the cheap checks, because Argon2id is designed to cost memory and
//     CPU, and spending it on a password that fails a length rule is free work
//     an attacker can request at will (INV-234);
//   * before the transaction, because holding a database connection and its
//     locks for the duration of a deliberately slow hash is how a registration
//     spike becomes a database outage (INV-234).

import type { Clock } from "../common/ports/index.js";
import {
  normalizeEmail, type NormalizedEmail,
} from "./email-identity.js";
import {
  EmailAlreadyRegisteredError,
  type PasswordHasher, type UserId, type UserRepository,
  type VerificationChallengeId, type VerificationChallengeRepository,
  type VerificationTokenFactory,
} from "../common/ports/auth.js";

// ── Password policy ──────────────────────────────────────────────────────────

/**
 * Minimum length, matching the frontend's `isPasswordAcceptable` (>= 8).
 *
 * MEASURED from the real registration form, not chosen from a blog post. The
 * handoff specifies no password policy, so the frontend is the only stated
 * requirement and a server minimum stricter than the UI would reject passwords
 * the UI told the user were fine.
 *
 * Recorded as a security decision rather than a silent default (OD-063): 8 is
 * the current product answer, and it is on the low side of modern guidance.
 */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * Maximum length.
 *
 * Not a security rule — a resource bound. Argon2id hashes its input regardless
 * of size, and a multi-megabyte "password" is a cheap way to make the server do
 * expensive work. 1024 characters accommodates any real passphrase or password
 * manager output.
 *
 * The input is REJECTED, never silently truncated: truncation would mean two
 * different passwords authenticate the same account.
 */
export const PASSWORD_MAX_LENGTH = 1024;

export type PasswordRejection = "too-short" | "too-long";

/**
 * Checks length, and NOTHING else.
 *
 * No forced uppercase/digit/symbol composition rules. They push users toward
 * `Password1!` — predictable, and shorter than a passphrase that would be
 * stronger. The product specifies none, so none are invented.
 *
 * The password is NOT trimmed, lowercased or Unicode-normalized. It is an
 * opaque byte sequence: a leading space may be deliberate, and altering it
 * would mean the password a user typed is not the password LAGDA stored
 * (INV-233).
 */
export function checkPassword(plaintext: string): PasswordRejection | null {
  if (plaintext.length < PASSWORD_MIN_LENGTH) return "too-short";
  if (plaintext.length > PASSWORD_MAX_LENGTH) return "too-long";
  return null;
}

// ── The use case ─────────────────────────────────────────────────────────────

export interface RegisterUserInput {
  readonly email: string;
  /** Used to derive a hash, then dropped. Never stored, never logged. */
  readonly password: string;
  readonly displayName: string;
  readonly organization?: string;
  readonly intendedUse?: string;
  /**
   * The user ticked "I agree to LAGDA's Terms of Service and Privacy Policy."
   *
   * Required to be `true`. A registration that proceeded without it would
   * record an acceptance that never happened.
   */
  readonly acceptedTerms: boolean;
}

export interface RegisterUserDependencies {
  readonly users: UserRepository;
  readonly challenges: VerificationChallengeRepository;
  readonly hasher: PasswordHasher;
  readonly tokens: VerificationTokenFactory;
  readonly clock: Clock;
  readonly newUserId: () => UserId;
  readonly newChallengeId: () => VerificationChallengeId;
  /**
   * Runs the two writes together.
   *
   * A user with no verification challenge cannot ever verify their email, and a
   * challenge with no user references nothing. Both or neither (INV-240).
   */
  readonly commit: (
    operation: (repositories: {
      readonly users: UserRepository;
      readonly challenges: VerificationChallengeRepository;
    }) => Promise<void>,
  ) => Promise<void>;
  /** The Terms version being accepted. Configuration, not a literal. */
  readonly termsVersion: string;
  readonly verificationTtlMs: number;
}

export type RegisterUserFailure =
  | { readonly kind: "invalid-email"; readonly reason: string }
  | { readonly kind: "invalid-password"; readonly reason: PasswordRejection }
  | { readonly kind: "terms-not-accepted" }
  | { readonly kind: "email-already-registered" };

export type RegisterUserResult =
  | {
    readonly outcome: "registered";
    readonly userId: UserId;
    readonly email: string;
    readonly emailVerified: false;
    /**
     * The RAW verification token.
     *
     * Returned from the use case so a notification component can deliver it,
     * and returned nowhere else — never in an HTTP response, never logged,
     * never persisted (INV-237). Today nothing consumes it, because
     * notification infrastructure does not exist; see REGISTRATION_REPORT.md.
     */
    readonly verificationToken: string;
    readonly verificationExpiresAt: number;
  }
  | { readonly outcome: "rejected"; readonly failure: RegisterUserFailure };

export async function registerUser(
  input: RegisterUserInput,
  deps: RegisterUserDependencies,
): Promise<RegisterUserResult> {
  // ── 1. Identity ─────────────────────────────────────────────────────────
  const email = normalizeEmail(input.email);
  if (email.outcome !== "ok") {
    return { outcome: "rejected", failure: { kind: "invalid-email", reason: email.reason } };
  }

  // ── 2. Cheap, deterministic checks BEFORE the expensive one ─────────────
  const passwordProblem = checkPassword(input.password);
  if (passwordProblem !== null) {
    return {
      outcome: "rejected",
      failure: { kind: "invalid-password", reason: passwordProblem },
    };
  }
  if (!input.acceptedTerms) {
    return { outcome: "rejected", failure: { kind: "terms-not-accepted" } };
  }

  // A pre-check purely for behaviour: it avoids spending Argon2 work on an
  // email that is already taken. It is NOT the duplicate guarantee — the
  // database unique constraint below is, because two concurrent registrations
  // both pass this check (INV-232).
  const existing = await deps.users.findByNormalizedEmail(email.normalized);
  if (existing !== null) {
    return { outcome: "rejected", failure: { kind: "email-already-registered" } };
  }

  // ── 3. The expensive step, outside any transaction ──────────────────────
  const passwordHash = await deps.hasher.hash(input.password);

  // ── 4. Credentials and identity ─────────────────────────────────────────
  const now = deps.clock.now();
  const userId = deps.newUserId();
  const token = deps.tokens.issue();

  // ── 5. One short transaction ────────────────────────────────────────────
  try {
    await deps.commit(async (repositories) => {
      await repositories.users.create({
        userId,
        normalizedEmail: email.normalized,
        email: email.display,
        passwordHash,
        displayName: input.displayName.trim(),
        organization: emptyToNull(input.organization),
        intendedUse: emptyToNull(input.intendedUse),
        termsVersion: deps.termsVersion,
        termsAcceptedAt: now,
        createdAt: now,
      });

      await repositories.challenges.create({
        challengeId: deps.newChallengeId(),
        userId,
        // The DIGEST. The raw token leaves this function and is never written.
        tokenDigest: token.digest,
        createdAt: now,
        expiresAt: now + deps.verificationTtlMs,
      });
    });
  } catch (error) {
    if (error instanceof EmailAlreadyRegisteredError) {
      // The race the pre-check cannot close: another registration committed
      // between the check and this insert. Same public outcome, so the two
      // paths are indistinguishable to a caller.
      return { outcome: "rejected", failure: { kind: "email-already-registered" } };
    }
    throw error;
  }

  return {
    outcome: "registered",
    userId,
    email: email.display,
    // NEVER derived from "registration succeeded". A new account is unverified
    // until someone proves control of the mailbox (INV-241).
    emailVerified: false,
    verificationToken: token.raw,
    verificationExpiresAt: now + deps.verificationTtlMs,
  };
}

function emptyToNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Re-exported so callers have one import for the identity rule. */
export type { NormalizedEmail };
