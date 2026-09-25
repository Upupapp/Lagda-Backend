// Read and dismissed state for the document notification feed (071).
//
// Scoped by construction AND by row-level security, like every tenant
// repository: `workspace_id` is fixed at construction and every statement
// states it, so a missing RLS context fails closed instead of reading across
// tenants.

import { sql, type Transaction } from "kysely";
import type { UserId, WorkspaceId } from "@lagda/contracts";
import type {
  ScopedDocumentNotificationStateRepository, DocumentNotificationState,
  DocumentNotificationStateChange,
} from "@lagda/application";
import type { Database } from "../schema/index.js";
import { translatePersistenceError } from "../errors.js";

/** A feed never shows more than this many rows, so no honest call needs more. */
const MAX_IDS_PER_CALL = 200;

function bounded(eventIds: readonly string[]): string[] {
  return [...new Set(eventIds)].slice(0, MAX_IDS_PER_CALL);
}

/** The new value for one timestamp column: untouched, set now, or cleared. */
function columnValue(flag: boolean | undefined, column: "read_at" | "dismissed_at") {
  if (flag === undefined) return sql.ref(`document_notification_states.${column}`);
  return flag ? sql`now()` : sql`null`;
}

export function createScopedDocumentNotificationStateRepository(
  trx: Transaction<Database>,
  workspaceId: WorkspaceId,
): ScopedDocumentNotificationStateRepository {
  return {
    async listStates(userId: UserId, eventIds: readonly string[]) {
      const ids = bounded(eventIds);
      const states = new Map<string, DocumentNotificationState>();
      if (ids.length === 0) return states;
      try {
        const rows = await trx
          .selectFrom("document_notification_states")
          .select(["evidence_event_id", "read_at", "dismissed_at"])
          .where("workspace_id", "=", workspaceId)
          .where("user_id", "=", userId)
          .where("evidence_event_id", "in", ids)
          .execute();
        for (const row of rows) {
          states.set(row.evidence_event_id, {
            read: row.read_at !== null,
            dismissed: row.dismissed_at !== null,
          });
        }
        return states;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async setState(
      userId: UserId, eventIds: readonly string[], change: DocumentNotificationStateChange,
    ) {
      const ids = bounded(eventIds);
      if (ids.length === 0) return 0;
      if (change.read === undefined && change.dismissed === undefined) return 0;
      try {
        // INSERT ... SELECT from evidence, not INSERT ... VALUES: only ids that
        // are real events in THIS workspace are written at all. The foreign
        // key would refuse an invented id anyway, but refusing it would fail
        // every other id in the same statement; filtering first skips it.
        const result = await trx
          .insertInto("document_notification_states")
          .columns(["workspace_id", "user_id", "evidence_event_id", "read_at", "dismissed_at"])
          .expression(eb => eb
            .selectFrom("evidence_events")
            .select([
              eb.val(workspaceId).as("workspace_id"),
              eb.val(userId).as("user_id"),
              "evidence_event_id",
              (change.read === true ? sql<Date>`now()` : sql<Date | null>`null`).as("read_at"),
              (change.dismissed === true ? sql<Date>`now()` : sql<Date | null>`null`).as("dismissed_at"),
            ])
            .where("workspace_id", "=", workspaceId)
            .where("evidence_event_id", "in", ids))
          .onConflict(oc => oc
            .columns(["workspace_id", "user_id", "evidence_event_id"])
            .doUpdateSet({
              read_at: columnValue(change.read, "read_at") as never,
              dismissed_at: columnValue(change.dismissed, "dismissed_at") as never,
              updated_at: sql`now()` as never,
            }))
          .executeTakeFirst();
        return Number(result.numInsertedOrUpdatedRows ?? 0n);
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },
  };
}
