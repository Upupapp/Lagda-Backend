// 077 against real PostgreSQL: an inbox entry records its role, a copy
// recipient's entry holds no credential, and an unknown role is refused.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { LagdaDatabase } from "./client/index.js";
import { createUserSigningRecordsRepository } from "./repositories/user-signing-records.js";
import { createTestDatabase, hasIntegrationDatabase, seedUser, truncateAll } from "./testing/harness.js";

const suite = hasIntegrationDatabase() ? describe : describe.skip;
const NOW = Date.parse("2026-09-26T08:00:00.000Z");
const USER = "usr_inbox_077";

const entry = (over: Record<string, unknown> = {}) => ({
  userId: USER, signingRequestId: "sr_077", recipientId: "srr_signer", workspaceId: "ws_077",
  recipientNormalizedEmail: "me@example.com", grantCredentialDigest: "b".repeat(64) as string | null,
  recipientType: "signer" as string | null, documentTitle: "Lease", senderName: "Paul",
  senderEmail: "paul@example.com", workspaceName: "Acme", invitedAt: NOW - 1000, expiresAt: NOW + 86_400_000,
  ...over,
});

suite("signing inbox roles (077)", () => {
  let db: LagdaDatabase;
  beforeAll(async () => { db = await createTestDatabase(); });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await truncateAll(db);
    await sql`delete from user_signing_inbox`.execute(db.db);
    await seedUser(db, USER, { email: "me@example.com" });
  });

  it("stores each entry's role and lists every open one", async () => {
    const records = createUserSigningRecordsRepository(db.db);
    await records.openInboxEntry(entry());
    await records.openInboxEntry(entry({ recipientId: "srr_approver", recipientType: "approver" }));
    await records.openInboxEntry(entry({ recipientId: "srr_viewer", recipientType: "viewer" }));

    const listed = await records.listOpenInboxForUser(USER, NOW, 10);
    expect(listed.map(e => e.recipientType).sort()).toEqual(["approver", "signer", "viewer"]);
  });

  it("accepts a copy recipient's entry with no credential", async () => {
    const records = createUserSigningRecordsRepository(db.db);
    await records.openInboxEntry(entry({ recipientId: "srr_cc", recipientType: "carbon-copy", grantCredentialDigest: null }));
    const [found] = await records.listOpenInboxForUser(USER, NOW, 10);
    expect(found).toMatchObject({ recipientType: "carbon-copy", grantCredentialDigest: null });
  });

  it("refuses a role outside the vocabulary", async () => {
    const records = createUserSigningRecordsRepository(db.db);
    await expect(records.openInboxEntry(entry({ recipientType: "notary" })))
      .rejects.toThrow(/user_signing_inbox_recipient_type_check/);
  });

  it("left row level security FORCED on the recipients table after the backfill", async () => {
    const { rows } = await sql<{ forced: boolean }>`
      select relforcerowsecurity as forced from pg_class where relname = 'signing_request_recipients'
    `.execute(db.db);
    expect(rows[0]?.forced).toBe(true);
  });
});
