// PostgreSQL repository adapters, bound to one transaction and one workspace.
//
// These are constructed by the unit of work, never independently — which is what
// guarantees every repository in one operation writes through the same
// transaction. Separate instances each handed a context could quietly use the
// pool instead, producing atomicity that looks correct and is not.

import type { Transaction } from "kysely";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type { WorkspaceRole } from "@lagda/core";
import type {
  ScopedWorkspaceRepository, ScopedMembershipRepository,
  WorkspaceRecord, WorkspaceMembershipRecord,
} from "@lagda/application";
import type { Database } from "../schema/index.js";
import {
  toWorkspaceRecord, fromWorkspaceRecord,
  toMembershipRecord, fromMembershipRecord,
} from "../mapping/index.js";
import { WorkspaceScopeMismatchError, translatePersistenceError } from "../errors.js";

/**
 * Refuses to persist a record belonging to a different workspace.
 *
 * The alternative — silently rewriting `workspaceId` to match the scope — would
 * turn a programmer error into a data-corruption event, quietly moving a record
 * between tenants. RLS would also reject the write, but failing here names the
 * problem instead of surfacing a policy violation from three layers down.
 */
function assertScope(
  scope: WorkspaceId,
  recordWorkspace: WorkspaceId,
  entity: string,
): void {
  if (recordWorkspace !== scope) {
    throw new WorkspaceScopeMismatchError(entity, scope, recordWorkspace);
  }
}

export function createScopedWorkspaceRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): ScopedWorkspaceRepository {
  return {
    async find(): Promise<WorkspaceRecord | null> {
      // The predicate is explicit even though RLS would also constrain it.
      // Two layers, deliberately: a reader can see the scope without knowing
      // the policy exists (INV-058).
      const row = await trx
        .selectFrom("workspaces")
        .selectAll()
        .where("workspace_id", "=", scope)
        .executeTakeFirst();
      return row === undefined ? null : toWorkspaceRecord(row);
    },

    async insert(workspace: WorkspaceRecord): Promise<void> {
      assertScope(scope, workspace.workspaceId, "Workspace");
      try {
        await trx.insertInto("workspaces").values(fromWorkspaceRecord(workspace)).execute();
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },
  };
}

export function createScopedMembershipRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): ScopedMembershipRepository {
  const scoped = () =>
    trx.selectFrom("workspace_memberships").selectAll().where("workspace_id", "=", scope);

  return {
    async findMember(memberId: WorkspaceMemberId): Promise<WorkspaceMembershipRecord | null> {
      const row = await scoped().where("member_id", "=", memberId).executeTakeFirst();
      // A member in another workspace is indistinguishable from one that does
      // not exist. Any difference would confirm it exists elsewhere.
      return row === undefined ? null : toMembershipRecord(row);
    },

    async findByUser(userId: UserId): Promise<WorkspaceMembershipRecord | null> {
      const row = await scoped().where("user_id", "=", userId).executeTakeFirst();
      return row === undefined ? null : toMembershipRecord(row);
    },

    async list(): Promise<readonly WorkspaceMembershipRecord[]> {
      // Explicit ORDER BY: PostgreSQL guarantees no row order without one, so
      // "insertion order" is an assumption that holds until it does not.
      const rows = await scoped()
        .orderBy("created_at", "desc")
        .orderBy("member_id", "asc")
        .execute();
      return rows.map(toMembershipRecord);
    },

    async countOwners(): Promise<number> {
      // COUNT in SQL rather than loading rows to measure their length.
      const result = await trx
        .selectFrom("workspace_memberships")
        .select(eb => eb.fn.countAll<string>().as("count"))
        .where("workspace_id", "=", scope)
        .where("role", "=", "owner")
        .executeTakeFirstOrThrow();
      return Number(result.count);
    },

    async insert(membership: WorkspaceMembershipRecord): Promise<void> {
      assertScope(scope, membership.workspaceId, "WorkspaceMembership");
      try {
        await trx
          .insertInto("workspace_memberships")
          .values(fromMembershipRecord(membership))
          .execute();
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async changeRoleIfUnchanged(input: {
      readonly memberId: WorkspaceMemberId;
      readonly expectedRole: WorkspaceRole;
      readonly nextRole: WorkspaceRole;
    }): Promise<boolean> {
      // Conditional on the CURRENT value. Read-then-write would let two
      // concurrent requests both read `sender` and both write, with the second
      // silently overwriting the first.
      const result = await trx
        .updateTable("workspace_memberships")
        .set({ role: input.nextRole })
        .where("workspace_id", "=", scope)
        .where("member_id", "=", input.memberId)
        .where("role", "=", input.expectedRole)
        .executeTakeFirst();

      // Zero rows is deliberately ambiguous: absent, other tenant, or changed
      // concurrently. The caller reports "could not apply", never which.
      return Number(result.numUpdatedRows) === 1;
    },
  };
}
