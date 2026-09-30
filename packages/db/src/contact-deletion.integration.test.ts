// Deleting an archived contact (092) on real PostgreSQL, as the runtime role.
//
// What only this suite can prove:
//
//   1. The grant: lagda_app may now DELETE contacts — and the repository's
//      delete refuses an active contact and another tenant's.
//   2. What a delete leaves standing: a document request keeps its snapshot
//      and only forgets the contact id (SET NULL on the one column — the
//      workspace id stays); tags go with the contact.
//   3. The migration goes down and back up.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { ContactId, UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type { ContactEmailKey } from "@lagda/core";
import type { LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import { migrateDown, migrateToLatest, migrationStatus } from "./migrations/runner.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-09-30T09:00:00.000Z");
const USER = "usr_del" as UserId;
const WS_A = "ws_del_a" as WorkspaceId;
const WS_B = "ws_del_b" as WorkspaceId;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("contact deletion (runtime role)", () => {
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
    const tx = createTransactionManager(owner.db);
    for (const [id, member] of [[WS_A, "mem_da"], [WS_B, "mem_db"]] as const) {
      await tx.runForWorkspace(id, async uow => {
        await uow.workspaces.insert({ workspaceId: id, name: `WS ${id}`, createdAt: AT });
        await uow.memberships.insert({ memberId: member as WorkspaceMemberId, workspaceId: id, userId: USER, role: "owner", createdAt: AT });
      });
    }
  });

  const tx = () => createTransactionManager(app.db);
  const insert = (workspaceId: WorkspaceId, contactId: string, archived = true) =>
    tx().runForWorkspace(workspaceId, async uow => {
      await uow.contacts.insert({
        contactId: contactId as ContactId, workspaceId, name: contactId, email: `${contactId}@example.com`,
        emailKey: `${contactId}@example.com` as ContactEmailKey, phone: null, organization: null, title: null,
        createdAt: AT, tagIds: ["tag-client"],
      });
      if (archived) await uow.contacts.archiveIfActive({ contactId: contactId as ContactId, now: AT + 1 });
    });
  const remove = (workspaceId: WorkspaceId, contactId: string) =>
    tx().runForWorkspace(workspaceId, uow => uow.contacts.deleteIfArchived(contactId as ContactId));

  it("grants lagda_app DELETE on contacts", async () => {
    const r = await sql<{ d: boolean }>`select has_table_privilege('lagda_app', 'contacts', 'DELETE') as d`.execute(owner.db);
    expect(r.rows[0]?.d).toBe(true);
  });

  it("deletes only an archived contact, only in its own workspace, with its tags", async () => {
    await insert(WS_A, "con_active", false);
    await insert(WS_A, "con_old");
    expect(await remove(WS_A, "con_active")).toBe(false);
    expect(await remove(WS_B, "con_old")).toBe(false);
    expect(await remove(WS_A, "con_old")).toBe(true);
    const left = await owner.db.selectFrom("contacts").select("contact_id").execute();
    expect(left.map(r => r.contact_id)).toEqual(["con_active"]);
    const tags = await owner.db.selectFrom("contact_tags").select("contact_id").execute();
    expect(tags.map(r => r.contact_id)).toEqual(["con_active"]);
  });

  it("leaves a document request standing, with its snapshot and workspace, forgetting only the contact", async () => {
    await insert(WS_A, "con_req");
    await sql`
      insert into contact_requests (
        request_id, workspace_id, kind, contact_id, recipient_name, recipient_email, delivery,
        title, status, requested_by_user_id, created_at, updated_at
      ) values (
        'cr_1', ${WS_A}, 'upload', 'con_req', 'Maria Santos', 'maria@example.com', 'email',
        'Audited statements', 'pending', ${USER}, ${new Date(AT)}, ${new Date(AT)}
      )
    `.execute(owner.db);
    expect(await remove(WS_A, "con_req")).toBe(true);
    const row = await owner.db.selectFrom("contact_requests")
      .select(["workspace_id", "contact_id", "recipient_name", "recipient_email"]).executeTakeFirst();
    expect(row).toEqual({ workspace_id: WS_A, contact_id: null, recipient_name: "Maria Santos", recipient_email: "maria@example.com" });
  });

  it("goes down when empty and back up", async () => {
    await truncateAll(owner);
    const down = await migrateDown(owner.db);
    expect(down.error).toBeUndefined();
    expect(down.applied).toEqual(["092_contact_deletion"]);
    const r = await sql<{ d: boolean }>`select has_table_privilege('lagda_app', 'contacts', 'DELETE') as d`.execute(owner.db);
    expect(r.rows[0]?.d).toBe(false);
    const up = await migrateToLatest(owner.db);
    expect(up.error).toBeUndefined();
    expect((await migrationStatus(owner.db)).every(s => s.applied)).toBe(true);
  });
});
