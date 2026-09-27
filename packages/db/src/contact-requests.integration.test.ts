// 086. Contact requests on REAL PostgreSQL, as the runtime role: the use
// cases end to end (member in-app vs external email), the notification
// vocabulary and IN_APP_ONLY suppression, tenant isolation, the table's
// CHECKs, no DELETE/TRUNCATE, and the migration's down/up.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type {
  ContactId, DocumentId, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import type { ContactEmailKey } from "@lagda/core";
import {
  createContactRequest, completeContactRequest, declineContactRequest,
  listMyReceivedContactRequests, listMySentContactRequests, getContact,
  createTemplateRegistry, ALL_TEMPLATES, ContactRequestMembersOnlyError,
  type ContactRequestDependencies, type AuthenticatedActor, type SessionId,
} from "@lagda/application";
import type { LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import { migrateDown, migrateToLatest, migrationStatus } from "./migrations/runner.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-09-27T09:00:00.000Z");
const WS_A = "ws_cr_a" as WorkspaceId;
const WS_B = "ws_cr_b" as WorkspaceId;
const SENDER = "usr_cr_sender" as UserId;
const COLLEAGUE = "usr_cr_colleague" as UserId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("contact requests (086, runtime role)", () => {
  let owner: LagdaDatabase;
  let app: LagdaDatabase;
  let deps: ContactRequestDependencies;
  let seq = 0;

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
    await seedUser(owner, SENDER, { email: "sender@example.com" });
    await seedUser(owner, COLLEAGUE, { email: "Colleague@Example.com" });
    const tx = createTransactionManager(owner.db);
    for (const ws of [WS_A, WS_B]) {
      await tx.runForWorkspace(ws, async uow => {
        await uow.workspaces.insert({ workspaceId: ws, name: `WS ${ws}`, createdAt: AT });
        await uow.memberships.insert({
          memberId: `mem_${ws}_s` as WorkspaceMemberId, workspaceId: ws,
          userId: SENDER, role: "sender", createdAt: AT,
        });
      });
    }
    await tx.runForWorkspace(WS_A, async uow => {
      await uow.memberships.insert({
        memberId: "mem_a_c" as WorkspaceMemberId, workspaceId: WS_A,
        userId: COLLEAGUE, role: "sender", createdAt: AT,
      });
      for (const [id, email] of [
        ["con_colleague", "colleague@example.com"], ["con_external", "maria@outside.example"],
      ] as const) {
        await uow.contacts.insert({
          contactId: id as ContactId, workspaceId: WS_A, name: `Name ${id}`, email,
          emailKey: email.toLowerCase() as ContactEmailKey, phone: null, organization: null,
          title: null, createdAt: AT,
        });
      }
      await uow.documents.insert({
        documentId: "doc_cr_1" as DocumentId, workspaceId: WS_A, title: "Lease",
        originalFilename: null, createdByUserId: SENDER, createdAt: AT,
      });
      await uow.documents.insert({
        documentId: "doc_cr_answer" as DocumentId, workspaceId: WS_A, title: "Answer",
        originalFilename: null, createdByUserId: COLLEAGUE, createdAt: AT,
      });
    });
    deps = {
      transactions: createTransactionManager(app.db),
      clock: { now: () => AT },
      ids: { nextContactRequestId: () => `cr_it_${++seq}` as never },
      templates: createTemplateRegistry(ALL_TEMPLATES),
      notificationIds: {
        nextNotificationIntentId: () => `nint_cr_${++seq}` as never,
        nextNotificationDeliveryId: () => `ndel_cr_${++seq}` as never,
      },
    };
  });

  const deliveries = () => owner.db.selectFrom("notification_intents")
    .innerJoin("notification_deliveries", "notification_deliveries.notification_intent_id",
      "notification_intents.notification_intent_id")
    .select([
      "notification_intents.notification_type", "notification_intents.audience_kind",
      "notification_intents.audience_user_id", "notification_intents.audience_contact_request_id",
      "notification_deliveries.state", "notification_deliveries.failure_code",
      "notification_deliveries.destination",
    ])
    .orderBy("notification_intents.created_at").orderBy("notification_intents.notification_intent_id")
    .execute();

  it("contacts carry the matching member at read time", async () => {
    const contactDeps = { transactions: deps.transactions, clock: deps.clock, ids: { nextContactId: () => "x" as never } };
    const colleague = await getContact(actor(SENDER), WS_A, "con_colleague" as ContactId, contactDeps);
    expect(colleague.workspaceMember).toEqual({ userId: COLLEAGUE, displayName: COLLEAGUE });
    const external = await getContact(actor(SENDER), WS_A, "con_external" as ContactId, contactDeps);
    expect(external.workspaceMember).toBeNull();
  });

  it("a member gets it in-app: an intent in their feed, its email suppressed IN_APP_ONLY", async () => {
    const view = await createContactRequest(actor(SENDER), WS_A, {
      kind: "signed-document", contactId: "con_colleague", title: "Signed lease", documentId: "doc_cr_1",
      dueAt: AT + 86_400_000,
    }, deps);
    expect(view).toMatchObject({ delivery: "in-app", recipient: { userId: COLLEAGUE }, documentTitle: "Lease" });
    expect(await deliveries()).toEqual([{
      notification_type: "CONTACT_REQUEST_RECEIVED", audience_kind: "USER",
      audience_user_id: COLLEAGUE, audience_contact_request_id: null,
      state: "SUPPRESSED", failure_code: "IN_APP_ONLY", destination: "Colleague@Example.com",
    }]);

    const others = await listMyReceivedContactRequests(COLLEAGUE, deps);
    expect(others.map(r => r.requestId)).toEqual([view.requestId]);
    expect(await listMySentContactRequests(SENDER, deps)).toHaveLength(1);
  });

  it("an external contact is emailed, addressed through the request", async () => {
    const view = await createContactRequest(actor(SENDER), WS_A, {
      kind: "upload", contactId: "con_external", title: "Permit",
    }, deps);
    expect(await deliveries()).toEqual([{
      notification_type: "CONTACT_REQUEST_EMAILED", audience_kind: "CONTACT_REQUEST",
      audience_user_id: null, audience_contact_request_id: view.requestId,
      state: "PENDING", failure_code: null, destination: "maria@outside.example",
    }]);
    await expect(createContactRequest(actor(SENDER), WS_A, {
      kind: "preparation", contactId: "con_external", title: "Prepare", documentId: "doc_cr_1",
    }, deps)).rejects.toBeInstanceOf(ContactRequestMembersOnlyError);
  });

  it("completion and decline notify the requester in-app", async () => {
    const a = await createContactRequest(actor(SENDER), WS_A, {
      kind: "upload", contactId: "con_colleague", title: "A",
    }, deps);
    const b = await createContactRequest(actor(SENDER), WS_A, {
      kind: "upload", contactId: "con_colleague", title: "B",
    }, deps);
    await completeContactRequest(actor(COLLEAGUE), WS_A, a.requestId, { documentId: "doc_cr_answer" }, deps);
    await declineContactRequest(actor(COLLEAGUE), WS_A, b.requestId, { reason: "No" }, deps);
    const rows = await owner.db.selectFrom("contact_requests")
      .select(["request_id", "status", "response_document_id", "decline_reason", "completed_by_user_id"])
      .orderBy("request_id").execute();
    expect(rows).toEqual([
      { request_id: a.requestId, status: "completed", response_document_id: "doc_cr_answer",
        decline_reason: null, completed_by_user_id: COLLEAGUE },
      { request_id: b.requestId, status: "declined", response_document_id: null,
        decline_reason: "No", completed_by_user_id: null },
    ].sort((x, y) => x.request_id.localeCompare(y.request_id)));
    const notices = (await deliveries()).filter(d => d.audience_user_id === SENDER);
    expect(notices.map(n => [n.notification_type, n.failure_code])).toEqual([
      ["CONTACT_REQUEST_COMPLETED", "IN_APP_ONLY"], ["CONTACT_REQUEST_DECLINED", "IN_APP_ONLY"],
    ]);
  });

  it("is invisible from another tenant, and the runtime role cannot delete or truncate", async () => {
    const view = await createContactRequest(actor(SENDER), WS_A, {
      kind: "upload", contactId: "con_external", title: "Permit",
    }, deps);
    const fromB = await deps.transactions.runForWorkspace(WS_B,
      uow => uow.contactRequests.find(view.requestId));
    expect(fromB).toBeNull();
    const bare = await app.db.selectFrom("contact_requests").selectAll().execute();
    expect(bare).toEqual([]);
    await expect(app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
      await sql`delete from contact_requests`.execute(trx);
    })).rejects.toThrow(/permission denied/u);
    await expect(sql`truncate contact_requests`.execute(app.db)).rejects.toThrow(/permission denied/u);
    // From another tenant's context, an update reaches no row at all.
    const moved = await app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.workspace_id', ${WS_B}, true)`.execute(trx);
      return sql`update contact_requests set workspace_id = ${WS_B}`.execute(trx);
    });
    expect(Number(moved.numAffectedRows ?? 0n)).toBe(0);
    const still = await owner.db.selectFrom("contact_requests").select("workspace_id").execute();
    expect(still).toEqual([{ workspace_id: WS_A }]);
  });

  it("the table refuses an emailed preparation and a delivery/recipient mismatch", async () => {
    const insert = (over: Record<string, unknown>) => owner.db.insertInto("contact_requests").values({
      request_id: `cr_raw_${++seq}`, workspace_id: WS_A, kind: "upload", contact_id: "con_external",
      recipient_name: "M", recipient_email: "m@x.example", delivery: "email", recipient_user_id: null,
      title: "t", message: null, document_id: null, due_at: null, status: "pending",
      response_document_id: null, decline_reason: null, requested_by_user_id: SENDER,
      completed_by_user_id: null, created_at: new Date(AT), updated_at: new Date(AT),
      completed_at: null, declined_at: null, cancelled_at: null, ...over,
    }).execute();
    await expect(insert({ kind: "preparation", document_id: "doc_cr_1" }))
      .rejects.toThrow(/contact_requests_preparation_members_only/u);
    await expect(insert({ delivery: "in-app" })).rejects.toThrow(/contact_requests_delivery_check/u);
    await expect(insert({ contact_id: "con_nowhere" })).rejects.toThrow(/contact_requests_contact_fk/u);
    await expect(insert({})).resolves.toBeDefined();
  });

  it("widens the notification vocabularies", async () => {
    const rows = await sql<{ def: string }>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conname in ('notification_intents_type_check', 'notification_intents_source_kind_check',
                         'notification_intents_audience_kind_check',
                         'notification_deliveries_failure_code_check')
    `.execute(owner.db);
    const defs = rows.rows.map(r => r.def).join(" ");
    for (const value of ["CONTACT_REQUEST_RECEIVED", "CONTACT_REQUEST_EMAILED",
      "CONTACT_REQUEST_COMPLETED", "CONTACT_REQUEST_DECLINED", "IN_APP_ONLY"]) {
      expect(defs).toContain(value);
    }
  });

  it("goes down when empty and back up", async () => {
    await truncateAll(owner);
    const reverted: string[] = [];
    while (!reverted.includes("086_contact_requests")) {
      const down = await migrateDown(owner.db);
      expect(down.error).toBeUndefined();
      expect(down.applied).toHaveLength(1);
      reverted.push(...down.applied);
    }
    const gone = await sql<{ n: string }>`
      select count(*)::text as n from pg_tables where tablename = 'contact_requests'
    `.execute(owner.db);
    expect(gone.rows[0]?.n).toBe("0");
    const up = await migrateToLatest(owner.db);
    expect(up.error).toBeUndefined();
    expect((await migrationStatus(owner.db)).every(s => s.applied)).toBe(true);
  });
});
