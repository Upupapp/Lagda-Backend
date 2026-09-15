// Verification challenges, in PostgreSQL.
//
// Every state change here is a CONDITIONAL update — the condition lives in the
// WHERE clause, never in a preceding read. A read-then-write leaves a window in
// which two concurrent requests both see an active challenge and both act on
// it, which is precisely what single-use has to prevent.

import type { Kysely, Selectable, Transaction } from "kysely";
import type {
  UserId, VerificationChallenge, VerificationChallengeId,
  VerificationChallengeRepositoryFull, VerificationTokenDigest,
  VerifiableUserRepository,
} from "@lagda/application";
import { assertNormalized } from "@lagda/application";
import type { Database, EmailVerificationChallengesTable } from "../schema/index.js";

function toChallenge(
  row: Selectable<EmailVerificationChallengesTable>,
): VerificationChallenge {
  return {
    challengeId: row.challenge_id as VerificationChallengeId,
    userId: row.user_id as UserId,
    createdAt: row.created_at.getTime(),
    expiresAt: row.expires_at.getTime(),
    consumedAt: row.consumed_at === null ? null : row.consumed_at.getTime(),
    supersededAt: row.superseded_at === null ? null : row.superseded_at.getTime(),
  };
}

export function createVerificationRepository(
  db: Kysely<Database> | Transaction<Database>,
): VerificationChallengeRepositoryFull {
  return {
    async findByTokenDigest(
      digest: VerificationTokenDigest,
    ): Promise<VerificationChallenge | null> {
      // Indexed unique lookup. Never a scan, and never a query built from the
      // raw code — only its digest reaches the database.
      const row = await db.selectFrom("email_verification_challenges").selectAll()
        .where("token_digest", "=", digest)
        .executeTakeFirst();
      return row === undefined ? null : toChallenge(row);
    },

    async findById(
      challengeId: VerificationChallengeId,
    ): Promise<VerificationChallenge | null> {
      // Primary-key lookup — the Firebase-provider finalize path (no raw
      // secret to digest; see verify-email.ts's finalizeExternalEmailVerification).
      const row = await db.selectFrom("email_verification_challenges").selectAll()
        .where("challenge_id", "=", challengeId)
        .executeTakeFirst();
      return row === undefined ? null : toChallenge(row);
    },

    async findActiveForUser(input): Promise<VerificationChallenge | null> {
      // Read-only — resendEmailVerification uses this to decide whether a
      // still-valid challenge already exists before rotating. At most one
      // active row exists per user (the partial unique index this repository's
      // insert/supersede pair maintains), so no ordering/limit ambiguity.
      const row = await db.selectFrom("email_verification_challenges").selectAll()
        .where("user_id", "=", input.userId)
        .where("consumed_at", "is", null)
        .where("superseded_at", "is", null)
        .where("expires_at", ">", new Date(input.now))
        .executeTakeFirst();
      return row === undefined ? null : toChallenge(row);
    },

    async consumeIfActive(input): Promise<boolean> {
      // The conditions ARE the concurrency control. Two requests racing on one
      // challenge both issue this UPDATE; PostgreSQL serializes them and the
      // second matches zero rows.
      const result = await db.updateTable("email_verification_challenges")
        // The ciphertext goes with the transition. A consumed challenge that
        // still carried an openable token would be a spent credential left
        // recoverable, and migration 037's CHECK constraint rejects the row.
        .set({
          consumed_at: new Date(input.now),
          sealed_secret: null,
          sealed_key_version: null,
        })
        .where("challenge_id", "=", input.challengeId)
        .where("consumed_at", "is", null)
        .where("superseded_at", "is", null)
        // Expiry is checked against the CALLER's clock rather than `now()`, so
        // the whole use case shares one coherent notion of time (§143).
        .where("expires_at", ">", new Date(input.now))
        .executeTakeFirst();

      return (result.numUpdatedRows ?? 0n) > 0n;
    },

    async supersedeActiveForUser(input): Promise<number> {
      // Regardless of expiry: an expired-but-unsuperseded row still occupies
      // the one-active-challenge index slot, so a resend must clear it before
      // inserting a replacement (§123).
      const result = await db.updateTable("email_verification_challenges")
        .set({
          superseded_at: new Date(input.now),
          sealed_secret: null,
          sealed_key_version: null,
        })
        .where("user_id", "=", input.userId)
        .where("consumed_at", "is", null)
        .where("superseded_at", "is", null)
        .executeTakeFirst();

      return Number(result.numUpdatedRows ?? 0n);
    },

    async create(input): Promise<void> {
      await db.insertInto("email_verification_challenges").values({
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
      // One null for unknown, consumed, superseded and expired. The renderer
      // suppresses in every case, and the lifecycle belongs to this row.
      const row = await db.selectFrom("email_verification_challenges")
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
      // Expiry performs no write of its own, so without this a token nobody
      // clicked would keep an openable credential indefinitely.
      const result = await db.updateTable("email_verification_challenges")
        .set({ sealed_secret: null, sealed_key_version: null })
        .where("sealed_secret", "is not", null)
        .where("expires_at", "<=", new Date(input.now))
        .where("challenge_id", "in", eb => eb
          .selectFrom("email_verification_challenges")
          .select("challenge_id")
          .where("sealed_secret", "is not", null)
          .where("expires_at", "<=", new Date(input.now))
          .limit(input.limit))
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0n);
    },
  };
}

/**
 * The account operations verification needs, and no others.
 *
 * Not a generic user patch: a method that could set any column would let a
 * future caller mark an account verified from somewhere that has not proven
 * anything (§73, §252).
 */
export function createVerifiableUserRepository(
  db: Kysely<Database> | Transaction<Database>,
): VerifiableUserRepository {
  return {
    async findById(userId: UserId) {
      const row = await db.selectFrom("users")
        .select(["user_id", "normalized_email", "email_verified_at"])
        .where("user_id", "=", userId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        userId: row.user_id as UserId,
        normalizedEmail: row.normalized_email,
        emailVerifiedAt: row.email_verified_at === null
          ? null
          : row.email_verified_at.getTime(),
      };
    },

    async findByNormalizedEmail(email) {
      // The canonical key, asserted rather than re-derived. This adapter must
      // never normalize independently (INV-231).
      const row = await db.selectFrom("users").selectAll()
        .where("normalized_email", "=", assertNormalized(email))
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        userId: row.user_id as UserId,
        email: row.email,
        displayName: row.display_name,
        emailVerifiedAt: row.email_verified_at === null
          ? null
          : row.email_verified_at.getTime(),
        createdAt: row.created_at.getTime(),
      };
    },

    async markEmailVerifiedIfUnverified(input): Promise<boolean> {
      // `WHERE email_verified_at IS NULL` is what keeps the FIRST verification
      // time historically true. Without it a repeat redemption would silently
      // move the timestamp forward (§21, §70).
      const result = await db.updateTable("users")
        .set({ email_verified_at: new Date(input.verifiedAt) })
        .where("user_id", "=", input.userId)
        .where("email_verified_at", "is", null)
        .executeTakeFirst();

      return (result.numUpdatedRows ?? 0n) > 0n;
    },
  };
}
