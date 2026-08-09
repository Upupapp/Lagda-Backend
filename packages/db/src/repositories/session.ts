// Session persistence.
//
// **Global, not workspace-scoped.** The one deliberate exception to the tenancy
// rule: authentication happens before any workspace is known, so a
// workspace-scoped lookup could never run at the moment it is needed. The
// credential itself is the authorization to read this row.
//
// Documented in TENANCY_MODEL.md so tenancy tooling does not read it as an
// accidental cross-tenant query.

import type { Kysely, Selectable } from "kysely";
import type { UserId } from "@lagda/contracts";
import type {
  NewSession, RevocationReason, SessionId, SessionRecord, SessionRepository,
  TokenDigest,
} from "@lagda/application";
import type { Database, UserSessionsTable } from "../schema/index.js";
import { translatePersistenceError } from "../errors.js";

function toRecord(row: Selectable<UserSessionsTable>): SessionRecord {
  return {
    sessionId: row.session_id as SessionId,
    userId: row.user_id as UserId,
    tokenHash: row.token_hash as TokenDigest,
    csrfTokenHash: row.csrf_token_hash as TokenDigest,
    createdAt: row.created_at.getTime(),
    lastSeenAt: row.last_seen_at.getTime(),
    expiresAt: row.expires_at.getTime(),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at.getTime() }),
    ...(row.revocation_reason === null
      ? {}
      : { revocationReason: row.revocation_reason as RevocationReason }),
  };
}

/**
 * Runs on the POOL, not inside a workspace transaction.
 *
 * Correct here and nowhere else: session resolution precedes any tenant
 * context, and there is no RLS on this table to require one.
 */
export function createSessionRepository(db: Kysely<Database>): SessionRepository {
  return {
    async findByTokenHash(tokenHash: TokenDigest): Promise<SessionRecord | null> {
      // By DIGEST. The port offers no method taking a raw token, so a caller
      // cannot pass one to SQL even by accident.
      const row = await db
        .selectFrom("user_sessions")
        .selectAll()
        .where("token_hash", "=", tokenHash)
        .executeTakeFirst();
      return row ? toRecord(row) : null;
    },

    async create(session: NewSession): Promise<void> {
      try {
        await db
          .insertInto("user_sessions")
          .values({
            session_id: session.sessionId,
            user_id: session.userId,
            token_hash: session.tokenHash,
            csrf_token_hash: session.csrfTokenHash,
            created_at: new Date(session.createdAt),
            last_seen_at: new Date(session.createdAt),
            expires_at: new Date(session.expiresAt),
          })
          .execute();
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async touch(sessionId: SessionId, at: number): Promise<void> {
      await db
        .updateTable("user_sessions")
        .set({ last_seen_at: new Date(at) })
        .where("session_id", "=", sessionId)
        .execute();
    },

    async revoke(sessionId: SessionId, at: number, reason: RevocationReason): Promise<void> {
      await db
        .updateTable("user_sessions")
        .set({ revoked_at: new Date(at), revocation_reason: reason })
        // Already-revoked rows are left alone, so the ORIGINAL reason and time
        // survive. Overwriting them would rewrite security history: a session
        // killed by a password reset would later read as an ordinary logout.
        .where("session_id", "=", sessionId)
        .where("revoked_at", "is", null)
        .execute();
    },

    async revokeAllForUser(
      userId: UserId, at: number, reason: RevocationReason,
    ): Promise<number> {
      const result = await db
        .updateTable("user_sessions")
        .set({ revoked_at: new Date(at), revocation_reason: reason })
        .where("user_id", "=", userId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
  };
}
