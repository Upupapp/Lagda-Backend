// The account/profile repository.
//
// Read the `set(...)` calls below: `updateProfile` names five columns and
// `updatePreferences` names nine. Neither can reach `email`, `normalized_email`,
// `email_verified_at` or `password_hash`, because neither mentions them and no
// generic patch method exists to be called instead.
//
// That is the whole mass-assignment defence. Not a denylist that someone must
// remember to extend when a column is added — an absence of capability.

import type { Kysely, Selectable, Transaction } from "kysely";
import type {
  AccountCredentialRepository, AccountProfileRepository, AccountSessionRepository,
  Appearance, CurrentUser, DateFormat, Density, DocumentListView, NumberFormat,
  PasswordHash, SessionId, TimeFormat, UserId,
} from "@lagda/application";
import type { Database, UsersTable } from "../schema/index.js";

function toCurrentUser(
  row: Selectable<UsersTable>,
  security: CurrentUser["security"],
): CurrentUser {
  return {
    userId: row.user_id as UserId,
    // The DISPLAY email. `normalized_email` is an internal lookup key and is
    // deliberately not mapped here — it is not on `CurrentUser` at all (§7).
    email: row.email,
    // DERIVED. The timestamp stays inside the row; the product shows a badge.
    emailVerified: row.email_verified_at !== null,
    profile: {
      fullName: row.full_name,
      displayName: row.display_name,
      jobTitle: row.job_title,
      department: row.department,
      preferredSenderName: row.preferred_sender_name,
    },
    preferences: {
      timezone: row.timezone,
      locale: row.locale,
      language: row.language,
      dateFormat: row.date_format as DateFormat | null,
      timeFormat: row.time_format as TimeFormat | null,
      numberFormat: row.number_format as NumberFormat | null,
      appearance: row.appearance as Appearance | null,
      density: row.density as Density | null,
      documentListView: row.document_list_view as DocumentListView | null,
    },
    security,
    createdAt: row.created_at.getTime(),
  };
}

export function createAccountProfileRepository(
  db: Kysely<Database> | Transaction<Database>,
): AccountProfileRepository {
  return {
    async findCurrentUser(userId: UserId): Promise<CurrentUser | null> {
      const row = await db.selectFrom("users").selectAll()
        .where("user_id", "=", userId)
        .executeTakeFirst();
      if (row === undefined) return null;

      // The MFA summary, read from the factor table. Only whether a verified
      // factor exists and what type — never the secret, the key version, the
      // watermark, or any challenge state (§8, §95).
      const factor = await db.selectFrom("mfa_factors")
        .select(["factor_type"])
        .where("user_id", "=", userId)
        .where("disabled_at", "is", null)
        .where("verified_at", "is not", null)
        .executeTakeFirst();

      const remaining = factor === undefined ? null : Number(
        (await db.selectFrom("mfa_recovery_codes")
          .select(eb => eb.fn.countAll().as("remaining"))
          .where("user_id", "=", userId)
          .where("consumed_at", "is", null)
          .executeTakeFirst())?.remaining ?? 0);

      return toCurrentUser(row, {
        mfaEnabled: factor !== undefined,
        mfaFactor: factor === undefined ? null : "TOTP",
        recoveryCodesRemaining: remaining,
      });
    },

    async updateProfile(input): Promise<boolean> {
      // FIVE columns, named explicitly. There is no spread of a request body
      // here and no dynamic key assignment — the shape of this call is what
      // makes `{"emailVerified": true}` unable to do anything (§243).
      const result = await db.updateTable("users")
        .set({
          full_name: input.profile.fullName,
          display_name: input.profile.displayName,
          job_title: input.profile.jobTitle,
          department: input.profile.department,
          preferred_sender_name: input.profile.preferredSenderName,
          profile_updated_at: new Date(input.updatedAt),
        })
        .where("user_id", "=", input.userId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async updatePreferences(input): Promise<boolean> {
      const result = await db.updateTable("users")
        .set({
          timezone: input.preferences.timezone,
          locale: input.preferences.locale,
          language: input.preferences.language,
          date_format: input.preferences.dateFormat,
          time_format: input.preferences.timeFormat,
          number_format: input.preferences.numberFormat,
          appearance: input.preferences.appearance,
          density: input.preferences.density,
          document_list_view: input.preferences.documentListView,
          profile_updated_at: new Date(input.updatedAt),
        })
        .where("user_id", "=", input.userId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
  };
}

/**
 * Credentials, reached through a SEPARATE named repository.
 *
 * Deliberately not folded into the profile repository. Getting at a password
 * hash should be a deliberate act with its own import, not something a profile
 * handler already holds a reference to (§102).
 */
export function createAccountCredentialRepository(
  db: Kysely<Database> | Transaction<Database>,
): AccountCredentialRepository {
  return {
    async findPasswordHash(userId: UserId): Promise<PasswordHash | null> {
      const row = await db.selectFrom("users").select("password_hash")
        .where("user_id", "=", userId)
        .executeTakeFirst();
      return row === undefined ? null : (row.password_hash as PasswordHash);
    },

    async replacePasswordHash(input): Promise<boolean> {
      const result = await db.updateTable("users")
        .set({ password_hash: input.passwordHash })
        .where("user_id", "=", input.userId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
  };
}

export function createAccountSessionRepository(
  db: Kysely<Database> | Transaction<Database>,
): AccountSessionRepository {
  return {
    async listActiveForUser(userId: UserId) {
      // Four columns. No `token_hash`, no `csrf_token_hash` — a projection that
      // selected them would put a digest one careless `send()` away from a
      // response body (§202).
      const rows = await db.selectFrom("user_sessions")
        .select(["session_id", "created_at", "last_seen_at", "expires_at"])
        .where("user_id", "=", userId)
        .where("revoked_at", "is", null)
        .orderBy("last_seen_at", "desc")
        .execute();
      return rows.map(row => ({
        sessionId: row.session_id as SessionId,
        createdAt: row.created_at.getTime(),
        lastSeenAt: row.last_seen_at.getTime(),
        expiresAt: row.expires_at.getTime(),
      }));
    },

    async revokeOwnedByUser(input): Promise<boolean> {
      // BOTH `user_id` and `session_id`. A revoke keyed on the session alone
      // would let anyone who learned an identifier sign another account out.
      const result = await db.updateTable("user_sessions")
        .set({ revoked_at: new Date(input.at), revocation_reason: input.reason })
        .where("user_id", "=", input.userId)
        .where("session_id", "=", input.sessionId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async revokeAllForUserExcept(input): Promise<number> {
      const result = await db.updateTable("user_sessions")
        .set({ revoked_at: new Date(input.at), revocation_reason: input.reason })
        .where("user_id", "=", input.userId)
        .where("session_id", "!=", input.keepSessionId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
  };
}
