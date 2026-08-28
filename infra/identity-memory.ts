// An in-process identity store, for the local dev API.
//
// The identity surface has been mounted since OD-069 was closed, and has never
// been exercised: identity-routes.test.ts stubs all seventeen dependency graphs
// and says why -- "a stub that answered would let a mounted-but-broken route
// pass as a mounted one". So the routes were proven MOUNTED, never proven to
// WORK.
//
// This wires the three that make "log in" real -- register, login, current user
// -- against real code paths: the real Argon2 hasher, the real session service,
// the real token generators and digesters. Only persistence is in memory.
//
// NOT a database and not a fixture layer. Nothing here answers a question the
// domain should answer: it stores what it is given and returns what it stored.

import {
  EmailAlreadyRegisteredError,
  type UserRepository, type VerificationChallengeRepository,
  type NewUser, type UserRecord, type AuthUserRecord, type NormalizedEmail,
  type UserId, type NewVerificationChallenge,
} from "@lagda/application";
import type {
  AccountProfileRepository, CurrentUser, UserProfileFields, UserPreferences,
  AccountSessionRepository, AccountCredentialRepository,
  SessionRepository, SessionRecord, NewSession, SessionId, PasswordHash,
} from "@lagda/application";

export class InMemoryIdentity {
  readonly #byEmail = new Map<string, NewUser>();
  readonly #byId = new Map<string, NewUser>();
  readonly challenges: NewVerificationChallenge[] = [];
  /** challengeId -> lifecycle. Verification reads and consumes through this. */
  readonly #challengeRows = new Map<string, {
    challengeId: string; userId: UserId; tokenDigest: string;
    createdAt: number; expiresAt: number;
    consumedAt: number | null; supersededAt: number | null;
    sealedSecret?: string; sealedKeyVersion?: string;
  }>();
  /** userId -> when the address was verified. Null until it is. */
  readonly #verifiedAt = new Map<string, number>();
  /** Profile and preference columns, written only by their own use cases. */
  readonly #profiles = new Map<string, UserProfileFields>();
  readonly #preferences = new Map<string, UserPreferences>();
  /** userId -> current password hash, once changed away from registration's. */
  readonly #passwords = new Map<string, PasswordHash>();
  /**
   * Sessions, shared.
   *
   * ONE map behind both ports on purpose: createSessionService writes through
   * SessionRepository and the account surface reads through
   * AccountSessionRepository. Two stores would let "sign out everywhere"
   * report success against rows the authenticator never consulted.
   */
  readonly #sessions = new Map<string, SessionRecord>();
  /**
   * Password-reset challenges. Same lifecycle as verification, separate rows:
   * a token that could redeem either would let an email link change a password.
   */
  /** TOTP factors, one active per user; the secret is stored SEALED. */
  readonly #factors = new Map<string, {
    factorId: string; userId: UserId; factorType: string;
    secretCiphertext: string | null; secretKeyVersion: string | null;
    createdAt: number; verifiedAt: number | null; disabledAt: number | null;
    lastUsedTimeStep: number | null;
  }>();
  /** Recovery codes, digested. userId -> the current set. */
  readonly #recovery = new Map<string, { id: string; digest: string; consumedAt: number | null }[]>();
  /** Pre-authentication credentials: password accepted, second factor pending. */
  readonly #pending = new Map<string, {
    pendingId: string; userId: UserId; credentialDigest: string;
    createdAt: number; expiresAt: number; consumedAt: number | null;
    revokedAt: number | null; failedAttempts: number; maxAttempts: number;
    authenticationMethod: string;
  }>();
  readonly #resetRows = new Map<string, {
    challengeId: string; userId: UserId; tokenDigest: string;
    createdAt: number; expiresAt: number;
    consumedAt: number | null; supersededAt: number | null;
    sealedSecret?: string; sealedKeyVersion?: string;
  }>();
  #sequence = 0;

  nextUserId(): UserId {
    this.#sequence += 1;
    return `usr_dev_${this.#sequence}` as UserId;
  }

  get count(): number {
    return this.#byEmail.size;
  }

  #toRecord(user: NewUser): UserRecord {
    return {
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
      // Set only by a real redemption through verificationChallengesFull.
      emailVerifiedAt: this.#verifiedAt.get(user.userId) ?? null,
      createdAt: user.termsAcceptedAt ?? Date.now(),
    };
  }

  readonly users: UserRepository = {
    create: (user: NewUser) => {
      // The database is the authority on duplicate identity (INV-232), so the
      // rejection belongs here rather than in a caller's pre-check.
      if (this.#byEmail.has(user.normalizedEmail)) {
        return Promise.reject(new EmailAlreadyRegisteredError());
      }
      this.#byEmail.set(user.normalizedEmail, user);
      this.#byId.set(user.userId, user);
      return Promise.resolve();
    },
    findByNormalizedEmail: (email: NormalizedEmail) => {
      const user = this.#byEmail.get(email);
      return Promise.resolve(user ? this.#toRecord(user) : null);
    },
    findAuthByNormalizedEmail: (email: NormalizedEmail) => {
      const user = this.#byEmail.get(email);
      if (!user) return Promise.resolve(null);
      const record: AuthUserRecord = {
        ...this.#toRecord(user),
        normalizedEmail: user.normalizedEmail,
        // The CHANGED hash wins. Reading the registration hash here would let
        // an old password keep working after a change.
        passwordHash: this.#passwords.get(user.userId) ?? user.passwordHash,
      };
      return Promise.resolve(record);
    },
  };

  readonly verificationChallenges: VerificationChallengeRepository = {
    create: (challenge: NewVerificationChallenge) => {
      this.challenges.push(challenge);
      this.#challengeRows.set(challenge.challengeId, {
        challengeId: challenge.challengeId,
        userId: challenge.userId,
        tokenDigest: challenge.tokenDigest,
        createdAt: challenge.createdAt,
        expiresAt: challenge.expiresAt,
        consumedAt: null,
        supersededAt: null,
      });
      return Promise.resolve();
    },
  };

  /**
   * The verification side of the same rows.
   *
   * `consumeIfActive` decides on the row rather than on a preceding read: a
   * read-then-write leaves a window where two redemptions both see an active
   * challenge (§68), and a fake that split them would not reproduce the
   * condition the database enforces.
   */
  readonly verificationChallengesFull = {
    findByTokenDigest: (digest: string) => {
      const row = [...this.#challengeRows.values()].find((r) => r.tokenDigest === digest);
      return Promise.resolve(row
        ? {
            challengeId: row.challengeId as never,
            userId: row.userId,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            consumedAt: row.consumedAt,
            supersededAt: row.supersededAt,
          }
        : null);
    },
    consumeIfActive: ({ challengeId, now }: { challengeId: string; now: number }) => {
      const row = this.#challengeRows.get(challengeId);
      if (!row) return Promise.resolve(false);
      if (row.consumedAt !== null || row.supersededAt !== null || row.expiresAt <= now) {
        return Promise.resolve(false);
      }
      row.consumedAt = now;
      return Promise.resolve(true);
    },
    supersedeActiveForUser: ({ userId, now }: { userId: UserId; now: number }) => {
      let count = 0;
      for (const row of this.#challengeRows.values()) {
        if (row.userId === userId && row.consumedAt === null && row.supersededAt === null) {
          row.supersededAt = now;
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
    create: (input: {
      challengeId: string; userId: UserId; tokenDigest: string;
      createdAt: number; expiresAt: number;
      sealedSecret?: string; sealedKeyVersion?: string;
    }) => {
      this.#challengeRows.set(input.challengeId, {
        ...input, consumedAt: null, supersededAt: null,
      });
      return Promise.resolve();
    },
    findSealedIfActive: ({ challengeId, now }: { challengeId: string; now: number }) => {
      const row = this.#challengeRows.get(challengeId);
      if (!row || row.consumedAt !== null || row.supersededAt !== null || row.expiresAt <= now) {
        return Promise.resolve(null);
      }
      return Promise.resolve(
        row.sealedSecret !== undefined && row.sealedKeyVersion !== undefined
          ? { sealed: row.sealedSecret, keyVersion: row.sealedKeyVersion }
          : null,
      );
    },
    scrubExpiredSecrets: ({ now, limit }: { now: number; limit: number }) => {
      let scrubbed = 0;
      for (const row of this.#challengeRows.values()) {
        if (scrubbed >= limit) break;
        if (row.expiresAt <= now && row.sealedSecret !== undefined) {
          delete row.sealedSecret; delete row.sealedKeyVersion; scrubbed += 1;
        }
      }
      return Promise.resolve(scrubbed);
    },
  };

  /** The user side verification needs: read one, and verify once. */
  readonly verifiableUsers = {
    findByNormalizedEmail: this.users.findByNormalizedEmail,
    findById: (userId: UserId) => {
      const user = this.#byId.get(userId);
      return Promise.resolve(user
        ? { userId: user.userId, emailVerifiedAt: this.#verifiedAt.get(userId) ?? null }
        : null);
    },
    /**
     * First verification wins. A second redemption must not rewrite the
     * timestamp -- the original stays historically meaningful (§21, §70).
     */
    markEmailVerifiedIfUnverified: (input: { userId: UserId; verifiedAt: number }) => {
      if (this.#verifiedAt.has(input.userId)) return Promise.resolve(false);
      this.#verifiedAt.set(input.userId, input.verifiedAt);
      return Promise.resolve(true);
    },
  };

  readonly accounts: AccountProfileRepository = {
    findCurrentUser: (userId: UserId) => {
      const user = this.#byId.get(userId);
      if (!user) return Promise.resolve(null);
      const current: CurrentUser = {
        userId: user.userId,
        email: user.email,
        emailVerified: this.#verifiedAt.has(userId),
        profile: this.#profiles.get(userId) ?? {
          fullName: null,
          displayName: user.displayName,
          jobTitle: null,
          department: null,
          preferredSenderName: null,
        },
        preferences: this.#preferences.get(userId) ?? {
          timezone: null, locale: null, language: null,
          dateFormat: null, timeFormat: null, numberFormat: null,
          appearance: null, density: null, documentListView: null,
        },
        security: { mfaEnabled: false, mfaFactor: null, recoveryCodesRemaining: null },
        createdAt: user.termsAcceptedAt ?? Date.now(),
      };
      return Promise.resolve(current);
    },
    // Both return false for an unknown user, which is how the use cases tell
    // "nothing written" from "written nothing new".
    updateProfile: ({ userId, profile }) => {
      if (!this.#byId.has(userId)) return Promise.resolve(false);
      this.#profiles.set(userId, profile);
      return Promise.resolve(true);
    },
    updatePreferences: ({ userId, preferences }) => {
      if (!this.#byId.has(userId)) return Promise.resolve(false);
      this.#preferences.set(userId, preferences);
      return Promise.resolve(true);
    },
  };

  /** What createSessionService writes through. */
  readonly sessionRepository: SessionRepository = {
    findByTokenHash: (hash) =>
      Promise.resolve([...this.#sessions.values()].find((r) => r.tokenHash === hash) ?? null),
    create: (session: NewSession) => {
      this.#sessions.set(session.sessionId, { ...session, lastSeenAt: session.createdAt });
      return Promise.resolve();
    },
    touch: (id, at) => {
      const row = this.#sessions.get(id);
      if (row) this.#sessions.set(id, { ...row, lastSeenAt: at });
      return Promise.resolve();
    },
    revoke: (id, at, reason) => {
      const row = this.#sessions.get(id);
      if (row && row.revokedAt === undefined) {
        this.#sessions.set(id, { ...row, revokedAt: at, revocationReason: reason });
      }
      return Promise.resolve();
    },
    revokeAllForUser: () => Promise.resolve(0),
  };

  /** What the account surface reads and revokes through. Same rows. */
  readonly accountSessions: AccountSessionRepository = {
    listActiveForUser: (userId) => Promise.resolve(
      [...this.#sessions.values()]
        .filter((r) => r.userId === userId && r.revokedAt === undefined)
        .map((r) => ({
          sessionId: r.sessionId,
          createdAt: r.createdAt,
          lastSeenAt: r.lastSeenAt,
          expiresAt: r.expiresAt,
        })),
    ),
    revokeOwnedByUser: ({ userId, sessionId, at, reason }) => {
      const row = this.#sessions.get(sessionId);
      // Ownership is checked HERE, not by the caller: a revoke that trusted a
      // client-supplied id could end someone else's session.
      if (!row || row.userId !== userId || row.revokedAt !== undefined) {
        return Promise.resolve(false);
      }
      this.#sessions.set(sessionId, { ...row, revokedAt: at, revocationReason: reason });
      return Promise.resolve(true);
    },
    revokeAllForUserExcept: ({ userId, keepSessionId, at, reason }) => {
      let count = 0;
      for (const [id, row] of this.#sessions) {
        if (row.userId !== userId || id === keepSessionId || row.revokedAt !== undefined) continue;
        this.#sessions.set(id, { ...row, revokedAt: at, revocationReason: reason });
        count += 1;
      }
      return Promise.resolve(count);
    },
  };

  /** The reset side of the same account, mirroring verificationChallengesFull. */
  readonly resetChallenges = {
    findByTokenDigest: (digest: string) => {
      const row = [...this.#resetRows.values()].find((r) => r.tokenDigest === digest);
      return Promise.resolve(row
        ? {
            challengeId: row.challengeId as never,
            userId: row.userId,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            consumedAt: row.consumedAt,
            supersededAt: row.supersededAt,
          }
        : null);
    },
    consumeIfActive: ({ challengeId, now }: { challengeId: string; now: number }) => {
      const row = this.#resetRows.get(challengeId);
      if (!row || row.consumedAt !== null || row.supersededAt !== null || row.expiresAt <= now) {
        return Promise.resolve(false);
      }
      row.consumedAt = now;
      return Promise.resolve(true);
    },
    supersedeActiveForUser: ({ userId, now }: { userId: UserId; now: number }) => {
      let count = 0;
      for (const row of this.#resetRows.values()) {
        if (row.userId === userId && row.consumedAt === null && row.supersededAt === null) {
          row.supersededAt = now; count += 1;
        }
      }
      return Promise.resolve(count);
    },
    create: (input: {
      challengeId: string; userId: UserId; tokenDigest: string;
      createdAt: number; expiresAt: number;
      sealedSecret?: string; sealedKeyVersion?: string;
    }) => {
      this.#resetRows.set(input.challengeId, { ...input, consumedAt: null, supersededAt: null });
      return Promise.resolve();
    },
    findSealedIfActive: ({ challengeId, now }: { challengeId: string; now: number }) => {
      const row = this.#resetRows.get(challengeId);
      if (!row || row.consumedAt !== null || row.supersededAt !== null || row.expiresAt <= now) {
        return Promise.resolve(null);
      }
      return Promise.resolve(
        row.sealedSecret !== undefined && row.sealedKeyVersion !== undefined
          ? { sealed: row.sealedSecret, keyVersion: row.sealedKeyVersion }
          : null,
      );
    },
    scrubExpiredSecrets: ({ now, limit }: { now: number; limit: number }) => {
      let scrubbed = 0;
      for (const row of this.#resetRows.values()) {
        if (scrubbed >= limit) break;
        if (row.expiresAt <= now && row.sealedSecret !== undefined) {
          delete row.sealedSecret; delete row.sealedKeyVersion; scrubbed += 1;
        }
      }
      return Promise.resolve(scrubbed);
    },
  };

  /** The account write reset needs, and the lookup that finds who to reset. */
  readonly resettableUsers = {
    findByNormalizedEmail: this.users.findByNormalizedEmail,
    replacePasswordHash: ({ userId, passwordHash }: { userId: UserId; passwordHash: PasswordHash }) => {
      if (!this.#byId.has(userId)) return Promise.resolve(false);
      this.#passwords.set(userId, passwordHash);
      return Promise.resolve(true);
    },
  };

  /** Reset ends every session: a password change must not leave one behind. */
  readonly resetSessionRevoker = {
    revokeAllForUser: (userId: UserId, at: number, reason: string) => {
      let count = 0;
      for (const [id, row] of this.#sessions) {
        if (row.userId !== userId || row.revokedAt !== undefined) continue;
        this.#sessions.set(id, { ...row, revokedAt: at, revocationReason: reason as never });
        count += 1;
      }
      return Promise.resolve(count);
    },
  };

  readonly mfaFactors = {
    // One ACTIVE factor: created-but-unverified counts, disabled does not.
    findActiveForUser: (userId: UserId) => {
      const row = [...this.#factors.values()].find(
        (f) => f.userId === userId && f.disabledAt === null);
      return Promise.resolve(row ? { ...row } as never : null);
    },
    create: (input: {
      factorId: string; userId: UserId; factorType: string;
      secretCiphertext: string; secretKeyVersion: string; createdAt: number;
    }) => {
      this.#factors.set(input.factorId, {
        ...input, verifiedAt: null, disabledAt: null, lastUsedTimeStep: null,
      });
      return Promise.resolve();
    },
    markVerifiedIfPending: ({ factorId, verifiedAt }: { factorId: string; verifiedAt: number }) => {
      const row = this.#factors.get(factorId);
      if (!row || row.verifiedAt !== null || row.disabledAt !== null) return Promise.resolve(false);
      row.verifiedAt = verifiedAt;
      return Promise.resolve(true);
    },
    /**
     * Replay defence. A TOTP code stays valid for its whole window, so the
     * step is recorded and a code from the same or an older step is refused --
     * otherwise an observed code works twice.
     */
    advanceTimeStepIfNewer: ({ factorId, timeStep }: { factorId: string; timeStep: number }) => {
      const row = this.#factors.get(factorId);
      if (!row) return Promise.resolve(false);
      if (row.lastUsedTimeStep !== null && row.lastUsedTimeStep >= timeStep) {
        return Promise.resolve(false);
      }
      row.lastUsedTimeStep = timeStep;
      return Promise.resolve(true);
    },
    disable: ({ factorId, disabledAt }: { factorId: string; disabledAt: number }) => {
      const row = this.#factors.get(factorId);
      if (!row || row.disabledAt !== null) return Promise.resolve(false);
      row.disabledAt = disabledAt;
      return Promise.resolve(true);
    },
  };

  readonly recoveryCodes = {
    // Replaces the whole set: a partially rotated set would leave old codes live.
    replaceAllForUser: ({ userId, codes }: {
      userId: UserId; codes: readonly { id: string; digest: string }[]; createdAt: number;
    }) => {
      this.#recovery.set(userId, codes.map((c) => ({ ...c, consumedAt: null })));
      return Promise.resolve();
    },
    consumeForUser: ({ userId, digest, now }: { userId: UserId; digest: string; now: number }) => {
      const set = this.#recovery.get(userId);
      const code = set?.find((c) => c.digest === digest && c.consumedAt === null);
      if (!code) return Promise.resolve(false);
      code.consumedAt = now;
      return Promise.resolve(true);
    },
    deleteAllForUser: (userId: UserId) => {
      this.#recovery.delete(userId);
      return Promise.resolve();
    },
    /** How many are left, so the account surface can warn before they run out. */
    countUnusedForUser: (userId: UserId) =>
      Promise.resolve((this.#recovery.get(userId) ?? []).filter((c) => c.consumedAt === null).length),
  };

  readonly pendingAuth = {
    create: (input: {
      pendingId: string; userId: UserId; credentialDigest: string;
      createdAt: number; expiresAt: number; maxAttempts: number;
      authenticationMethod: string;
    }) => {
      this.#pending.set(input.pendingId, {
        ...input, consumedAt: null, revokedAt: null, failedAttempts: 0,
      });
      return Promise.resolve();
    },
    findByCredentialDigest: (digest: string) => {
      const row = [...this.#pending.values()].find((p) => p.credentialDigest === digest);
      return Promise.resolve(row ? { ...row } as never : null);
    },
    recordFailedAttempt: ({ pendingId }: { pendingId: string }) => {
      const row = this.#pending.get(pendingId);
      if (!row) return Promise.resolve({ failedAttempts: 0, exhausted: true });
      row.failedAttempts += 1;
      return Promise.resolve({
        failedAttempts: row.failedAttempts,
        exhausted: row.failedAttempts >= row.maxAttempts,
      });
    },
    consumeIfUsable: ({ pendingId, now }: { pendingId: string; now: number }) => {
      const row = this.#pending.get(pendingId);
      if (!row || row.consumedAt !== null || row.revokedAt !== null || row.expiresAt <= now) {
        return Promise.resolve(false);
      }
      row.consumedAt = now;
      return Promise.resolve(true);
    },
    revokeAllForUser: ({ userId, now }: { userId: UserId; now: number }) => {
      let count = 0;
      for (const row of this.#pending.values()) {
        if (row.userId !== userId || row.consumedAt !== null || row.revokedAt !== null) continue;
        row.revokedAt = now; count += 1;
      }
      return Promise.resolve(count);
    },
  };

  readonly credentials: AccountCredentialRepository = {
    findPasswordHash: (userId) => {
      const changed = this.#passwords.get(userId);
      if (changed !== undefined) return Promise.resolve(changed);
      const user = this.#byId.get(userId);
      return Promise.resolve(user?.passwordHash ?? null);
    },
    replacePasswordHash: ({ userId, passwordHash }) => {
      if (!this.#byId.has(userId)) return Promise.resolve(false);
      this.#passwords.set(userId, passwordHash);
      return Promise.resolve(true);
    },
  };

  /**
   * Runs both writes together.
   *
   * A user with no challenge can never verify their email and a challenge with
   * no user references nothing (INV-240). There is no real transaction here, so
   * this snapshots and restores rather than pretending to roll back.
   */
  commit = async <T>(
    operation: (repos: {
      users: UserRepository;
      challenges: VerificationChallengeRepository;
    }) => Promise<T>,
  ): Promise<T> => {
    const emails = new Map(this.#byEmail);
    const ids = new Map(this.#byId);
    const challengeCount = this.challenges.length;
    try {
      return await operation({ users: this.users, challenges: this.verificationChallenges });
    } catch (error) {
      this.#byEmail.clear(); for (const [k, v] of emails) this.#byEmail.set(k, v);
      this.#byId.clear(); for (const [k, v] of ids) this.#byId.set(k, v);
      this.challenges.length = challengeCount;
      throw error;
    }
  };
}
