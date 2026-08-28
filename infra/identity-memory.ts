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
import type { AccountProfileRepository, CurrentUser } from "@lagda/application";

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
        passwordHash: user.passwordHash,
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
        emailVerified: false,
        profile: {
          fullName: null,
          displayName: user.displayName,
          jobTitle: null,
          department: null,
          preferredSenderName: null,
        },
        preferences: {
          timezone: null, locale: null, language: null,
          dateFormat: null, timeFormat: null, numberFormat: null,
          appearance: null, density: null, documentListView: null,
        },
        security: { mfaEnabled: false, mfaFactor: null, recoveryCodesRemaining: null },
        createdAt: user.termsAcceptedAt ?? Date.now(),
      };
      return Promise.resolve(current);
    },
    updateProfile: () => Promise.resolve(false),
    updatePreferences: () => Promise.resolve(false),
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
