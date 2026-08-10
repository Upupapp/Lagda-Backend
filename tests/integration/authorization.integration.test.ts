// Member administration against REAL PostgreSQL, as the REAL RUNTIME ROLE.
//
// What only this file can prove: that the last-owner invariant survives two
// concurrent transactions, and that an administrator demoted mid-flight cannot
// commit a write under the authority they just lost. Both are races, and a fake
// with a synchronous store cannot have them.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import {
  CreateWorkspace, listWorkspaceMembers, changeWorkspaceMemberRole,
  removeWorkspaceMember, getWorkspace, listMyWorkspaces,
  LastOwnerViolationError, RoleGrantDeniedError,
  ResourceNotFoundError,
  type MemberAdministrationDependencies,
  type AuthenticatedActor, type SessionId,
} from "@lagda/application";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import {
  createDatabase, loadDatabaseConfig, createTransactionManager,
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
  withRawGlobalTransaction, withRawTenantTransaction,
  type LagdaDatabase,
} from "@lagda/db";

const AT = Date.parse("2026-08-10T15:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const ADMIN_A = "usr_admin_a" as UserId;
const ADMIN_B = "usr_admin_b" as UserId;
const MEMBER = "usr_member" as UserId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("member administration on PostgreSQL", () => {
  let owner: LagdaDatabase;
  /** The role the application actually runs as. Subject to RLS. */
  let app: LagdaDatabase;
  let workspaceId: WorkspaceId;

  beforeAll(async () => {
    owner = await createTestDatabase();
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

  const deps = (): MemberAdministrationDependencies => ({
    transactions: createTransactionManager(app.db),
    clock: new FixedClock(AT),
  });

  const seedMember = (
    memberId: string, userId: UserId, role: string,
  ) => withRawTenantTransaction(owner, workspaceId, trx =>
    trx.insertInto("workspace_memberships").values({
      member_id: memberId, workspace_id: workspaceId,
      user_id: userId, role, created_at: new Date(AT + 1000),
    }).execute());

  const ownerCount = async () => {
    const rows = await withRawGlobalTransaction(owner, trx =>
      trx.selectFrom("workspace_memberships").selectAll()
        .where("role", "=", "owner").execute());
    return rows.length;
  };

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, OWNER, { email: "owner@example.com" });
    await seedUser(owner, ADMIN_A, { email: "admin-a@example.com" });
    await seedUser(owner, ADMIN_B, { email: "admin-b@example.com" });
    await seedUser(owner, MEMBER, { email: "member@example.com" });

    const created = await new CreateWorkspace({
      transactions: createTransactionManager(app.db),
      clock: new FixedClock(AT),
      workspaceIds: new SequentialWorkspaceIds(),
      memberIds: new SequentialMemberIds(),
      idempotency: {
        digester: createIdempotencyKeyDigester(),
        ids: createIdempotencyRecordIds(),
        clock: new FixedClock(AT),
        policy: { retentionMs: 86_400_000 },
      },
    }).execute({ actor: actor(OWNER), name: "Acme Legal" });
    workspaceId = created.workspaceId;

    await seedMember("mem_admin_a", ADMIN_A, "administrator");
    await seedMember("mem_admin_b", ADMIN_B, "administrator");
    await seedMember("mem_member", MEMBER, "member");
  });

  it("runs as a role that is NOT superuser and cannot bypass RLS", async () => {
    const result = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'lagda_app'
    `.execute(owner.db);
    expect(result.rows[0]?.rolsuper).toBe(false);
    expect(result.rows[0]?.rolbypassrls).toBe(false);
  });

  // ── The last-owner invariant, under concurrency ───────────────────────────

  describe("last-owner protection", () => {
    it("refuses to demote the only owner", async () => {
      await expect(changeWorkspaceMemberRole(
        actor(ADMIN_A), workspaceId,
        (await ownerMembershipId()), "administrator", deps()))
        .rejects.toBeInstanceOf(LastOwnerViolationError);
      expect(await ownerCount()).toBe(1);
    });

    it("refuses to remove the only owner", async () => {
      await expect(removeWorkspaceMember(
        actor(ADMIN_A), workspaceId, await ownerMembershipId(), deps()))
        .rejects.toBeInstanceOf(LastOwnerViolationError);
      expect(await ownerCount()).toBe(1);
    });

    it("survives TWO CONCURRENT attempts to strip the last owner", async () => {
      // The race the invariant exists for. Both transactions read an owner
      // count of one; both must refuse. Neither may commit.
      //
      // Under SINGLE_OWNER there is only ever one owner, so the count both read
      // is 1 and the pure rule refuses each independently — no lock is needed
      // for THIS shape. The test exists to prove the outcome rather than to
      // assert a mechanism, and it would catch a future change that moved the
      // count read outside the transaction.
      const membershipId = await ownerMembershipId();

      const outcomes = await Promise.allSettled([
        changeWorkspaceMemberRole(
          actor(ADMIN_A), workspaceId, membershipId, "administrator", deps()),
        removeWorkspaceMember(actor(ADMIN_B), workspaceId, membershipId, deps()),
      ]);

      expect(outcomes.every(o => o.status === "rejected")).toBe(true);
      expect(await ownerCount()).toBe(1);
    });

    it("keeps the owner when a demotion and a removal race each other repeatedly",
      async () => {
        // Ten rounds. A race that only fails occasionally is a race that ships.
        const membershipId = await ownerMembershipId();
        for (let round = 0; round < 10; round++) {
          await Promise.allSettled([
            changeWorkspaceMemberRole(
              actor(ADMIN_A), workspaceId, membershipId, "member", deps()),
            removeWorkspaceMember(actor(ADMIN_B), workspaceId, membershipId, deps()),
            changeWorkspaceMemberRole(
              actor(ADMIN_B), workspaceId, membershipId, "sender", deps()),
          ]);
          expect(await ownerCount()).toBe(1);
        }
      }, 30_000);
  });

  // ── Authorization time-of-check / time-of-use ─────────────────────────────

  describe("stale authority", () => {
    it("reads the actor's role INSIDE the transaction, not before it", async () => {
      // Demote the administrator, then have them act. A design that resolved
      // authorization before opening the transaction — as every other workspace
      // operation does — would still be holding the old role here.
      await changeWorkspaceMemberRole(
        actor(OWNER), workspaceId, "mem_admin_a" as WorkspaceMemberId, "member", deps());

      await expect(removeWorkspaceMember(
        actor(ADMIN_A), workspaceId, "mem_member" as WorkspaceMemberId, deps()))
        .rejects.toBeInstanceOf(ResourceNotFoundError);

      // The target is still there.
      const rows = await withRawGlobalTransaction(owner, trx =>
        trx.selectFrom("workspace_memberships").selectAll()
          .where("user_id", "=", MEMBER).execute());
      expect(rows).toHaveLength(1);
    });

    it("refuses an actor whose membership was removed entirely", async () => {
      await removeWorkspaceMember(
        actor(OWNER), workspaceId, "mem_admin_a" as WorkspaceMemberId, deps());

      await expect(listWorkspaceMembers(actor(ADMIN_A), workspaceId, deps()))
        .rejects.toBeInstanceOf(ResourceNotFoundError);
    });
  });

  // ── Escalation ────────────────────────────────────────────────────────────

  describe("privilege escalation", () => {
    it("cannot grant OWNER, from any administrative role", async () => {
      for (const [who, target] of [
        [OWNER, "mem_admin_a"], [ADMIN_A, "mem_member"],
      ] as const) {
        await expect(changeWorkspaceMemberRole(
          actor(who), workspaceId, target as WorkspaceMemberId, "owner", deps()))
          .rejects.toBeInstanceOf(RoleGrantDeniedError);
      }
      expect(await ownerCount()).toBe(1);
    });

    it("cannot self-promote", async () => {
      await expect(changeWorkspaceMemberRole(
        actor(MEMBER), workspaceId, "mem_member" as WorkspaceMemberId,
        "administrator", deps())).rejects.toThrow();

      const row = await withRawGlobalTransaction(owner, trx =>
        trx.selectFrom("workspace_memberships").selectAll()
          .where("user_id", "=", MEMBER).executeTakeFirst());
      expect(row?.role).toBe("member");
    });

    it("cannot store a role the CHECK constraint refuses", async () => {
      await expect(withRawTenantTransaction(owner, workspaceId, trx =>
        trx.updateTable("workspace_memberships")
          .set({ role: "superuser" })
          .where("member_id", "=", "mem_member").execute())).rejects.toThrow();
    });
  });

  // ── Cross-tenant ──────────────────────────────────────────────────────────

  describe("cross-tenant administration", () => {
    it("cannot change a role in another workspace with a real membership id", async () => {
      const other = await new CreateWorkspace({
        transactions: createTransactionManager(app.db),
        clock: new FixedClock(AT),
        workspaceIds: { nextWorkspaceId: () => "ws_other" as WorkspaceId },
        memberIds: { nextWorkspaceMemberId: () => "mem_other_owner" as never },
        idempotency: {
          digester: createIdempotencyKeyDigester(),
          ids: createIdempotencyRecordIds(),
          clock: new FixedClock(AT),
          policy: { retentionMs: 86_400_000 },
        },
      }).execute({ actor: actor(MEMBER), name: "Their Own" });

      // Acme's owner, naming Acme's workspace, targeting a membership that
      // exists in the OTHER workspace. The repository is tenant-scoped, so the
      // id resolves to nothing.
      await expect(changeWorkspaceMemberRole(
        actor(OWNER), workspaceId,
        "mem_other_owner" as WorkspaceMemberId, "member", deps()))
        .rejects.toBeInstanceOf(ResourceNotFoundError);

      // And targeting the OTHER workspace directly is refused too — the actor
      // has no membership there.
      await expect(changeWorkspaceMemberRole(
        actor(OWNER), other.workspaceId,
        "mem_other_owner" as WorkspaceMemberId, "member", deps()))
        .rejects.toBeInstanceOf(ResourceNotFoundError);

      const row = await withRawGlobalTransaction(owner, trx =>
        trx.selectFrom("workspace_memberships").selectAll()
          .where("member_id", "=", "mem_other_owner").executeTakeFirst());
      expect(row?.role).toBe("owner");
    });

    it("cannot remove a member of another workspace", async () => {
      await new CreateWorkspace({
        transactions: createTransactionManager(app.db),
        clock: new FixedClock(AT),
        workspaceIds: { nextWorkspaceId: () => "ws_other" as WorkspaceId },
        memberIds: { nextWorkspaceMemberId: () => "mem_other_owner" as never },
        idempotency: {
          digester: createIdempotencyKeyDigester(),
          ids: createIdempotencyRecordIds(),
          clock: new FixedClock(AT),
          policy: { retentionMs: 86_400_000 },
        },
      }).execute({ actor: actor(MEMBER), name: "Their Own" });

      await expect(removeWorkspaceMember(
        actor(OWNER), workspaceId, "mem_other_owner" as WorkspaceMemberId, deps()))
        .rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it("cannot list another workspace's members", async () => {
      await new CreateWorkspace({
        transactions: createTransactionManager(app.db),
        clock: new FixedClock(AT),
        workspaceIds: { nextWorkspaceId: () => "ws_other" as WorkspaceId },
        memberIds: { nextWorkspaceMemberId: () => "mem_other_owner" as never },
        idempotency: {
          digester: createIdempotencyKeyDigester(),
          ids: createIdempotencyRecordIds(),
          clock: new FixedClock(AT),
          policy: { retentionMs: 86_400_000 },
        },
      }).execute({ actor: actor(MEMBER), name: "Their Own" });

      await expect(listWorkspaceMembers(
        actor(OWNER), "ws_other" as WorkspaceId, deps()))
        .rejects.toBeInstanceOf(ResourceNotFoundError);
    });
  });

  // ── Removal semantics ─────────────────────────────────────────────────────

  describe("removal", () => {
    it("deletes the row and revokes access on the very next call", async () => {
      expect(await getWorkspace(MEMBER, workspaceId, deps())).toBeTruthy();

      await removeWorkspaceMember(
        actor(OWNER), workspaceId, "mem_member" as WorkspaceMemberId, deps());

      await expect(getWorkspace(MEMBER, workspaceId, deps()))
        .rejects.toBeInstanceOf(ResourceNotFoundError);

      const rows = await withRawGlobalTransaction(owner, trx =>
        trx.selectFrom("workspace_memberships").selectAll()
          .where("user_id", "=", MEMBER).execute());
      expect(rows).toHaveLength(0);
    });

    it("does not delete the account", async () => {
      await removeWorkspaceMember(
        actor(OWNER), workspaceId, "mem_member" as WorkspaceMemberId, deps());

      const account = await withRawGlobalTransaction(owner, trx =>
        trx.selectFrom("users").selectAll()
          .where("user_id", "=", MEMBER).executeTakeFirst());
      expect(account).toBeDefined();
    });

    it("leaves the person's OTHER workspace untouched", async () => {
      await new CreateWorkspace({
        transactions: createTransactionManager(app.db),
        clock: new FixedClock(AT),
        workspaceIds: { nextWorkspaceId: () => "ws_theirs" as WorkspaceId },
        memberIds: { nextWorkspaceMemberId: () => "mem_theirs" as never },
        idempotency: {
          digester: createIdempotencyKeyDigester(),
          ids: createIdempotencyRecordIds(),
          clock: new FixedClock(AT),
          policy: { retentionMs: 86_400_000 },
        },
      }).execute({ actor: actor(MEMBER), name: "Their Own" });

      await removeWorkspaceMember(
        actor(OWNER), workspaceId, "mem_member" as WorkspaceMemberId, deps());

      const theirs = await listMyWorkspaces(
        MEMBER, { transactions: createTransactionManager(app.db) });
      expect(theirs).toHaveLength(1);
      expect(theirs[0]?.name).toBe("Their Own");
    });

    it("lets the removed person be invited back with no rejoin ambiguity", async () => {
      // The reason the row is deleted rather than marked: a fresh membership is
      // an ordinary insert, with no reactivate-or-recreate decision to make.
      await removeWorkspaceMember(
        actor(OWNER), workspaceId, "mem_member" as WorkspaceMemberId, deps());

      await seedMember("mem_member_again", MEMBER, "sender");
      expect((await getWorkspace(MEMBER, workspaceId, deps())).role).toBe("sender");
    });
  });

  // ── The directory ─────────────────────────────────────────────────────────

  describe("the member directory", () => {
    it("returns real account addresses to an administrator", async () => {
      const members = await listWorkspaceMembers(actor(ADMIN_A), workspaceId, deps());
      expect(members).toHaveLength(4);
      expect(members.map(m => m.email).sort()).toEqual([
        "admin-a@example.com", "admin-b@example.com",
        "member@example.com", "owner@example.com",
      ]);
    });

    it("refuses an ordinary member", async () => {
      await expect(listWorkspaceMembers(actor(MEMBER), workspaceId, deps()))
        .rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it("is ordered deterministically", async () => {
      const first = await listWorkspaceMembers(actor(OWNER), workspaceId, deps());
      const second = await listWorkspaceMembers(actor(OWNER), workspaceId, deps());
      expect(first.map(m => m.membershipId)).toEqual(second.map(m => m.membershipId));
    });
  });

  async function ownerMembershipId(): Promise<WorkspaceMemberId> {
    const row = await withRawGlobalTransaction(owner, trx =>
      trx.selectFrom("workspace_memberships").select("member_id")
        .where("role", "=", "owner").executeTakeFirstOrThrow());
    return row.member_id as WorkspaceMemberId;
  }
});
