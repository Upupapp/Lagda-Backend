// Password recovery.
//
// ── Two operations ─────────────────────────────────────────────────────────
//
//   requestPasswordReset    mint a recovery credential for an eligible account
//   resetPassword           spend it: replace the password, revoke sessions
//
// ── The credential ─────────────────────────────────────────────────────────
//
// A password-reset token is the most dangerous credential LAGDA issues. A
// session token grants the access its owner already had; a reset token GRANTS
// THE ACCOUNT, and it does so to whoever holds it, with no password required.
//
// So it is deliberately the shortest-lived thing in the system, single-use,
// stored only as a digest, and in its own credential domain — a verification
// code cannot become one and it cannot become a session (§2, §5, §12, §13).
//
// ── Eligibility: unverified accounts MAY reset (§33) ───────────────────────
//
// Option A of §33. A reset link proves possession of the registered mailbox,
// which is exactly the proof email verification asks for — so refusing an
// unverified account protects nothing while stranding a real one: someone who
// registered, never got round to verifying, and has now forgotten the password
// would have no route back at all.
//
// It does NOT follow that reset verifies the email. It does not (§34, §96) —
// see `resetPassword`. Such a user resets, then still has to verify before
// login succeeds, because those are two separate account facts.

import type { Clock } from "../common/ports/index.js";
import { normalizeEmail } from "./email-identity.js";
import { checkPassword, type PasswordRejection } from "./register-user.js";
import type {
  PasswordHash, PasswordHasher, PasswordResetChallengeId,
  PasswordResettableUserRepository, ResetTokenDigest, ResetTokenFactory, UserId,
} from "../common/ports/auth.js";
import type { RevocationReason } from "../common/ports/session.js";

/**
 * A reset challenge as the application sees it.
 *
 * No persisted status. Active means neither consumed nor superseded; expiry is
 * a comparison against the clock. A status column would need a job to keep it
 * true, and a lagging job would leave dead credentials looking live (§135).
 */
export interface PasswordResetChallenge {
  readonly challengeId: PasswordResetChallengeId;
  readonly userId: UserId;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly consumedAt: number | null;
  readonly supersededAt: number | null;
}

/** Why a challenge could not be spent. INTERNAL — never all exposed (§120). */
export type ResetRejection =
  | "malformed" | "not-found" | "consumed" | "superseded" | "expired";

export interface PasswordResetChallengeRepository {
  /** Digest lookup. Unique and indexed — never a scan of account rows (§7). */
  readonly findByTokenDigest: (
    digest: ResetTokenDigest,
  ) => Promise<PasswordResetChallenge | null>;
  /**
   * Marks a challenge consumed, CONDITIONALLY.
   *
   * Returns false when the row was already terminal or expired. The conditions
   * live in the UPDATE's WHERE clause and are evaluated by PostgreSQL at write
   * time, which is what makes them a TOCTOU defence rather than a second
   * opinion — a preceding read cannot see a write that has not happened yet
   * (§60, §68, §70).
   */
  readonly consumeIfActive: (input: {
    readonly challengeId: PasswordResetChallengeId;
    readonly now: number;
  }) => Promise<boolean>;
  /** Supersedes every active challenge for a user. Returns how many. */
  readonly supersedeActiveForUser: (input: {
    readonly userId: UserId;
    readonly now: number;
  }) => Promise<number>;
  readonly create: (input: {
    readonly challengeId: PasswordResetChallengeId;
    readonly userId: UserId;
    readonly tokenDigest: ResetTokenDigest;
    readonly createdAt: number;
    readonly expiresAt: number;
  }) => Promise<void>;
}

/** The revocation capability reset needs. Not the whole session repository. */
export interface ResetSessionRevoker {
  readonly revokeAllForUser: (
    userId: UserId, at: number, reason: RevocationReason,
  ) => Promise<number>;
}

/**
 * Revokes in-flight login ceremonies (BACKEND-23 §105).
 *
 * A pending authentication is a PASSWORD PROOF that has not yet been completed
 * with a second factor. Changing the password must kill it: otherwise someone
 * who used the old password to start a ceremony can finish it afterwards, and
 * the reset the victim just performed did not actually revoke their access.
 *
 * Optional so a deployment without MFA behaves exactly as BACKEND-22 built it.
 */
export interface ResetPendingAuthRevoker {
  readonly revokeAllForUser: (input: {
    readonly userId: UserId;
    readonly now: number;
  }) => Promise<number>;
}

// ── Request ──────────────────────────────────────────────────────────────────

export interface RequestPasswordResetDependencies {
  readonly tokens: ResetTokenFactory;
  readonly clock: Clock;
  readonly newChallengeId: () => PasswordResetChallengeId;
  readonly resetTtlMs: number;
  readonly commit: <T>(
    operation: (repositories: {
      readonly challenges: PasswordResetChallengeRepository;
      readonly users: PasswordResettableUserRepository;
    }) => Promise<T>,
  ) => Promise<T>;
  /**
   * Persists the intent to deliver, INSIDE the transaction (§38, §141).
   *
   * The placement is the entire guarantee. If delivery cannot be durably
   * scheduled the rotation rolls back and the user keeps whatever link they
   * already had. Scheduling after commit would produce the worst outcome
   * available: the previous link invalidated, and the replacement never sent —
   * a locked-out user with no recovery path.
   *
   * Absent while no notification infrastructure exists, in which case the
   * challenge is still created correctly and the raw token is discarded.
   */
  readonly scheduleDelivery?: (input: {
    readonly userId: UserId;
    readonly rawToken: string;
    readonly expiresAt: number;
  }) => Promise<void>;
}

/**
 * The PUBLIC result. Deliberately ONE shape (§21, §22).
 *
 * Unknown address, ineligible account and successful rotation are
 * indistinguishable. Anything else turns forgot-password into an
 * account-existence oracle available to anyone, unauthenticated, at will —
 * and an oracle that also emails the account it confirms.
 */
export type RequestPasswordResetResult = {
  readonly outcome: "accepted";
  /** TELEMETRY ONLY. Must never reach a response body (§118). */
  readonly telemetryReason: "challenge-created" | "unknown-account";
};

export async function requestPasswordReset(
  email: string,
  deps: RequestPasswordResetDependencies,
): Promise<RequestPasswordResetResult> {
  // The SAME normalizer registration and login use. Not a reset-specific rule:
  // an address that resolves to one account at login and another at recovery
  // would be a way to request a reset for someone else's account (§20, INV-274).
  const normalized = normalizeEmail(email);
  if (normalized.outcome !== "ok") {
    return { outcome: "accepted", telemetryReason: "unknown-account" };
  }

  const now = deps.clock.now();
  // Generated BEFORE the transaction: it is cheap, and a rolled-back
  // transaction simply discards it — an unsent raw token is inert (§140).
  const token = deps.tokens.issue();
  const expiresAt = now + deps.resetTtlMs;

  return deps.commit(async ({ challenges, users }) => {
    const account = await users.findByNormalizedEmail(normalized.normalized);
    if (account === null) {
      // No challenge, no account created, no email (§35). The caller cannot
      // tell this branch from the one below.
      return { outcome: "accepted", telemetryReason: "unknown-account" };
    }

    // Supersede FIRST, then insert. The partial unique index permits exactly one
    // active challenge per user, so this ordering is what lets the insert
    // succeed at all — and it is what makes two concurrent requests serialize
    // rather than both landing (§15, §16, §17).
    await challenges.supersedeActiveForUser({ userId: account.userId, now });
    await challenges.create({
      challengeId: deps.newChallengeId(),
      userId: account.userId,
      // The DIGEST. The raw token never reaches persistence (§6, §39).
      tokenDigest: token.digest,
      createdAt: now,
      expiresAt,
    });

    if (deps.scheduleDelivery !== undefined) {
      await deps.scheduleDelivery({
        userId: account.userId, rawToken: token.raw, expiresAt,
      });
    }

    return { outcome: "accepted", telemetryReason: "challenge-created" };
  });
}

// ── Reset ────────────────────────────────────────────────────────────────────

export interface ResetPasswordDependencies {
  /**
   * Digests a SUBMITTED token. Returns null for anything that cannot be one, so
   * a malformed submission costs no database work and no hashing (§10, §53).
   */
  readonly digestSubmitted: (raw: string) => ResetTokenDigest | null;
  readonly hasher: PasswordHasher;
  readonly clock: Clock;
  /**
   * Reads a challenge OUTSIDE any transaction, to reject clearly dead tokens
   * before Argon2 (§104, §105).
   *
   * Safe here in a way it would NOT be at login: a reset token is 256 bits of
   * randomness that identifies no public account, so a failed lookup teaches an
   * attacker nothing about who exists. There is therefore nothing for a dummy
   * hash to hide, and skipping it removes a free CPU-exhaustion path (§106).
   *
   * This result is ADVISORY. It is never what authorizes the reset — the
   * transaction below re-decides (§60).
   */
  readonly peek: (digest: ResetTokenDigest) => Promise<PasswordResetChallenge | null>;
  readonly commit: <T>(
    operation: (repositories: {
      readonly challenges: PasswordResetChallengeRepository;
      readonly users: PasswordResettableUserRepository;
      readonly sessions: ResetSessionRevoker;
      readonly pendingAuth?: ResetPendingAuthRevoker;
    }) => Promise<T>,
  ) => Promise<T>;
}

export interface ResetPasswordInput {
  readonly token: string;
  readonly newPassword: string;
}

export type ResetPasswordResult =
  | {
    readonly outcome: "reset";
    readonly userId: UserId;
    /** For telemetry. A COUNT, never the session identifiers (§82). */
    readonly revokedSessionCount: number;
  }
  | { readonly outcome: "invalid-password"; readonly reason: PasswordRejection }
  | { readonly outcome: "invalid-token"; readonly reason: ResetRejection };

export async function resetPassword(
  input: ResetPasswordInput,
  deps: ResetPasswordDependencies,
): Promise<ResetPasswordResult> {
  // ── Cheap checks first, in this order deliberately ───────────────────────
  //
  // Token SHAPE, then password policy, then a lookup, and only then Argon2.
  // Everything before the hash is microseconds; the hash is ~50ms of dedicated
  // CPU by design. An endpoint that hashes before checking anything is a
  // one-request-per-core denial of service (§53, §108, §251).
  const digest = deps.digestSubmitted(input.token);
  if (digest === null) return { outcome: "invalid-token", reason: "malformed" };

  // EXACTLY the registration policy — imported, not restated. A reset path with
  // its own rule is how an account ends up with a password its own signup form
  // would have refused (§51, §178, INV-283).
  const rejection = checkPassword(input.newPassword);
  if (rejection !== null) {
    return { outcome: "invalid-password", reason: rejection };
  }

  const challenge = await deps.peek(digest);
  if (challenge === null) return { outcome: "invalid-token", reason: "not-found" };
  const beforeHash = deps.clock.now();
  if (challenge.supersededAt !== null) {
    return { outcome: "invalid-token", reason: "superseded" };
  }
  if (challenge.consumedAt !== null) {
    return { outcome: "invalid-token", reason: "consumed" };
  }
  if (challenge.expiresAt <= beforeHash) {
    return { outcome: "invalid-token", reason: "expired" };
  }

  // ── Hash OUTSIDE the transaction (§59, §252) ─────────────────────────────
  //
  // Argon2id is intentionally slow and memory-hard. Holding a PostgreSQL
  // transaction — and the row locks it implies — for ~50ms per request is how a
  // recovery endpoint takes the connection pool down under load.
  //
  // The cost is that everything checked above may become false while this runs.
  // That is accepted, and handled below rather than assumed away.
  const passwordHash: PasswordHash = await deps.hasher.hash(input.newPassword);

  return deps.commit(async ({ challenges, users, sessions, pendingAuth }) => {
    const now = deps.clock.now();

    // ── The TOCTOU boundary (§60, §253) ────────────────────────────────────
    //
    // A CONDITIONAL consume, not a re-read. Between `peek` and here, a
    // concurrent request may have spent this token, a newer forgot-password
    // request may have superseded it, or it may simply have expired while
    // Argon2 ran. All three are the same answer: PostgreSQL evaluates the
    // conditions at write time and this UPDATE matches zero rows.
    //
    // Consumption is FIRST, before the password is touched. Two requests
    // holding the same token race here and exactly one wins, so the loser
    // cannot go on to overwrite the winner's password (§69, §70, §254).
    const consumed = await challenges.consumeIfActive({
      challengeId: challenge.challengeId, now,
    });
    if (!consumed) {
      // Deliberately vague INTERNALLY too. Which of the three happened is not
      // knowable without another read, and the public answer collapses them
      // anyway (§120).
      return { outcome: "invalid-token", reason: "consumed" };
    }

    // Only `password_hash`. Nothing here can reach `email_verified_at`: a reset
    // proves mailbox possession, but verification is a separate account fact
    // and the product decided they stay separate (§34, §96, §246).
    const replaced = await users.replacePasswordHash({
      userId: challenge.userId, passwordHash,
    });
    if (!replaced) {
      // The account vanished between issuing and spending. Roll the whole thing
      // back — a consumed challenge with no password change would burn the
      // user's only recovery credential for nothing (§68).
      throw new AccountGoneDuringResetError();
    }

    // Any OTHER live reset link for this account dies now. Otherwise an older
    // email sitting in the mailbox could change the password the user just set
    // (§72, §255).
    await challenges.supersedeActiveForUser({ userId: challenge.userId, now });

    // ── Revoke every session (§62, §63, §131) ──────────────────────────────
    //
    // The threat this exists for: an attacker who already stole a session and
    // is the REASON the user is resetting. Changing the password while leaving
    // that session alive achieves nothing — the intruder keeps their access and
    // the user believes they have removed it.
    //
    // Inside the same transaction as the password change, so a revocation
    // failure cannot leave a changed password with live old sessions (§66, §67).
    const revokedSessionCount = await sessions.revokeAllForUser(
      challenge.userId, now, "password-change",
    );

    // And any login ceremony still in flight. A pending authentication is a
    // proof of the OLD password; leaving it alive means an attacker who started
    // logging in before the reset can still finish afterwards (§105, §174).
    if (pendingAuth !== undefined) {
      await pendingAuth.revokeAllForUser({ userId: challenge.userId, now });
    }

    return { outcome: "reset", userId: challenge.userId, revokedSessionCount };
  });
}

/**
 * The account disappeared between issuing a reset challenge and spending it.
 *
 * Thrown rather than returned, because it must ROLL THE TRANSACTION BACK. A
 * returned value would commit the challenge consumption.
 */
export class AccountGoneDuringResetError extends Error {
  constructor() {
    super("The account no longer exists.");
    this.name = "AccountGoneDuringResetError";
  }
}
