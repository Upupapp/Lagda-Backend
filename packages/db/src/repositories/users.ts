// Accounts and verification challenges, in PostgreSQL.
//
// GLOBAL, not tenant-scoped. Every other repository in this package binds a
// workspace; these two deliberately do not, because an account exists before any
// workspace and login must find one without a tenant (INV-236).
//
// This adapter NEVER normalizes an email. It receives a canonical key produced
// by `normalizeEmail` and stores it as given — a second normalization rule here
// would drift from the first (INV-231).

import type { Kysely, Selectable, Transaction } from "kysely";
import {
  EmailAlreadyRegisteredError,
  type AuthUserRecord, type NewUser, type NewVerificationChallenge,
  type NormalizedEmail, type PasswordHash, type UserId, type UserRecord,
  type UserRepository, type VerificationChallengeRepository,
} from "@lagda/application";
import type { Database, UsersTable } from "../schema/index.js";
import { isUniqueViolation } from "../errors.js";

function toUserRecord(row: Selectable<UsersTable>): UserRecord {
  return {
    userId: row.user_id as UserId,
    // The DISPLAY form. `normalized_email` is internal identity and is not part
    // of this projection (INV-238).
    email: row.email,
    displayName: row.display_name,
    emailVerifiedAt: row.email_verified_at === null
      ? null
      : row.email_verified_at.getTime(),
    createdAt: row.created_at.getTime(),
  };
}

export function createUserRepository(
  db: Kysely<Database> | Transaction<Database>,
): UserRepository {
  return {
    async create(user: NewUser): Promise<void> {
      try {
        await db.insertInto("users").values({
          user_id: user.userId,
          email: user.email,
          normalized_email: user.normalizedEmail,
          password_hash: user.passwordHash,
          display_name: user.displayName,
          organization: user.organization,
          intended_use: user.intendedUse,
          // NEVER set at registration. A new account is unverified until
          // someone proves control of the mailbox (INV-241).
          email_verified_at: null,
          terms_version: user.termsVersion,
          terms_accepted_at: new Date(user.termsAcceptedAt),
          created_at: new Date(user.createdAt),
        }).execute();
      } catch (error) {
        // INSERT only — there is no update path here at all. Public
        // registration that could touch an existing row is an account takeover
        // primitive, so the capability simply does not exist (INV-235).
        if (isUniqueViolation(error, "users_normalized_email_key")) {
          // Translated to an application error. A raw PostgreSQL message would
          // leak the constraint name and the attempted address into whatever
          // logged it (§43).
          throw new EmailAlreadyRegisteredError();
        }
        throw error;
      }
    },

    async findByNormalizedEmail(email: NormalizedEmail): Promise<UserRecord | null> {
      const row = await db.selectFrom("users").selectAll()
        .where("normalized_email", "=", email)
        .executeTakeFirst();
      return row === undefined ? null : toUserRecord(row);
    },

    async findAuthByNormalizedEmail(
      email: NormalizedEmail,
    ): Promise<AuthUserRecord | null> {
      // The ONE method that returns a password hash. Separate from the ordinary
      // lookup so reaching credentials is a deliberate act with a named type,
      // rather than something that arrives by default in every read.
      const row = await db.selectFrom("users").selectAll()
        .where("normalized_email", "=", email)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        ...toUserRecord(row),
        normalizedEmail: row.normalized_email as NormalizedEmail,
        passwordHash: row.password_hash as PasswordHash,
      };
    },
  };
}

export function createVerificationChallengeRepository(
  db: Kysely<Database> | Transaction<Database>,
): VerificationChallengeRepository {
  return {
    async create(challenge: NewVerificationChallenge): Promise<void> {
      await db.insertInto("email_verification_challenges").values({
        challenge_id: challenge.challengeId,
        user_id: challenge.userId,
        // The digest. The raw token never reaches this layer.
        token_digest: challenge.tokenDigest,
        created_at: new Date(challenge.createdAt),
        expires_at: new Date(challenge.expiresAt),
        // Registration creates a challenge; only BACKEND-21 consumes one.
        consumed_at: null,
      }).execute();
    },
  };
}
