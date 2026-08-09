// Multi-factor authentication.
//
// ── The factor is TOTP ─────────────────────────────────────────────────────
//
// Measured from the product, not assumed: `MfaChallenge.tsx` says "Enter the
// 6-digit code from your authenticator app", and `MfaSetup.tsx` runs a QR
// scan → confirm → recovery codes enrolment. There is no email or SMS login
// factor anywhere. See MFA_OTP_PRODUCT_INVENTORY.md.
//
// That shapes everything. A delivered OTP has a challenge row, a stored
// verifier, delivery intent, resend and supersession. TOTP has none of those —
// the code is COMPUTED on the user's phone from a shared secret, so nothing is
// issued and nothing is sent.
//
// What TOTP needs instead, and what is here:
//
//   a pre-authentication transaction   the password proof, short-lived
//   a durable attempt counter          the brute-force bound on 10^6 codes
//   a replay watermark                 a code is valid for a window, once
//   recovery codes                     the loss path
//   a fresh session, only at the end   never before both factors
//
// ── Terminology, kept honest (§2, §56) ─────────────────────────────────────
//
// This IS multi-factor authentication: a password (something known) plus a
// TOTP secret held on a device (something possessed), and the two are
// independent — compromising the mailbox does not yield the TOTP secret.
//
// It is NOT phishing-resistant. A user can be induced to read a code to an
// attacker in real time, which WebAuthn would prevent and this does not.
// Recorded in MFA_SECURITY.md rather than described as equivalent.

import type { Clock } from "../common/ports/index.js";
import type {
  AuthenticationMethod, MfaFactorId, MfaFactorType, PasswordHash, PasswordHasher,
  PendingAuthDigest, PendingAuthenticationId, RecoveryCodeDigest, RecoveryCodeId,
  UserId,
} from "../common/ports/auth.js";

// ── Records ──────────────────────────────────────────────────────────────────

export interface MfaFactor {
  readonly factorId: MfaFactorId;
  readonly userId: UserId;
  readonly factorType: MfaFactorType;
  /** Encrypted. The application never sees plaintext — it hands it to a port. */
  readonly secretCiphertext: string | null;
  readonly secretKeyVersion: string | null;
  readonly createdAt: number;
  readonly verifiedAt: number | null;
  readonly disabledAt: number | null;
  readonly lastUsedTimeStep: number | null;
}

export interface PendingAuthentication {
  readonly pendingId: PendingAuthenticationId;
  readonly userId: UserId;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly consumedAt: number | null;
  readonly revokedAt: number | null;
  readonly failedAttempts: number;
  readonly maxAttempts: number;
  readonly authenticationMethod: AuthenticationMethod;
}

/**
 * How many wrong codes a single login ceremony tolerates.
 *
 * Five, matching handoff §145 ("5 attempts / 15 minutes") — the one MFA number
 * the handoff actually specifies.
 *
 * This is the REAL brute-force bound, not the rate limiter. A 6-digit code is
 * 10^6 possibilities; with five attempts per ceremony an attacker needs 200 000
 * complete password-verified ceremonies to expect one hit, and every one of
 * those requires the password they do not have.
 */
export const MFA_MAX_ATTEMPTS = 5;

/**
 * How long a password proof stays good — 10 minutes, absolute (§85, §86).
 *
 * Long enough to unlock a phone and open an authenticator; short enough that a
 * pre-auth cookie left on a shared machine is not a standing invitation. It is
 * never extended: nothing inside the ceremony can push this out.
 */
export const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

// ── Ports ────────────────────────────────────────────────────────────────────

export interface MfaFactorRepository {
  readonly findActiveForUser: (
    userId: UserId, factorType: MfaFactorType,
  ) => Promise<MfaFactor | null>;
  readonly create: (input: {
    readonly factorId: MfaFactorId;
    readonly userId: UserId;
    readonly factorType: MfaFactorType;
    readonly secretCiphertext: string;
    readonly secretKeyVersion: string;
    readonly createdAt: number;
  }) => Promise<void>;
  /** Marks a pending factor verified. Enrolment is not enabling (§93). */
  readonly markVerifiedIfPending: (input: {
    readonly factorId: MfaFactorId;
    readonly verifiedAt: number;
  }) => Promise<boolean>;
  /**
   * Advances the replay watermark, CONDITIONALLY.
   *
   * Returns false when the stored watermark is already at or beyond the given
   * step — which is exactly a replay. The comparison is in the WHERE clause so
   * two concurrent submissions of the same code cannot both pass (§191).
   */
  readonly advanceTimeStepIfNewer: (input: {
    readonly factorId: MfaFactorId;
    readonly timeStep: number;
  }) => Promise<boolean>;
  readonly disable: (input: {
    readonly factorId: MfaFactorId;
    readonly disabledAt: number;
  }) => Promise<boolean>;
}

export interface RecoveryCodeRepository {
  /** Replaces a user's whole set. Regeneration is not accumulation. */
  readonly replaceAllForUser: (input: {
    readonly userId: UserId;
    readonly codes: readonly { readonly id: RecoveryCodeId; readonly digest: RecoveryCodeDigest }[];
    readonly createdAt: number;
  }) => Promise<void>;
  /**
   * Consumes one code for one user, CONDITIONALLY.
   *
   * Scoped by user AND digest. A digest-only lookup would let a code belonging
   * to one account satisfy another's login if the digests ever collided or an
   * attacker learned a code out of band (§221).
   */
  readonly consumeForUser: (input: {
    readonly userId: UserId;
    readonly digest: RecoveryCodeDigest;
    readonly now: number;
  }) => Promise<boolean>;
  readonly countUnusedForUser: (userId: UserId) => Promise<number>;
  readonly deleteAllForUser: (userId: UserId) => Promise<void>;
}

export interface PendingAuthenticationRepository {
  readonly create: (input: {
    readonly pendingId: PendingAuthenticationId;
    readonly userId: UserId;
    readonly credentialDigest: PendingAuthDigest;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly maxAttempts: number;
    readonly authenticationMethod: AuthenticationMethod;
  }) => Promise<void>;
  readonly findByCredentialDigest: (
    digest: PendingAuthDigest,
  ) => Promise<PendingAuthentication | null>;
  /**
   * Increments the failure counter ATOMICALLY, returning what remains.
   *
   * `failed_attempts = failed_attempts + 1` computed by PostgreSQL, never
   * read-modify-write in application code. Five parallel wrong codes must cost
   * five attempts, not one (§30, §31).
   */
  readonly recordFailedAttempt: (input: {
    readonly pendingId: PendingAuthenticationId;
  }) => Promise<{ readonly failedAttempts: number; readonly exhausted: boolean }>;
  /** Consumes only if active, unexpired and with attempts remaining. */
  readonly consumeIfUsable: (input: {
    readonly pendingId: PendingAuthenticationId;
    readonly now: number;
  }) => Promise<boolean>;
  /** For password reset and security actions. Returns how many. */
  readonly revokeAllForUser: (input: {
    readonly userId: UserId;
    readonly now: number;
  }) => Promise<number>;
}

/** Encrypts and decrypts factor secrets. The key never crosses this boundary. */
export interface SecretSealer {
  readonly keyVersion: string;
  readonly seal: (plaintext: string) => string;
  readonly open: (sealed: string) => string;
}

/** Generates and verifies TOTP. RFC arithmetic lives in infrastructure. */
export interface TotpEngine {
  readonly generateSecret: () => string;
  readonly buildProvisioningUri: (secret: string, accountLabel: string) => string;
  readonly verify: (input: {
    readonly secret: string;
    readonly code: string;
    readonly nowMs: number;
    readonly accountLabel: string;
  }) => { readonly valid: boolean; readonly timeStep: number | null };
  readonly isWellFormedCode: (raw: string) => boolean;
}

export interface RecoveryCodeFactory {
  readonly issue: () => {
    readonly display: readonly string[];
    readonly digests: readonly RecoveryCodeDigest[];
  };
  readonly digestSubmitted: (raw: string) => RecoveryCodeDigest | null;
}

export interface PendingAuthCredentialFactory {
  readonly issue: () => { readonly raw: string; readonly digest: PendingAuthDigest };
  readonly digestSubmitted: (raw: string) => PendingAuthDigest | null;
}

// ── Is MFA required? ─────────────────────────────────────────────────────────

/**
 * Server-authoritative, always.
 *
 * Nothing a client sends participates. A request carrying `mfaRequired: false`
 * changes nothing, because this reads the factor table (§87, §213).
 */
export async function requiresMfa(
  userId: UserId, factors: MfaFactorRepository,
): Promise<boolean> {
  const factor = await factors.findActiveForUser(userId, "TOTP");
  return factor !== null && factor.verifiedAt !== null;
}

// ── Completing the second factor ─────────────────────────────────────────────

export type MfaRejection =
  /** No usable pre-auth credential: unknown, expired, consumed or revoked. */
  | "pending-not-found"
  | "pending-expired"
  | "attempts-exhausted"
  | "invalid-code"
  /** The submitted code was correct but already used for its time step. */
  | "code-replayed"
  | "factor-missing";

export type CompleteMfaResult =
  | {
    readonly outcome: "authenticated";
    readonly userId: UserId;
    readonly method: AuthenticationMethod;
    /** Remaining recovery codes, when one was just spent. For the UI to warn. */
    readonly recoveryCodesRemaining: number | null;
  }
  | { readonly outcome: "rejected"; readonly reason: MfaRejection };

export interface CompleteMfaDependencies {
  readonly clock: Clock;
  readonly totp: TotpEngine;
  readonly sealer: SecretSealer;
  readonly recoveryCodes: RecoveryCodeFactory;
  readonly pendingCredentials: PendingAuthCredentialFactory;
  readonly commit: <T>(
    operation: (repositories: {
      readonly pending: PendingAuthenticationRepository;
      readonly factors: MfaFactorRepository;
      readonly recovery: RecoveryCodeRepository;
    }) => Promise<T>,
  ) => Promise<T>;
  /** The account label baked into the provisioning URI. Read, never trusted. */
  readonly accountLabelFor: (userId: UserId) => Promise<string | null>;
}

export interface CompleteMfaInput {
  /** The RAW pre-auth credential from the cookie. Resolves the ceremony. */
  readonly pendingCredential: string;
  readonly code: string;
}

/**
 * Verifies the second factor and completes the authentication ceremony.
 *
 * Accepts EITHER a TOTP code or a recovery code, distinguished by shape. The
 * product presents them on separate pages, but the ceremony is the same and
 * splitting it into two use cases would duplicate the attempt counter — the one
 * piece of state that must not be duplicated, since two counters of five are
 * ten attempts.
 *
 * NOTE what this does not do: issue a session. It reports that the factors are
 * satisfied; the caller creates a fresh session afterwards. Keeping session
 * issuance out of here is what makes "no session before MFA" checkable at one
 * place instead of trusted throughout (§79, §80).
 */
export async function completeMfaChallenge(
  input: CompleteMfaInput,
  deps: CompleteMfaDependencies,
): Promise<CompleteMfaResult> {
  // Cheap structural rejection first. A malformed credential never reaches a
  // query, and is not an attempt against anyone's ceremony.
  const pendingDigest = deps.pendingCredentials.digestSubmitted(input.pendingCredential);
  if (pendingDigest === null) {
    return { outcome: "rejected", reason: "pending-not-found" };
  }

  const now = deps.clock.now();

  return deps.commit(async ({ pending, factors, recovery }) => {
    const ceremony = await pending.findByCredentialDigest(pendingDigest);
    if (ceremony === null || ceremony.consumedAt !== null || ceremony.revokedAt !== null) {
      return { outcome: "rejected", reason: "pending-not-found" };
    }
    if (ceremony.expiresAt <= now) {
      // The absolute bound. Never extended, so the user restarts login (§86).
      return { outcome: "rejected", reason: "pending-expired" };
    }
    if (ceremony.failedAttempts >= ceremony.maxAttempts) {
      return { outcome: "rejected", reason: "attempts-exhausted" };
    }

    const factor = await factors.findActiveForUser(ceremony.userId, "TOTP");
    if (factor === null || factor.verifiedAt === null
      || factor.secretCiphertext === null) {
      return { outcome: "rejected", reason: "factor-missing" };
    }

    // ── Recovery code, or TOTP? ──────────────────────────────────────────
    //
    // Decided by SHAPE, before either is checked. A submission that is neither
    // still costs an attempt (§34): otherwise an attacker gets unlimited
    // guesses simply by sending values of the wrong length, and the counter
    // that bounds brute force never moves.
    const recoveryDigest = deps.recoveryCodes.digestSubmitted(input.code);

    if (recoveryDigest !== null) {
      const spent = await recovery.consumeForUser({
        userId: ceremony.userId, digest: recoveryDigest, now,
      });
      if (!spent) return failAttempt(pending, ceremony, "invalid-code");

      const consumed = await pending.consumeIfUsable({
        pendingId: ceremony.pendingId, now,
      });
      if (!consumed) {
        // A concurrent submission finished the ceremony first. The recovery
        // code is spent either way, which is correct: it was used.
        return { outcome: "rejected", reason: "pending-not-found" };
      }
      return {
        outcome: "authenticated",
        userId: ceremony.userId,
        method: "PASSWORD_PLUS_RECOVERY_CODE",
        recoveryCodesRemaining: await recovery.countUnusedForUser(ceremony.userId),
      };
    }

    if (!deps.totp.isWellFormedCode(input.code)) {
      return failAttempt(pending, ceremony, "invalid-code");
    }

    const label = await deps.accountLabelFor(ceremony.userId);
    if (label === null) return { outcome: "rejected", reason: "factor-missing" };

    const verification = deps.totp.verify({
      secret: deps.sealer.open(factor.secretCiphertext),
      code: input.code,
      nowMs: now,
      accountLabel: label,
    });
    if (!verification.valid || verification.timeStep === null) {
      return failAttempt(pending, ceremony, "invalid-code");
    }

    // ── Replay (§191) ────────────────────────────────────────────────────
    //
    // The code is arithmetically correct, and that is not sufficient. A TOTP
    // code stays valid for its whole time step plus the skew window, so one
    // observed over a shoulder or captured by a proxy would otherwise work
    // again for up to 90 seconds. The watermark advances only forwards, in the
    // WHERE clause, so two concurrent submissions of one code cannot both win.
    const advanced = await factors.advanceTimeStepIfNewer({
      factorId: factor.factorId, timeStep: verification.timeStep,
    });
    if (!advanced) {
      // Deliberately costs an attempt. A replay is an attack signal, and
      // letting it be free gives an attacker unlimited retries of a code they
      // have observed.
      return failAttempt(pending, ceremony, "code-replayed");
    }

    const consumed = await pending.consumeIfUsable({
      pendingId: ceremony.pendingId, now,
    });
    if (!consumed) {
      // Exactly one first-time transition. A concurrent correct submission
      // already completed this ceremony, and must not produce a second
      // session (§37, §163).
      return { outcome: "rejected", reason: "pending-not-found" };
    }

    return {
      outcome: "authenticated",
      userId: ceremony.userId,
      method: "PASSWORD_PLUS_TOTP",
      recoveryCodesRemaining: null,
    };
  });
}

async function failAttempt(
  pending: PendingAuthenticationRepository,
  ceremony: PendingAuthentication,
  reason: MfaRejection,
): Promise<CompleteMfaResult> {
  const { exhausted } = await pending.recordFailedAttempt({
    pendingId: ceremony.pendingId,
  });
  // Once exhausted the ceremony is dead: a correct code afterwards still fails,
  // because `consumeIfUsable` refuses a row at its attempt ceiling (§32, §161).
  return {
    outcome: "rejected",
    reason: exhausted ? "attempts-exhausted" : reason,
  };
}

// ── Enrolment ────────────────────────────────────────────────────────────────

export interface BeginEnrolmentResult {
  readonly factorId: MfaFactorId;
  /** SECRET. Shown once, for the QR code and manual key (§187). */
  readonly provisioningUri: string;
  readonly secret: string;
}

export interface BeginEnrolmentDependencies {
  readonly clock: Clock;
  readonly totp: TotpEngine;
  readonly sealer: SecretSealer;
  readonly newFactorId: () => MfaFactorId;
  readonly accountLabelFor: (userId: UserId) => Promise<string | null>;
  readonly commit: <T>(
    operation: (repositories: { readonly factors: MfaFactorRepository }) => Promise<T>,
  ) => Promise<T>;
}

export type BeginEnrolmentOutcome =
  | { readonly outcome: "started"; readonly enrolment: BeginEnrolmentResult }
  | { readonly outcome: "already-enabled" };

/**
 * Starts enrolment: generates a secret and stores it UNVERIFIED.
 *
 * The factor is not active. `verifiedAt` stays null until the user proves the
 * authenticator actually holds the secret, so abandoning this flow halfway
 * cannot lock anyone out of their own account (§188).
 */
export async function beginMfaEnrolment(
  userId: UserId, deps: BeginEnrolmentDependencies,
): Promise<BeginEnrolmentOutcome> {
  const label = await deps.accountLabelFor(userId);
  if (label === null) return { outcome: "already-enabled" };

  const secret = deps.totp.generateSecret();
  const factorId = deps.newFactorId();
  const now = deps.clock.now();

  return deps.commit(async ({ factors }) => {
    const existing = await factors.findActiveForUser(userId, "TOTP");
    if (existing !== null && existing.verifiedAt !== null) {
      // Already protected. Re-enrolling would silently replace a working
      // factor, which is a way to take over an account from a stolen session.
      return { outcome: "already-enabled" };
    }
    if (existing !== null) {
      // An abandoned attempt. Disable it so the partial unique index permits
      // the replacement.
      await factors.disable({ factorId: existing.factorId, disabledAt: now });
    }

    await factors.create({
      factorId, userId, factorType: "TOTP",
      secretCiphertext: deps.sealer.seal(secret),
      secretKeyVersion: deps.sealer.keyVersion,
      createdAt: now,
    });

    return {
      outcome: "started",
      enrolment: {
        factorId,
        provisioningUri: deps.totp.buildProvisioningUri(secret, label),
        secret,
      },
    };
  });
}

export type ConfirmEnrolmentResult =
  | {
    readonly outcome: "enabled";
    /** Shown ONCE. Never retrievable afterwards (§194). */
    readonly recoveryCodes: readonly string[];
  }
  | { readonly outcome: "invalid-code" }
  | { readonly outcome: "no-pending-enrolment" };

export interface ConfirmEnrolmentDependencies {
  readonly clock: Clock;
  readonly totp: TotpEngine;
  readonly sealer: SecretSealer;
  readonly recoveryCodes: RecoveryCodeFactory;
  readonly newRecoveryCodeId: () => RecoveryCodeId;
  readonly accountLabelFor: (userId: UserId) => Promise<string | null>;
  readonly commit: <T>(
    operation: (repositories: {
      readonly factors: MfaFactorRepository;
      readonly recovery: RecoveryCodeRepository;
    }) => Promise<T>,
  ) => Promise<T>;
}

/**
 * Confirms enrolment by verifying a code from the newly provisioned secret.
 *
 * This is what makes enrolment safe: it proves the authenticator holds the
 * secret BEFORE the account starts requiring it. Marking MFA enabled on a
 * button press, without this, locks out any user whose QR scan silently failed.
 */
export async function confirmMfaEnrolment(
  input: { readonly userId: UserId; readonly code: string },
  deps: ConfirmEnrolmentDependencies,
): Promise<ConfirmEnrolmentResult> {
  if (!deps.totp.isWellFormedCode(input.code)) {
    return { outcome: "invalid-code" };
  }
  const label = await deps.accountLabelFor(input.userId);
  if (label === null) return { outcome: "no-pending-enrolment" };

  const now = deps.clock.now();

  return deps.commit(async ({ factors, recovery }) => {
    const factor = await factors.findActiveForUser(input.userId, "TOTP");
    if (factor === null || factor.secretCiphertext === null) {
      return { outcome: "no-pending-enrolment" };
    }
    if (factor.verifiedAt !== null) return { outcome: "no-pending-enrolment" };

    const verification = deps.totp.verify({
      secret: deps.sealer.open(factor.secretCiphertext),
      code: input.code, nowMs: now, accountLabel: label,
    });
    if (!verification.valid || verification.timeStep === null) {
      return { outcome: "invalid-code" };
    }

    const marked = await factors.markVerifiedIfPending({
      factorId: factor.factorId, verifiedAt: now,
    });
    if (!marked) return { outcome: "no-pending-enrolment" };

    // The enrolment code burns its time step too, so it cannot immediately be
    // replayed against a login.
    await factors.advanceTimeStepIfNewer({
      factorId: factor.factorId, timeStep: verification.timeStep,
    });

    // Recovery codes are issued WITH enablement, in the same transaction.
    // Enabling MFA without a loss path is how a user locks themselves out
    // permanently the day their phone breaks.
    const issued = deps.recoveryCodes.issue();
    await recovery.replaceAllForUser({
      userId: input.userId,
      codes: issued.digests.map(digest => ({ id: deps.newRecoveryCodeId(), digest })),
      createdAt: now,
    });

    return { outcome: "enabled", recoveryCodes: issued.display };
  });
}

// ── Disable ──────────────────────────────────────────────────────────────────

export type DisableMfaResult =
  | { readonly outcome: "disabled" }
  | { readonly outcome: "invalid-password" }
  | { readonly outcome: "not-enabled" };

export interface DisableMfaDependencies {
  readonly clock: Clock;
  readonly hasher: PasswordHasher;
  readonly passwordHashFor: (userId: UserId) => Promise<PasswordHash | null>;
  readonly commit: <T>(
    operation: (repositories: {
      readonly factors: MfaFactorRepository;
      readonly recovery: RecoveryCodeRepository;
      readonly pending: PendingAuthenticationRepository;
    }) => Promise<T>,
  ) => Promise<T>;
}

/**
 * Disables MFA. Requires the CURRENT PASSWORD, not merely a session (§94, §180).
 *
 * Removing a second factor is the exact action an attacker holding a stolen
 * session wants to perform first. A session alone must not be enough to undo
 * the control that exists to limit what a stolen session is worth.
 */
export async function disableMfa(
  input: { readonly userId: UserId; readonly password: string },
  deps: DisableMfaDependencies,
): Promise<DisableMfaResult> {
  const hash = await deps.passwordHashFor(input.userId);
  if (hash === null) return { outcome: "not-enabled" };
  // Argon2 BEFORE the transaction, for the same reason as password reset.
  if (!await deps.hasher.verify(input.password, hash)) {
    return { outcome: "invalid-password" };
  }

  const now = deps.clock.now();

  return deps.commit(async ({ factors, recovery, pending }) => {
    const factor = await factors.findActiveForUser(input.userId, "TOTP");
    if (factor === null || factor.verifiedAt === null) {
      return { outcome: "not-enabled" };
    }

    const disabled = await factors.disable({ factorId: factor.factorId, disabledAt: now });
    if (!disabled) return { outcome: "not-enabled" };

    // Recovery codes are meaningless without the factor, and a set left behind
    // would silently become valid again on re-enrolment (§181).
    await recovery.deleteAllForUser(input.userId);
    // Any ceremony in flight was waiting for a factor that no longer exists.
    await pending.revokeAllForUser({ userId: input.userId, now });

    return { outcome: "disabled" };
  });
}
