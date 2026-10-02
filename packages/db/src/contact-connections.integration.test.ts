// Contact connections (091) on real PostgreSQL, as the runtime role.
//
// What only this suite can prove:
//
//   1. The grants: select/insert/update for `lagda_app`, and NO delete or
//      truncate on either table — refused by the database, not merely unused.
//   2. One pending request per pair, in EITHER direction, is the database's
//      rule too (the partial unique index), surfaced as a conflict.
//   3. Every change names its party: a stranger cannot read, accept,
//      decline or cancel a request.
//   4. An exact lookup finds only a VERIFIED account; discovery defaults on.
//   5. The migration goes down and back up.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { UserId, WorkspaceId, ContactId } from "@lagda/contracts";
import { ResourceConflictError } from "@lagda/application";
import type { LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createContactConnectionRepository, createPeopleDirectory, avatarVersionsOf,
} from "./repositories/contact-connections.js";
import { migrateDown, migrateToLatest, migrationStatus } from "./migrations/runner.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-09-30T09:00:00.000Z");
const WS_A = "ws_cc_a" as WorkspaceId;
const WS_B = "ws_cc_b" as WorkspaceId;
const ANA = "usr_cc_ana" as UserId;
const BEN = "usr_cc_ben" as UserId;
const EVE = "usr_cc_eve" as UserId;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("contact connections (runtime role)", () => {
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
    await seedUser(owner, ANA, { email: "ana@example.com" });
    await seedUser(owner, BEN, { email: "Ben@Example.com" });
    await seedUser(owner, EVE, { email: "eve@example.com" });
    await owner.db.updateTable("users").set({ email_verified_at: new Date(AT), job_title: "Counsel" })
      .where("user_id", "in", [ANA, BEN]).execute();
    const tx = createTransactionManager(owner.db);
    await tx.runForWorkspace(WS_A, uow => uow.workspaces.insert({ workspaceId: WS_A, name: "Firm A", createdAt: AT }));
    await tx.runForWorkspace(WS_B, uow => uow.workspaces.insert({ workspaceId: WS_B, name: "Firm B", createdAt: AT }));
  });

  const repo = () => createContactConnectionRepository(app.db);
  const request = (id: string, from: UserId, to: UserId) => repo().insert({
    connectionId: id, requesterUserId: from, requesterWorkspaceId: WS_A, requesterWorkspaceName: "Firm A",
    recipientUserId: to, status: "pending", declinedAt: null, createdAt: AT,
  });

  it("grants select, insert and update, and never delete or truncate", async () => {
    for (const table of ["contact_connections", "contact_discovery_settings"]) {
      const privileges = await sql<{ select: boolean; insert: boolean; update: boolean; delete: boolean; truncate: boolean }>`
        select has_table_privilege('lagda_app', ${table}, 'SELECT') as select,
               has_table_privilege('lagda_app', ${table}, 'INSERT') as insert,
               has_table_privilege('lagda_app', ${table}, 'UPDATE') as update,
               has_table_privilege('lagda_app', ${table}, 'DELETE') as delete,
               has_table_privilege('lagda_app', ${table}, 'TRUNCATE') as truncate
      `.execute(owner.db);
      expect(privileges.rows[0]).toEqual({ select: true, insert: true, update: true, delete: false, truncate: false });
    }
  });

  it("allows one pending request per pair, in either direction", async () => {
    await request("cc_1", ANA, BEN);
    await expect(request("cc_2", ANA, BEN)).rejects.toBeInstanceOf(ResourceConflictError);
    await expect(request("cc_3", BEN, ANA)).rejects.toBeInstanceOf(ResourceConflictError);
    // A different pair is independent.
    await request("cc_4", ANA, EVE);
    expect((await repo().listBetween(ANA, BEN)).map(r => r.connectionId)).toEqual(["cc_1"]);
  });

  it("lets only the parties read or change a request", async () => {
    await request("cc_1", ANA, BEN);
    expect(await repo().findForParticipant("cc_1", EVE)).toBeNull();
    expect(await repo().markAccepted({ connectionId: "cc_1", recipientUserId: ANA, recipientWorkspaceId: WS_A, at: AT })).toBe(false);
    expect(await repo().markDeclined({ connectionId: "cc_1", recipientUserId: EVE, at: AT })).toBe(false);
    expect(await repo().markCancelled({ connectionId: "cc_1", requesterUserId: BEN, at: AT })).toBe(false);
    expect((await repo().listReceived(BEN)).map(r => r.connectionId)).toEqual(["cc_1"]);
    expect((await repo().listSent(ANA)).map(r => r.connectionId)).toEqual(["cc_1"]);

    expect(await repo().markAccepted({ connectionId: "cc_1", recipientUserId: BEN, recipientWorkspaceId: WS_B, at: AT + 1 })).toBe(true);
    await repo().setContacts({ connectionId: "cc_1", requesterContactId: "con_a" as ContactId, recipientContactId: "con_b" as ContactId, at: AT + 2 });
    // Each side's contact stands for the other account.
    expect([...await repo().accountsForContacts(WS_A, ["con_a", "con_x"])]).toEqual([["con_a", { userId: BEN, workspaceId: WS_B }]]);
    expect([...await repo().accountsForContacts(WS_B, ["con_b"])]).toEqual([["con_b", { userId: ANA, workspaceId: WS_A }]]);
    // Once accepted it cannot be declined or cancelled.
    expect(await repo().markDeclined({ connectionId: "cc_1", recipientUserId: BEN, at: AT })).toBe(false);
    expect(await repo().markCancelled({ connectionId: "cc_1", requesterUserId: ANA, at: AT })).toBe(false);
  });

  it("keeps declined_at when a declined request is cancelled", async () => {
    await request("cc_1", ANA, BEN);
    await repo().markDeclined({ connectionId: "cc_1", recipientUserId: BEN, at: AT + 5 });
    await repo().markCancelled({ connectionId: "cc_1", requesterUserId: ANA, at: AT + 6 });
    const [row] = await repo().listBetween(ANA, BEN);
    expect(row).toMatchObject({ status: "cancelled", declinedAt: AT + 5, cancelledAt: AT + 6 });
  });

  it("finds only a verified account by its exact normalized address; discovery defaults on", async () => {
    const people = createPeopleDirectory(app.db);
    expect(await people.findVerifiedByEmail("ben@example.com")).toMatchObject({ userId: BEN, email: "Ben@Example.com", jobTitle: "Counsel" });
    expect(await people.findVerifiedByEmail("eve@example.com")).toBeNull();
    expect(await people.isDiscoverable(BEN)).toBe(true);
    await people.setDiscoverable(BEN, false, AT);
    expect(await people.isDiscoverable(BEN)).toBe(false);
    await people.setDiscoverable(BEN, true, AT + 1);
    expect(await people.isDiscoverable(BEN)).toBe(true);
    expect(await avatarVersionsOf(app.db, [ANA, BEN])).toEqual(new Map());
  });

  it("goes down when empty and back up", async () => {
    await truncateAll(owner);
    // 093 and 092 sit above 091 and come off first.
    for (const name of ["095_public_inquiries", "094_team_deletion", "093_user_plans", "092_contact_deletion"]) {
      const later = await migrateDown(owner.db);
      expect(later.error).toBeUndefined();
      expect(later.applied).toEqual([name]);
    }
    const down = await migrateDown(owner.db);
    expect(down.error).toBeUndefined();
    expect(down.applied).toEqual(["091_contact_connections"]);
    const gone = await sql<{ n: string }>`
      select count(*)::text as n from pg_tables where tablename in ('contact_connections', 'contact_discovery_settings')
    `.execute(owner.db);
    expect(gone.rows[0]?.n).toBe("0");
    const up = await migrateToLatest(owner.db);
    expect(up.error).toBeUndefined();
    expect((await migrationStatus(owner.db)).every(s => s.applied)).toBe(true);
  });
});
