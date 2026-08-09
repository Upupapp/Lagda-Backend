// Workspace lifecycle against REAL PostgreSQL, as the REAL RUNTIME ROLE.
//
// ── Why the role matters more than the assertions ──────────────────────────
//
// Every suite here connects as `lagda_app`, not as the database owner. An owner
// bypasses RLS unless FORCE is set, so a tenancy suite that connects as
// `postgres` passes while production leaks. The first test verifies the role
// genuinely cannot bypass, because every assertion after it depends on that
// being true (§91, §172).
//
// ── What only this file can prove ──────────────────────────────────────────
//
// Rollback, unique constraints, foreign keys, RLS policies, SQLSTATE codes and
// transaction-local settings. The unit suite exercises orchestration against a
// fake and cannot speak to any of them.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { UserId, WorkspaceId, WorkspaceMemberId, IdempotencyKey } from "@lagda/contracts";
import {
  CreateWorkspace, listMyWorkspaces, getWorkspace, updateWorkspace,
  resolveWorkspaceAccess,
  ResourceNotFoundError, IdempotencyConflictError,
  type CreateWorkspaceDependencies, type AuthenticatedActor, type SessionId,
} from "@lagda/application";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import {
  createDatabase, loadDatabaseConfig, createTransactionManager,
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
  withRawTenantTransaction, withRawGlobalTransaction,
  type LagdaDatabase,
} from "@lagda/db";

const AT = Date.parse("2026-08-09T10:00:00.000Z");
const ALICE = "usr_alice" as UserId;
const BOB = "usr_bob" as UserId;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("workspace lifecycle on PostgreSQL", () => {
  /** Owner connection. Fixtures and grants only. */
  let owner: LagdaDatabase;
  /** The role the application actually runs as. Subject to RLS. */
  let app: LagdaDatabase;

  beforeAll(async () => {
    owner = await createTestDatabase();
    await sql`alter role lagda_app with login password 'lagda_app_test'`.execute(owner.db);
    // The runtime role needs to read accounts to satisfy nothing here directly,
    // but the foreign key's referential check runs as the table owner, so no
    // grant on `users` is required — asserted below rather than assumed.
    const url = new URL(process.env["DATABASE_TEST_URL"] ?? "");
    url.username = "lagda_app";
    url.password = "lagda_app_test";
    app = createDatabase(loadDatabaseConfig({ DATABASE_URL: url.toString() }));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
  });

  /**
   * ONE generator per test, shared by every call within it.
   *
   * A fresh `SequentialWorkspaceIds` per use-case construction would hand every
   * workspace the id `ws_1`, and the second create in any test would collide on
   * the primary key. The production generator is random and long-lived for the
   * same reason.
   */
  let workspaceIds: SequentialWorkspaceIds;
  let memberIds: SequentialMemberIds;
  let recordIds: ReturnType<typeof createIdempotencyRecordIds>;

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, ALICE);
    await seedUser(owner, BOB);
    workspaceIds = new SequentialWorkspaceIds();
    memberIds = new SequentialMemberIds();
    recordIds = createIdempotencyRecordIds();
  });

  /** A use case wired to the RUNTIME role's connection. */
  function createWorkspace(over: Partial<CreateWorkspaceDependencies> = {}) {
    return new CreateWorkspace({
      transactions: createTransactionManager(app.db),
      clock: new FixedClock(AT),
      workspaceIds,
      memberIds,
      idempotency: {
        digester: createIdempotencyKeyDigester(),
        ids: recordIds,
        clock: new FixedClock(AT),
        policy: { retentionMs: 24 * 3_600_000 },
      },
      ...over,
    });
  }

  const deps = () => ({ transactions: createTransactionManager(app.db) });
  const actor = (userId: UserId): AuthenticatedActor =>
    ({ actorType: "user", userId, sessionId: "ses_fixture" as SessionId });

  // ── The precondition every other test depends on ──────────────────────────

  it("runs as a role that is NOT superuser and cannot bypass RLS", async () => {
    const result = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'lagda_app'
    `.execute(owner.db);

    // If either were true, every assertion below would pass vacuously.
    expect(result.rows[0]?.rolsuper).toBe(false);
    expect(result.rows[0]?.rolbypassrls).toBe(false);
  });

  // ── Creation ──────────────────────────────────────────────────────────────

  describe("creation", () => {
    it("commits the workspace and the owner membership together", async () => {
      const created = await createWorkspace()
        .execute({ actor: actor(ALICE), name: "Northbridge Legal" });

      const rows = await withRawTenantTransaction(owner, created.workspaceId, async trx => ({
        workspace: await trx.selectFrom("workspaces").selectAll()
          .where("workspace_id", "=", created.workspaceId).executeTakeFirst(),
        members: await trx.selectFrom("workspace_memberships").selectAll()
          .where("workspace_id", "=", created.workspaceId).execute(),
      }));

      expect(rows.workspace?.name).toBe("Northbridge Legal");
      expect(rows.members).toHaveLength(1);
      expect(rows.members[0]?.user_id).toBe(ALICE);
      expect(rows.members[0]?.role).toBe("owner");
    });

    it("leaves NEITHER row when the membership insert fails", async () => {
      // §151, and the most important test in this file. A committed workspace
      // with no membership is an inaccessible orphan: no endpoint could reach
      // it again, and there is no deletion endpoint to remove it.
      //
      // The failure is forced with a membership whose user does not exist, so
      // PostgreSQL's own foreign key raises it — not a stub, and not a throw the
      // application chose to perform.
      const transactions = createTransactionManager(app.db);
      const workspaceId = "ws_orphan_probe" as WorkspaceId;

      await expect(
        transactions.runForWorkspace(workspaceId, async uow => {
          await uow.workspaces.insert({ workspaceId, name: "Doomed", createdAt: AT });
          await uow.memberships.insert({
            memberId: "mem_orphan" as WorkspaceMemberId,
            workspaceId,
            userId: "usr_does_not_exist" as UserId,
            role: "owner",
            createdAt: AT,
          });
        }),
      ).rejects.toThrow();

      const survivors = await withRawGlobalTransaction(owner, trx =>
        trx.selectFrom("workspaces").selectAll()
          .where("workspace_id", "=", workspaceId).execute());
      expect(survivors).toHaveLength(0);
    });

    it("refuses a membership for an account that does not exist", async () => {
      // The foreign key added by migration 013. Without it, a membership can
      // name a user nobody can authenticate as — a row that authorizes nobody.
      await expect(
        createTransactionManager(app.db).runForWorkspace(
          "ws_fk_probe" as WorkspaceId, async uow => {
            await uow.workspaces.insert({
              workspaceId: "ws_fk_probe" as WorkspaceId, name: "FK", createdAt: AT,
            });
            await uow.memberships.insert({
              memberId: "mem_fk" as WorkspaceMemberId,
              workspaceId: "ws_fk_probe" as WorkspaceId,
              userId: "usr_ghost" as UserId, role: "owner", createdAt: AT,
            });
          }),
      ).rejects.toThrow();
    });

    it("refuses a DUPLICATE membership for one user in one workspace", async () => {
      const created = await createWorkspace().execute({ actor: actor(ALICE), name: "Acme" });

      await expect(
        createTransactionManager(app.db).runForWorkspace(created.workspaceId, uow =>
          uow.memberships.insert({
            memberId: "mem_second" as WorkspaceMemberId,
            workspaceId: created.workspaceId,
            userId: ALICE, role: "owner", createdAt: AT,
          })),
      ).rejects.toThrow();
    });

    it("does not have an owner_user_id column any more", async () => {
      // Membership is the single authority (§12). A denormalized owner would be
      // a second one that an ownership transfer could leave disagreeing.
      const columns = await sql<{ column_name: string }>`
        select column_name from information_schema.columns
        where table_name = 'workspaces'
      `.execute(owner.db);

      expect(columns.rows.map(r => r.column_name).sort())
        .toEqual(["created_at", "name", "workspace_id"]);
    });

    it("lets two different users create workspaces with the SAME name", async () => {
      // §8, §154. A global unique constraint would tell every customer which
      // names their competitors had taken.
      const a = await createWorkspace().execute({ actor: actor(ALICE), name: "Legal" });
      const b = await createWorkspace().execute({ actor: actor(BOB), name: "Legal" });
      expect(a.workspaceId).not.toBe(b.workspaceId);
    });

    it("lets ONE user hold several independent memberships", async () => {
      // §153. A global account, several tenants. Never a user duplicated per
      // workspace.
      const first = await createWorkspace().execute({ actor: actor(ALICE), name: "One" });
      const second = await createWorkspace().execute({ actor: actor(ALICE), name: "Two" });

      const mine = await listMyWorkspaces(ALICE, deps());
      expect(mine.map(w => w.workspaceId).sort())
        .toEqual([first.workspaceId, second.workspaceId].sort());

      const accounts = await withRawGlobalTransaction(owner, trx =>
        trx.selectFrom("users").selectAll().where("user_id", "=", ALICE).execute());
      expect(accounts).toHaveLength(1);
    });
  });

  // ── Idempotency, durably ──────────────────────────────────────────────────

  describe("idempotent creation", () => {
    it("creates exactly ONE workspace and ONE membership for a retried request", async () => {
      const useCase = createWorkspace();
      const key = "durable-key-00001" as IdempotencyKey;

      const first = await useCase.execute({
        actor: actor(ALICE), name: "Acme", idempotencyKey: key,
      });
      const second = await useCase.execute({
        actor: actor(ALICE), name: "Acme", idempotencyKey: key,
      });

      expect(second.workspaceId).toBe(first.workspaceId);

      const all = await withRawGlobalTransaction(owner, async trx => ({
        workspaces: await trx.selectFrom("workspaces").selectAll().execute(),
        members: await trx.selectFrom("workspace_memberships").selectAll().execute(),
      }));
      expect(all.workspaces).toHaveLength(1);
      expect(all.members).toHaveLength(1);
    });

    it("does not create a second tenant under CONCURRENT identical retries", async () => {
      // §166. Two requests in flight at once: the second blocks on the unique
      // index rather than both proceeding.
      const useCase = createWorkspace();
      const key = "concurrent-key-001" as IdempotencyKey;

      const outcomes = await Promise.allSettled([
        useCase.execute({ actor: actor(ALICE), name: "Acme", idempotencyKey: key }),
        useCase.execute({ actor: actor(ALICE), name: "Acme", idempotencyKey: key }),
      ]);

      const workspaces = await withRawGlobalTransaction(owner, trx =>
        trx.selectFrom("workspaces").selectAll().execute());

      expect(workspaces).toHaveLength(1);
      // At least one succeeded. The other either replayed or was refused as
      // in-progress; both are correct, and neither created a tenant.
      expect(outcomes.some(o => o.status === "fulfilled")).toBe(true);
    });

    it("REFUSES a reused key with a different name and creates nothing", async () => {
      const useCase = createWorkspace();
      const key = "conflict-key-00001" as IdempotencyKey;

      await useCase.execute({ actor: actor(ALICE), name: "Acme", idempotencyKey: key });
      await expect(
        useCase.execute({ actor: actor(ALICE), name: "Other", idempotencyKey: key }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);

      const workspaces = await withRawGlobalTransaction(owner, trx =>
        trx.selectFrom("workspaces").selectAll().execute());
      expect(workspaces).toHaveLength(1);
    });

    it("frees the key when the transaction ROLLS BACK", async () => {
      // The property that makes a failed attempt retryable without a lease and
      // without a recovery job: the claim row dies with the transaction, so the
      // key is not poisoned.
      //
      // The failure is real — a duplicate member id violates the primary key
      // inside the same transaction that wrote the claim. Nothing is stubbed.
      const first = await createWorkspace().execute({ actor: actor(ALICE), name: "First" });
      const collidingMemberId = await withRawTenantTransaction(owner, first.workspaceId, trx =>
        trx.selectFrom("workspace_memberships").select("member_id")
          .where("workspace_id", "=", first.workspaceId).executeTakeFirstOrThrow());

      const key = "rollback-key-00001" as IdempotencyKey;
      const doomed = createWorkspace({
        memberIds: {
          nextWorkspaceMemberId: () =>
            collidingMemberId.member_id as WorkspaceMemberId,
        },
      });

      await expect(
        doomed.execute({ actor: actor(ALICE), name: "Doomed", idempotencyKey: key }),
      ).rejects.toThrow();

      // No poisoned key and no orphan: the same key executes cleanly now.
      const retried = await createWorkspace()
        .execute({ actor: actor(ALICE), name: "Doomed", idempotencyKey: key });
      expect(retried.name).toBe("Doomed");

      const workspaces = await withRawGlobalTransaction(owner, trx =>
        trx.selectFrom("workspaces").selectAll().execute());
      // The first workspace and the successful retry. The doomed attempt left
      // nothing behind.
      expect(workspaces).toHaveLength(2);
    });
  });

  // ── Listing, under RLS ────────────────────────────────────────────────────

  describe("listing my workspaces", () => {
    it("returns only the caller's own, under the runtime role", async () => {
      // §155. Alice is in A and C, Bob in B. Alice's list is A and C, and the
      // filtering happens in SQL and in RLS — not in application memory.
      const a = await createWorkspace().execute({ actor: actor(ALICE), name: "A" });
      await createWorkspace().execute({ actor: actor(BOB), name: "B" });
      const c = await createWorkspace().execute({ actor: actor(ALICE), name: "C" });

      const mine = await listMyWorkspaces(ALICE, deps());
      expect(mine.map(w => w.workspaceId).sort())
        .toEqual([a.workspaceId, c.workspaceId].sort());
    });

    it("cannot see another user's memberships even with a raw query", async () => {
      // §174. The application predicate is removed and only the POLICY is left.
      // A `SELECT *` with no WHERE clause is exactly the query production cannot
      // write, which is why it is the one worth running here.
      await createWorkspace().execute({ actor: actor(ALICE), name: "Alice only" });
      await createWorkspace().execute({ actor: actor(BOB), name: "Bob only" });

      const rows = await app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.user_id', ${ALICE}, true)`.execute(trx);
        return trx.selectFrom("workspace_memberships").selectAll().execute();
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBe(ALICE);
    });

    it("sees NOTHING with no user context and no tenant context", async () => {
      // Fail-closed. A missing setting yields NULL, and the policy matches
      // nothing rather than everything.
      await createWorkspace().execute({ actor: actor(ALICE), name: "Hidden" });

      const rows = await app.db.transaction().execute(trx =>
        trx.selectFrom("workspaces").selectAll().execute());
      expect(rows).toHaveLength(0);
    });

    it("CANNOT write from a user-scoped transaction", async () => {
      // §88. The user-scoped policies are FOR SELECT, so no policy permits a
      // write in this scope. PostgreSQL expresses that two ways and both are
      // asserted, because only one of them is an error:
      //
      //   UPDATE  no permitting policy means no row is visible to update, so it
      //           affects ZERO rows silently. A test asserting a throw would
      //           pass for the wrong reason if a policy were later widened.
      //   INSERT  WITH CHECK has nothing to satisfy, so it RAISES.
      const created = await createWorkspace().execute({ actor: actor(ALICE), name: "Acme" });

      const affected = await app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.user_id', ${ALICE}, true)`.execute(trx);
        const result = await trx.updateTable("workspaces").set({ name: "Rewritten" })
          .where("workspace_id", "=", created.workspaceId).executeTakeFirst();
        return Number(result.numUpdatedRows);
      });
      expect(affected).toBe(0);

      await expect(
        app.db.transaction().execute(async trx => {
          await sql`select set_config('lagda.user_id', ${ALICE}, true)`.execute(trx);
          await trx.insertInto("workspaces").values({
            workspace_id: "ws_smuggled", name: "Smuggled", created_at: new Date(AT),
          }).execute();
        }),
      ).rejects.toThrow();

      const after = await getWorkspace(ALICE, created.workspaceId, deps());
      expect(after.name).toBe("Acme");
    });

    it("does not leak user context into the next pooled transaction", async () => {
      // §175. `SET LOCAL` dies at COMMIT. A session-level SET would ride the
      // connection into the next request, and this is the assertion that would
      // catch it.
      await createWorkspace().execute({ actor: actor(ALICE), name: "Acme" });
      await listMyWorkspaces(ALICE, deps());

      const leaked = await app.db.transaction().execute(trx =>
        trx.selectFrom("workspace_memberships").selectAll().execute());
      expect(leaked).toHaveLength(0);
    });
  });

  // ── Cross-tenant access ───────────────────────────────────────────────────

  describe("cross-tenant access", () => {
    it("HIDES another tenant's workspace behind not-found", async () => {
      const theirs = await createWorkspace().execute({ actor: actor(BOB), name: "Bob Legal" });
      await expect(getWorkspace(ALICE, theirs.workspaceId, deps()))
        .rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it("resolves no access for a workspace the caller is not in", async () => {
      const theirs = await createWorkspace().execute({ actor: actor(BOB), name: "Bob Legal" });
      expect(await resolveWorkspaceAccess(ALICE, theirs.workspaceId, deps())).toBeNull();
    });

    it("refuses a cross-tenant RENAME and leaves the name alone", async () => {
      const theirs = await createWorkspace().execute({ actor: actor(BOB), name: "Bob Legal" });

      await expect(updateWorkspace(ALICE, theirs.workspaceId, { name: "Hijacked" }, deps()))
        .rejects.toBeInstanceOf(ResourceNotFoundError);

      expect((await getWorkspace(BOB, theirs.workspaceId, deps())).name).toBe("Bob Legal");
    });

    it("cannot read another tenant's rows with tenant context set to a foreign id", async () => {
      // §173. Knowing an ID is not access: tenant context only ever RESTRICTS.
      // A transaction bound to Bob's workspace still cannot produce Alice's rows.
      const alice = await createWorkspace().execute({ actor: actor(ALICE), name: "Alice" });
      const bob = await createWorkspace().execute({ actor: actor(BOB), name: "Bob" });

      const seen = await withRawTenantTransaction(app, bob.workspaceId, trx =>
        trx.selectFrom("workspaces").selectAll().execute());

      expect(seen.map(r => r.workspace_id)).toEqual([bob.workspaceId]);
      expect(seen.map(r => r.workspace_id)).not.toContain(alice.workspaceId);
    });
  });

  // ── Membership is the authorization, and it is live ───────────────────────

  describe("membership authorization", () => {
    it("takes effect IMMEDIATELY when a membership is removed — no re-login", async () => {
      // §115, §177. Nothing about workspace authorization lives in the session
      // credential, so a membership change needs no new session to apply.
      const created = await createWorkspace().execute({ actor: actor(ALICE), name: "Acme" });
      expect((await getWorkspace(ALICE, created.workspaceId, deps())).name).toBe("Acme");

      await withRawTenantTransaction(owner, created.workspaceId, trx =>
        trx.deleteFrom("workspace_memberships")
          .where("workspace_id", "=", created.workspaceId).execute());

      // The very next call is refused. No cache, no session refresh, no delay.
      await expect(getWorkspace(ALICE, created.workspaceId, deps()))
        .rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it("refuses a member who is not an owner the rename, but not the read", async () => {
      const created = await createWorkspace().execute({ actor: actor(ALICE), name: "Acme" });

      await withRawTenantTransaction(owner, created.workspaceId, trx =>
        trx.insertInto("workspace_memberships").values({
          member_id: "mem_reviewer", workspace_id: created.workspaceId,
          user_id: BOB, role: "reviewer", created_at: new Date(AT),
        }).execute());

      expect((await getWorkspace(BOB, created.workspaceId, deps())).role).toBe("reviewer");
      await expect(updateWorkspace(BOB, created.workspaceId, { name: "Nope" }, deps()))
        .rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it("stores only roles the CHECK constraint allows", async () => {
      const created = await createWorkspace().execute({ actor: actor(ALICE), name: "Acme" });
      await expect(
        withRawTenantTransaction(owner, created.workspaceId, trx =>
          trx.insertInto("workspace_memberships").values({
            member_id: "mem_bogus", workspace_id: created.workspaceId,
            user_id: BOB, role: "SYSTEM_ADMIN", created_at: new Date(AT),
          }).execute()),
      ).rejects.toThrow();
    });
  });

  // ── Rename ────────────────────────────────────────────────────────────────

  describe("rename", () => {
    it("changes the name and nothing else", async () => {
      const created = await createWorkspace().execute({ actor: actor(ALICE), name: "Acme" });
      const result = await updateWorkspace(
        ALICE, created.workspaceId, { name: "Acme Legal" }, deps());

      expect(result.outcome).toBe("updated");

      const row = await withRawTenantTransaction(owner, created.workspaceId, trx =>
        trx.selectFrom("workspaces").selectAll()
          .where("workspace_id", "=", created.workspaceId).executeTakeFirst());

      expect(row?.name).toBe("Acme Legal");
      // §5, §191. A rename does not mint a new tenant identity, and it does not
      // rewrite when the workspace came into existence — the stable id is what
      // future signing evidence references.
      expect(row?.workspace_id).toBe(created.workspaceId);
      expect(row?.created_at.getTime()).toBe(AT);
    });

    it("keeps every membership intact", async () => {
      const created = await createWorkspace().execute({ actor: actor(ALICE), name: "Acme" });
      await updateWorkspace(ALICE, created.workspaceId, { name: "Renamed" }, deps());

      const members = await withRawTenantTransaction(owner, created.workspaceId, trx =>
        trx.selectFrom("workspace_memberships").selectAll().execute());
      expect(members).toHaveLength(1);
      expect(members[0]?.user_id).toBe(ALICE);
    });

    it("refuses a blank name at the database as well as in the domain", async () => {
      // Defence in depth: the domain rejects it, and the CHECK constraint means
      // a future code path that skipped validation still could not store one.
      const created = await createWorkspace().execute({ actor: actor(ALICE), name: "Acme" });
      await expect(
        withRawTenantTransaction(owner, created.workspaceId, trx =>
          trx.updateTable("workspaces").set({ name: "   " })
            .where("workspace_id", "=", created.workspaceId).execute()),
      ).rejects.toThrow();
    });
  });

  // ── Lifecycle absences ────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("has no archived_at, lifecycle_state, deleted_at or status column", async () => {
      // §133, §183. ACTIVE is the only state a workspace has, and there is no
      // column implying otherwise.
      const columns = await sql<{ column_name: string }>`
        select column_name from information_schema.columns
        where table_name = 'workspaces'
      `.execute(owner.db);
      const names = columns.rows.map(r => r.column_name);

      for (const absent of ["archived_at", "deleted_at", "lifecycle_state", "status"]) {
        expect(names).not.toContain(absent);
      }
    });

    it("cannot delete a workspace that still has members", async () => {
      // ON DELETE RESTRICT, both directions. Deleting a tenant must not silently
      // erase who belonged to it — retention is unresolved until BACKEND-55.
      const created = await createWorkspace().execute({ actor: actor(ALICE), name: "Acme" });
      await expect(
        withRawGlobalTransaction(owner, trx =>
          trx.deleteFrom("workspaces")
            .where("workspace_id", "=", created.workspaceId).execute()),
      ).rejects.toThrow();
    });

    it("cannot delete an account that still holds a membership", async () => {
      const created = await createWorkspace().execute({ actor: actor(ALICE), name: "Acme" });
      void created;
      await expect(
        withRawGlobalTransaction(owner, trx =>
          trx.deleteFrom("users").where("user_id", "=", ALICE).execute()),
      ).rejects.toThrow();
    });
  });
});
