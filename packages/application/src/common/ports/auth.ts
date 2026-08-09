// Account identity and credentials.
//
// Nothing here names Argon2, a database, or a mail provider.

import type { UserId } from "@lagda/contracts";
import type { NormalizedEmail } from "../../auth/email-identity.js";

/**
 * Re-exported from contracts, NOT redeclared.
 *
 * A second `UserId` brand was declared here originally, and it was structurally
 * incompatible with the one BACKEND-13's session service takes - so the account
 * id returned by login could not be passed to `issue()` without a cast. Two
 * brands for one concept is exactly the kind of duplication branding exists to
 * prevent.
 */
export type { UserId };

/**
 * An encoded password hash.
 *
 * Branded so it cannot be confused with a plaintext password by assignment,
 * and so a hash cannot be handed to something expecting a password. NEVER
 * appears in a public API contract (INV-238).
 */
export type PasswordHash = string & { readonly __brand: "PasswordHash" };

/**
 * Hashes and verifies passwords.
 *
 * `verify` exists because BACKEND-20 will need it and the port is the natural
 * place for it — implementing it now costs nothing and splitting the port later
 * would churn every caller. Registration uses `hash` only; no login flow is
 * built here.
 */
export interface PasswordHasher {
  /**
   * The plaintext is used and discarded. It is never stored, never logged, and
   * never placed in an error (INV-233).
   */
  readonly hash: (plaintext: string) => Promise<PasswordHash>;
  readonly verify: (plaintext: string, hash: PasswordHash) => Promise<boolean>;
  /**
   * Whether a stored hash was produced with weaker parameters than current
   * policy. BACKEND-20 can rehash on successful login, when the plaintext is
   * briefly available again.
   */
  readonly needsRehash: (hash: PasswordHash) => boolean;
}

// ── Users ────────────────────────────────────────────────────────────────────

/**
 * What registration writes.
 *
 * `displayName`, `organization` and `intendedUse` come from the real
 * registration form. They live on the user row for now; BACKEND-24 owns profile
 * and may move them. Deliberately no phone, address, birthday or ID: the form
 * does not ask, and collecting what is not needed is its own harm.
 */
export interface NewUser {
  readonly userId: UserId;
  /** Canonical lookup identity. Always produced by `normalizeEmail`. */
  readonly normalizedEmail: NormalizedEmail;
  /** What the user typed, for display. Never used for lookup. */
  readonly email: string;
  readonly passwordHash: PasswordHash;
  readonly displayName: string;
  readonly organization: string | null;
  readonly intendedUse: string | null;
  /**
   * Which Terms and Privacy Policy version was accepted, and when.
   *
   * A bare `termsAccepted: true` would be worthless the day the documents
   * change: it records that someone agreed to something, without recording
   * what.
   */
  readonly termsVersion: string;
  readonly termsAcceptedAt: number;
  readonly createdAt: number;
}

/**
 * A user, without credentials.
 *
 * The projection ordinary code sees. There is deliberately no `passwordHash`
 * here: a field that is not on the type cannot be serialized into a response by
 * accident (INV-238).
 */
export interface UserRecord {
  readonly userId: UserId;
  readonly email: string;
  readonly displayName: string;
  readonly emailVerifiedAt: number | null;
  readonly createdAt: number;
}

/**
 * A user WITH credentials, for authentication only.
 *
 * Separate from `UserRecord` so reaching a password hash is a deliberate act
 * with a named type, not something that arrives by default. BACKEND-20 is its
 * only intended consumer.
 */
export interface AuthUserRecord extends UserRecord {
  readonly normalizedEmail: NormalizedEmail;
  readonly passwordHash: PasswordHash;
}

/**
 * Thrown when the normalized-email unique constraint rejects an insert.
 *
 * The database is the authority on duplicate identity, not an application
 * pre-check — a check-then-insert has a race between the two, and two
 * simultaneous registrations would both pass it (INV-232).
 */
export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super("An account already exists for this email address.");
    this.name = "EmailAlreadyRegisteredError";
  }
}

/**
 * Global account identity. NOT workspace-scoped, deliberately.
 *
 * A user exists before any workspace does and may belong to several. Requiring
 * a workspace to look up an account would make login impossible, and this is
 * therefore NOT an accidental tenancy bypass — it is the one repository that
 * legitimately has no tenant (INV-236).
 */
export interface UserRepository {
  /**
   * Inserts a new account.
   *
   * @throws EmailAlreadyRegisteredError when the unique constraint rejects it.
   *         NEVER updates an existing row: public registration that could
   *         overwrite an account is an account takeover primitive (INV-235).
   */
  readonly create: (user: NewUser) => Promise<void>;
  /** Lookup by canonical identity. Takes an already-normalized key. */
  readonly findByNormalizedEmail: (email: NormalizedEmail) => Promise<UserRecord | null>;
  /** Credentials included. For authentication only. */
  readonly findAuthByNormalizedEmail: (
    email: NormalizedEmail,
  ) => Promise<AuthUserRecord | null>;
}

// ── Email verification ───────────────────────────────────────────────────────

export type VerificationChallengeId = string & { readonly __brand: "VerificationChallengeId" };

/** A digest of a verification token. The RAW token is never persisted. */
export type VerificationTokenDigest = string & { readonly __brand: "VerificationTokenDigest" };

export interface NewVerificationChallenge {
  readonly challengeId: VerificationChallengeId;
  readonly userId: UserId;
  /**
   * A digest, not the token.
   *
   * The raw token is a bearer credential emailed to the user. Storing it would
   * mean a database read grants account verification for every pending user —
   * the same rule sessions follow (INV-237).
   */
  readonly tokenDigest: VerificationTokenDigest;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface VerificationChallengeRepository {
  readonly create: (challenge: NewVerificationChallenge) => Promise<void>;
}

/**
 * Generates verification tokens.
 *
 * Domain-separated from session and CSRF tokens: reusing one credential's
 * generator namespace for another means a token minted for one purpose may be
 * accepted for the other (INV-239).
 */
export interface VerificationTokenFactory {
  readonly issue: () => { readonly raw: string; readonly digest: VerificationTokenDigest };
}

// ── Password reset ───────────────────────────────────────────────────────────

export type PasswordResetChallengeId = string & {
  readonly __brand: "PasswordResetChallengeId";
};

/**
 * A digest of a password-reset token.
 *
 * A DISTINCT brand from `VerificationTokenDigest`, not an alias. Both are
 * 64 lowercase hex characters, so without separate brands a verification digest
 * could be passed to a reset lookup and the compiler would agree. The two
 * credentials are different security domains (§2, §8) and the type system is
 * asked to say so.
 */
export type ResetTokenDigest = string & { readonly __brand: "ResetTokenDigest" };

/**
 * Generates password-reset tokens.
 *
 * Domain-separated from verification, session and CSRF tokens. A token minted
 * to prove mailbox possession for VERIFICATION must never be presentable as
 * authority to REPLACE A PASSWORD — that is a straight account takeover
 * (INV-278).
 */
export interface ResetTokenFactory {
  readonly issue: () => { readonly raw: string; readonly digest: ResetTokenDigest };
}

/**
 * The one credential write password reset needs on an account.
 *
 * Deliberately not a generic patch: a method that can set arbitrary user
 * columns is a method that can set `email_verified_at`, and reset must never do
 * that (§34, §100).
 */
export interface PasswordResettableUserRepository
  extends Pick<UserRepository, "findByNormalizedEmail"> {
  readonly replacePasswordHash: (input: {
    readonly userId: UserId;
    readonly passwordHash: PasswordHash;
  }) => Promise<boolean>;
}
