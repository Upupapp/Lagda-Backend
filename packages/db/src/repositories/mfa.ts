// MFA factors, recovery codes and pending authentications, in PostgreSQL.
//
// The attempt counter is the reason this file matters. A 6-digit code is one
// million possibilities, and the only thing standing between an attacker with a
// stolen password and a working session is that the counter is honest under
// concurrency. Every increment is computed BY PostgreSQL, and every terminal
// check is a WHERE clause rather than a preceding read.

import type { Kysely, Selectable, Transaction } from "kysely";
import { sql } from "kysely";
import type {
  AuthenticationMethod, MfaFactor, MfaFactorId, MfaFactorRepository, MfaFactorType,
  PendingAuthDigest, PendingAuthentication, PendingAuthenticationId,
  PendingAuthenticationRepository, RecoveryCodeRepository, UserId,
} from "@lagda/application";
import type {
  Database, MfaFactorsTable, PendingAuthenticationsTable,
} from "../schema/index.js";

function toFactor(row: Selectable<MfaFactorsTable>): MfaFactor {
  return {
    factorId: row.factor_id as MfaFactorId,
    userId: row.user_id as UserId,
    factorType: row.factor_type as MfaFactorType,
    secretCiphertext: row.secret_ciphertext,
    secretKeyVersion: row.secret_key_version,
    createdAt: row.created_at.getTime(),
    verifiedAt: row.verified_at === null ? null : row.verified_at.getTime(),
    disabledAt: row.disabled_at === null ? null : row.disabled_at.getTime(),
    // bigint arrives as a string from pg. `Number` is safe here: a time step is
    // seconds-since-epoch / 30, about 5.9e7 today and nowhere near 2^53.
    lastUsedTimeStep:
      row.last_used_time_step === null ? null : Number(row.last_used_time_step),
  };
}

export function createMfaFactorRepository(
  db: Kysely<Database> | Transaction<Database>,
): MfaFactorRepository {
  return {
    async findActiveForUser(userId, factorType): Promise<MfaFactor | null> {
      const row = await db.selectFrom("mfa_factors").selectAll()
        .where("user_id", "=", userId)
        .where("factor_type", "=", factorType)
        .where("disabled_at", "is", null)
        .executeTakeFirst();
      return row === undefined ? null : toFactor(row);
    },

    async create(input): Promise<void> {
      await db.insertInto("mfa_factors").values({
        factor_id: input.factorId,
        user_id: input.userId,
        factor_type: input.factorType,
        // CIPHERTEXT. The plaintext secret never reaches this layer.
        secret_ciphertext: input.secretCiphertext,
        secret_key_version: input.secretKeyVersion,
        created_at: new Date(input.createdAt),
        verified_at: null,
        disabled_at: null,
        last_used_time_step: null,
      }).execute();
    },

    async markVerifiedIfPending(input): Promise<boolean> {
      const result = await db.updateTable("mfa_factors")
        .set({ verified_at: new Date(input.verifiedAt) })
        .where("factor_id", "=", input.factorId)
        // Only a PENDING factor. A second confirmation must not rewrite the
        // original enrolment time, which is account-security history.
        .where("verified_at", "is", null)
        .where("disabled_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async advanceTimeStepIfNewer(input): Promise<boolean> {
      // The replay defence, as a conditional UPDATE. A step at or below the
      // watermark matches nothing, so a code that already authenticated cannot
      // authenticate again — and two concurrent submissions of the same code
      // serialize here, with the second matching zero rows.
      const result = await db.updateTable("mfa_factors")
        .set({ last_used_time_step: input.timeStep })
        .where("factor_id", "=", input.factorId)
        .where("disabled_at", "is", null)
        // Raw, because `last_used_time_step` is bigint and pg reads it back as
        // a string — a typed comparison would compare a string to a number.
        // The value is bound as a parameter, never interpolated.
        .where(sql<boolean>`last_used_time_step is null
                            or last_used_time_step < ${input.timeStep}`)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async disable(input): Promise<boolean> {
      const result = await db.updateTable("mfa_factors")
        .set({ disabled_at: new Date(input.disabledAt) })
        .where("factor_id", "=", input.factorId)
        .where("disabled_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
  };
}

export function createRecoveryCodeRepository(
  db: Kysely<Database> | Transaction<Database>,
): RecoveryCodeRepository {
  return {
    async replaceAllForUser(input): Promise<void> {
      // REPLACES. Regenerating a set must invalidate the old one — otherwise a
      // printout from a year ago still authenticates.
      await db.deleteFrom("mfa_recovery_codes")
        .where("user_id", "=", input.userId).execute();
      if (input.codes.length === 0) return;
      await db.insertInto("mfa_recovery_codes").values(
        input.codes.map(code => ({
          recovery_code_id: code.id,
          user_id: input.userId,
          code_digest: code.digest,
          created_at: new Date(input.createdAt),
          consumed_at: null,
        })),
      ).execute();
    },

    async consumeForUser(input): Promise<boolean> {
      // Scoped by USER as well as digest. A digest-only consume would let a
      // code learned out of band satisfy a different account's login.
      const result = await db.updateTable("mfa_recovery_codes")
        .set({ consumed_at: new Date(input.now) })
        .where("user_id", "=", input.userId)
        .where("code_digest", "=", input.digest)
        .where("consumed_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async countUnusedForUser(userId): Promise<number> {
      const row = await db.selectFrom("mfa_recovery_codes")
        .select(eb => eb.fn.countAll().as("remaining"))
        .where("user_id", "=", userId)
        .where("consumed_at", "is", null)
        .executeTakeFirst();
      return Number(row?.remaining ?? 0);
    },

    async deleteAllForUser(userId): Promise<void> {
      await db.deleteFrom("mfa_recovery_codes")
        .where("user_id", "=", userId).execute();
    },
  };
}

function toPending(
  row: Selectable<PendingAuthenticationsTable>,
): PendingAuthentication {
  return {
    pendingId: row.pending_id as PendingAuthenticationId,
    userId: row.user_id as UserId,
    createdAt: row.created_at.getTime(),
    expiresAt: row.expires_at.getTime(),
    consumedAt: row.consumed_at === null ? null : row.consumed_at.getTime(),
    revokedAt: row.revoked_at === null ? null : row.revoked_at.getTime(),
    failedAttempts: row.failed_attempts,
    maxAttempts: row.max_attempts,
    authenticationMethod: row.authentication_method as AuthenticationMethod,
  };
}

export function createPendingAuthenticationRepository(
  db: Kysely<Database> | Transaction<Database>,
): PendingAuthenticationRepository {
  return {
    async create(input): Promise<void> {
      await db.insertInto("pending_authentications").values({
        pending_id: input.pendingId,
        user_id: input.userId,
        // A DIGEST. The raw pre-auth credential carries a completed password
        // proof and never reaches persistence.
        credential_digest: input.credentialDigest,
        created_at: new Date(input.createdAt),
        expires_at: new Date(input.expiresAt),
        consumed_at: null,
        revoked_at: null,
        failed_attempts: 0,
        max_attempts: input.maxAttempts,
        authentication_method: input.authenticationMethod,
      }).execute();
    },

    async findByCredentialDigest(
      digest: PendingAuthDigest,
    ): Promise<PendingAuthentication | null> {
      const row = await db.selectFrom("pending_authentications").selectAll()
        .where("credential_digest", "=", digest)
        .executeTakeFirst();
      return row === undefined ? null : toPending(row);
    },

    async recordFailedAttempt(input) {
      // ── The atomic increment (§30) ──────────────────────────────────────
      //
      // `failed_attempts + 1` is computed by PostgreSQL inside the UPDATE.
      // A read-then-write in application code would let five parallel wrong
      // codes each read 0 and each write 1 — five guesses for the price of
      // one, repeatable indefinitely.
      //
      // The ceiling is in the WHERE clause too, so the counter can never pass
      // `max_attempts` and violate the CHECK constraint.
      const row = await db.updateTable("pending_authentications")
        .set(eb => ({ failed_attempts: eb("failed_attempts", "+", 1) }))
        .where("pending_id", "=", input.pendingId)
        .where("consumed_at", "is", null)
        .where("revoked_at", "is", null)
        .where(sql<boolean>`failed_attempts < max_attempts`)
        .returning(["failed_attempts", "max_attempts"])
        .executeTakeFirst();

      if (row === undefined) {
        // Already at the ceiling, or already terminal. Either way there are no
        // attempts left.
        const current = await db.selectFrom("pending_authentications")
          .select(["failed_attempts", "max_attempts"])
          .where("pending_id", "=", input.pendingId)
          .executeTakeFirst();
        return {
          failedAttempts: current?.failed_attempts ?? 0,
          exhausted: true,
        };
      }
      return {
        failedAttempts: row.failed_attempts,
        exhausted: row.failed_attempts >= row.max_attempts,
      };
    },

    async consumeIfUsable(input): Promise<boolean> {
      // Every condition that makes a ceremony completable, evaluated at write
      // time. The attempts check is what makes §32 true: a correct code
      // submitted after exhaustion still matches zero rows.
      const result = await db.updateTable("pending_authentications")
        .set({ consumed_at: new Date(input.now) })
        .where("pending_id", "=", input.pendingId)
        .where("consumed_at", "is", null)
        .where("revoked_at", "is", null)
        .where("expires_at", ">", new Date(input.now))
        .where(sql<boolean>`failed_attempts < max_attempts`)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async revokeAllForUser(input): Promise<number> {
      const result = await db.updateTable("pending_authentications")
        .set({ revoked_at: new Date(input.now) })
        .where("user_id", "=", input.userId)
        .where("consumed_at", "is", null)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
  };
}
