// The org chart, in PostgreSQL.
//
// Every write is conditional and every read is workspace-scoped, like every
// other repository here. Two things are deliberately NOT enforced in this file
// because the database enforces them better:
//
//   sibling name uniqueness   two partial unique indexes, so two concurrent
//                             creates cannot both land
//   membership prerequisite   a compound FK to workspace_memberships, so a
//                             non-member cannot be filed into a department even
//                             through a race
//
// A pre-read for either would have a window, and the window is exactly where
// the bug lives.

import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type {
  ScopedOrganizationUnitRepository, OrganizationUnitRecord,
  OrganizationUnitId, UnitMembership,
} from "@lagda/application";
import type { OrganizationUnitKind } from "@lagda/core";
import { isOrganizationUnitKind } from "@lagda/core";
import type { WorkspaceId, UserId } from "@lagda/contracts";
import type { Database, OrganizationUnitsTable } from "../schema/index.js";
import { PersistenceMappingError } from "../mapping/index.js";

function toKind(value: string): OrganizationUnitKind {
  // Validated rather than cast. Persisted state is untrusted input, and an
  // unrecognised kind would reach a client that has no label for it.
  if (!isOrganizationUnitKind(value)) {
    throw new PersistenceMappingError(
      "organization_units", "kind", `Unrecognised unit kind ${value}.`);
  }
  return value;
}

function toRecord(
  row: Selectable<OrganizationUnitsTable>,
): OrganizationUnitRecord {
  return {
    unitId: row.unit_id as OrganizationUnitId,
    workspaceId: row.workspace_id as WorkspaceId,
    parentUnitId: row.parent_unit_id as OrganizationUnitId | null,
    kind: toKind(row.kind),
    name: row.name,
    createdAt: row.created_at.getTime(),
    archivedAt: row.archived_at === null ? null : row.archived_at.getTime(),
  };
}

export function createScopedOrganizationUnitRepository(
  trx: Kysely<Database> | Transaction<Database>,
  scope: WorkspaceId,
): ScopedOrganizationUnitRepository {
  const scoped = () => trx.selectFrom("organization_units").selectAll()
    .where("workspace_id", "=", scope);

  return {
    async list() {
      // Archived rows INCLUDED. A caller deciding where to place a unit must
      // see the whole tree; hiding archived parents would let a placement look
      // valid and then violate a constraint.
      //
      // Ordered by name so a tree rendered from this is stable between calls
      // rather than following insertion order.
      const rows = await scoped()
        .orderBy("parent_unit_id", "asc")
        .orderBy("name", "asc")
        .execute();
      return rows.map(toRecord);
    },

    async findById(unitId: OrganizationUnitId) {
      const row = await scoped()
        .where("unit_id", "=", unitId as string)
        .executeTakeFirst();
      // A unit in another workspace is indistinguishable from one that does not
      // exist -- the scope predicate makes both null.
      return row === undefined ? null : toRecord(row);
    },

    async insert(unit: OrganizationUnitRecord) {
      await trx.insertInto("organization_units").values({
        unit_id: unit.unitId,
        workspace_id: unit.workspaceId,
        parent_unit_id: unit.parentUnitId,
        kind: unit.kind,
        name: unit.name,
        created_at: new Date(unit.createdAt),
        archived_at: null,
      }).execute();
    },

    async updateIfLive(input) {
      // Conditional on being live, in the WHERE clause. A preceding read cannot
      // see a concurrent archive.
      const result = await trx.updateTable("organization_units")
        .set({ name: input.name, parent_unit_id: input.parentUnitId })
        .where("workspace_id", "=", scope)
        .where("unit_id", "=", input.unitId as string)
        .where("archived_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0n) === 1;
    },

    async archiveIfLive(input) {
      const result = await trx.updateTable("organization_units")
        .set({ archived_at: new Date(input.now) })
        .where("workspace_id", "=", scope)
        .where("unit_id", "=", input.unitId as string)
        .where("archived_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0n) === 1;
    },

    async listMembers(unitId: OrganizationUnitId): Promise<readonly UnitMembership[]> {
      const rows = await trx.selectFrom("organization_unit_members")
        .select(["user_id", "title"])
        .where("workspace_id", "=", scope)
        .where("unit_id", "=", unitId as string)
        .orderBy("created_at", "asc")
        .execute();
      return rows.map(row => ({ userId: row.user_id as UserId, title: row.title }));
    },

    async addMember(input) {
      // ON CONFLICT DO NOTHING: adding somebody twice is the state the caller
      // asked for, and a second click should not be an error. That includes a
      // repeated `title` — changing an EXISTING member's title is
      // `setMemberTitle`'s job, not this one's, so a conflicting add leaves
      // whatever title they already had untouched rather than overwriting it.
      await trx.insertInto("organization_unit_members").values({
        unit_id: input.unitId,
        workspace_id: scope,
        user_id: input.userId,
        created_at: new Date(input.now),
        title: input.title ?? null,
      })
        .onConflict(conflict => conflict
          .columns(["unit_id", "user_id"])
          .doNothing())
        .execute();
    },

    async removeMember(input) {
      const result = await trx.deleteFrom("organization_unit_members")
        .where("workspace_id", "=", scope)
        .where("unit_id", "=", input.unitId as string)
        .where("user_id", "=", input.userId as string)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0n) === 1;
    },

    async setMemberTitle(input) {
      const result = await trx.updateTable("organization_unit_members")
        .set({ title: input.title })
        .where("workspace_id", "=", scope)
        .where("unit_id", "=", input.unitId as string)
        .where("user_id", "=", input.userId as string)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0n) === 1;
    },

    async findByTitle(unitId: OrganizationUnitId, title: string) {
      // Case- and whitespace-insensitive, matching the partial unique index
      // (061) that makes this lookup meaningful in the first place — a title
      // stored as "Department Head" must be found by "department head" too.
      const row = await trx.selectFrom("organization_unit_members")
        .select("user_id")
        .where("workspace_id", "=", scope)
        .where("unit_id", "=", unitId as string)
        .where(sql`lower(btrim(title))`, "=", sql`lower(btrim(${title}))`)
        .executeTakeFirst();
      return row === undefined ? null : (row.user_id as UserId);
    },

    async unitsForUser(userId: UserId) {
      const rows = await trx.selectFrom("organization_unit_members")
        .select("unit_id")
        .where("workspace_id", "=", scope)
        .where("user_id", "=", userId as string)
        .execute();
      return rows.map(row => row.unit_id as OrganizationUnitId);
    },
  };
}
