// Workspace branding (082) against REAL PostgreSQL, as the REAL RUNTIME ROLE.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { UserId, WorkspaceId } from "@lagda/contracts";
import {
  CreateWorkspace, getWorkspaceBranding, updateWorkspaceBranding, setWorkspaceLogo,
  removeWorkspaceLogo, getWorkspaceLogo,
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

const AT = Date.parse("2026-09-26T10:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const OTHER = "usr_other" as UserId;
const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});
const LOGO = { bytes: new Uint8Array(Buffer.from("89504e47", "hex")), width: 300, height: 90, digest: "b".repeat(64) };

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("workspace branding on PostgreSQL", () => {
  let owner: LagdaDatabase;
  let app: LagdaDatabase;
  let workspaceId: WorkspaceId;
  let otherWorkspaceId: WorkspaceId;

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

  const deps = () => ({ transactions: createTransactionManager(app.db), clock: new FixedClock(AT) });

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, OWNER, { email: "owner@example.com" });
    await seedUser(owner, OTHER, { email: "other@example.com" });
    const ids = new SequentialWorkspaceIds();
    const create = (userId: UserId, name: string) => new CreateWorkspace({
      transactions: createTransactionManager(app.db), clock: new FixedClock(AT),
      workspaceIds: ids, memberIds: new SequentialMemberIds(),
      idempotency: {
        digester: createIdempotencyKeyDigester(), ids: createIdempotencyRecordIds(),
        clock: new FixedClock(AT), policy: { retentionMs: 86_400_000 },
      },
    }).execute({ actor: actor(userId), name });
    workspaceId = (await create(OWNER, "Acme Legal")).workspaceId;
    await withRawGlobalTransaction(owner, trx => trx.updateTable("workspace_memberships")
      .set({ member_id: "mem_first" }).where("workspace_id", "=", workspaceId).execute());
    otherWorkspaceId = (await create(OTHER, "Other Firm")).workspaceId;
  });

  it("saves, reads and clears branding and the logo as the runtime role", async () => {
    await updateWorkspaceBranding(actor(OWNER), workspaceId,
      { senderDisplayName: "Acme Team", primaryColor: "#0a4b8c" }, deps());
    await setWorkspaceLogo(actor(OWNER), workspaceId, LOGO, deps());
    const view = await getWorkspaceBranding(actor(OWNER), workspaceId, deps());
    expect(view).toMatchObject({ senderDisplayName: "Acme Team", primaryColor: "#0A4B8C", logo: { version: LOGO.digest } });
    expect((await getWorkspaceLogo(actor(OWNER), workspaceId, deps()))?.bytes).toEqual(LOGO.bytes);
    await removeWorkspaceLogo(actor(OWNER), workspaceId, deps());
    expect((await getWorkspaceBranding(actor(OWNER), workspaceId, deps())).logo).toBeNull();
  });

  it("keeps each workspace's branding to itself", async () => {
    await updateWorkspaceBranding(actor(OWNER), workspaceId, { primaryColor: "#112233" }, deps());
    expect((await getWorkspaceBranding(actor(OTHER), otherWorkspaceId, deps())).primaryColor).toBeNull();
    await expect(getWorkspaceBranding(actor(OTHER), workspaceId, deps())).rejects.toThrow();
  });

  it("gives the runtime role no DELETE", async () => {
    await updateWorkspaceBranding(actor(OWNER), workspaceId, { primaryColor: "#112233" }, deps());
    await expect(app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.workspace_id', ${workspaceId}, true)`.execute(trx);
      await trx.deleteFrom("workspace_branding").execute();
    })).rejects.toThrow(/permission denied/);
  });

  it("refuses a bad colour and half a logo at the database", async () => {
    await expect(withRawGlobalTransaction(owner, trx => trx.insertInto("workspace_branding").values({
      workspace_id: workspaceId, primary_color: "#abcdeg", updated_at: new Date(AT),
    } as never).execute())).rejects.toThrow(/color_check/);
    await expect(withRawGlobalTransaction(owner, trx => trx.insertInto("workspace_branding").values({
      workspace_id: workspaceId, logo_bytes: Buffer.from([1]), updated_at: new Date(AT),
    } as never).execute())).rejects.toThrow(/logo_together/);
  });

  it("logs branding changes in the activity log", async () => {
    await updateWorkspaceBranding(actor(OWNER), workspaceId, { footerTagline: "Since 1998" }, deps());
    const rows = await withRawGlobalTransaction(owner, trx => trx.selectFrom("workspace_activity_events")
      .select(["action"]).where("workspace_id", "=", workspaceId).execute());
    expect(rows.map(r => r.action)).toContain("workspace.branding_changed");
  });
});
