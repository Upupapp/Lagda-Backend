// Workspace tenancy — security tests against REAL PostgreSQL.
//
// These run as the RUNTIME role (`lagda_app`), not as the table owner. That
// distinction is the whole point: an owner bypasses RLS unless FORCE is set, so
// a suite that connects as `postgres` would pass while production leaked. The
// first test verifies the role genuinely cannot bypass, because every assertion
// after it depends on that being true.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import { createDatabase, type LagdaDatabase } from "./client/index.js";
import { loadDatabaseConfig } from "./config/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
  withRawTenantTransaction, withRawGlobalTransaction,
} from "./testing/harness.js";

const AT = Date.parse("2026-08-09T07:00:00.000Z");
const USER = "usr_1" as UserId;
const WS_A = "ws_a" as WorkspaceId;
const WS_B = "ws_b" as WorkspaceId;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("workspace tenancy (RLS, runtime role)", () => {
  /** Owner connection. Used only to set up fixtures and grant the runtime role. */
  let owner: LagdaDatabase;
  /** The role the application actually runs as. Subject to RLS. */
  let app: LagdaDatabase;

  beforeAll(async () => {
    owner = await createTestDatabase();

    // Give the runtime role a password so tests can connect as it. Production
    // credentials come from deployment; this is test-only setup.
    await sql`alter role lagda_app with login password 'lagda_app_test'`.execute(owner.db);

    const url = new URL(process.env["DATABASE_TEST_URL"] ?? "");
    url.username = "lagda_app";
    url.password = "lagda_app_test";
    app = createDatabase(loadDatabaseConfig({ DATABASE_URL: url.toString() }));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
  });

  beforeEach(async () => {
    await truncateAll(owner);
    // Memberships reference a real account since migration 013.
    await seedUser(owner, USER);
    // Seeded as owner. FORCE RLS applies to the owner too, so seeding happens
    // through a tenant transaction like anything else.
    const tx = createTransactionManager(owner.db);
    for (const [id, member] of [[WS_A, "mem_a"], [WS_B, "mem_b"]] as const) {
      await tx.runForWorkspace(id, async uow => {
        await uow.workspaces.insert({
          workspaceId: id, name: `Workspace ${id}`, createdAt: AT,
        });
        await uow.memberships.insert({
          memberId: member as WorkspaceMemberId, workspaceId: id,
          userId: USER, role: "owner", createdAt: AT,
        });
      });
    }
  });

  // ── The precondition every other test depends on ───────────────────────────

  describe("runtime role", () => {
    it("is not superuser and cannot bypass RLS", async () => {
      const result = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
        select rolsuper, rolbypassrls from pg_roles where rolname = 'lagda_app'
      `.execute(owner.db);

      // If either were true, every assertion below would pass vacuously.
      expect(result.rows[0]?.rolsuper).toBe(false);
      expect(result.rows[0]?.rolbypassrls).toBe(false);
    });

    it("does not own the tenant tables", async () => {
      // An owner bypasses RLS unless FORCE is set. Not owning them is the
      // primary protection; FORCE is the backstop.
      const result = await sql<{ tableowner: string }>`
        select tableowner from pg_tables where tablename = 'workspace_memberships'
      `.execute(owner.db);
      expect(result.rows[0]?.tableowner).not.toBe("lagda_app");
    });

    it("has FORCE row level security enabled", async () => {
      const result = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`
        select relrowsecurity, relforcerowsecurity
        from pg_class where relname = 'workspace_memberships'
      `.execute(owner.db);
      expect(result.rows[0]?.relrowsecurity).toBe(true);
      expect(result.rows[0]?.relforcerowsecurity).toBe(true);
    });
  });

  // ── Reads ──────────────────────────────────────────────────────────────────

  describe("reads", () => {
    it("sees its own workspace's members", async () => {
      const tx = createTransactionManager(app.db);
      const rows = await tx.runForWorkspace(WS_A, uow => uow.memberships.list());
      expect(rows).toHaveLength(1);
    });

    it("CANNOT see another workspace's members, even asking for them by ID", async () => {
      // The attack: workspace A knows B's member ID and asks for it directly.
      const tx = createTransactionManager(app.db);
      // Note there is no way to even ASK for workspace B here: the unit of work
      // binds the scope, so the cross-tenant read is not expressible.
      const found = await tx.runForWorkspace(WS_A, uow =>
        uow.memberships.findMember("mem_b" as WorkspaceMemberId));
      expect(found).toBeNull();
    });

    it("CANNOT see another workspace's rows even with NO predicate at all", async () => {
      // The bug RLS exists to catch: a query that forgot its scope entirely.
      // Repository scoping cannot catch this, because the forgetting happens
      // in the repository.
            const rows = await withRawTenantTransaction(app, WS_A, trx =>
        trx.selectFrom("workspace_memberships").selectAll().execute());
      expect(rows).toHaveLength(1);
      expect(rows[0]?.workspace_id).toBe(WS_A);
    });
  });

  // ── Writes ─────────────────────────────────────────────────────────────────

  describe("writes", () => {
    it("CANNOT insert a row belonging to another workspace", async () => {
      // A policy with only USING would allow this. WITH CHECK is what stops it.
            const failure = await withRawTenantTransaction(app, WS_A, trx =>
        trx.insertInto("workspace_memberships").values({
          member_id: "mem_injected", workspace_id: WS_B,
          user_id: USER, role: "sender", created_at: new Date(AT),
        }).execute(),
      ).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(Error);
      expect(String((failure as Error).message)).toMatch(/row-level security/i);
    });

    it("CANNOT move its own row into another workspace", async () => {
      // Workspace ownership is immutable. Even if application code tried, the
      // policy's WITH CHECK rejects the new value.
            const failure = await withRawTenantTransaction(app, WS_A, trx =>
        trx.updateTable("workspace_memberships")
          .set({ workspace_id: WS_B })
          .where("member_id", "=", "mem_a")
          .execute(),
      ).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(Error);
      expect(String((failure as Error).message)).toMatch(/row-level security/i);
    });

    it("CANNOT update another workspace's row", async () => {
            const result = await withRawTenantTransaction(app, WS_A, trx =>
        trx.updateTable("workspace_memberships")
          .set({ role: "auditor" })
          .where("member_id", "=", "mem_b")
          .execute());

      // Invisible rather than forbidden: the row is not in scope, so zero rows
      // match. Nothing reveals that it exists elsewhere.
      expect(Number(result[0]?.numUpdatedRows ?? 0)).toBe(0);
    });

    it("CANNOT delete another workspace's row", async () => {
            const result = await withRawTenantTransaction(app, WS_A, trx =>
        trx.deleteFrom("workspace_memberships")
          .where("member_id", "=", "mem_b")
          .execute());
      expect(Number(result[0]?.numDeletedRows ?? 0)).toBe(0);

      const survived = await sql<{ count: string }>`
        select count(*)::text as count from workspace_memberships where member_id = 'mem_b'
      `.execute(owner.db);
      expect(survived.rows[0]?.count).toBe("1");
    });
  });

  // ── Fail closed ────────────────────────────────────────────────────────────

  describe("missing tenant context", () => {
    it("sees NOTHING rather than everything", async () => {
      // The most important default in the whole design. If missing context
      // meant "unrestricted", every bug that lost context would become a full
      // cross-tenant read.
      const rows = await withRawGlobalTransaction(app, trx =>
        trx.selectFrom("workspace_memberships").selectAll().execute());
      expect(rows).toHaveLength(0);
    });

    it("cannot insert tenant rows without context", async () => {
      const failure = await withRawGlobalTransaction(app, trx =>
        trx.insertInto("workspaces").values({
          workspace_id: "ws_sneaky", name: "Sneaky",
          created_at: new Date(AT),
        }).execute(),
      ).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);
    });
  });

  // ── Pooled connection safety ───────────────────────────────────────────────

  describe("context does not leak between transactions", () => {
    it("does not carry workspace B's context into workspace A", async () => {
      // The hazard that made BACKEND-06 defer RLS. Two transactions in sequence
      // on a small pool will share a physical connection; `SET LOCAL` must
      // disappear at COMMIT.
      
      const inB = await withRawTenantTransaction(app, WS_B, trx =>
        trx.selectFrom("workspace_memberships").selectAll().execute());
      expect(inB.map(r => r.workspace_id)).toEqual([WS_B]);

      const inA = await withRawTenantTransaction(app, WS_A, trx =>
        trx.selectFrom("workspace_memberships").selectAll().execute());
      expect(inA.map(r => r.workspace_id)).toEqual([WS_A]);

      // And a context-free transaction afterwards still sees nothing.
      const global = await withRawGlobalTransaction(app, trx =>
        trx.selectFrom("workspace_memberships").selectAll().execute());
      expect(global).toHaveLength(0);
    });

    it("does not survive a rolled-back transaction", async () => {
      // A failed B transaction must not contaminate the next A transaction.
      const tx = createTransactionManager(app.db);

      await expect(
        tx.runForWorkspace(WS_B, () => Promise.reject(new Error("boom"))),
      ).rejects.toThrow("boom");

      const global = await withRawGlobalTransaction(app, trx =>
        trx.selectFrom("workspace_memberships").selectAll().execute());
      expect(global).toHaveLength(0);
    });

    it("survives many alternating transactions on a shared pool", async () => {
      // Repetition matters: a leak that only appears once a connection is
      // reused would hide in a single-iteration test.
      for (let i = 0; i < 10; i++) {
        const target = i % 2 === 0 ? WS_A : WS_B;
        const rows = await withRawTenantTransaction(app, target, trx =>
          trx.selectFrom("workspace_memberships").selectAll().execute());
        expect(rows.map(r => r.workspace_id), `iteration ${String(i)}`).toEqual([target]);
      }
    });
  });

  // ── Relational integrity ───────────────────────────────────────────────────

  describe("cross-workspace relationships", () => {
    it("CANNOT attach a member to a workspace it does not belong to", async () => {
      // Even in the correct tenant context, the foreign key holds: the parent
      // workspace must exist. Compound FKs extend this to child tables in
      // BACKEND-08 onward.
            const failure = await withRawTenantTransaction(app, "ws_ghost" as WorkspaceId, trx =>
        trx.insertInto("workspace_memberships").values({
          member_id: "mem_ghost", workspace_id: "ws_ghost",
          user_id: USER, role: "owner", created_at: new Date(AT),
        }).execute(),
      ).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(Error);
    });
  });
});
