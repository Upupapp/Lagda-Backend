// Email ownership verification.
//
// This proves control of the registered MAILBOX to the level that receiving a
// code implies. It is not identity verification, not KYC, and not notarial
// identification — nothing here establishes who a person is (§2).
//
// ── Two operations ─────────────────────────────────────────────────────────
//
//   verifyEmail                 redeem a code, mark the account verified
//   resendEmailVerification     rotate the challenge, schedule delivery
//
// Both are transactional, and the ORDER inside each transaction is the whole
// design — see the comments at each one.

import type { Clock } from "../common/ports/index.js";
import type { NotificationRepository } from "../common/ports/notifications.js";
import type { DeliverySecretSealer } from "../common/ports/signing-access.js";
import { normalizeEmail } from "./email-identity.js";
import type {
  UserId, UserRepository, VerificationChallengeId, VerificationTokenDigest,
  VerificationTokenFactory,
} from "../common/ports/auth.js";

/**
 * A challenge as the application sees it.
 *
 * There is no persisted `status`. State is DERIVED from timestamps: a challenge
 * is active when it has neither been consumed nor superseded, and expiry is a
 * comparison against the clock. A stored status column would need a job to keep
 * it true, and the day that job fell behind the column would lie (§229, §230).
 */
export interface VerificationChallenge {
  readonly challengeId: VerificationChallengeId;
  readonly userId: UserId;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly consumedAt: number | null;
  readonly supersededAt: number | null;
}

/** Why a challenge could not be redeemed. Internal — never all exposed. */
export type ChallengeRejection = "not-found" | "consumed" | "superseded" | "expired";

export interface VerificationChallengeRepositoryFull {
  /** Digest lookup. Indexed and unique — never a scan (§7). */
  readonly findByTokenDigest: (
    digest: VerificationTokenDigest,
  ) => Promise<VerificationChallenge | null>;
  /**
   * Lookup by the challenge's OWN id rather than a digest of its secret.
   *
   * Added for Firebase-provider verification (P2 migration): that path's
   * proof of mailbox ownership comes from Firebase's server-side
   * `emailVerified` state, not from redeeming a LAGDA-minted secret, so there
   * is no raw code to digest. The challenge row is still the LAGDA-side
   * binding context (which account, which email, still-valid window) — this
   * is simply a second way to reach the same row. `challengeId` alone proves
   * nothing (it is not a bearer secret); see finalizeExternalEmailVerification.
   */
  readonly findById: (
    challengeId: VerificationChallengeId,
  ) => Promise<VerificationChallenge | null>;
  /**
   * Marks a challenge consumed, CONDITIONALLY.
   *
   * Returns false when the row was already terminal. The condition lives in the
   * UPDATE's WHERE clause, not in a preceding read — a read-then-write leaves a
   * window in which two requests both see an active challenge (§68).
   */
  readonly consumeIfActive: (input: {
    readonly challengeId: VerificationChallengeId;
    readonly now: number;
  }) => Promise<boolean>;
  /** Supersedes every active challenge for a user. Returns how many. */
  readonly supersedeActiveForUser: (input: {
    readonly userId: UserId;
    readonly now: number;
  }) => Promise<number>;
  readonly create: (input: {
    readonly challengeId: VerificationChallengeId;
    readonly userId: UserId;
    readonly tokenDigest: VerificationTokenDigest;
    readonly createdAt: number;
    readonly expiresAt: number;
    /** The raw token, sealed, so the email can carry it (OD-184). */
    readonly sealedSecret?: string;
    readonly sealedKeyVersion?: string;
  }) => Promise<void>;

  /**
   * Reads back the sealed token for a challenge that is still usable.
   *
   * Null for unknown, consumed, superseded and expired alike — the renderer
   * suppresses in every case, and this row is what knows the lifecycle.
   */
  readonly findSealedIfActive: (input: {
    readonly challengeId: VerificationChallengeId;
    readonly now: number;
  }) => Promise<{ readonly sealed: string; readonly keyVersion: string } | null>;

  /** Clears ciphertext from challenges that expired without being used. */
  readonly scrubExpiredSecrets: (input: {
    readonly now: number;
    readonly limit: number;
  }) => Promise<number>;
}

/** The one write verification needs on an account. Not a generic patch (§73). */
export interface VerifiableUserRepository
  extends Pick<UserRepository, "findByNormalizedEmail"> {
  readonly findById: (userId: UserId) => Promise<{
    readonly userId: UserId;
    /**
     * Added for Firebase-provider verification: finalization must compare
     * THIS (the account's own canonical address) against what Firebase
     * independently reports as verified, never trusting the caller to say
     * which email it means (§5/§23 of the migration mission).
     */
    readonly normalizedEmail: string;
    readonly emailVerifiedAt: number | null;
  } | null>;
  /**
   * Sets `email_verified_at` ONLY if it is currently null.
   *
   * Returns false when the account was already verified. The first successful
   * verification stays historically meaningful; a second redemption must not
   * rewrite it (§21, §70).
   */
  readonly markEmailVerifiedIfUnverified: (input: {
    readonly userId: UserId;
    readonly verifiedAt: number;
  }) => Promise<boolean>;
}

// ── Verify ───────────────────────────────────────────────────────────────────

export interface VerifyEmailDependencies {
  /**
   * Digests a SUBMITTED code, canonicalizing first.
   *
   * Returns null for anything that cannot be a code, so a malformed submission
   * costs no database work (§9).
   */
  readonly digestSubmitted: (raw: string) => VerificationTokenDigest | null;
  readonly clock: Clock;
  /**
   * Runs the whole redemption in ONE transaction.
   *
   * Nothing external happens inside it — no email, no HTTP, no hashing (§67).
   */
  readonly commit: <T>(
    operation: (repositories: {
      readonly challenges: VerificationChallengeRepositoryFull;
      readonly users: VerifiableUserRepository;
      /**
       * Establishes user context for the rest of this transaction (OD-185).
       *
       * The account is DISCOVERED here, by the address lookup, and a
       * verification notification is GLOBAL_USER-scoped — so the context
       * cannot be set at the top and the intent cannot be written without it.
       * One user, once; a second adoption throws.
       */
      readonly adoptUser: (userId: UserId) => Promise<{
        readonly notifications: NotificationRepository;
        readonly transaction: unknown;
      }>;
    }) => Promise<T>,
  ) => Promise<T>;
}

export type VerifyEmailResult =
  | { readonly outcome: "verified"; readonly userId: UserId; readonly verifiedAt: number }
  /**
   * The code was valid and the account was ALREADY verified.
   *
   * A success-equivalent, not an error. A user who clicks twice, or whose
   * response was lost and who retried, must not see a hard failure (§20, §112).
   */
  | { readonly outcome: "already-verified"; readonly userId: UserId }
  | { readonly outcome: "invalid"; readonly reason: ChallengeRejection };

export async function verifyEmail(
  submittedCode: string,
  deps: VerifyEmailDependencies,
): Promise<VerifyEmailResult> {
  // Cheap structural rejection FIRST. An oversized or malformed string never
  // reaches a query.
  const digest = deps.digestSubmitted(submittedCode);
  if (digest === null) return { outcome: "invalid", reason: "not-found" };

  const now = deps.clock.now();

  return deps.commit(async ({ challenges, users }) => {
    const challenge = await challenges.findByTokenDigest(digest);
    if (challenge === null) return { outcome: "invalid", reason: "not-found" };

    // Terminal states first, then expiry. Expiry is DERIVED here rather than
    // stored, so no job has to keep a status column honest.
    if (challenge.supersededAt !== null) {
      return { outcome: "invalid", reason: "superseded" };
    }
    if (challenge.consumedAt !== null) {
      // A consumed code cannot verify again. But if the ACCOUNT is verified —
      // which it will be, since consumption is what verified it — this is the
      // double-click case and deserves a success-equivalent answer.
      const account = await users.findById(challenge.userId);
      if (account !== null && account.emailVerifiedAt !== null) {
        return { outcome: "already-verified", userId: challenge.userId };
      }
      return { outcome: "invalid", reason: "consumed" };
    }
    if (challenge.expiresAt <= now) {
      // Never reactivated. The user requests a new code (§59).
      return { outcome: "invalid", reason: "expired" };
    }

    // CONDITIONAL consumption. If a concurrent request consumed it between the
    // read above and this write, `false` comes back and this request takes the
    // already-verified path — exactly one first-time transition happens (§23).
    const consumed = await challenges.consumeIfActive({
      challengeId: challenge.challengeId, now,
    });
    if (!consumed) {
      return { outcome: "already-verified", userId: challenge.userId };
    }

    // Set only if currently null, so a repeat can never rewrite the original
    // verification time.
    const marked = await users.markEmailVerifiedIfUnverified({
      userId: challenge.userId, verifiedAt: now,
    });
    if (!marked) {
      return { outcome: "already-verified", userId: challenge.userId };
    }

    // Any other active challenge for this account is now pointless and must not
    // remain redeemable (§71).
    await challenges.supersedeActiveForUser({ userId: challenge.userId, now });

    return { outcome: "verified", userId: challenge.userId, verifiedAt: now };
  });
}

// ── External-provider finalization ──────────────────────────────────────────
//
// Nothing below names a vendor — same rule this file's neighbors follow
// (auth.ts: "Nothing here names Argon2, a database, or a mail provider").
// Which external identity provider is in use, and its SDK, live entirely in
// the composition layer (see identity-composition.ts) and its own adapter
// package; this module only knows the shape of the proof it needs.
//
// Same public result shape as verifyEmail() (VerifyEmailResult), and the same
// terminal transitions (consumeIfActive → markEmailVerifiedIfUnverified →
// supersedeActiveForUser) — this is the SAME LAGDA-side state machine,
// entered a different way. The difference is what counts as proof:
// verifyEmail() proves mailbox ownership by redeeming a LAGDA-minted secret;
// this proves it by asking the external provider, server-side, whether ITS
// OWN independently-delivered verification succeeded for the identity this
// LAGDA account maps to. The browser's word is never trusted either way.

/** What this function needs from the external provider — read-only, server-side only. */
export interface ExternalVerificationLookup {
  readonly getVerificationState: (
    externalUid: string,
  ) => Promise<{ readonly email: string; readonly emailVerified: boolean } | null>;
}

export interface FinalizeExternalEmailVerificationDependencies {
  readonly clock: Clock;
  /**
   * Derives the external provider's uid from a LAGDA account id.
   * Deterministic and one-directional — never something the caller supplies
   * (§5/§23: an external uid is never accepted from the request).
   */
  readonly externalUid: (userId: UserId) => string;
  readonly verifier: ExternalVerificationLookup;
  readonly commit: <T>(
    operation: (repositories: {
      readonly challenges: VerificationChallengeRepositoryFull;
      readonly users: VerifiableUserRepository;
    }) => Promise<T>,
  ) => Promise<T>;
}

export async function finalizeExternalEmailVerification(
  challengeId: VerificationChallengeId,
  deps: FinalizeExternalEmailVerificationDependencies,
): Promise<VerifyEmailResult> {
  const now = deps.clock.now();

  return deps.commit(async ({ challenges, users }) => {
    const challenge = await challenges.findById(challengeId);
    if (challenge === null) return { outcome: "invalid", reason: "not-found" };

    // Identical terminal-state ordering to verifyEmail() — see its comments.
    if (challenge.supersededAt !== null) {
      return { outcome: "invalid", reason: "superseded" };
    }
    if (challenge.consumedAt !== null) {
      const account = await users.findById(challenge.userId);
      if (account !== null && account.emailVerifiedAt !== null) {
        return { outcome: "already-verified", userId: challenge.userId };
      }
      return { outcome: "invalid", reason: "consumed" };
    }
    if (challenge.expiresAt <= now) {
      return { outcome: "invalid", reason: "expired" };
    }

    const account = await users.findById(challenge.userId);
    if (account === null) return { outcome: "invalid", reason: "not-found" };

    // THE PROOF. Never the browser's `{ emailVerified: true }` — a fresh,
    // server-side read of the external provider's own record for the uid
    // this LAGDA account (not the request) determines, checked against the
    // account's own canonical email. Any mismatch fails closed into the SAME
    // public bucket as every other rejection (never distinguishable from
    // "expired").
    const uid = deps.externalUid(challenge.userId);
    const externalUser = await deps.verifier.getVerificationState(uid);
    if (
      externalUser === null
      || !externalUser.emailVerified
      || externalUser.email !== account.normalizedEmail
    ) {
      return { outcome: "invalid", reason: "not-found" };
    }

    const consumed = await challenges.consumeIfActive({ challengeId, now });
    if (!consumed) {
      return { outcome: "already-verified", userId: challenge.userId };
    }

    const marked = await users.markEmailVerifiedIfUnverified({
      userId: challenge.userId, verifiedAt: now,
    });
    if (!marked) {
      return { outcome: "already-verified", userId: challenge.userId };
    }

    await challenges.supersedeActiveForUser({ userId: challenge.userId, now });

    return { outcome: "verified", userId: challenge.userId, verifiedAt: now };
  });
}

// ── Resend ───────────────────────────────────────────────────────────────────

export interface ResendVerificationDependencies {
  readonly tokens: VerificationTokenFactory;
  readonly clock: Clock;
  readonly newChallengeId: () => VerificationChallengeId;
  readonly verificationTtlMs: number;
  readonly commit: <T>(
    operation: (repositories: {
      readonly challenges: VerificationChallengeRepositoryFull;
      readonly users: VerifiableUserRepository;
      /**
       * Establishes user context for the rest of this transaction (OD-185).
       *
       * The account is DISCOVERED here, by the address lookup, and a
       * verification notification is GLOBAL_USER-scoped — so the context
       * cannot be set at the top and the intent cannot be written without it.
       * One user, once; a second adoption throws.
       */
      readonly adoptUser: (userId: UserId) => Promise<{
        readonly notifications: NotificationRepository;
        readonly transaction: unknown;
      }>;
    }) => Promise<T>,
  ) => Promise<T>;
  /**
   * Persists the intent to deliver, INSIDE the transaction.
   *
   * That placement is the point: if delivery cannot be durably scheduled, the
   * whole rotation rolls back and the user keeps the code they already have.
   * Scheduling after commit would produce an account whose old code was
   * invalidated and whose new code nobody will ever send (§63, §64).
   *
   * Absent when no notification infrastructure exists, in which case the
   * rotation still happens and the raw code is discarded — see the report.
   */
  readonly scheduleDelivery?: (
    input: {
      readonly userId: UserId;
      readonly challengeId: VerificationChallengeId;
      /** The ACCOUNT's canonical address, not the form that resolved it. */
      readonly destination: string;
      readonly displayName: string | null;
      readonly expiresAt: number;
    },
    context: {
      readonly notifications: NotificationRepository;
      readonly transaction: unknown;
    },
  ) => Promise<void>;
  /**
   * Seals the raw code so the email can carry it (OD-184).
   *
   * Absent means the challenge rotates and cannot be mailed, which surfaces as
   * a SUPPRESSED delivery rather than as silence.
   */
  readonly sealer?: DeliverySecretSealer;
}

/**
 * The PUBLIC result.
 *
 * Deliberately one shape. An unknown address, an already-verified account and a
 * successful rotation are indistinguishable to the caller — otherwise resend
 * becomes an account-existence oracle, which matters more here than at
 * registration because the caller has asserted nothing (§44, §86).
 */
export type ResendVerificationResult = {
  readonly outcome: "accepted";
  /** For TELEMETRY only. Must never reach a response. */
  readonly telemetryReason: "rotated" | "unknown-account" | "already-verified";
  /**
   * Present ONLY when telemetryReason is "rotated". For the Firebase-provider
   * route's own optional handoff-issuance decision — see verification-routes.ts.
   * Still must never be forwarded into the ordinary `{accepted:true}` response
   * body used by non-Firebase deployments. A Firebase-mode deployment's
   * response DOES vary by whether this is present; that is a disclosed,
   * narrower anti-enumeration guarantee than the default path's, not an
   * oversight — see the migration report's Security Review.
   */
  readonly challengeId?: VerificationChallengeId;
  /** Present alongside challengeId, same rationale — needed to derive the
   *  Firebase UID for the handoff issuance; never forwarded to a response. */
  readonly userId?: UserId;
  /** The ACCOUNT's own canonical address, not the submitted form — same
   *  rationale, so the Firebase user is created with the address finalize()
   *  will later compare against, not whatever casing/spacing was typed. */
  readonly normalizedEmail?: string;
};

export async function resendEmailVerification(
  email: string,
  deps: ResendVerificationDependencies,
): Promise<ResendVerificationResult> {
  const normalized = normalizeEmail(email);
  if (normalized.outcome !== "ok") {
    return { outcome: "accepted", telemetryReason: "unknown-account" };
  }

  const now = deps.clock.now();
  // Generated BEFORE the transaction: it is cheap, and if the transaction rolls
  // back the raw code is simply discarded and never delivered (§65).
  const code = deps.tokens.issue();

  const challengeId = deps.newChallengeId();

  return deps.commit(async ({ challenges, users, adoptUser }) => {
    const account = await users.findByNormalizedEmail(normalized.normalized);
    if (account === null) {
      return { outcome: "accepted", telemetryReason: "unknown-account" };
    }
    if (account.emailVerifiedAt !== null) {
      // No new challenge, no email. Sending one would be a way to spam a
      // verified address, and there is nothing left to verify (§25, §101).
      return { outcome: "accepted", telemetryReason: "already-verified" };
    }

    // Supersede FIRST, then insert. The partial unique index permits exactly one
    // active challenge per user, so this ordering is what lets the insert
    // succeed — and it is what makes two concurrent resends serialize rather
    // than both landing (§17, §18).
    await challenges.supersedeActiveForUser({ userId: account.userId, now });
    await challenges.create({
      challengeId,
      userId: account.userId,
      // The DIGEST. The raw code never reaches persistence in the clear.
      tokenDigest: code.digest,
      createdAt: now,
      expiresAt: now + deps.verificationTtlMs,
      // The same code, SEALED, in the same statement (OD-184). Consumed,
      // superseded or expired all end its life.
      ...(deps.sealer === undefined ? {} : {
        sealedSecret: deps.sealer.seal(code.raw),
        sealedKeyVersion: deps.sealer.keyVersion,
      }),
    });

    // Inside the transaction, so a scheduling failure rolls the rotation back.
    if (deps.scheduleDelivery !== undefined) {
      // OD-185. Adopt AFTER the lookup that found the account and before the
      // only write that needs user context.
      const adopted = await adoptUser(account.userId);
      await deps.scheduleDelivery({
        userId: account.userId,
        challengeId,
        destination: account.email,
        displayName: account.displayName,
        expiresAt: now + deps.verificationTtlMs,
      }, adopted);
    }

    return {
      outcome: "accepted", telemetryReason: "rotated", challengeId,
      userId: account.userId, normalizedEmail: normalized.normalized,
    };
  });
}
