// Persistence integration tests — REAL PostgreSQL.
//
// These are the tests that cannot be faked: whether a transaction actually
// rolls back, whether a CHECK constraint rejects a bad role, whether a
// `timestamptz` survives a round trip, whether SQLSTATE translation matches
// what the database really raises.
//
// The behavioural CONTRACT suite runs separately, against the same adapter, so
// the fake and PostgreSQL are held to one specification.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import { CreateWorkspace, type SessionId } from "@lagda/application";
import type { LagdaDatabase } from "./client/index.js";
import { migrationStatus, migrateToLatest } from "./migrations/runner.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  UniqueConstraintViolation, ForeignKeyConstraintViolation, CheckConstraintViolation,
  WorkspaceScopeMismatchError, translatePersistenceError,
} from "./errors.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
  withRawTenantTransaction,
} from "./testing/harness.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";

const CREATED_AT = Date.parse("2026-08-09T06:30:00.000Z");
const OWNER = "usr_1" as UserId;
const WS = "ws_1" as WorkspaceId;

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
    // Every membership references a real account since migration 013.
    await seedUser(database, OWNER);
  });

  const seed = (workspaceId: WorkspaceId, memberId: string) =>
    createTransactionManager(database.db).runForWorkspace(workspaceId, async uow => {
      await uow.workspaces.insert({
        workspaceId, name: `Workspace ${workspaceId}`, createdAt: CREATED_AT,
      });
      await uow.memberships.insert({
        memberId: memberId as WorkspaceMemberId, workspaceId,
        userId: OWNER, role: "owner", createdAt: CREATED_AT,
      });
    });

  // ── Migrations ─────────────────────────────────────────────────────────────

  describe("migrations", () => {
    it("has applied every migration from zero", async () => {
      const status = await migrationStatus(database.db);
      expect(status.length).toBeGreaterThan(0);
      expect(status.every(m => m.applied)).toBe(true);
    });

    it("is a no-op when already current", async () => {
      const outcome = await migrateToLatest(database.db);
      expect(outcome.error).toBeUndefined();
      expect(outcome.applied).toEqual([]);
    });
  });

  // ── Unit of work ───────────────────────────────────────────────────────────

  describe("unit of work", () => {
    it("commits every repository write together", async () => {
      await seed(WS, "mem_1");

      const loaded = await createTransactionManager(database.db)
        .runForWorkspace(WS, async uow => ({
          workspace: await uow.workspaces.find(),
          members: await uow.memberships.list(),
        }));

      expect(loaded.workspace).not.toBeNull();
      expect(loaded.members).toHaveLength(1);
    });

    it("ROLLS BACK every repository write when one fails", async () => {
      // The test a fake cannot perform. Both repositories come from one unit of
      // work, so both writes share a transaction — the proof that "atomic" is
      // real rather than apparent.
      const transactions = createTransactionManager(database.db);

      await expect(
        transactions.runForWorkspace(WS, async uow => {
          await uow.workspaces.insert({
            workspaceId: WS, name: "Doomed", createdAt: CREATED_AT,
          });
          await uow.memberships.insert({
            memberId: "mem_doomed" as WorkspaceMemberId, workspaceId: WS,
            userId: OWNER, role: "owner", createdAt: CREATED_AT,
          });
          throw new Error("deliberate failure after both writes");
        }),
      ).rejects.toThrow("deliberate failure");

      const survivors = await transactions.runForWorkspace(WS, async uow => ({
        workspace: await uow.workspaces.find(),
        members: await uow.memberships.list(),
      }));
      expect(survivors.workspace).toBeNull();
      expect(survivors.members).toHaveLength(0);
    });

    it("releases connections after repeated failures", async () => {
      // A transaction leaking its client on the error path exhausts the pool
      // after `poolMax` failures and then hangs forever.
      const transactions = createTransactionManager(database.db);
      for (let i = 0; i < 15; i++) {
        await expect(
          transactions.runForWorkspace(WS, () => Promise.reject(new Error("boom"))),
        ).rejects.toThrow("boom");
      }
      expect(await database.ping()).toBe(true);
    });

    it("exposes no tenant repositories in global mode", async () => {
      // Global mode is not a route to workspace data. Structural, not incidental.
      const uow = await createTransactionManager(database.db)
        .runGlobal(u => Promise.resolve(u));
      expect(uow.scope).toBe("global");
      expect(uow).not.toHaveProperty("memberships");
      expect(uow).not.toHaveProperty("workspaces");
    });
  });

  // ── Workspace scope enforcement ────────────────────────────────────────────

  describe("workspace mismatch", () => {
    it("REFUSES to persist a record belonging to another workspace", async () => {
      // Raised before the write, so the problem is named rather than surfacing
      // as an RLS policy violation from three layers down. The workspace is
      // never rewritten to match the scope.
      await expect(
        createTransactionManager(database.db).runForWorkspace(WS, uow =>
          uow.workspaces.insert({
            workspaceId: "ws_other" as WorkspaceId, name: "Wrong",
            createdAt: CREATED_AT,
          })),
      ).rejects.toBeInstanceOf(WorkspaceScopeMismatchError);
    });
  });

  // ── Error translation ──────────────────────────────────────────────────────

  describe("persistence error translation", () => {
    it("translates a duplicate membership into UniqueConstraintViolation", async () => {
      await seed(WS, "mem_1");

      const duplicate = await createTransactionManager(database.db)
        .runForWorkspace(WS, uow =>
          uow.memberships.insert({
            memberId: "mem_2" as WorkspaceMemberId, workspaceId: WS,
            userId: OWNER, role: "sender", createdAt: CREATED_AT,
          }))
        .catch((e: unknown) => e);

      expect(duplicate).toBeInstanceOf(UniqueConstraintViolation);
      // The constraint NAME identifies which business rule broke. The offending
      // value is deliberately absent — it is user data.
      expect((duplicate as UniqueConstraintViolation).constraint)
        .toBe("uq_workspace_memberships_workspace_user");
    });

    it("translates a missing parent into ForeignKeyConstraintViolation", async () => {
      const orphan = await createTransactionManager(database.db)
        .runForWorkspace("ws_ghost" as WorkspaceId, uow =>
          uow.memberships.insert({
            memberId: "mem_x" as WorkspaceMemberId, workspaceId: "ws_ghost" as WorkspaceId,
            userId: OWNER, role: "owner", createdAt: CREATED_AT,
          }))
        .catch((e: unknown) => e);

      expect(orphan).toBeInstanceOf(ForeignKeyConstraintViolation);
    });

    it("translates a bad role into CheckConstraintViolation", async () => {
      await seed(WS, "mem_1");
      const failure = await withRawTenantTransaction(database, WS, trx =>
        trx.insertInto("workspace_memberships").values({
          member_id: "mem_bad", workspace_id: WS, user_id: OWNER,
          role: "superuser", created_at: new Date(CREATED_AT),
        }).execute(),
      ).catch((e: unknown) => translatePersistenceError(e));

      expect(failure).toBeInstanceOf(CheckConstraintViolation);
    });

    it("does NOT downgrade an unknown error into an expected conflict", () => {
      // A connection failure or timeout must stay an infrastructure failure.
      // Reporting it as "conflict" or "not found" would tell a caller the data
      // is absent when the database is simply unreachable.
      const network = new Error("ECONNREFUSED");
      expect(translatePersistenceError(network)).toBe(network);
    });
  });

  // ── Concurrency ────────────────────────────────────────────────────────────

  describe("conditional updates", () => {
    it("applies once and refuses the stale second writer", async () => {
      // Read-then-write would let both writers proceed, with the second
      // silently overwriting the first. The conditional update matches zero
      // rows instead.
      await seed(WS, "mem_1");
      const transactions = createTransactionManager(database.db);
      const member = "mem_1" as WorkspaceMemberId;

      const first = await transactions.runForWorkspace(WS, uow =>
        uow.memberships.changeRoleIfUnchanged({
          memberId: member, expectedRole: "owner", nextRole: "administrator",
        }));
      const second = await transactions.runForWorkspace(WS, uow =>
        uow.memberships.changeRoleIfUnchanged({
          memberId: member, expectedRole: "owner", nextRole: "auditor",
        }));

      expect(first).toBe(true);
      expect(second).toBe(false);

      const final = await transactions.runForWorkspace(WS, uow =>
        uow.memberships.findMember(member));
      expect(final?.role).toBe("administrator");
    });
  });

  // ── Mapping ────────────────────────────────────────────────────────────────

  describe("mapping", () => {
    it("round-trips a UTC timestamp without shifting it", async () => {
      await seed(WS, "mem_1");
      const loaded = await createTransactionManager(database.db)
        .runForWorkspace(WS, uow => uow.workspaces.find());

      expect(loaded?.createdAt).toBe(CREATED_AT);
      expect(new Date(loaded!.createdAt).toISOString()).toBe("2026-08-09T06:30:00.000Z");
    });

    it("orders listed members deterministically", async () => {
      // PostgreSQL guarantees no row order without ORDER BY, so "insertion
      // order" is an assumption that holds until it does not.
      await seed(WS, "mem_1");
      // A second, DIFFERENT account: `UNIQUE(workspace_id, user_id)` forbids two
      // memberships for one user, and the foreign key forbids a user that does
      // not exist.
      await seedUser(database, "usr_2");
      await createTransactionManager(database.db).runForWorkspace(WS, uow =>
        uow.memberships.insert({
          memberId: "mem_2" as WorkspaceMemberId, workspaceId: WS,
          userId: "usr_2" as UserId, role: "sender", createdAt: CREATED_AT,
        }));

      const first = await createTransactionManager(database.db)
        .runForWorkspace(WS, uow => uow.memberships.list());
      const second = await createTransactionManager(database.db)
        .runForWorkspace(WS, uow => uow.memberships.list());

      expect(first.map(m => m.memberId)).toEqual(second.map(m => m.memberId));
    });
  });

  // ── Constraints still hold ─────────────────────────────────────────────────

  describe("constraints", () => {
    it("refuses to delete a workspace that still has members", async () => {
      // ON DELETE RESTRICT. Deleting a workspace must not silently erase who
      // belonged to it — deletion semantics are unresolved.
      await seed(WS, "mem_1");
      const blocked = await withRawTenantTransaction(database, WS, trx =>
        trx.deleteFrom("workspaces").where("workspace_id", "=", WS).execute(),
      ).catch((e: unknown) => translatePersistenceError(e));

      expect(blocked).toBeInstanceOf(ForeignKeyConstraintViolation);
    });

    it("rejects a blank workspace name", async () => {
      const failure = await withRawTenantTransaction(database, "ws_blank" as WorkspaceId, trx =>
        trx.insertInto("workspaces").values({
          workspace_id: "ws_blank", name: "   ",
          created_at: new Date(CREATED_AT),
        }).execute(),
      ).catch((e: unknown) => translatePersistenceError(e));

      expect(failure).toBeInstanceOf(CheckConstraintViolation);
    });

    it("keeps the compound-key target in place for future child tables", async () => {
      const indexes = await sql<{ indexname: string }>`
        select indexname from pg_indexes where tablename = 'workspace_memberships'
      `.execute(database.db);
      expect(indexes.rows.map(r => r.indexname))
        .toContain("uq_workspace_memberships_workspace_member");
    });
  });

  // ── The BACKEND-05 use case, against real PostgreSQL ───────────────────────

  describe("CreateWorkspace against PostgreSQL", () => {
    it("persists the workspace and its owner atomically", async () => {
      // The application use case, unchanged, running on real adapters. It never
      // learns that PostgreSQL exists.
      const useCase = new CreateWorkspace({
        transactions: createTransactionManager(database.db),
        clock: { now: () => CREATED_AT },
        workspaceIds: { nextWorkspaceId: () => "ws_real" as WorkspaceId },
        memberIds: { nextWorkspaceMemberId: () => "mem_real" as WorkspaceMemberId },
        idempotency: {
          digester: createIdempotencyKeyDigester(),
          ids: createIdempotencyRecordIds(),
          clock: { now: () => CREATED_AT },
          policy: { retentionMs: 24 * 3_600_000 },
        },
      });

      const result = await useCase.execute({
        actor: { actorType: "user", userId: OWNER, sessionId: "ses_x" as SessionId },
        name: "Northbridge Legal",
      });
      expect(result.workspaceId).toBe("ws_real");

      const members = await createTransactionManager(database.db)
        .runForWorkspace("ws_real" as WorkspaceId, uow => uow.memberships.list());
      expect(members).toHaveLength(1);
      expect(members[0]?.role).toBe("owner");
    });
  });
});
