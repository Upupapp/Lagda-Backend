// Notifications against REAL PostgreSQL, as the runtime role.
//
// What only this suite can prove:
//
//   1. Two concurrent creations for one source resolve to ONE intent — the
//      race `createIfAbsent`'s ON CONFLICT exists for, and the one a fake
//      cannot model because it has no second connection.
//   2. The scope CHECK refuses a row that is both workspace- and user-scoped,
//      and one that is neither.
//   3. RLS hides a workspace's notifications from another tenant, and hides a
//      global account notification from every workspace.
//   4. The audience CHECK refuses a kind that disagrees with its column.
//   5. An intent cannot be UPDATEd at all — the grant is not there.
//   6. A frozen destination survives an unrelated profile change, because
//      nothing re-reads it.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type {
  NotificationIntentId, NotificationDeliveryId, NewNotificationIntent,
  SigningRequestRecipientId,
} from "@lagda/application";
import { createDatabase, type LagdaDatabase } from "./client/index.js";
import { loadDatabaseConfig } from "./config/index.js";
import { createTransactionManager } from "./transactions/index.js";
import { createNotificationRepository } from "./repositories/notifications.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-08-18T07:00:00.000Z");
const USER = "usr_notify" as UserId;
const WS_A = "ws_na" as WorkspaceId;
const WS_B = "ws_nb" as WorkspaceId;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

/** Deterministic ids, so a conflict is visible rather than hidden by a UUID. */
function idGenerator(prefix: string) {
  let n = 0;
  return {
    nextNotificationIntentId: () => `nint_${prefix}_${++n}` as NotificationIntentId,
    nextNotificationDeliveryId: () => `ndel_${prefix}_${n}` as NotificationDeliveryId,
  };
}

const workspaceIntent = (
  sourceId: string,
  destination = "alice@example.test",
): NewNotificationIntent => ({
  scope: { kind: "WORKSPACE", workspaceId: WS_A },
  notificationType: "SIGNING_INVITATION",
  source: { kind: "SIGNING_ACCESS_GRANT", sourceId },
  audience: {
    kind: "SIGNING_REQUEST_RECIPIENT",
    signingRequestRecipientId: "srr_a" as SigningRequestRecipientId,
  },
  template: { key: "signing-invitation", version: 1 },
  locale: "en",
  templateInput: {
    recipientName: "Maria Santos", documentTitle: "Lease Agreement",
    senderDisplayName: "Paulo Reyes", workspaceName: "Reyes Legal",
  },
  secretRef: { kind: "SEALED", sealed: "v1.aa.bb.cc" as never, keyVersion: "k1" },
  channel: "EMAIL",
  destination,
});

const globalIntent = (sourceId: string): NewNotificationIntent => ({
  scope: { kind: "GLOBAL_USER", userId: USER },
  notificationType: "PASSWORD_RESET",
  source: { kind: "SECURITY_CHALLENGE", sourceId },
  audience: { kind: "USER", userId: USER },
  template: { key: "password-reset", version: 1 },
  locale: "en",
  templateInput: { recipientName: "Maria Santos" },
  secretRef: { kind: "CHALLENGE", challengeId: sourceId },
  channel: "EMAIL",
  destination: "alice@example.test",
});

suite("notifications (RLS, runtime role)", () => {
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

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, USER);
    const tx = createTransactionManager(owner.db);
    for (const [ws, member] of [[WS_A, "mem_na"], [WS_B, "mem_nb"]] as const) {
      await tx.runForWorkspace(ws, async uow => {
        await uow.workspaces.insert({ workspaceId: ws, name: `WS ${ws}`, createdAt: AT });
        await uow.memberships.insert({
          memberId: member as WorkspaceMemberId, workspaceId: ws,
          userId: USER, role: "owner", createdAt: AT,
        });
      });
    }
  });

  /** Runs inside a workspace RLS context on the runtime-role connection. */
  const inWorkspace = async <T>(
    workspaceId: WorkspaceId,
    prefix: string,
    body: (repository: ReturnType<typeof createNotificationRepository>) => Promise<T>,
  ): Promise<T> =>
    app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.workspace_id', ${workspaceId}, true)`.execute(trx);
      return body(createNotificationRepository(trx, idGenerator(prefix), () => AT));
    });

  /** Runs inside a user RLS context — no workspace at all. */
  const asUser = async <T>(
    userId: UserId,
    prefix: string,
    body: (repository: ReturnType<typeof createNotificationRepository>) => Promise<T>,
  ): Promise<T> =>
    app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.user_id', ${userId}, true)`.execute(trx);
      return body(createNotificationRepository(trx, idGenerator(prefix), () => AT));
    });

  describe("logical idempotency", () => {
    it("resolves two CONCURRENT creations for one source to one intent", async () => {
      // S240, and the reason `createIfAbsent` is ON CONFLICT rather than
      // read-then-insert: both transactions read "absent" under a check-then-
      // write and both insert.
      const [first, second] = await Promise.all([
        inWorkspace(WS_A, "a", r => r.createIfAbsent(workspaceIntent("grant_1"), null)),
        inWorkspace(WS_A, "b", r => r.createIfAbsent(workspaceIntent("grant_1"), null)),
      ]);

      const outcomes = [first.outcome, second.outcome].sort();
      expect(outcomes).toEqual(["ALREADY_EXISTS", "CREATED"]);
      expect(first.intent.notificationIntentId)
        .toBe(second.intent.notificationIntentId);

      const rows = await owner.db.selectFrom("notification_intents")
        .select("notification_intent_id").execute();
      expect(rows).toHaveLength(1);
    });

    it("creates a distinct intent for a new source occurrence", async () => {
      // S138, S241. A second OTP challenge is a new source id.
      await asUser(USER, "a", r => r.createIfAbsent(globalIntent("chal_1"), null));
      await asUser(USER, "b", r => r.createIfAbsent(globalIntent("chal_2"), null));

      const rows = await owner.db.selectFrom("notification_intents")
        .select("notification_intent_id").execute();
      expect(rows).toHaveLength(2);
    });

    it("permits one delivery per intent and channel", async () => {
      // S195. The UNIQUE is what stops one decision producing two messages.
      const created = await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(workspaceIntent("grant_1"), null));

      await expect(owner.db.insertInto("notification_deliveries").values({
        notification_delivery_id: "ndel_dup",
        notification_intent_id: created.intent.notificationIntentId,
        workspace_id: WS_A, user_id: null, channel: "EMAIL",
        destination: "alice@example.test", state: "PENDING",
        failure_code: null, created_at: new Date(AT),
      }).execute()).rejects.toThrow();
    });
  });

  describe("scope", () => {
    it("stores a global account notification with no workspace", async () => {
      // S273. No fake tenant, and the row is still readable by its owner.
      const created = await asUser(USER, "a",
        r => r.createIfAbsent(globalIntent("chal_1"), null));

      expect(created.intent.scope).toEqual({ kind: "GLOBAL_USER", userId: USER });

      const row = await owner.db.selectFrom("notification_intents")
        .selectAll()
        .where("notification_intent_id", "=", created.intent.notificationIntentId)
        .executeTakeFirstOrThrow();
      expect(row.workspace_id).toBeNull();
      expect(row.user_id).toBe(USER);
    });

    it("refuses a row that claims both scopes", async () => {
      await expect(owner.db.insertInto("notification_intents").values({
        notification_intent_id: "nint_both",
        workspace_id: WS_A, user_id: USER,
        notification_type: "PASSWORD_RESET",
        source_kind: "SECURITY_CHALLENGE", source_id: "chal_x",
        audience_kind: "USER", audience_user_id: USER,
        audience_recipient_id: null, audience_invitation_id: null,
        template_key: "password-reset", template_version: 1, locale: "en",
        template_input: JSON.stringify({ recipientName: "M" }),
        secret_ref_kind: "CHALLENGE", sealed_secret: null,
        sealed_key_version: null, challenge_id: "chal_x",
        created_at: new Date(AT),
      }).execute()).rejects.toThrow();
    });

    it("refuses an audience kind that disagrees with its column", async () => {
      await expect(owner.db.insertInto("notification_intents").values({
        notification_intent_id: "nint_mismatch",
        workspace_id: WS_A, user_id: null,
        notification_type: "SIGNING_INVITATION",
        source_kind: "SIGNING_ACCESS_GRANT", source_id: "grant_x",
        // Claims USER while carrying a recipient id.
        audience_kind: "USER", audience_user_id: null,
        audience_recipient_id: "srr_a", audience_invitation_id: null,
        template_key: "signing-invitation", template_version: 1, locale: "en",
        template_input: JSON.stringify({}),
        secret_ref_kind: null, sealed_secret: null,
        sealed_key_version: null, challenge_id: null,
        created_at: new Date(AT),
      }).execute()).rejects.toThrow();
    });
  });

  describe("tenant isolation", () => {
    it("hides one workspace's notifications from another", async () => {
      const created = await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(workspaceIntent("grant_1"), null));

      const seen = await inWorkspace(WS_B, "b",
        r => r.findIntentById(created.intent.notificationIntentId));

      expect(seen).toBeNull();
    });

    it("hides a global account notification from every workspace", async () => {
      // The two RLS predicates are disjoint: a workspace admin must not learn
      // that one of their members requested a password reset.
      const created = await asUser(USER, "a",
        r => r.createIfAbsent(globalIntent("chal_1"), null));

      const seen = await inWorkspace(WS_A, "b",
        r => r.findIntentById(created.intent.notificationIntentId));

      expect(seen).toBeNull();
    });

    it("hides a workspace notification from a user context", async () => {
      const created = await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(workspaceIntent("grant_1"), null));

      const seen = await asUser(USER, "b",
        r => r.findIntentById(created.intent.notificationIntentId));

      expect(seen).toBeNull();
    });
  });

  describe("immutability", () => {
    it("refuses an UPDATE on an intent under the runtime role", async () => {
      // S55. The grant was never issued, so immutability is enforced by
      // PostgreSQL rather than by every future writer remembering.
      const created = await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(workspaceIntent("grant_1"), null));

      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        return sql`
          update notification_intents set locale = 'xx'
          where notification_intent_id = ${created.intent.notificationIntentId}
        `.execute(trx);
      })).rejects.toThrow();
    });

    it("keeps a destination frozen against an unrelated profile change", async () => {
      // S248, S250. Nothing re-reads the address, so nothing can redirect it.
      const created = await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(workspaceIntent("grant_1", "alice@example.test"), null));

      await owner.db.updateTable("users")
        .set({ email: "changed@example.test", normalized_email: "changed@example.test" })
        .where("user_id", "=", USER).execute();

      const delivery = await inWorkspace(WS_A, "b",
        r => r.findDeliveryById(created.delivery.notificationDeliveryId));

      expect(delivery?.destination).toBe("alice@example.test");
    });
  });

  describe("stopping a pending delivery", () => {
    it("cancels a PENDING delivery and refuses a second stop", async () => {
      const created = await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(workspaceIntent("grant_1"), null));

      const first = await inWorkspace(WS_A, "b", r => r.stopPendingDelivery(
        created.delivery.notificationDeliveryId, "CANCELLED", "SOURCE_CANCELLED", null));
      const second = await inWorkspace(WS_A, "c", r => r.stopPendingDelivery(
        created.delivery.notificationDeliveryId, "CANCELLED", "SOURCE_CANCELLED", null));

      expect(first).toBe(true);
      // Conditional on still being PENDING, so it is not idempotently "true".
      expect(second).toBe(false);
    });

    it("finds a stranded PENDING delivery for reconciliation", async () => {
      // S262. The lost-enqueue case: the row exists and nothing will pick it up.
      await inWorkspace(WS_A, "a", r => r.createIfAbsent(workspaceIntent("grant_1"), null));

      const stranded = await inWorkspace(WS_A, "b",
        r => r.findPendingDeliveries(AT + 1, 10));

      expect(stranded).toHaveLength(1);
      expect(stranded[0]?.state).toBe("PENDING");
    });
  });
});
