// The activity log (079) against REAL PostgreSQL, as the REAL RUNTIME ROLE.
//
// What only this file can prove: the runtime role can append but never edit
// or delete history, another workspace's log is invisible, an entry commits
// with its change or not at all, and the cursor pages the real index.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { UserId, WorkspaceId } from "@lagda/contracts";
import {
  CreateWorkspace, updateWorkspace, listWorkspaceActivity, recordActivity,
  type AuthenticatedActor, type SessionId,
} from "@lagda/application";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import {
  createDatabase, loadDatabaseConfig, createTransactionManager,
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
  withRawGlobalTransaction,
  type LagdaDatabase,
} from "@lagda/db";

const AT = Date.parse("2026-09-26T09:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const OTHER_OWNER = "usr_other_owner" as UserId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("workspace activity log on PostgreSQL", () => {
  let owner: LagdaDatabase;
  let app: LagdaDatabase;

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

  let workspaceId: WorkspaceId;
  let otherWorkspaceId: WorkspaceId;

  const create = (userId: UserId, name: string, ids: SequentialWorkspaceIds) => new CreateWorkspace({
    transactions: createTransactionManager(app.db), clock: new FixedClock(AT),
    workspaceIds: ids, memberIds: new SequentialMemberIds(),
    idempotency: {
      digester: createIdempotencyKeyDigester(), ids: createIdempotencyRecordIds(),
      clock: new FixedClock(AT), policy: { retentionMs: 86_400_000 },
    },
  }).execute({ actor: actor(userId), name });

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, OWNER, { email: "owner@example.com" });
    await seedUser(owner, OTHER_OWNER, { email: "other@example.com" });
    const ids = new SequentialWorkspaceIds();
    workspaceId = (await create(OWNER, "Acme Legal", ids)).workspaceId;
    await withRawGlobalTransaction(owner, trx => trx.updateTable("workspace_memberships")
      .set({ member_id: "mem_first_owner" }).where("workspace_id", "=", workspaceId).execute());
    otherWorkspaceId = (await create(OTHER_OWNER, "Other Firm", ids)).workspaceId;
  });

  const rows = () => withRawGlobalTransaction(owner, trx =>
    trx.selectFrom("workspace_activity_events").selectAll().orderBy("occurred_at").execute());

  it("records creation and rename with the change, as the runtime role", async () => {
    const transactions = createTransactionManager(app.db);
    await updateWorkspace(OWNER, workspaceId, { name: "Acme Law" }, { transactions, clock: new FixedClock(AT + 1) });
    const mine = (await rows()).filter(r => r.workspace_id === workspaceId);
    expect(mine.map(r => r.action)).toEqual(["workspace.created", "workspace.renamed"]);
    expect(mine[1]?.details).toMatchObject({ from: "Acme Legal", to: "Acme Law", actorName: OWNER });
  });

  it("never lets the runtime role edit or delete history", async () => {
    await expect(app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.workspace_id', ${workspaceId}, true)`.execute(trx);
      await trx.updateTable("workspace_activity_events").set({ action: "workspace.renamed" }).execute();
    })).rejects.toThrow(/permission denied/);
    await expect(app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.workspace_id', ${workspaceId}, true)`.execute(trx);
      await trx.deleteFrom("workspace_activity_events").execute();
    })).rejects.toThrow(/permission denied/);
    expect(await rows()).toHaveLength(2);
  });

  it("stays append-only when the runtime role OWNS the table, as in production (080)", async () => {
    // Production migrates as lagda_app, which makes it the owner, and an owner
    // holds every privilege until one is revoked. Reproduce that, re-apply
    // 080, and prove the runtime role still cannot edit or delete.
    const { up } = await import("../../packages/db/src/migrations/080_workspace_activity_append_only.js");
    const tableOwner = await sql<{ owner: string }>`
      select tableowner as owner from pg_tables where tablename = 'workspace_activity_events'`.execute(owner.db);
    const original = tableOwner.rows[0]?.owner ?? "";
    await sql`alter table workspace_activity_events owner to lagda_app`.execute(owner.db);
    try {
      await up(owner.db as never);
      // Still able to do its job: append and read.
      await expect(listWorkspaceActivity(actor(OWNER), workspaceId, {},
        { transactions: createTransactionManager(app.db) })).resolves.toBeTruthy();
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${workspaceId}, true)`.execute(trx);
        await trx.updateTable("workspace_activity_events").set({ action: "workspace.renamed" }).execute();
      })).rejects.toThrow(/permission denied/);
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${workspaceId}, true)`.execute(trx);
        await trx.deleteFrom("workspace_activity_events").execute();
      })).rejects.toThrow(/permission denied/);
    } finally {
      // Handing ownership back takes the owner's privileges with it; restore
      // 079's grants so the rest of the suite runs against the normal state.
      await sql`alter table workspace_activity_events owner to ${sql.id(original)}`.execute(owner.db);
      await sql`grant select, insert on workspace_activity_events to lagda_app`.execute(owner.db);
    }
  });

  it("shows one workspace's log to that workspace only", async () => {
    const page = await listWorkspaceActivity(actor(OWNER), workspaceId, {},
      { transactions: createTransactionManager(app.db) });
    expect(page.events.map(e => e.summary)).toEqual(["usr_owner created the workspace “Acme Legal”"]);
    await expect(listWorkspaceActivity(actor(OWNER), otherWorkspaceId, {},
      { transactions: createTransactionManager(app.db) })).rejects.toThrow();
  });

  it("rolls the entry back with a change that fails", async () => {
    const transactions = createTransactionManager(app.db);
    await expect(transactions.runForWorkspace(workspaceId, async uow => {
      await recordActivity(uow, { action: "workspace.renamed", actorUserId: OWNER, occurredAt: AT, details: { from: "a", to: "b" } });
      throw new Error("the change failed");
    })).rejects.toThrow("the change failed");
    expect((await rows()).filter(r => r.workspace_id === workspaceId)).toHaveLength(1);
  });

  it("pages newest-first through the real index without gaps or repeats", async () => {
    const transactions = createTransactionManager(app.db);
    for (let i = 1; i <= 7; i++) {
      await updateWorkspace(OWNER, workspaceId, { name: `Acme ${String(i)}` },
        { transactions, clock: new FixedClock(AT + i * 1000) });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listWorkspaceActivity(actor(OWNER), workspaceId, { limit: 3, cursor }, { transactions });
      seen.push(...page.events.map(e => e.eventId));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
    const renamed = await listWorkspaceActivity(actor(OWNER), workspaceId, { category: "workspace", limit: 1 }, { transactions });
    expect(renamed.events[0]?.summary).toContain("to “Acme 7”");
  });
});
