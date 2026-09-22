// Organization unit member titles (061), against REAL PostgreSQL, as the
// RUNTIME role.
//
// What only this suite can prove:
//
//   1. RLS isolates titles the same way it isolates everything else in this
//      table — a title set in one workspace is invisible, and unfindable
//      by `findByTitle`, from another.
//   2. The partial unique index actually fires: two people cannot hold the
//      same title in the same unit, case- and whitespace-insensitively,
//      and the SAME title is fine in two different units.
//   3. `setMemberTitle` and `findByTitle` behave live against the database,
//      not just against the in-memory fake `resolveWorkflowRoleAssignments`
//      is unit-tested against.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type { OrganizationUnitId, OrganizationUnitRecord } from "@lagda/application";
import { type LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll,
  hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-09-22T09:00:00.000Z");
const USER_A = "usr_a";
const USER_B = "usr_b";
const WS_A = "ws_out_a" as WorkspaceId;
const WS_B = "ws_out_b" as WorkspaceId;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("organization unit member titles (RLS, runtime role)", () => {
  let owner: LagdaDatabase;
  let app: LagdaDatabase;

  beforeAll(async () => {
    owner = await createTestDatabase();
    app = await createRuntimeRoleDatabase(owner);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
  });

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, USER_A);
    await seedUser(owner, USER_B);
    const tx = createTransactionManager(owner.db);
    for (const id of [WS_A, WS_B]) {
      await tx.runForWorkspace(id, async uow => {
        await uow.workspaces.insert({ workspaceId: id, name: `WS ${id}`, createdAt: AT });
        await uow.memberships.insert({
          memberId: `mem_${id}_a` as WorkspaceMemberId, workspaceId: id,
          userId: USER_A as UserId, role: "owner", createdAt: AT,
        });
        await uow.memberships.insert({
          memberId: `mem_${id}_b` as WorkspaceMemberId, workspaceId: id,
          userId: USER_B as UserId, role: "member", createdAt: AT + 1,
        });
      });
    }
  });

  const insertUnit = (workspaceId: WorkspaceId, unitId: string, name = "Records") =>
    createTransactionManager(app.db).runForWorkspace(workspaceId, uow => {
      const unit: OrganizationUnitRecord = {
        unitId: unitId as OrganizationUnitId, workspaceId,
        parentUnitId: null, kind: "department", name,
        createdAt: AT, archivedAt: null,
      };
      return uow.organizationUnits.insert(unit);
    });

  const addMember = (
    workspaceId: WorkspaceId, unitId: string, userId: string, title: string | null = null,
  ) => createTransactionManager(app.db).runForWorkspace(workspaceId, uow =>
    uow.organizationUnits.addMember({
      unitId: unitId as OrganizationUnitId, userId: userId as UserId, now: AT,
      title,
    }));

  describe("row-level security", () => {
    it("a title set in one workspace is not found in another", async () => {
      await insertUnit(WS_A, "unit_a1");
      await addMember(WS_A, "unit_a1", USER_A, "Department Head");

      // The SAME unit_id, queried while scoped to a DIFFERENT workspace.
      // `organization_units`'s primary key is `unit_id` alone, so this id
      // could never legitimately belong to WS_B — RLS is what makes it
      // invisible there rather than an accident of never colliding.
      const foundElsewhere = await createTransactionManager(app.db)
        .runForWorkspace(WS_B, uow =>
          uow.organizationUnits.findByTitle("unit_a1" as OrganizationUnitId, "Department Head"));
      expect(foundElsewhere).toBeNull();

      const foundHere = await createTransactionManager(app.db)
        .runForWorkspace(WS_A, uow =>
          uow.organizationUnits.findByTitle("unit_a1" as OrganizationUnitId, "Department Head"));
      expect(foundHere).toBe(USER_A);
    });

    it("listMembers hides another workspace's roster", async () => {
      await insertUnit(WS_A, "unit_1");
      await addMember(WS_A, "unit_1", USER_A, "Department Head");

      const seen = await createTransactionManager(app.db)
        .runForWorkspace(WS_B, uow => uow.organizationUnits.listMembers("unit_1" as OrganizationUnitId));
      expect(seen).toEqual([]);
    });
  });

  describe("the partial unique index", () => {
    it("refuses TWO people holding the same title in one unit", async () => {
      await insertUnit(WS_A, "unit_1");
      await addMember(WS_A, "unit_1", USER_A, "Department Head");

      await expect(addMember(WS_A, "unit_1", USER_B, "Department Head"))
        .rejects.toThrow();
    });

    it("is case- and whitespace-insensitive", async () => {
      await insertUnit(WS_A, "unit_1");
      await addMember(WS_A, "unit_1", USER_A, "Department Head");

      await expect(addMember(WS_A, "unit_1", USER_B, "  department head  "))
        .rejects.toThrow();
    });

    it("allows the SAME title in two DIFFERENT units", async () => {
      await insertUnit(WS_A, "unit_1", "Legal");
      await insertUnit(WS_A, "unit_2", "Finance");
      await addMember(WS_A, "unit_1", USER_A, "Department Head");

      await expect(addMember(WS_A, "unit_2", USER_B, "Department Head"))
        .resolves.toBeUndefined();
    });

    it("allows any number of members with NO title", async () => {
      await insertUnit(WS_A, "unit_1");
      await addMember(WS_A, "unit_1", USER_A, null);
      await expect(addMember(WS_A, "unit_1", USER_B, null)).resolves.toBeUndefined();
    });

    it("refuses via setMemberTitle too, not only at add time", async () => {
      await insertUnit(WS_A, "unit_1");
      await addMember(WS_A, "unit_1", USER_A, "Department Head");
      await addMember(WS_A, "unit_1", USER_B, null);

      await expect(createTransactionManager(app.db).runForWorkspace(WS_A, uow =>
        uow.organizationUnits.setMemberTitle({
          unitId: "unit_1" as OrganizationUnitId, userId: USER_B as UserId,
          title: "Department Head",
        }))).rejects.toThrow();
    });
  });

  describe("setMemberTitle / findByTitle, live", () => {
    it("changes who a title resolves to, without removing the old holder", async () => {
      await insertUnit(WS_A, "unit_1");
      await addMember(WS_A, "unit_1", USER_A, "Department Head");
      await addMember(WS_A, "unit_1", USER_B, null);

      await createTransactionManager(app.db).runForWorkspace(WS_A, async uow => {
        await uow.organizationUnits.setMemberTitle({
          unitId: "unit_1" as OrganizationUnitId, userId: USER_A as UserId, title: null,
        });
        await uow.organizationUnits.setMemberTitle({
          unitId: "unit_1" as OrganizationUnitId, userId: USER_B as UserId,
          title: "Department Head",
        });
      });

      const resolved = await createTransactionManager(app.db)
        .runForWorkspace(WS_A, uow =>
          uow.organizationUnits.findByTitle("unit_1" as OrganizationUnitId, "Department Head"));
      expect(resolved).toBe(USER_B);
    });

    it("returns null for a title nobody currently holds", async () => {
      await insertUnit(WS_A, "unit_1");
      const resolved = await createTransactionManager(app.db)
        .runForWorkspace(WS_A, uow =>
          uow.organizationUnits.findByTitle("unit_1" as OrganizationUnitId, "Department Head"));
      expect(resolved).toBeNull();
    });
  });
});
