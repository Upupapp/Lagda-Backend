// Password-reset challenges, in PostgreSQL.
//
// Every state change is a CONDITIONAL update — the condition is in the WHERE
// clause, never in a preceding read. That is not a style preference: a
// read-then-write leaves a window in which two requests holding the same reset
// token both see it active, and both go on to set a password. Only one of those
// passwords is the one the user typed.

import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { NotificationRepository } from "@lagda/application";
import { createNotificationRepository } from "./notifications.js";
import type {
  PasswordHash, PasswordResetChallenge, PasswordResetChallengeId,
  PasswordResetChallengeRepository, PasswordResettableUserRepository,
  ResetTokenDigest, UserId,
} from "@lagda/application";
import { assertNormalized } from "@lagda/application";
import type { Database, PasswordResetChallengesTable } from "../schema/index.js";

function toChallenge(
  row: Selectable<PasswordResetChallengesTable>,
): PasswordResetChallenge {
  return {
    challengeId: row.challenge_id as PasswordResetChallengeId,
    userId: row.user_id as UserId,
    createdAt: row.created_at.getTime(),
    expiresAt: row.expires_at.getTime(),
    consumedAt: row.consumed_at === null ? null : row.consumed_at.getTime(),
    supersededAt: row.superseded_at === null ? null : row.superseded_at.getTime(),
  };
}

/**
 * Establishes user context for the remainder of a transaction (OD-185).
 *
 * ── Why this is a factory and not a method on a repository ────────────────
 *
 * Adopting a user is a property of the TRANSACTION, not of any one table. It
 * changes what every subsequent statement can see, so it belongs beside the
 * transaction rather than inside a repository that happens to need it.
 *
 * ── The guard, and why it throws ──────────────────────────────────────────
 *
 * A transaction may adopt ONE user, once. Adopting a second would let a single
 * unit of work act as two people, and every RLS predicate evaluated after the
 * switch would silently answer for the wrong one. Re-adopting the SAME user is
 * allowed and is a no-op, because a retry inside one flow is ordinary.
 *
 * `set_config(..., true)` is transaction-local, so the context is gone at
 * COMMIT or ROLLBACK and cannot ride a pooled connection into the next request
 * — the same mechanism, and the same guarantee, as tenant context.
 */
export function createUserAdopter(
  trx: Transaction<Database>,
  setting: string,
): (userId: string) => Promise<{
  notifications: NotificationRepository; transaction: unknown;
}> {
  let adopted: string | null = null;

  return async (userId: string) => {
    if (adopted !== null && adopted !== userId) {
      throw new Error(
        "A transaction may not act as two different users. "
        + `Already adopted ${adopted}, asked for ${userId}.`);
    }
    if (adopted === null) {
      await sql`select set_config(${setting}, ${userId}, true)`.execute(trx);
      adopted = userId;
    }
    return {
      notifications: createNotificationRepository(trx),
      transaction: trx,
    };
  };
}

export function createPasswordResetRepository(
  db: Kysely<Database> | Transaction<Database>,
): PasswordResetChallengeRepository {
  return {
    async findByTokenDigest(
      digest: ResetTokenDigest,
    ): Promise<PasswordResetChallenge | null> {
      // Indexed unique lookup on the DIGEST. The raw token never reaches a
      // query, so it never reaches a statement log either (§7, §45).
      const row = await db.selectFrom("password_reset_challenges").selectAll()
        .where("token_digest", "=", digest)
        .executeTakeFirst();
      return row === undefined ? null : toChallenge(row);
    },

    async consumeIfActive(input): Promise<boolean> {
      // These four conditions ARE the single-use guarantee and the TOCTOU
      // defence. Two requests racing on one token both issue this UPDATE;
      // PostgreSQL serializes them on the row and the second matches nothing.
      //
      // Expiry is compared against the CALLER's clock rather than `now()`, so
      // the whole use case shares one coherent notion of time — a token that
      // was live when the request started does not die mid-transaction because
      // the database clock moved.
      const result = await db.updateTable("password_reset_challenges")
        // The ciphertext goes with the transition. A consumed challenge that
        // still carried an openable token would be a spent credential left
        // recoverable, and the CHECK constraint added in migration 035 rejects
        // the row outright rather than trusting this line to be remembered.
        .set({
          consumed_at: new Date(input.now),
          sealed_secret: null,
          sealed_key_version: null,
        })
        .where("challenge_id", "=", input.challengeId)
        .where("consumed_at", "is", null)
        .where("superseded_at", "is", null)
        .where("expires_at", ">", new Date(input.now))
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async supersedeActiveForUser(input): Promise<number> {
      // Only ACTIVE rows. An already-consumed challenge keeps its consumed
      // state — the CHECK constraint forbids carrying both, and overwriting
      // would destroy the record that this token once changed a password.
      const result = await db.updateTable("password_reset_challenges")
        .set({
          superseded_at: new Date(input.now),
          sealed_secret: null,
          sealed_key_version: null,
        })
        .where("user_id", "=", input.userId)
        .where("consumed_at", "is", null)
        .where("superseded_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    async create(input): Promise<void> {
      await db.insertInto("password_reset_challenges").values({
        challenge_id: input.challengeId,
        user_id: input.userId,
        token_digest: input.tokenDigest,
        created_at: new Date(input.createdAt),
        expires_at: new Date(input.expiresAt),
        consumed_at: null,
        superseded_at: null,
        sealed_secret: input.sealedSecret ?? null,
        sealed_key_version: input.sealedKeyVersion ?? null,
      }).execute();
    },

    async findSealedIfActive(input) {
      // The four refusals collapse into one null: unknown, consumed,
      // superseded, expired. The caller suppresses the message in every case,
      // and splitting them here would leak a challenge's lifecycle to a
      // renderer that has no use for it.
      const row = await db.selectFrom("password_reset_challenges")
        .select(["sealed_secret", "sealed_key_version"])
        .where("challenge_id", "=", input.challengeId)
        .where("consumed_at", "is", null)
        .where("superseded_at", "is", null)
        .where("expires_at", ">", new Date(input.now))
        .executeTakeFirst();

      if (row === undefined
        || row.sealed_secret === null
        || row.sealed_key_version === null) {
        return null;
      }
      return { sealed: row.sealed_secret, keyVersion: row.sealed_key_version };
    },

    async scrubExpiredSecrets(input) {
      // Bounded, and driven off the partial index. Expiry is the one path that
      // performs no write of its own, so without this a token nobody clicked
      // would keep an openable credential forever -- the exact outcome OD-184
      // chose this table to avoid.
      const result = await db.updateTable("password_reset_challenges")
        .set({ sealed_secret: null, sealed_key_version: null })
        .where("sealed_secret", "is not", null)
        .where("expires_at", "<=", new Date(input.now))
        .where("challenge_id", "in", eb => eb
          .selectFrom("password_reset_challenges")
          .select("challenge_id")
          .where("sealed_secret", "is not", null)
          .where("expires_at", "<=", new Date(input.now))
          .limit(input.limit))
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
  };
}

/**
 * The account write password reset needs, and only that.
 *
 * `replacePasswordHash` sets ONE column. There is no path from here to
 * `email_verified_at`, which is what makes "reset does not verify email" a
 * property of the code rather than a promise about it (§34, §100, §152).
 */
export function createPasswordResettableUserRepository(
  db: Kysely<Database> | Transaction<Database>,
): PasswordResettableUserRepository {
  return {
    async findByNormalizedEmail(email) {
      // Guards against a caller passing a raw address. Lookup by anything other
      // than the canonical form silently misses accounts (INV-274).
      assertNormalized(email);
      const row = await db.selectFrom("users").selectAll()
        .where("normalized_email", "=", email)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        userId: row.user_id as UserId,
        email: row.email,
        displayName: row.display_name,
        emailVerifiedAt:
          row.email_verified_at === null ? null : row.email_verified_at.getTime(),
        createdAt: row.created_at.getTime(),
      };
    },

    async replacePasswordHash(input: {
      readonly userId: UserId;
      readonly passwordHash: PasswordHash;
    }): Promise<boolean> {
      const result = await db.updateTable("users")
        .set({ password_hash: input.passwordHash })
        .where("user_id", "=", input.userId)
        .executeTakeFirst();
      // False when the account no longer exists. The caller rolls back rather
      // than reporting a reset that changed nothing.
      return Number(result.numUpdatedRows) === 1;
    },
  };
}
