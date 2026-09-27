// Notification preferences (084) on real PostgreSQL, as the runtime role.
//
// What only this suite can prove:
//
//   1. The grants: select/insert/update for `lagda_app`, and NO delete or
//      truncate — refused by the database, not merely unused.
//   2. Ownership is the account's: no RLS (like 072), each row keyed by its
//      user, one account's change never touching another's, and the row
//      readable from a WORKSPACE-scoped transaction, which is where intent
//      creation reads it.
//   3. End to end: a muted category's intent commits with its delivery
//      SUPPRESSED / RECIPIENT_PREFERENCE — the widened delivery CHECK admits
//      the code — while a security message to the same account is PENDING.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import {
  createNotificationIntent,
  type NotificationIntentId, type NotificationDeliveryId,
} from "@lagda/application";
import { fakeTemplateRegistry } from "@lagda/application/test-support";
import type { LagdaDatabase } from "./client/index.js";
import { createNotificationPreferenceRepository } from "./repositories/notification-preferences.js";
import { createTransactionManager } from "./transactions/index.js";
import { createNotificationRepository } from "./repositories/notifications.js";
import { migrateDown, migrateToLatest, migrationStatus } from "./migrations/runner.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll,
  hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const USER = "usr_prefs" as UserId;
const OTHER = "usr_prefs_other" as UserId;
const WS = "ws_prefs" as WorkspaceId;
const AT = Date.parse("2026-09-26T10:00:00.000Z");

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("user notification preferences (runtime role)", () => {
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
    await seedUser(owner, USER);
    await seedUser(owner, OTHER);
  });

  describe("the table", () => {
    it("grants select, insert and update to lagda_app, and never delete or truncate", async () => {
      const privileges = await sql<{ privilege: string; granted: boolean }>`
        select p.privilege, has_table_privilege('lagda_app', 'user_notification_preferences', p.privilege) as granted
        from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(privilege)
      `.execute(owner.db);
      expect(Object.fromEntries(privileges.rows.map(r => [r.privilege, r.granted]))).toEqual({
        SELECT: true, INSERT: true, UPDATE: true, DELETE: false, TRUNCATE: false,
      });
    });

    it("carries no row-level security, like the other account-owned tables", async () => {
      const rows = await sql<{ relname: string; relrowsecurity: boolean }>`
        select relname, relrowsecurity from pg_class
        where relname in ('user_notification_preferences', 'user_avatars') order by relname
      `.execute(owner.db);
      expect(rows.rows).toEqual([
        { relname: "user_avatars", relrowsecurity: false },
        { relname: "user_notification_preferences", relrowsecurity: false },
      ]);
    });

    it("refuses the runtime role a DELETE or TRUNCATE", async () => {
      await createNotificationPreferenceRepository(app.db).apply(USER, { invitations: false }, AT);
      await expect(sql`delete from user_notification_preferences`.execute(app.db))
        .rejects.toThrow(/permission denied/);
      await expect(sql`truncate user_notification_preferences`.execute(app.db))
        .rejects.toThrow(/permission denied/);
    });

    it("goes down when empty and back up", async () => {
      await truncateAll(owner);
      const down = await migrateDown(owner.db);
      expect(down.error).toBeUndefined();
      expect(down.applied).toEqual(["084_user_notification_preferences"]);
      const gone = await sql<{ n: string }>`
        select count(*)::text as n from pg_tables where tablename = 'user_notification_preferences'
      `.execute(owner.db);
      expect(gone.rows[0]?.n).toBe("0");

      const up = await migrateToLatest(owner.db);
      expect(up.error).toBeUndefined();
      expect((await migrationStatus(owner.db)).every(s => s.applied)).toBe(true);
      await seedUser(owner, USER);
    });

    it("refuses a row for an account that does not exist", async () => {
      await expect(createNotificationPreferenceRepository(app.db)
        .apply("usr_nobody" as UserId, { invitations: false }, AT)).rejects.toThrow();
    });
  });

  describe("the repository", () => {
    it("has no row until the first change, which lands the untouched switches on", async () => {
      const repo = createNotificationPreferenceRepository(app.db);
      expect(await repo.find(USER)).toBeNull();
      await expect(repo.apply(USER, { requestCompleted: false }, AT)).resolves.toEqual({
        signerActivity: true, requestCompleted: false, actionReminders: true,
        workspaceRequests: true, invitations: true, updatedAt: AT,
      });
    });

    it("a later change sets only its own switches", async () => {
      const repo = createNotificationPreferenceRepository(app.db);
      await repo.apply(USER, { requestCompleted: false }, AT);
      const second = await repo.apply(USER, { workspaceRequests: false }, AT + 1000);
      expect(second).toMatchObject({
        requestCompleted: false, workspaceRequests: false, invitations: true, updatedAt: AT + 1000,
      });
      expect(await repo.find(USER)).toEqual(second);
    });

    it("one account's change never touches another's", async () => {
      const repo = createNotificationPreferenceRepository(app.db);
      await repo.apply(USER, { signerActivity: false }, AT);
      expect(await repo.find(OTHER)).toBeNull();
      await repo.apply(OTHER, { invitations: false }, AT);
      expect(await repo.find(USER)).toMatchObject({ signerActivity: false, invitations: true });
      expect(await repo.find(OTHER)).toMatchObject({ signerActivity: true, invitations: false });
    });
  });

  describe("suppression at intent creation", () => {
    beforeEach(async () => {
      await createTransactionManager(owner.db).runForWorkspace(WS, async uow => {
        await uow.workspaces.insert({ workspaceId: WS, name: "Prefs Legal", createdAt: AT });
        await uow.memberships.insert({
          memberId: "mem_prefs" as WorkspaceMemberId, workspaceId: WS,
          userId: USER, role: "owner", createdAt: AT,
        });
      });
    });

    let sequence = 0;
    const create = (uow: { notifications: Parameters<typeof createNotificationIntent>[0]["notifications"] }) =>
      createNotificationIntent({
        notifications: uow.notifications, templates: fakeTemplateRegistry,
        ids: {
          nextNotificationIntentId: () => `nint_prefs_${String(++sequence)}` as NotificationIntentId,
          nextNotificationDeliveryId: () => `ndel_prefs_${String(sequence)}` as NotificationDeliveryId,
        },
        clock: { now: () => AT },
      });

    const completed = (sourceId: string) => ({
      notificationType: "SIGNING_COMPLETED" as const,
      sourceId,
      scope: { kind: "WORKSPACE" as const, workspaceId: WS },
      audience: { kind: "USER" as const, userId: USER },
      destination: "prefs@example.test",
      templateInput: {
        recipientName: "Paulo", documentTitle: "Lease", workspaceName: "Prefs Legal", signerCount: 1,
      },
    });

    const deliveries = () => owner.db.selectFrom("notification_deliveries")
      .innerJoin("notification_intents", "notification_intents.notification_intent_id",
        "notification_deliveries.notification_intent_id")
      .select(["notification_intents.source_id", "notification_intents.notification_type",
        "notification_deliveries.state", "notification_deliveries.failure_code"])
      .orderBy("notification_intents.source_id")
      .execute();

    it("stops an optional email the account switched off, and records why", async () => {
      await createNotificationPreferenceRepository(app.db).apply(USER, { requestCompleted: false }, AT);

      // The runtime role, in a WORKSPACE-scoped transaction — the read of an
      // account-owned row from inside a tenant context is the point.
      await createTransactionManager(app.db).runForWorkspace(WS, uow =>
        create(uow)(completed("sr_muted"), uow));

      expect(await deliveries()).toEqual([{
        source_id: "sr_muted", notification_type: "SIGNING_COMPLETED",
        state: "SUPPRESSED", failure_code: "RECIPIENT_PREFERENCE",
      }]);
      // A suppressed delivery is not dispatchable work.
      const dispatchable = await owner.db.selectFrom("notification_dispatch_index")
        .select("state").where("state", "in", ["PENDING", "FAILED_RETRYABLE"]).execute();
      expect(dispatchable).toHaveLength(0);
    });

    it("sends when the category is on, or when another category is off", async () => {
      await createNotificationPreferenceRepository(app.db).apply(USER, { workspaceRequests: false }, AT);
      await createTransactionManager(app.db).runForWorkspace(WS, uow =>
        create(uow)(completed("sr_on"), uow));
      expect(await deliveries()).toEqual([{
        source_id: "sr_on", notification_type: "SIGNING_COMPLETED", state: "PENDING", failure_code: null,
      }]);
    });

    it("never suppresses security mail, even with every switch off", async () => {
      await createNotificationPreferenceRepository(app.db).apply(USER, {
        signerActivity: false, requestCompleted: false, actionReminders: false,
        workspaceRequests: false, invitations: false,
      }, AT);
      // The account's own security scope, as the reset producer writes it.
      await app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.user_id', ${USER}, true)`.execute(trx);
        const uow = { notifications: createNotificationRepository(trx) };
        return create(uow)({
          notificationType: "PASSWORD_RESET",
          sourceId: "chal_prefs",
          scope: { kind: "GLOBAL_USER", userId: USER },
          audience: { kind: "USER", userId: USER },
          destination: "prefs@example.test",
          templateInput: { recipientName: "Paulo" },
          secretRef: { kind: "CHALLENGE", challengeId: "chal_prefs" },
        }, trx);
      });
      expect(await deliveries()).toEqual([{
        source_id: "chal_prefs", notification_type: "PASSWORD_RESET", state: "PENDING", failure_code: null,
      }]);
    });
  });
});
