// 089. The invitee inbox on REAL PostgreSQL, as the runtime role: matching
// by the VERIFIED address only, the realm's RLS both ways (it reads across
// workspaces and writes nothing), the required decline reason, withdrawing a
// decline, the in-app notices and the feed, the logo scope, no DELETE or
// TRUNCATE, the backfill under FORCE as a table-owning runtime role, and the
// migration's down/up.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { UserId, WorkspaceId, WorkspaceInvitationId, WorkspaceMemberId } from "@lagda/contracts";
import {
  createWorkspaceInvitation, resendWorkspaceInvitation, revokeWorkspaceInvitation,
  listMyInvitations, acceptMyInvitation, declineMyInvitation, withdrawMyInvitationDecline,
  getMyInvitationLogo, InvitationInboxEmailUnverifiedError, InvitationStateConflictError,
  ApplicationValidationError, ResourceNotFoundError, createTemplateRegistry, ALL_TEMPLATES,
  type InvitationDependencies, type MyInvitationDependencies, type InvitationTokenFactory,
  type AuthenticatedActor, type SessionId,
} from "@lagda/application";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import type { LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import { createNotificationFeedRepository } from "./repositories/notification-feed.js";
import { inviteeDigestSql } from "./repositories/invitations.js";
import { migrateDown, migrateToLatest, migrationStatus } from "./migrations/runner.js";
import * as m089 from "./migrations/089_invitation_inbox.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-09-28T09:00:00.000Z");
const TTL = 7 * 24 * 3_600_000;
const WS_A = "ws_inbox_a" as WorkspaceId;
const WS_B = "ws_inbox_b" as WorkspaceId;
const OWNER_A = "usr_inbox_owner_a" as UserId;
const OWNER_B = "usr_inbox_owner_b" as UserId;
const INVITEE = "usr_inbox_invitee" as UserId;
const STRANGER = "usr_inbox_stranger" as UserId;
const UNVERIFIED = "usr_inbox_unverified" as UserId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

/** Real-shaped credentials: a 64-hex digest the 014 CHECK accepts. */
function tokens(): InvitationTokenFactory {
  const digest = (raw: string) => createHash("sha256").update(raw).digest("hex") as never;
  return {
    issue: () => {
      const raw = randomBytes(32).toString("base64url");
      return { raw, digest: digest(raw) };
    },
    digest: (submitted: string) => (submitted.length === 43 ? digest(submitted) : null),
  };
}

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("invitee inbox (089, runtime role)", () => {
  let owner: LagdaDatabase;
  let app: LagdaDatabase;
  let now = AT;
  let seq = 0;
  const clock = { now: () => now };
  const next = (prefix: string) => `${prefix}_${String(++seq)}`;
  const notices = () => ({
    clock,
    templates: createTemplateRegistry(ALL_TEMPLATES),
    ids: {
      nextInvitationNoticeId: () => next("ivn"),
      nextNotificationIntentId: () => next("nint_inbox") as never,
      nextNotificationDeliveryId: () => next("ndel_inbox") as never,
    },
  });
  let inviteDeps: InvitationDependencies;
  let deps: MyInvitationDependencies;

  beforeAll(async () => {
    owner = await createTestDatabase();
    app = await createRuntimeRoleDatabase(owner);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
  });

  beforeEach(async () => {
    now = AT;
    await truncateAll(owner);
    await seedUser(owner, OWNER_A, { email: "owner.a@example.com" });
    await seedUser(owner, OWNER_B, { email: "owner.b@example.com" });
    await seedUser(owner, INVITEE, { email: "Ivy.Invitee@Example.com" });
    await seedUser(owner, STRANGER, { email: "stranger@example.com" });
    await seedUser(owner, UNVERIFIED, { email: "unverified@example.com" });
    await owner.db.updateTable("users").set({ email_verified_at: new Date(AT - 1000) })
      .where("user_id", "in", [OWNER_A, OWNER_B, INVITEE, STRANGER]).execute();
    const tx = createTransactionManager(owner.db);
    for (const [ws, who] of [[WS_A, OWNER_A], [WS_B, OWNER_B]] as const) {
      await tx.runForWorkspace(ws, async uow => {
        await uow.workspaces.insert({ workspaceId: ws, name: `Firm ${ws}`, createdAt: AT });
        await uow.memberships.insert({
          memberId: `mem_${ws}` as WorkspaceMemberId, workspaceId: ws, userId: who, role: "owner", createdAt: AT,
        });
      });
    }
    await tx.runForWorkspace(WS_A, uow =>
      uow.branding.saveLogo({ bytes: new Uint8Array([137, 80, 78, 71]), width: 4, height: 4, digest: "a".repeat(64) }, AT));

    const transactions = createTransactionManager(app.db);
    inviteDeps = {
      transactions, clock,
      invitationIds: { nextWorkspaceInvitationId: () => next("inv_inbox") as WorkspaceInvitationId },
      tokens: tokens(),
      links: { build: raw => `https://app.lagda.test/accept-invitation?token=${raw}` },
      idempotency: {
        digester: createIdempotencyKeyDigester(), ids: createIdempotencyRecordIds(),
        clock, policy: { retentionMs: 86_400_000 },
      },
      notices: notices(),
    };
    deps = {
      transactions, clock,
      joinRequests: {
        clock,
        templates: createTemplateRegistry(ALL_TEMPLATES),
        ids: {
          nextJoinTicketId: () => next("jtk") as never,
          nextJoinRequestId: () => next("jrq") as never,
          nextJoinNoticeId: () => next("jnt"),
          nextNotificationIntentId: () => next("nint_join") as never,
          nextNotificationDeliveryId: () => next("ndel_join") as never,
          nextWorkspaceMemberId: () => next("mem_join") as never,
        },
      },
      notices: notices(),
      currentAccount: async userId => {
        const row = await owner.db.selectFrom("users")
          .select(["normalized_email", "email_verified_at", "display_name"])
          .where("user_id", "=", userId).executeTakeFirst();
        return row === undefined ? null : {
          normalizedEmail: row.normalized_email, emailVerified: row.email_verified_at !== null,
          displayName: row.display_name,
        };
      },
    };
  });

  const invite = async (ws: WorkspaceId, by: UserId, email: string) =>
    (await createWorkspaceInvitation({ actor: actor(by), workspaceId: ws, email, role: "sender" }, inviteDeps))
      .invitationId;

  const notices$ = () => owner.db.selectFrom("notification_intents")
    .innerJoin("notification_deliveries", "notification_deliveries.notification_intent_id",
      "notification_intents.notification_intent_id")
    .select([
      "notification_intents.notification_type", "notification_intents.audience_user_id",
      "notification_intents.source_kind", "notification_intents.template_input",
      "notification_deliveries.state", "notification_deliveries.failure_code",
    ])
    .where("notification_intents.notification_type", "in",
      ["WORKSPACE_INVITATION_RECEIVED", "WORKSPACE_INVITATION_DECLINED"])
    .orderBy("notification_intents.created_at").orderBy("notification_intents.notification_intent_id")
    .execute();

  it("matches by the VERIFIED normalized address only, across workspaces", async () => {
    const a = await invite(WS_A, OWNER_A, "IVY.INVITEE@example.com");
    const b = await invite(WS_B, OWNER_B, "ivy.invitee@example.com");
    await invite(WS_A, OWNER_A, "stranger@example.com");
    await invite(WS_A, OWNER_A, "unverified@example.com");

    const mine = await listMyInvitations(INVITEE, "pending", deps);
    expect(mine.map(i => [i.invitationId, i.workspaceId]).sort()).toEqual([[a, WS_A], [b, WS_B]].sort());
    const fromA = mine.find(i => i.workspaceId === WS_A);
    expect(fromA).toMatchObject({
      workspaceName: `Firm ${WS_A}`, role: "sender", invitedBy: { displayName: OWNER_A },
      branding: { displayName: `Firm ${WS_A}`, primaryColor: null, logo: { version: "a".repeat(64) } },
    });
    expect((await listMyInvitations(STRANGER, "pending", deps)).map(i => i.workspaceId)).toEqual([WS_A]);
    await expect(listMyInvitations(UNVERIFIED, "pending", deps)).rejects.toBeInstanceOf(InvitationInboxEmailUnverifiedError);

    // The stored digest is the SQL digest of the address, set by the trigger.
    const digest = await sql<{ d: string }>`select ${inviteeDigestSql("ivy.invitee@example.com")} as d`.execute(owner.db);
    const stored = await owner.db.selectFrom("workspace_invitations").select("invitee_email_digest")
      .where("invitation_id", "=", a).executeTakeFirstOrThrow();
    expect(stored.invitee_email_digest).toBe(digest.rows[0]?.d);
  });

  it("an account whose address changed no longer sees the old address's invitations", async () => {
    await invite(WS_A, OWNER_A, "ivy.invitee@example.com");
    await owner.db.updateTable("users")
      .set({ email: "ivy@elsewhere.example", normalized_email: "ivy@elsewhere.example" })
      .where("user_id", "=", INVITEE).execute();
    expect(await listMyInvitations(INVITEE, "pending", deps)).toEqual([]);
  });

  it("the realm reads only its own address, never writes, and nothing is visible without it", async () => {
    const a = await invite(WS_A, OWNER_A, "ivy.invitee@example.com");
    await invite(WS_B, OWNER_B, "stranger@example.com");

    expect(await app.db.selectFrom("workspace_invitations").selectAll().execute()).toEqual([]);
    const seen = await app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.workspace_invitee', ${inviteeDigestSql("ivy.invitee@example.com")}, true)`.execute(trx);
      const rows = await trx.selectFrom("workspace_invitations").select(["invitation_id", "workspace_id"]).execute();
      const updated = await sql`update workspace_invitations set declined_at = now()`.execute(trx);
      return { rows, updated: Number(updated.numAffectedRows ?? 0n) };
    });
    expect(seen.rows).toEqual([{ invitation_id: a, workspace_id: WS_A }]);
    expect(seen.updated).toBe(0);

    // Inside ANOTHER workspace, the realm still cannot write this one.
    const crossWrite = await app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.workspace_invitee', ${inviteeDigestSql("ivy.invitee@example.com")}, true)`.execute(trx);
      await sql`select set_config('lagda.workspace_id', ${WS_B}, true)`.execute(trx);
      return sql`update workspace_invitations set declined_at = now() where invitation_id = ${a}`.execute(trx);
    });
    expect(Number(crossWrite.numAffectedRows ?? 0n)).toBe(0);

    // The runtime role cannot delete or truncate an invitation.
    await expect(app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
      await sql`delete from workspace_invitations`.execute(trx);
    })).rejects.toThrow(/permission denied/u);
    await expect(sql`truncate workspace_invitations`.execute(app.db)).rejects.toThrow(/permission denied/u);
  });

  it("answers 404 for another address's invitation through every use case", async () => {
    const theirs = await invite(WS_A, OWNER_A, "stranger@example.com");
    await expect(acceptMyInvitation(actor(INVITEE), theirs, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(declineMyInvitation(actor(INVITEE), theirs, { reason: "x" }, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(withdrawMyInvitationDecline(actor(INVITEE), theirs, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(getMyInvitationLogo(INVITEE, theirs, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("serves the logo only through a listed invitation of the caller's", async () => {
    const a = await invite(WS_A, OWNER_A, "ivy.invitee@example.com");
    const b = await invite(WS_B, OWNER_B, "ivy.invitee@example.com");
    expect((await getMyInvitationLogo(INVITEE, a, deps))?.digest).toBe("a".repeat(64));
    expect(await getMyInvitationLogo(INVITEE, b, deps)).toBeNull();
    await revokeWorkspaceInvitation(actor(OWNER_A), WS_A, a, inviteDeps);
    await expect(getMyInvitationLogo(INVITEE, a, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("accepting consumes the invitation and files the pending join request", async () => {
    const a = await invite(WS_A, OWNER_A, "ivy.invitee@example.com");
    const result = await acceptMyInvitation(actor(INVITEE), a, deps);
    expect(result).toEqual({ workspaceId: WS_A, workspaceName: `Firm ${WS_A}`, role: "sender", joined: false, pending: true });
    const row = await owner.db.selectFrom("workspace_invitations").select(["accepted_at", "accepted_by_user_id"])
      .where("invitation_id", "=", a).executeTakeFirstOrThrow();
    expect(row.accepted_by_user_id).toBe(INVITEE);
    const requests = await owner.db.selectFrom("workspace_join_requests")
      .select(["invitation_id", "state", "requested_role", "user_id"]).execute();
    expect(requests).toEqual([{ invitation_id: a, state: "pending", requested_role: "sender", user_id: INVITEE }]);
    expect((await listMyInvitations(INVITEE, "accepted", deps)).map(i => i.invitationId)).toEqual([a]);
    await expect(acceptMyInvitation(actor(INVITEE), a, deps)).rejects.toBeInstanceOf(InvitationStateConflictError);
  });

  it("declining requires a reason, stores it, tells the inviter in-app only, and logs it", async () => {
    const a = await invite(WS_A, OWNER_A, "ivy.invitee@example.com");
    await expect(declineMyInvitation(actor(INVITEE), a, { reason: "  " }, deps))
      .rejects.toBeInstanceOf(ApplicationValidationError);
    now = AT + 5000;
    const view = await declineMyInvitation(actor(INVITEE), a, { reason: "Joined another firm" }, deps);
    expect(view).toMatchObject({ status: "declined", declineReason: "Joined another firm", declinedAt: AT + 5000 });
    const row = await owner.db.selectFrom("workspace_invitations").select(["declined_at", "decline_reason"])
      .where("invitation_id", "=", a).executeTakeFirstOrThrow();
    expect(row).toEqual({ declined_at: new Date(AT + 5000), decline_reason: "Joined another firm" });

    const all = await notices$();
    expect(all.map(n => [n.notification_type, n.audience_user_id, n.source_kind, n.state, n.failure_code])).toEqual([
      ["WORKSPACE_INVITATION_RECEIVED", INVITEE, "WORKSPACE_INVITATION_NOTICE", "SUPPRESSED", "IN_APP_ONLY"],
      ["WORKSPACE_INVITATION_DECLINED", OWNER_A, "WORKSPACE_INVITATION_NOTICE", "SUPPRESSED", "IN_APP_ONLY"],
    ]);
    expect(all[1]?.template_input).toMatchObject({
      invitationId: a, workspaceName: `Firm ${WS_A}`, inviterDisplayName: OWNER_A, role: "sender",
      inviteeDisplayName: INVITEE, inviteeEmail: "ivy.invitee@example.com", reason: "Joined another firm",
      expiresAt: new Date(AT + TTL).toISOString(),
    });
    // Each audience reads its notice in its own feed — and only its own.
    const ownerFeed = await createNotificationFeedRepository(app.db).listForUser(OWNER_A, 50);
    expect(ownerFeed.map(n => n.notificationType)).toEqual(["WORKSPACE_INVITATION_DECLINED"]);
    const inviteeFeed = await createNotificationFeedRepository(app.db).listForUser(INVITEE, 50);
    expect(inviteeFeed.map(n => n.notificationType)).toEqual(["WORKSPACE_INVITATION_RECEIVED"]);
    expect(await createNotificationFeedRepository(app.db).listForUser(STRANGER, 50)).toEqual([]);

    const activity = await owner.db.selectFrom("workspace_activity_events").select(["action", "details"])
      .where("workspace_id", "=", WS_A).where("action", "=", "invitation.declined").execute();
    expect(activity).toHaveLength(1);
    expect(activity[0]?.details).toMatchObject({ reason: "Joined another firm" });
  });

  it("withdrawing a decline reopens it; 409 once expired, revoked, or when a newer invitation is live", async () => {
    const a = await invite(WS_A, OWNER_A, "ivy.invitee@example.com");
    await declineMyInvitation(actor(INVITEE), a, { reason: "Not yet" }, deps);
    const reopened = await withdrawMyInvitationDecline(actor(INVITEE), a, deps);
    expect(reopened).toMatchObject({ status: "pending", declinedAt: null, declineReason: null });
    const row = await owner.db.selectFrom("workspace_invitations").select(["declined_at", "decline_reason"])
      .where("invitation_id", "=", a).executeTakeFirstOrThrow();
    expect(row).toEqual({ declined_at: null, decline_reason: null });
    const actions = await owner.db.selectFrom("workspace_activity_events").select("action")
      .where("workspace_id", "=", WS_A).orderBy("occurred_at").orderBy("event_id").execute();
    expect(actions.map(r => r.action)).toContain("invitation.decline_withdrawn");
    await expect(withdrawMyInvitationDecline(actor(INVITEE), a, deps)).rejects.toBeInstanceOf(InvitationStateConflictError);

    // A newer live invitation holds the slot: the unique index answers 409.
    await declineMyInvitation(actor(INVITEE), a, { reason: "No" }, deps);
    const newer = await invite(WS_A, OWNER_A, "ivy.invitee@example.com");
    await expect(withdrawMyInvitationDecline(actor(INVITEE), a, deps)).rejects.toBeInstanceOf(InvitationStateConflictError);

    // Expired.
    await declineMyInvitation(actor(INVITEE), newer, { reason: "No" }, deps);
    now = AT + TTL + 1;
    await expect(withdrawMyInvitationDecline(actor(INVITEE), newer, deps)).rejects.toBeInstanceOf(InvitationStateConflictError);
  });

  it("tells the verified account on every resend, and no one for an address without one", async () => {
    const a = await invite(WS_A, OWNER_A, "ivy.invitee@example.com");
    await invite(WS_A, OWNER_A, "unverified@example.com");
    await invite(WS_A, OWNER_A, "nobody@example.com");
    await resendWorkspaceInvitation({ actor: actor(OWNER_A), workspaceId: WS_A, invitationId: a }, inviteDeps);
    const received = (await notices$()).filter(n => n.notification_type === "WORKSPACE_INVITATION_RECEIVED");
    expect(received.map(n => n.audience_user_id)).toEqual([INVITEE, INVITEE]);
  });

  it("widens the vocabularies and keeps RLS forced", async () => {
    const rows = await sql<{ def: string }>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conname in ('notification_intents_type_check', 'notification_intents_source_kind_check',
                         'workspace_activity_events_action_check')
    `.execute(owner.db);
    const defs = rows.rows.map(r => r.def).join(" ");
    for (const value of ["WORKSPACE_INVITATION_RECEIVED", "WORKSPACE_INVITATION_DECLINED",
      "WORKSPACE_INVITATION_NOTICE", "invitation.decline_withdrawn"]) {
      expect(defs).toContain(value);
    }
    const flags = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      select relrowsecurity, relforcerowsecurity from pg_class where relname = 'workspace_invitations'
    `.execute(owner.db);
    expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    // A decline reason only on a declined row.
    await invite(WS_A, OWNER_A, "ivy.invitee@example.com");
    await expect(owner.db.updateTable("workspace_invitations").set({ decline_reason: "sneaky" }).execute())
      .rejects.toThrow(/chk_workspace_invitations_decline_reason/u);
  });

  it("backfills the digest when a table-owning runtime role migrates under FORCE", async () => {
    await truncateAll(owner);
    await seedUser(owner, OWNER_A, { email: "owner.a@example.com" });
    // 092, 091 and 090 sit above 089 and come off first; all are empty here.
    for (const name of ["095_public_inquiries", "094_team_deletion", "093_user_plans", "092_contact_deletion", "091_contact_connections", "090_user_notification_states"]) {
      const later = await migrateDown(owner.db);
      expect(later.error).toBeUndefined();
      expect(later.applied).toEqual([name]);
    }
    const down = await migrateDown(owner.db);
    expect(down.error).toBeUndefined();
    expect(down.applied).toEqual(["089_invitation_inbox"]);
    await createTransactionManager(owner.db).runForWorkspace(WS_A, uow =>
      uow.workspaces.insert({ workspaceId: WS_A, name: "Firm", createdAt: AT }));
    await sql`
      insert into workspace_invitations (
        invitation_id, workspace_id, invitee_email, invitee_normalized_email, requested_role,
        invited_by_user_id, token_digest, created_at, expires_at
      ) values (
        'inv_legacy', ${WS_A}, 'Legacy@Example.com', 'legacy@example.com', 'sender',
        ${OWNER_A}, ${"b".repeat(64)}, ${new Date(AT)}, ${new Date(AT + TTL)}
      )
    `.execute(owner.db);

    // Production's shape: lagda_app OWNS the tables 089 alters and runs it,
    // with FORCE row-level security applying to it. Rolled back afterwards.
    const Rollback = new Error("rollback");
    let backfilled: string | null | undefined;
    await expect(owner.db.transaction().execute(async trx => {
      for (const table of ["workspace_invitations", "notification_intents", "workspace_activity_events"]) {
        await sql`alter table ${sql.table(table)} owner to lagda_app`.execute(trx);
      }
      await sql`grant create on schema public to lagda_app`.execute(trx);
      await sql`set local role lagda_app`.execute(trx);
      await m089.up(trx as unknown as Kysely<unknown>);
      await sql`reset role`.execute(trx);
      const row = await sql<{ d: string | null }>`
        select invitee_email_digest as d from workspace_invitations where invitation_id = 'inv_legacy'
      `.execute(trx);
      backfilled = row.rows[0]?.d;
      throw Rollback;
    })).rejects.toBe(Rollback);
    const expected = await sql<{ d: string }>`select ${inviteeDigestSql("legacy@example.com")} as d`.execute(owner.db);
    expect(backfilled).toBe(expected.rows[0]?.d);

    // And the real migration, back up.
    const up = await migrateToLatest(owner.db);
    expect(up.error).toBeUndefined();
    expect((await migrationStatus(owner.db)).every(s => s.applied)).toBe(true);
    const after = await owner.db.selectFrom("workspace_invitations").select(["invitee_email_digest", "decline_reason"])
      .where("invitation_id", "=", "inv_legacy").executeTakeFirstOrThrow();
    expect(after).toEqual({ invitee_email_digest: expected.rows[0]?.d, decline_reason: null });
  });

  it("goes down when empty and back up", async () => {
    await truncateAll(owner);
    // 092, 091 and 090 sit above 089 and come off first; all are empty here.
    for (const name of ["095_public_inquiries", "094_team_deletion", "093_user_plans", "092_contact_deletion", "091_contact_connections", "090_user_notification_states"]) {
      const later = await migrateDown(owner.db);
      expect(later.error).toBeUndefined();
      expect(later.applied).toEqual([name]);
    }
    const down = await migrateDown(owner.db);
    expect(down.error).toBeUndefined();
    expect(down.applied).toEqual(["089_invitation_inbox"]);
    const columns = await sql<{ n: string }>`
      select count(*)::text as n from information_schema.columns
       where table_name = 'workspace_invitations' and column_name in ('decline_reason', 'invitee_email_digest')
    `.execute(owner.db);
    expect(columns.rows[0]?.n).toBe("0");
    const policy = await sql<{ n: string }>`
      select count(*)::text as n from pg_policies where policyname = 'invitee_inbox_read'
    `.execute(owner.db);
    expect(policy.rows[0]?.n).toBe("0");
    const up = await migrateToLatest(owner.db);
    expect(up.error).toBeUndefined();
    expect((await migrationStatus(owner.db)).every(s => s.applied)).toBe(true);
  });
});
