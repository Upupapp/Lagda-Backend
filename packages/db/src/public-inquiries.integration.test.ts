// Messages from the public website (095) on real PostgreSQL, as the runtime role.
//
// What only this suite can prove:
//
//   1. The grants: select and insert for `lagda_app`, and NO update, delete or
//      truncate — a received message cannot be changed or removed by the app.
//   2. A message and its notice to the inbox account commit together under
//      that account's own user context (a GLOBAL_USER row under row-level
//      security), and the notice carries who wrote but not what.
//   3. With no inbox account the message is still stored and nobody is told.
//   4. The table's own checks hold.
//   5. The migration goes down when empty and back up.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { UserId } from "@lagda/contracts";
import {
  submitPublicInquiry, listPublicInquiries, getPublicInquiry,
  createTemplateRegistry, ALL_TEMPLATES, ResourceNotFoundError,
  type PublicInquiryDependencies, type SessionId,
} from "@lagda/application";
import type { LagdaDatabase } from "./client/index.js";
import { createPublicInquiryRepository } from "./repositories/public-inquiries.js";
import { migrateDown, migrateToLatest } from "./migrations/runner.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-10-02T09:00:00.000Z");
const ANA = "usr_pi_ana" as UserId;
const BOSS = "usr_pi_boss" as UserId;
const actor = (userId: UserId) => ({ actorType: "user" as const, userId, sessionId: "ses_pi" as SessionId });

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("public inquiries (runtime role)", () => {
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
    await seedUser(owner, BOSS, { email: "11corteschristopher@gmail.com" });
  });

  const repo = () => createPublicInquiryRepository(app.db);
  let seq = 0;
  const deps = (inboxEmail: string | null = "11corteschristopher@gmail.com"): PublicInquiryDependencies => ({
    inquiries: repo(),
    clock: { now: () => AT },
    ids: { nextPublicInquiryId: () => `pin_pi_${String(++seq)}` },
    templates: createTemplateRegistry(ALL_TEMPLATES),
    notificationIds: {
      nextNotificationIntentId: () => `nint_pi_${String(++seq)}` as never,
      nextNotificationDeliveryId: () => `ndel_pi_${String(++seq)}` as never,
    },
    inboxEmail,
  });

  const contact = {
    kind: "contact", name: "Maria Santos", email: "maria@example.ph", topic: "Sales",
    subject: "Pricing for a law office", message: "We are twelve lawyers. How does Business work?",
    consent: true,
  };

  it("grants select and insert, and never update, delete or truncate", async () => {
    const r = await sql<{ s: boolean; i: boolean; u: boolean; d: boolean; t: boolean }>`
      select has_table_privilege('lagda_app', 'public_inquiries', 'SELECT') as s,
             has_table_privilege('lagda_app', 'public_inquiries', 'INSERT') as i,
             has_table_privilege('lagda_app', 'public_inquiries', 'UPDATE') as u,
             has_table_privilege('lagda_app', 'public_inquiries', 'DELETE') as d,
             has_table_privilege('lagda_app', 'public_inquiries', 'TRUNCATE') as t
    `.execute(owner.db);
    expect(r.rows[0]).toEqual({ s: true, i: true, u: false, d: false, t: false });
  });

  it("stores a message and tells the inbox account, in one transaction", async () => {
    const receipt = await submitPublicInquiry(contact, deps());
    const rows = await owner.db.selectFrom("public_inquiries").selectAll().execute();
    expect(rows.map(r => [r.inquiry_id, r.kind, r.name, r.email, r.topic]))
      .toEqual([[receipt.inquiryId, "contact", "Maria Santos", "maria@example.ph", "Sales"]]);

    const notices = await owner.db.selectFrom("notification_intents")
      .select(["notification_type", "audience_user_id", "user_id", "source_kind", "source_id", "template_input"])
      .execute();
    expect(notices.map(n => [n.notification_type, n.audience_user_id, n.user_id, n.source_kind, n.source_id]))
      .toEqual([["PUBLIC_INQUIRY_RECEIVED", BOSS, BOSS, "PUBLIC_INQUIRY", receipt.inquiryId]]);
    // Who wrote, never what they wrote.
    const frozen = JSON.stringify(notices[0]?.template_input);
    expect(frozen).toContain("maria@example.ph");
    expect(frozen).not.toContain("twelve lawyers");

    const deliveries = await owner.db.selectFrom("notification_deliveries")
      .select(["channel", "destination"]).execute();
    expect(deliveries).toEqual([{ channel: "EMAIL", destination: "11corteschristopher@gmail.com" }]);
  });

  it("is read by the inbox account and by nobody else", async () => {
    const { inquiryId } = await submitPublicInquiry(contact, deps());
    const inbox = await listPublicInquiries(actor(BOSS), {}, deps());
    expect(inbox.inquiries.map(i => i.inquiryId)).toEqual([inquiryId]);
    expect(inbox.counts).toEqual({ demo: 0, contact: 1, waitlist: 0 });
    expect((await getPublicInquiry(actor(BOSS), inquiryId, deps())).message)
      .toBe("We are twelve lawyers. How does Business work?");
    await expect(listPublicInquiries(actor(ANA), {}, deps())).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("stores the message and tells nobody when there is no inbox account", async () => {
    await submitPublicInquiry(contact, deps(null));
    await submitPublicInquiry({ ...contact, kind: "waitlist", topic: "notary" }, deps("nobody@example.com"));
    expect((await owner.db.selectFrom("public_inquiries").select("kind").orderBy("kind").execute()).map(r => r.kind))
      .toEqual(["contact", "waitlist"]);
    expect(await owner.db.selectFrom("notification_intents").select("notification_type").execute()).toEqual([]);
  });

  it("cannot be changed or removed by the runtime role", async () => {
    const { inquiryId } = await submitPublicInquiry(contact, deps(null));
    await expect(sql`update public_inquiries set name = 'x' where inquiry_id = ${inquiryId}`.execute(app.db))
      .rejects.toThrow(/permission denied/);
    await expect(sql`delete from public_inquiries where inquiry_id = ${inquiryId}`.execute(app.db))
      .rejects.toThrow(/permission denied/);
  });

  it("refuses a kind or an address the table does not accept", async () => {
    const row = { name: "A", email: "a@example.com", created_at: new Date(AT) };
    await expect(owner.db.insertInto("public_inquiries")
      .values({ ...row, inquiry_id: "pin_x1", kind: "newsletter" }).execute()).rejects.toThrow(/kind_check/);
    await expect(owner.db.insertInto("public_inquiries")
      .values({ ...row, inquiry_id: "pin_x2", kind: "demo", email: "nope" }).execute()).rejects.toThrow(/email_check/);
    await expect(owner.db.insertInto("public_inquiries")
      .values({ ...row, inquiry_id: "pin_x3", kind: "demo", name: "   " }).execute()).rejects.toThrow(/name_check/);
  });

  it("goes down when empty and back up", async () => {
    await truncateAll(owner);
    const newer = await migrateDown(owner.db);
    expect(newer.error).toBeUndefined();
    expect(newer.applied).toEqual(["096_document_waiting_notice"]);
    const down = await migrateDown(owner.db);
    expect(down.error).toBeUndefined();
    expect(down.applied).toEqual(["095_public_inquiries"]);
    const gone = await sql<{ n: string }>`
      select count(*)::text as n from pg_tables where tablename = 'public_inquiries'
    `.execute(owner.db);
    expect(gone.rows[0]?.n).toBe("0");
    expect((await migrateToLatest(owner.db)).error).toBeUndefined();
  });
});
