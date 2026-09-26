// Join links (078) against REAL PostgreSQL, as the REAL RUNTIME ROLE.
//
// What only this file can prove: the credential RLS policy shows one ticket
// and nothing else, a ticket is used exactly once even under a race, one
// pending request per person per workspace, and the constraints that keep a
// withdrawn ticket from carrying a live link.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import type { UserId, WorkspaceId } from "@lagda/contracts";
import {
  CreateWorkspace, createJoinTicket, sendJoinTicket, withdrawJoinTicket, previewJoinLink,
  submitJoinRequest, listJoinRequests, approveJoinRequest, requireCapability,
  JoinLinkUsedError, JoinLinkInvalidError, ResourceNotFoundError,
  type JoinTicketDependencies, type JoinRequestDependencies,
  type AuthenticatedActor, type SessionId,
} from "@lagda/application";
import {
  joinNotifyDependencies,
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import {
  createDatabase, loadDatabaseConfig, createTransactionManager,
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
  withRawGlobalTransaction,
  type LagdaDatabase,
} from "@lagda/db";
import { createJoinTicketTokenFactory, createJoinTicketSecrets } from "@lagda/api";

const AT = Date.parse("2026-09-26T09:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const JUAN = "usr_juan" as UserId;
const ANA = "usr_ana" as UserId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("workspace join links on PostgreSQL", () => {
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
  let ticketDeps: JoinTicketDependencies;
  let requestDeps: JoinRequestDependencies;

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, OWNER, { email: "owner@example.com" });
    await seedUser(owner, JUAN, { email: "juan@example.com" });
    await seedUser(owner, ANA, { email: "ana@example.com" });
    await owner.db.updateTable("users").set({ email_verified_at: new Date(AT) }).execute();

    const transactions = createTransactionManager(app.db);
    const created = await new CreateWorkspace({
      transactions, clock: new FixedClock(AT),
      workspaceIds: new SequentialWorkspaceIds(), memberIds: new SequentialMemberIds(),
      idempotency: {
        digester: createIdempotencyKeyDigester(), ids: createIdempotencyRecordIds(),
        clock: new FixedClock(AT), policy: { retentionMs: 86_400_000 },
      },
    }).execute({ actor: actor(OWNER), name: "Acme Legal" });
    workspaceId = created.workspaceId;

    // A distinct id space from the workspace's sequential member ids.
    const notify = joinNotifyDependencies(new FixedClock(AT));
    const tokens = createJoinTicketTokenFactory();
    ticketDeps = {
      transactions, ...notify, tokens,
      secrets: createJoinTicketSecrets(randomBytes(32).toString("base64"), "v1"),
    };
    requestDeps = {
      transactions, ...notify, tokens,
      currentAccount: async userId => {
        const row = await withRawGlobalTransaction(owner, trx => trx.selectFrom("users")
          .select(["email", "normalized_email", "email_verified_at"])
          .where("user_id", "=", userId).executeTakeFirst());
        return row === undefined ? null : {
          email: row.email, normalizedEmail: row.normalized_email, emailVerified: row.email_verified_at !== null,
        };
      },
    };
  });

  async function sentToken() {
    const draft = await createJoinTicket(actor(OWNER), workspaceId, { label: "For Juan" }, ticketDeps);
    const sent = await sendJoinTicket(actor(OWNER), workspaceId, draft.ticketId, { email: false }, ticketDeps);
    return { ticketId: draft.ticketId, token: sent.linkToken ?? "" };
  }

  const tickets = () => withRawGlobalTransaction(owner, trx =>
    trx.selectFrom("workspace_join_tickets").selectAll().execute());
  const requests = () => withRawGlobalTransaction(owner, trx =>
    trx.selectFrom("workspace_join_requests").selectAll().execute());

  it("stores a digest and a sealed copy, never the raw link token", async () => {
    const { token } = await sentToken();
    const [row] = await tickets();
    expect(row?.token_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.sealed_token).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  describe("credential scope under RLS", () => {
    it("shows exactly the one ticket its digest names, and not another", async () => {
      await sentToken();
      await sentToken();
      const [first] = await tickets();
      const visible = await app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.join_ticket_digest', ${first?.token_digest ?? ""}, true)`.execute(trx);
        return trx.selectFrom("workspace_join_tickets").select("ticket_id").execute();
      });
      expect(visible.map(v => v.ticket_id)).toEqual([first?.ticket_id]);
    });

    it("shows nothing with no context, and cannot write from the credential scope", async () => {
      await sentToken();
      const [row] = await tickets();
      expect(await app.db.selectFrom("workspace_join_tickets").selectAll().execute()).toHaveLength(0);
      const updated = await app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.join_ticket_digest', ${row?.token_digest ?? ""}, true)`.execute(trx);
        return trx.updateTable("workspace_join_tickets").set({ label: "hijacked" }).executeTakeFirst();
      });
      expect(Number(updated.numUpdatedRows)).toBe(0);
      expect((await tickets())[0]?.label).toBe("For Juan");
    });

    it("hides join requests from another workspace's context", async () => {
      const { token } = await sentToken();
      await submitJoinRequest(actor(JUAN), token, { fullName: "Juan Dela Cruz" }, requestDeps);
      const seen = await app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', 'ws_elsewhere', true)`.execute(trx);
        return trx.selectFrom("workspace_join_requests").selectAll().execute();
      });
      expect(seen).toHaveLength(0);
    });
  });

  describe("the ticket", () => {
    it("is used exactly once, even when two people race for it", async () => {
      const { token } = await sentToken();
      const outcomes = await Promise.allSettled([
        submitJoinRequest(actor(JUAN), token, { fullName: "Juan Dela Cruz" }, requestDeps),
        submitJoinRequest(actor(ANA), token, { fullName: "Ana Reyes" }, requestDeps),
      ]);
      expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
      const refused = outcomes.find(o => o.status === "rejected");
      expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(JoinLinkUsedError);
      expect(await requests()).toHaveLength(1);
      await expect(previewJoinLink(token, requestDeps)).rejects.toBeInstanceOf(JoinLinkUsedError);
    });

    it("dies on withdraw, and send-again issues a different live link", async () => {
      const { ticketId, token } = await sentToken();
      await withdrawJoinTicket(actor(OWNER), workspaceId, ticketId, ticketDeps);
      expect((await tickets())[0]).toMatchObject({ state: "withdrawn", token_digest: null, sealed_token: null });
      await expect(previewJoinLink(token, requestDeps)).rejects.toBeInstanceOf(JoinLinkInvalidError);

      const again = await sendJoinTicket(actor(OWNER), workspaceId, ticketId, { email: false }, ticketDeps);
      expect(again.linkToken).not.toBe(token);
      await expect(previewJoinLink(again.linkToken ?? "", requestDeps))
        .resolves.toMatchObject({ workspaceName: "Acme Legal" });
    });

    it("is approved into a New Comer whose privileges really authorize", async () => {
      const { token } = await sentToken();
      await submitJoinRequest(actor(JUAN), token, { fullName: "Juan Dela Cruz", reason: "New associate" }, requestDeps);
      expect(await withRawGlobalTransaction(owner, trx => trx.selectFrom("workspace_memberships")
        .selectAll().where("user_id", "=", JUAN).execute())).toHaveLength(0);

      const [request] = await listJoinRequests(actor(OWNER), workspaceId, "pending", ticketDeps);
      await approveJoinRequest(actor(OWNER), workspaceId, request?.requestId ?? "",
        { roleTitle: "Finance Associate", canAssignSigners: true }, ticketDeps);

      const [member] = await withRawGlobalTransaction(owner, trx => trx.selectFrom("workspace_memberships")
        .selectAll().where("user_id", "=", JUAN).execute());
      expect(member).toMatchObject({
        role: "member", role_title: "Finance Associate", can_request_documents: false, can_assign_signers: true,
      });
      const transactions = createTransactionManager(app.db);
      await expect(requireCapability(JUAN, workspaceId, "signing-request.send", { transactions })).resolves.toBeTruthy();
      await expect(requireCapability(JUAN, workspaceId, "upload-request.create", { transactions }))
        .rejects.toBeInstanceOf(ResourceNotFoundError);
    });
  });

  describe("constraints", () => {
    const raw = (values: Record<string, unknown>) => withRawGlobalTransaction(owner, trx =>
      trx.insertInto("workspace_join_tickets").values({
        ticket_id: "jtk_raw", workspace_id: workspaceId, label: "Raw", state: "draft",
        created_by_user_id: OWNER, created_at: new Date(AT), updated_at: new Date(AT),
        ...values,
      } as never).execute());

    it("refuses a sent ticket with no live link, and a withdrawn one that keeps it", async () => {
      await expect(raw({ state: "sent", sent_at: new Date(AT) })).rejects.toThrow(/live_link/);
      await expect(raw({
        state: "withdrawn", withdrawn_at: new Date(AT), token_digest: "a".repeat(64),
      })).rejects.toThrow();
    });

    it("permits ONE pending request per person per workspace", async () => {
      const a = await sentToken();
      const b = await sentToken();
      await submitJoinRequest(actor(JUAN), a.token, { fullName: "Juan" }, requestDeps);
      const [first] = await requests();
      await expect(withRawGlobalTransaction(owner, trx => trx.insertInto("workspace_join_requests").values({
        ...first!, request_id: "jrq_dup", ticket_id: b.ticketId,
      }).execute())).rejects.toThrow();
    });

    it("refuses a request that asks for OWNER", async () => {
      const a = await sentToken();
      await submitJoinRequest(actor(JUAN), a.token, { fullName: "Juan" }, requestDeps);
      await expect(withRawGlobalTransaction(owner, trx => trx.updateTable("workspace_join_requests")
        .set({ requested_role: "owner" }).execute())).rejects.toThrow();
    });
  });
});
