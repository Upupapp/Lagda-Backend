// Personal-feed read / dismissed state (090) on real PostgreSQL, as the
// runtime role.
//
// What only this suite can prove:
//
//   1. The grants: select/insert/update for `lagda_app`, and NO delete or
//      truncate — refused by the database, not merely unused.
//   2. Only the caller's OWN notices take a state: another account's notice,
//      a recipient-audience row and an invented id write nothing, through the
//      INSERT ... SELECT inside the account's realm (087's audience policy).
//   3. The feed reflects it: `read` / `dismissed` per account, dismissed
//      hidden unless asked for, and a repeated change is idempotent.
//   4. The migration goes down and back up.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { UserId, WorkspaceId } from "@lagda/contracts";
import type { LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import { createNotificationFeedRepository } from "./repositories/notification-feed.js";
import { migrateDown, migrateToLatest, migrationStatus } from "./migrations/runner.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll,
  hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-09-28T09:00:00.000Z");
const WS = "ws_ntf_state" as WorkspaceId;
const ME = "usr_ntf_me" as UserId;
const OTHER = "usr_ntf_other" as UserId;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("user notification states (runtime role)", () => {
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

  /** A USER-audience notice, written as the superuser (fixture only). */
  async function notice(id: string, audience: UserId, offsetMs: number): Promise<void> {
    await sql`
      insert into notification_intents (
        notification_intent_id, workspace_id, notification_type,
        source_kind, source_id, audience_kind, audience_user_id,
        template_key, template_version, locale, template_input, created_at
      ) values (
        ${id}, ${WS}, 'SIGNING_COMPLETED',
        'SIGNING_REQUEST', ${`src_${id}`}, 'USER', ${audience},
        'signing-completed', 1, 'en', ${"{}"}, ${new Date(AT + offsetMs)}
      )
    `.execute(owner.db);
  }

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, ME);
    await seedUser(owner, OTHER);
    await createTransactionManager(owner.db).runForWorkspace(WS, uow =>
      uow.workspaces.insert({ workspaceId: WS, name: "Firm", createdAt: AT }));
    await notice("nti_mine_1", ME, 1_000);
    await notice("nti_mine_2", ME, 2_000);
    await notice("nti_other", OTHER, 3_000);
  });

  const feed = () => createNotificationFeedRepository(app.db);
  const states = () => owner.db.selectFrom("user_notification_states")
    .select(["user_id", "notification_intent_id", "read_at", "dismissed_at"])
    .orderBy("notification_intent_id").execute();

  describe("the table", () => {
    it("grants select, insert and update to lagda_app, and never delete or truncate", async () => {
      const privileges = await sql<{ privilege: string; granted: boolean }>`
        select p.privilege, has_table_privilege('lagda_app', 'user_notification_states', p.privilege) as granted
        from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(privilege)
      `.execute(owner.db);
      expect(Object.fromEntries(privileges.rows.map(r => [r.privilege, r.granted]))).toEqual({
        SELECT: true, INSERT: true, UPDATE: true, DELETE: false, TRUNCATE: false,
      });
    });

    it("refuses the runtime role a DELETE or TRUNCATE", async () => {
      await feed().setStates(ME, ["nti_mine_1"], { read: true });
      await expect(sql`delete from user_notification_states`.execute(app.db))
        .rejects.toThrow(/permission denied/);
      await expect(sql`truncate user_notification_states`.execute(app.db))
        .rejects.toThrow(/permission denied/);
    });

    it("carries no foreign key to notification_intents (see the migration)", async () => {
      const fks = await sql<{ target: string }>`
        select confrelid::regclass::text as target from pg_constraint
         where conrelid = 'user_notification_states'::regclass and contype = 'f'
      `.execute(owner.db);
      expect(fks.rows.map(r => r.target)).toEqual(["users"]);
    });
  });

  describe("setStates", () => {
    it("writes only the caller's own notices; foreign and invented ids are skipped", async () => {
      const updated = await feed().setStates(ME, ["nti_mine_1", "nti_other", "nti_nope"], { read: true });
      expect(updated).toBe(1);
      const rows = await states();
      expect(rows.map(r => [r.user_id, r.notification_intent_id])).toEqual([[ME, "nti_mine_1"]]);
      expect(rows[0]?.read_at).toBeInstanceOf(Date);
      expect(rows[0]?.dismissed_at).toBeNull();
    });

    it("cannot reach another account's notice even by naming it", async () => {
      expect(await feed().setStates(ME, ["nti_other"], { dismissed: true })).toBe(0);
      expect(await states()).toEqual([]);
      const theirs = await feed().listForUser(OTHER, 50);
      expect(theirs.map(n => [n.notificationIntentId, n.dismissedAt])).toEqual([["nti_other", null]]);
    });

    it("is idempotent: a repeated mark-read keeps the first read time", async () => {
      await feed().setStates(ME, ["nti_mine_1"], { read: true });
      const first = (await states())[0]?.read_at;
      await new Promise(resolve => setTimeout(resolve, 20));
      await feed().setStates(ME, ["nti_mine_1", "nti_mine_1"], { read: true });
      const rows = await states();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.read_at?.getTime()).toBe(first?.getTime());
    });

    it("changes one flag without touching the other, and clears with false", async () => {
      await feed().setStates(ME, ["nti_mine_1"], { read: true });
      await feed().setStates(ME, ["nti_mine_1"], { dismissed: true });
      let row = (await states())[0];
      expect(row?.read_at).not.toBeNull();
      expect(row?.dismissed_at).not.toBeNull();
      await feed().setStates(ME, ["nti_mine_1"], { dismissed: false });
      row = (await states())[0];
      expect(row?.read_at).not.toBeNull();
      expect(row?.dismissed_at).toBeNull();
      await feed().setStates(ME, ["nti_mine_1"], { read: false });
      expect((await states())[0]?.read_at).toBeNull();
    });
  });

  describe("the feed", () => {
    it("reports read and dismissed per account, and hides dismissed unless asked", async () => {
      await feed().setStates(ME, ["nti_mine_1"], { read: true });
      await feed().setStates(ME, ["nti_mine_2"], { dismissed: true });

      const all = await feed().listForUser(ME, 50, { includeDismissed: true });
      expect(all.map(n => [n.notificationIntentId, n.readAt !== null, n.dismissedAt !== null])).toEqual([
        ["nti_mine_2", false, true],
        ["nti_mine_1", true, false],
      ]);

      const visible = await feed().listForUser(ME, 50, { includeDismissed: false });
      expect(visible.map(n => n.notificationIntentId)).toEqual(["nti_mine_1"]);

      // A restore brings it back.
      await feed().setStates(ME, ["nti_mine_2"], { dismissed: false });
      expect((await feed().listForUser(ME, 50, { includeDismissed: false })).map(n => n.notificationIntentId))
        .toEqual(["nti_mine_2", "nti_mine_1"]);
    });

    it("hides dismissed rows before the limit, so a page is never shortened", async () => {
      await feed().setStates(ME, ["nti_mine_2"], { dismissed: true });
      const page = await feed().listForUser(ME, 1, { includeDismissed: false });
      expect(page.map(n => n.notificationIntentId)).toEqual(["nti_mine_1"]);
    });
  });

  it("goes down when empty and back up", async () => {
    await truncateAll(owner);
    // 091 sits above 090 and comes off first; it is empty here.
    const later = await migrateDown(owner.db);
    expect(later.error).toBeUndefined();
    expect(later.applied).toEqual(["091_contact_connections"]);
    const down = await migrateDown(owner.db);
    expect(down.error).toBeUndefined();
    expect(down.applied).toEqual(["090_user_notification_states"]);
    const gone = await sql<{ n: string }>`
      select count(*)::text as n from pg_tables where tablename = 'user_notification_states'
    `.execute(owner.db);
    expect(gone.rows[0]?.n).toBe("0");
    const up = await migrateToLatest(owner.db);
    expect(up.error).toBeUndefined();
    expect((await migrationStatus(owner.db)).every(s => s.applied)).toBe(true);
  });
});
