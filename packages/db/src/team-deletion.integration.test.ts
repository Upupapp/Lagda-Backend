// 094. Deleting a team, against Postgres as the runtime role: only an empty
// one (no members, no sub-teams), decided by the delete itself; never another
// workspace's. And the one-time clean-up removes every archived team, leaf
// first, with its old memberships — and nothing else.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type { OrganizationUnitId, OrganizationUnitRecord } from "@lagda/application";
import { type LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll,
  hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";
import { up as migrate094 } from "./migrations/094_team_deletion.js";

const AT = Date.parse("2026-10-01T09:00:00.000Z");
const USER_A = "usr_a";
const WS_A = "ws_del_a" as WorkspaceId;
const WS_B = "ws_del_b" as WorkspaceId;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("team deletion (094, runtime role)", () => {
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
    const tx = createTransactionManager(owner.db);
    for (const id of [WS_A, WS_B]) {
      await tx.runForWorkspace(id, async uow => {
        await uow.workspaces.insert({ workspaceId: id, name: `WS ${id}`, createdAt: AT });
        await uow.memberships.insert({
          memberId: `mem_${id}` as WorkspaceMemberId, workspaceId: id,
          userId: USER_A as UserId, role: "owner", createdAt: AT,
        });
      });
    }
  });

  const run = <T>(workspaceId: WorkspaceId, work: Parameters<ReturnType<typeof createTransactionManager>["runForWorkspace"]>[1]) =>
    createTransactionManager(app.db).runForWorkspace(workspaceId, work) as Promise<T>;

  const insertUnit = (workspaceId: WorkspaceId, unitId: string, parent: string | null = null) =>
    run(workspaceId, uow => {
      const unit: OrganizationUnitRecord = {
        unitId: unitId as OrganizationUnitId, workspaceId,
        parentUnitId: parent as OrganizationUnitId | null, kind: "team", name: unitId,
        createdAt: AT, archivedAt: null,
      };
      return uow.organizationUnits.insert(unit);
    });

  const deleteIfEmpty = (workspaceId: WorkspaceId, unitId: string) =>
    run<boolean>(workspaceId, uow => uow.organizationUnits.deleteIfEmpty(unitId as OrganizationUnitId));

  const unitIds = (workspaceId: WorkspaceId) =>
    run<readonly OrganizationUnitRecord[]>(workspaceId, uow => uow.organizationUnits.list())
      .then(list => list.map(u => u.unitId as string).sort());

  it("deletes an empty team", async () => {
    await insertUnit(WS_A, "unit_empty");
    expect(await deleteIfEmpty(WS_A, "unit_empty")).toBe(true);
    expect(await unitIds(WS_A)).toEqual([]);
  });

  it("keeps a team with a member", async () => {
    await insertUnit(WS_A, "unit_staffed");
    await run(WS_A, uow => uow.organizationUnits.addMember({ unitId: "unit_staffed" as OrganizationUnitId, userId: USER_A as UserId, now: AT }));
    expect(await deleteIfEmpty(WS_A, "unit_staffed")).toBe(false);
    expect(await unitIds(WS_A)).toEqual(["unit_staffed"]);
  });

  it("keeps a team with a sub-team", async () => {
    await insertUnit(WS_A, "unit_parent");
    await insertUnit(WS_A, "unit_child", "unit_parent");
    expect(await deleteIfEmpty(WS_A, "unit_parent")).toBe(false);
    expect(await unitIds(WS_A)).toEqual(["unit_child", "unit_parent"]);
  });

  it("never deletes another workspace's team", async () => {
    await insertUnit(WS_A, "unit_theirs");
    expect(await deleteIfEmpty(WS_B, "unit_theirs")).toBe(false);
    expect(await unitIds(WS_A)).toEqual(["unit_theirs"]);
  });

  it("the clean-up removes archived teams leaf first, with their memberships, and keeps everything else", async () => {
    await insertUnit(WS_A, "unit_live");
    await insertUnit(WS_A, "unit_old_parent");
    await insertUnit(WS_A, "unit_old_child", "unit_old_parent");
    await insertUnit(WS_B, "unit_old_b");
    // An old membership, from before the team was archived.
    await run(WS_A, uow => uow.organizationUnits.addMember({ unitId: "unit_old_child" as OrganizationUnitId, userId: USER_A as UserId, now: AT }));
    // Archived the only way the product ever could: the child first.
    const archive = (ws: WorkspaceId, id: string) => run(ws, uow => uow.organizationUnits.archiveIfLive({ unitId: id as OrganizationUnitId, now: AT }));
    await archive(WS_A, "unit_old_child");
    await archive(WS_A, "unit_old_parent");
    await archive(WS_B, "unit_old_b");
    expect(await unitIds(WS_A)).toEqual(["unit_live", "unit_old_child", "unit_old_parent"]);

    await migrate094(owner.db as never);

    expect(await unitIds(WS_A)).toEqual(["unit_live"]);
    expect(await unitIds(WS_B)).toEqual([]);
    const left = await owner.db.executeQuery<{ n: string }>(sql`
      select count(*)::text as n from organization_unit_members where unit_id = 'unit_old_child'`.compile(owner.db));
    expect(left.rows[0]?.n).toBe("0");
    // The person is still in the workspace.
    const member = await run<unknown>(WS_A, uow => uow.memberships.findByUser(USER_A as UserId));
    expect(member).not.toBeNull();
  });
});
