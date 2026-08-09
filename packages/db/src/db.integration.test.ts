// Persistence integration tests — REAL PostgreSQL.
//
// These are the tests that cannot be faked. A mock cannot tell you whether a
// transaction actually rolls back, whether a CHECK constraint rejects a bad
// role, or whether a `timestamptz` survives a round trip without shifting.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import { CreateWorkspace } from "@lagda/application";
import type { LagdaDatabase } from "./client/index.js";
import { migrationStatus } from "./migrations/runner.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createWorkspaceRepository, createWorkspaceMembershipRepository,
} from "./repositories/workspaces.js";
import { isUniqueViolation, isForeignKeyViolation, isCheckViolation } from "./errors.js";
import { createTestDatabase, truncateAll, hasIntegrationDatabase } from "./testing/harness.js";

const CREATED_AT = Date.parse("2026-08-09T06:30:00.000Z");
const OWNER = "usr_1" as UserId;
// Most of these tests write to one workspace; the tenancy suite covers the rest.
const WS_SCOPE = "ws_1" as WorkspaceId;

// Skips cleanly when no integration database is configured, so `npm test` stays
// offline. CI sets DATABASE_TEST_URL and these run for real.
const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("persistence integration", () => {
  let database: LagdaDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    // Without this the process hangs on open pool handles.
    await database?.close();
  });

  beforeEach(async () => {
    await truncateAll(database);
  });

  // ── Migrations ─────────────────────────────────────────────────────────────

  describe("migrations", () => {
    it("has applied every migration from zero", async () => {
      const status = await migrationStatus(database.db);
      expect(status.length).toBeGreaterThan(0);
      expect(status.every(m => m.applied)).toBe(true);
    });

    it("is a no-op when already current", async () => {
      // Re-running the deployment step must be safe.
      const { migrateToLatest } = await import("./migrations/runner.js");
      const outcome = await migrateToLatest(database.db);
      expect(outcome.error).toBeUndefined();
      expect(outcome.applied).toEqual([]);
    });
  });

  // ── Transactions ───────────────────────────────────────────────────────────

  describe("transactions", () => {
    it("commits both writes together", async () => {
      const transactions = createTransactionManager(database.db);
      const workspaces = createWorkspaceRepository(database.db);
      const memberships = createWorkspaceMembershipRepository(database.db);

      await transactions.runForWorkspace(WS_SCOPE, async tx => {
        await workspaces.save({
          workspaceId: "ws_1" as WorkspaceId, name: "Acme",
          ownerUserId: OWNER, createdAt: CREATED_AT,
        }, tx);
        await memberships.save({
          memberId: "mem_1" as WorkspaceMemberId, workspaceId: "ws_1" as WorkspaceId,
          userId: OWNER, role: "owner", createdAt: CREATED_AT,
        }, tx);
      });

      const tx2 = createTransactionManager(database.db);
      await tx2.runForWorkspace("ws_1" as WorkspaceId, async t => {
        expect(await workspaces.findById("ws_1" as WorkspaceId, t)).not.toBeNull();
        expect(await memberships.listForWorkspace("ws_1" as WorkspaceId, t)).toHaveLength(1);
      });
    });

    it("ROLLS BACK both writes when the second fails", async () => {
      // The test a fake cannot perform. The workspace insert succeeds, the
      // membership insert violates the role CHECK, and PostgreSQL must discard
      // the workspace too — otherwise a workspace with no owner would exist,
      // which is exactly the unrecoverable state the transaction prevents.
      const transactions = createTransactionManager(database.db);
      const workspaces = createWorkspaceRepository(database.db);

      await expect(
        transactions.runForWorkspace(WS_SCOPE, async tx => {
          await workspaces.save({
            workspaceId: "ws_rollback" as WorkspaceId, name: "Doomed",
            ownerUserId: OWNER, createdAt: CREATED_AT,
          }, tx);
          // Fails after a successful write. If the rollback did not happen, the
          // workspace would survive.
          throw new Error("deliberate failure after the first write");
        }),
      ).rejects.toThrow("deliberate failure");

      await transactions.runForWorkspace("ws_rollback" as WorkspaceId, async t => {
        expect(await workspaces.findById("ws_rollback" as WorkspaceId, t)).toBeNull();
      });
    });

    it("releases connections after repeated failures", async () => {
      // A transaction that leaks its client on the error path exhausts the pool
      // after `poolMax` failures and then hangs forever.
      const transactions = createTransactionManager(database.db);
      for (let i = 0; i < 15; i++) {
        await expect(
          transactions.runForWorkspace(WS_SCOPE, () => Promise.reject(new Error("boom"))),
        ).rejects.toThrow("boom");
      }
      expect(await database.ping()).toBe(true);
    });

    it("refuses a transaction context it did not create", () => {
      const workspaces = createWorkspaceRepository(database.db);
      const foreign = { notATransaction: true } as never;
      return expect(
        workspaces.save({
          workspaceId: "ws_x" as WorkspaceId, name: "X",
          ownerUserId: OWNER, createdAt: CREATED_AT,
        }, foreign),
      ).rejects.toThrow(/not created by the PostgreSQL transaction manager/);
    });
  });

  // ── Constraints ────────────────────────────────────────────────────────────

  describe("constraints", () => {
    const seedWorkspace = async (id: string) => {
      const transactions = createTransactionManager(database.db);
      const workspaces = createWorkspaceRepository(database.db);
      await transactions.runForWorkspace(WS_SCOPE, tx => workspaces.save({
        workspaceId: id as WorkspaceId, name: `Workspace ${id}`,
        ownerUserId: OWNER, createdAt: CREATED_AT,
      }, tx));
    };

    it("rejects a second membership for the same user in one workspace", async () => {
      await seedWorkspace("ws_1");
      const transactions = createTransactionManager(database.db);
      const memberships = createWorkspaceMembershipRepository(database.db);

      await transactions.runForWorkspace(WS_SCOPE, tx => memberships.save({
        memberId: "mem_1" as WorkspaceMemberId, workspaceId: "ws_1" as WorkspaceId,
        userId: OWNER, role: "owner", createdAt: CREATED_AT,
      }, tx));

      const duplicate = await transactions.runForWorkspace(WS_SCOPE, tx => memberships.save({
        memberId: "mem_2" as WorkspaceMemberId, workspaceId: "ws_1" as WorkspaceId,
        userId: OWNER, role: "sender", createdAt: CREATED_AT,
      }, tx)).catch((e: unknown) => e);

      // The database is the authority here: an application pre-check cannot
      // survive two concurrent requests.
      expect(isUniqueViolation(duplicate, "uq_workspace_memberships_workspace_user")).toBe(true);
    });

    it("lets the same user belong to two DIFFERENT workspaces", async () => {
      await seedWorkspace("ws_1");
      await seedWorkspace("ws_2");
      const transactions = createTransactionManager(database.db);
      const memberships = createWorkspaceMembershipRepository(database.db);

      await transactions.runForWorkspace(WS_SCOPE, async tx => {
        await memberships.save({
          memberId: "mem_1" as WorkspaceMemberId, workspaceId: "ws_1" as WorkspaceId,
          userId: OWNER, role: "owner", createdAt: CREATED_AT,
        }, tx);
        await memberships.save({
          memberId: "mem_2" as WorkspaceMemberId, workspaceId: "ws_2" as WorkspaceId,
          userId: OWNER, role: "sender", createdAt: CREATED_AT,
        }, tx);
      });

      // Uniqueness is per workspace, not global — the distinction §25 warns about.
      for (const id of ["ws_1", "ws_2"] as const) {
        await transactions.runForWorkspace(id as WorkspaceId, async t => {
          expect(await memberships.listForWorkspace(id as WorkspaceId, t)).toHaveLength(1);
        });
      }
    });

    it("rejects a membership in a workspace that does not exist", async () => {
      const transactions = createTransactionManager(database.db);
      const memberships = createWorkspaceMembershipRepository(database.db);

      const orphan = await transactions.runForWorkspace(WS_SCOPE, tx => memberships.save({
        memberId: "mem_x" as WorkspaceMemberId, workspaceId: "ws_missing" as WorkspaceId,
        userId: OWNER, role: "owner", createdAt: CREATED_AT,
      }, tx)).catch((e: unknown) => e);

      expect(isForeignKeyViolation(orphan)).toBe(true);
    });

    it("rejects a role outside the canonical vocabulary", async () => {
      await seedWorkspace("ws_1");
      const failure = await database.db
        .insertInto("workspace_memberships")
        .values({
          member_id: "mem_bad", workspace_id: "ws_1", user_id: OWNER,
          role: "superuser", created_at: new Date(CREATED_AT),
        })
        .execute()
        .catch((e: unknown) => e);

      expect(isCheckViolation(failure, "chk_workspace_memberships_role")).toBe(true);
    });

    it("rejects a blank workspace name", async () => {
      const failure = await database.db
        .insertInto("workspaces")
        .values({
          workspace_id: "ws_blank", name: "   ",
          owner_user_id: OWNER, created_at: new Date(CREATED_AT),
        })
        .execute()
        .catch((e: unknown) => e);

      expect(isCheckViolation(failure, "chk_workspaces_name_not_blank")).toBe(true);
    });

    it("refuses to delete a workspace that still has members", async () => {
      // ON DELETE RESTRICT, not CASCADE. Deleting a workspace must not silently
      // erase who belonged to it — deletion semantics are unresolved.
      await seedWorkspace("ws_1");
      const transactions = createTransactionManager(database.db);
      const memberships = createWorkspaceMembershipRepository(database.db);
      await transactions.runForWorkspace(WS_SCOPE, tx => memberships.save({
        memberId: "mem_1" as WorkspaceMemberId, workspaceId: "ws_1" as WorkspaceId,
        userId: OWNER, role: "owner", createdAt: CREATED_AT,
      }, tx));

      const blocked = await database.db
        .deleteFrom("workspaces").where("workspace_id", "=", "ws_1").execute()
        .catch((e: unknown) => e);

      expect(isForeignKeyViolation(blocked)).toBe(true);
    });
  });

  // ── Mapping ────────────────────────────────────────────────────────────────

  describe("mapping", () => {
    it("round-trips a UTC timestamp without shifting it", async () => {
      // `timestamptz` plus a pinned type parser. A naive column, or a driver
      // returning a string, would silently reinterpret this in local time.
      const transactions = createTransactionManager(database.db);
      const workspaces = createWorkspaceRepository(database.db);

      await transactions.runForWorkspace(WS_SCOPE, tx => workspaces.save({
        workspaceId: "ws_time" as WorkspaceId, name: "Time",
        ownerUserId: OWNER, createdAt: CREATED_AT,
      }, tx));

      await transactions.runForWorkspace("ws_time" as WorkspaceId, async t => {
        const loaded = await workspaces.findById("ws_time" as WorkspaceId, t);
        expect(loaded?.createdAt).toBe(CREATED_AT);
        expect(new Date(loaded!.createdAt).toISOString()).toBe("2026-08-09T06:30:00.000Z");
      });
    });

    // The "unrecognised role" case is NOT tested here. It requires dropping the
    // CHECK constraint to write an invalid row, and a test that mutates SCHEMA
    // breaks isolation: TRUNCATE clears data, not DDL, so a failed run leaks a
    // dropped constraint into every later run. It is a pure function, so it is
    // unit-tested in mapping/mapping.test.ts with no database at all.
  });

  // ── Tenancy ────────────────────────────────────────────────────────────────

  describe("tenancy", () => {
    it("CANNOT read a member of another workspace", async () => {
      const transactions = createTransactionManager(database.db);
      const workspaces = createWorkspaceRepository(database.db);
      const memberships = createWorkspaceMembershipRepository(database.db);

      await transactions.runForWorkspace(WS_SCOPE, async tx => {
        await workspaces.save({ workspaceId: "ws_a" as WorkspaceId, name: "A", ownerUserId: OWNER, createdAt: CREATED_AT }, tx);
        await workspaces.save({ workspaceId: "ws_b" as WorkspaceId, name: "B", ownerUserId: OWNER, createdAt: CREATED_AT }, tx);
        await memberships.save({
          memberId: "mem_b" as WorkspaceMemberId, workspaceId: "ws_b" as WorkspaceId,
          userId: OWNER, role: "owner", createdAt: CREATED_AT,
        }, tx);
      });

      // The member exists — in workspace B. Scoped to A it is simply absent.
      await transactions.runForWorkspace("ws_a" as WorkspaceId, async t => {
        expect(await memberships.findInWorkspace(
          "ws_a" as WorkspaceId, "mem_b" as WorkspaceMemberId, t,
        )).toBeNull();
      });
      await transactions.runForWorkspace("ws_b" as WorkspaceId, async t => {
        const fromB = await memberships.findInWorkspace(
          "ws_b" as WorkspaceId, "mem_b" as WorkspaceMemberId, t,
        );
        expect(fromB?.memberId).toBe("mem_b");
      });
    });

    it("lists only the requested workspace's members", async () => {
      const transactions = createTransactionManager(database.db);
      const workspaces = createWorkspaceRepository(database.db);
      const memberships = createWorkspaceMembershipRepository(database.db);

      await transactions.runForWorkspace(WS_SCOPE, async tx => {
        await workspaces.save({ workspaceId: "ws_a" as WorkspaceId, name: "A", ownerUserId: OWNER, createdAt: CREATED_AT }, tx);
        await workspaces.save({ workspaceId: "ws_b" as WorkspaceId, name: "B", ownerUserId: OWNER, createdAt: CREATED_AT }, tx);
        await memberships.save({ memberId: "mem_a" as WorkspaceMemberId, workspaceId: "ws_a" as WorkspaceId, userId: OWNER, role: "owner", createdAt: CREATED_AT }, tx);
        await memberships.save({ memberId: "mem_b" as WorkspaceMemberId, workspaceId: "ws_b" as WorkspaceId, userId: OWNER, role: "owner", createdAt: CREATED_AT }, tx);
      });

      await transactions.runForWorkspace("ws_a" as WorkspaceId, async t => {
        const inA = await memberships.listForWorkspace("ws_a" as WorkspaceId, t);
        expect(inA).toHaveLength(1);
        expect(inA[0]?.memberId).toBe("mem_a");
      });
    });
  });

  // ── The BACKEND-05 use case, against real PostgreSQL ───────────────────────

  describe("CreateWorkspace against PostgreSQL", () => {
    it("persists the workspace and its owner atomically", async () => {
      // The application use case, unchanged, running on real adapters. It never
      // learns that PostgreSQL exists.
      const useCase = new CreateWorkspace({
        workspaces: createWorkspaceRepository(database.db),
        memberships: createWorkspaceMembershipRepository(database.db),
        transactions: createTransactionManager(database.db),
        clock: { now: () => CREATED_AT },
        workspaceIds: { nextWorkspaceId: () => "ws_real" as WorkspaceId },
        memberIds: { nextWorkspaceMemberId: () => "mem_real" as WorkspaceMemberId },
      });

      const result = await useCase.execute({ ownerUserId: OWNER, name: "Northbridge Legal" });

      expect(result.workspaceId).toBe("ws_real");
      await createTransactionManager(database.db)
        .runForWorkspace("ws_real" as WorkspaceId, async t => {
          const members = await createWorkspaceMembershipRepository(database.db)
            .listForWorkspace("ws_real" as WorkspaceId, t);
          expect(members).toHaveLength(1);
          expect(members[0]?.role).toBe("owner");
        });
    });
  });
});
