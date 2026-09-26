// 079. The workspace activity log: append and read, nothing else. The runtime
// role holds no UPDATE or DELETE on the table, so neither exists here.

import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { UserId, WorkspaceId } from "@lagda/contracts";
import type {
  ScopedWorkspaceActivityRepository, WorkspaceActivityAction, WorkspaceActivityDetails,
} from "@lagda/application";
import type { Database } from "../schema/index.js";

type Db = Kysely<Database> | Transaction<Database>;

export function createScopedWorkspaceActivityRepository(
  db: Db, workspaceId: WorkspaceId,
): ScopedWorkspaceActivityRepository {
  return {
    async append(entry) {
      await db.insertInto("workspace_activity_events").values({
        event_id: `act_${randomUUID().replace(/-/g, "")}`,
        workspace_id: workspaceId,
        action: entry.action,
        actor_user_id: entry.actorUserId,
        occurred_at: new Date(entry.occurredAt),
        details: JSON.stringify(entry.details),
      }).execute();
    },

    async list(input) {
      let query = db.selectFrom("workspace_activity_events")
        .select(["event_id", "action", "actor_user_id", "occurred_at", "details"])
        .where("workspace_id", "=", workspaceId);
      if (input.actions !== null) {
        if (input.actions.length === 0) return [];
        query = query.where("action", "in", [...input.actions]);
      }
      if (input.before !== null) {
        const at = new Date(input.before.occurredAt);
        const id = input.before.eventId;
        query = query.where(sql<boolean>`(occurred_at, event_id) < (${at}, ${id})`);
      }
      const rows = await query
        .orderBy("occurred_at", "desc").orderBy("event_id", "desc")
        .limit(input.limit)
        .execute();
      return rows.map(row => ({
        eventId: row.event_id,
        workspaceId,
        action: row.action as WorkspaceActivityAction,
        actorUserId: row.actor_user_id as UserId | null,
        occurredAt: row.occurred_at.getTime(),
        details: row.details as WorkspaceActivityDetails,
      }));
    },
  };
}
