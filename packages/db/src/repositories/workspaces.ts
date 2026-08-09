// Representative repository adapters.
//
// The MINIMUM needed to prove row mapping, workspace scoping, transaction
// participation and constraint translation against real PostgreSQL.
// BACKEND-08 owns repositories properly; this is not a template for generated
// CRUD, and there is deliberately no generic base class.

import type { Kysely } from "kysely";
import type { WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type {
  TransactionContext, WorkspaceRepository, WorkspaceMembershipRepository,
  WorkspaceRecord, WorkspaceMembershipRecord,
} from "@lagda/application";
import type { Database } from "../schema/index.js";
import { unwrapTransaction } from "../transactions/index.js";
import {
  toWorkspaceRecord, fromWorkspaceRecord,
  toMembershipRecord, fromMembershipRecord,
} from "../mapping/index.js";

export function createWorkspaceRepository(db: Kysely<Database>): WorkspaceRepository {
  return {
    async findById(workspaceId: WorkspaceId): Promise<WorkspaceRecord | null> {
      const row = await db
        .selectFrom("workspaces")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      return row === undefined ? null : toWorkspaceRecord(row);
    },

    async save(workspace: WorkspaceRecord, tx: TransactionContext): Promise<void> {
      // Writes go through the caller's transaction, not through `db`. Using the
      // pool here would commit independently of the surrounding transaction and
      // survive its rollback — the exact failure the transaction exists to
      // prevent.
      await unwrapTransaction(tx)
        .insertInto("workspaces")
        .values(fromWorkspaceRecord(workspace))
        .execute();
    },
  };
}

export function createWorkspaceMembershipRepository(
  db: Kysely<Database>,
): WorkspaceMembershipRepository {
  return {
    async findInWorkspace(
      workspaceId: WorkspaceId,
      memberId: WorkspaceMemberId,
    ): Promise<WorkspaceMembershipRecord | null> {
      // BOTH predicates in the query. Fetching by member_id and comparing the
      // workspace afterwards would still read another tenant's row into memory,
      // and would rely on every caller remembering the comparison.
      const row = await db
        .selectFrom("workspace_memberships")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("member_id", "=", memberId)
        .executeTakeFirst();
      return row === undefined ? null : toMembershipRecord(row);
    },

    async listForWorkspace(
      workspaceId: WorkspaceId,
    ): Promise<readonly WorkspaceMembershipRecord[]> {
      const rows = await db
        .selectFrom("workspace_memberships")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .orderBy("created_at", "desc")
        .execute();
      return rows.map(toMembershipRecord);
    },

    async save(
      membership: WorkspaceMembershipRecord,
      tx: TransactionContext,
    ): Promise<void> {
      await unwrapTransaction(tx)
        .insertInto("workspace_memberships")
        .values(fromMembershipRecord(membership))
        .execute();
    },
  };
}
