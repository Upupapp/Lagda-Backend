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
      // Registration issues a verification challenge; nothing in this store
      // completes one, so an account here is genuinely unverified. Reporting it
      // as verified would be inventing a fact the flow never established.
      emailVerifiedAt: null,
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
      return Promise.resolve();
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
