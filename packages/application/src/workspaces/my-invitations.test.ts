// 089. The signed-in invitee inbox, tested with fakes: matching by the
// VERIFIED address, the decline reason, withdrawing a decline, the in-app
// notices and the activity log. RLS is proved in the Postgres suite.

import { describe, it, expect, beforeEach } from "vitest";
import type { UserId, WorkspaceId, WorkspaceInvitationId } from "@lagda/contracts";
import { INVITATION_TTL_MS } from "@lagda/contracts";
import {
  createWorkspaceInvitation, resendWorkspaceInvitation, declineWorkspaceInvitation,
  type InvitationDependencies,
} from "./invitations.js";
import {
  listMyInvitations, acceptMyInvitation, declineMyInvitation, withdrawMyInvitationDecline,
  getMyInvitationLogo, InvitationInboxEmailUnverifiedError, InvitationStateConflictError,
  type MyInvitationDependencies, type InviteeAccount,
} from "./my-invitations.js";
import { CreateWorkspace } from "./create-workspace.js";
import { describeActivity } from "./activity.js";
import { ApplicationValidationError, ResourceNotFoundError } from "../common/errors/index.js";
import { assertNormalized } from "../auth/email-identity.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import {
  joinNotifyDependencies, invitationNoticeDependencies,
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

const AT = Date.parse("2026-09-28T09:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const INVITEE = "usr_invitee" as UserId;
const STRANGER = "usr_stranger" as UserId;
const UNVERIFIED = "usr_unverified" as UserId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

const ACCOUNTS: Record<string, InviteeAccount> = {
  [INVITEE]: { normalizedEmail: "invitee@example.com", emailVerified: true, displayName: "Ivy Invitee" },
  [STRANGER]: { normalizedEmail: "stranger@example.com", emailVerified: true, displayName: "Sam Stranger" },
  [UNVERIFIED]: { normalizedEmail: "unverified@example.com", emailVerified: false, displayName: "Una" },
};

let store: InMemoryStore;
let transactions: FakeTransactionManager;
let now: number;
let workspaceId: WorkspaceId;
let inviteDeps: InvitationDependencies;
let deps: MyInvitationDependencies;

const clock = { now: () => now };
const intents = () => [...store.notificationIntents.values()];
const actions = () => store.activity.map(a => a.action);

async function invite(email: string): Promise<WorkspaceInvitationId> {
  const created = await createWorkspaceInvitation({
    actor: actor(OWNER), workspaceId, email, role: "sender",
  }, inviteDeps);
  return created.invitationId;
}

beforeEach(async () => {
  now = AT;
  store = new InMemoryStore();
  transactions = new FakeTransactionManager(store);
  store.accountEmails.set(assertNormalized("owner@example.com"), OWNER);
  store.accountEmails.set(assertNormalized("invitee@example.com"), INVITEE);
  store.verifiedAccounts.set("invitee@example.com", { userId: INVITEE, displayName: "Ivy Invitee" });
  const created = await new CreateWorkspace({
    transactions, clock: new FixedClock(AT),
    workspaceIds: new SequentialWorkspaceIds(), memberIds: new SequentialMemberIds(),
    idempotency: {
      digester: createIdempotencyKeyDigester(), ids: createIdempotencyRecordIds(),
      clock: new FixedClock(AT), policy: { retentionMs: 86_400_000 },
    },
  }).execute({ actor: actor(OWNER), name: "Acme Legal" });
  workspaceId = created.workspaceId;
  let n = 0;
  let t = 0;
  inviteDeps = {
    transactions, clock,
    invitationIds: { nextWorkspaceInvitationId: () => `inv_${String(++n)}` as WorkspaceInvitationId },
    tokens: {
      issue: () => {
        const raw = `invtok_${String(++t).padStart(4, "0")}`;
        return { raw, digest: `digest-of-${raw}` as never };
      },
      digest: (s: string) => (s.startsWith("invtok_") ? `digest-of-${s}` as never : null),
    },
    links: { build: raw => `https://app.lagda.test/accept-invitation?token=${raw}` },
    idempotency: {
      digester: createIdempotencyKeyDigester(), ids: createIdempotencyRecordIds(),
      clock: new FixedClock(AT), policy: { retentionMs: 86_400_000 },
    },
    notices: invitationNoticeDependencies(new FixedClock(AT)),
  };
  deps = {
    transactions, clock,
    joinRequests: joinNotifyDependencies(new FixedClock(AT)),
    notices: invitationNoticeDependencies(new FixedClock(AT)),
    currentAccount: userId => Promise.resolve(ACCOUNTS[userId] ?? null),
  };
  await transactions.runForWorkspace(workspaceId, async uow => {
    await uow.branding.saveSettings({ senderDisplayName: "Acme Law Offices", footerTagline: null, primaryColor: "#123ABC" }, AT);
    await uow.branding.saveLogo({ bytes: new Uint8Array([137, 80]), width: 10, height: 10, digest: "d".repeat(64) }, AT);
  });
});

describe("my invitations — matching", () => {
  it("lists only invitations addressed to the verified address, with the inviting workspace's branding", async () => {
    const mine = await invite("Invitee@Example.com");
    await invite("someone.else@example.com");
    const items = await listMyInvitations(INVITEE, "pending", deps);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      invitationId: mine, workspaceId, workspaceName: "Acme Legal", role: "sender", status: "pending",
      createdAt: AT, expiresAt: AT + INVITATION_TTL_MS, declinedAt: null, declineReason: null,
      branding: { displayName: "Acme Law Offices", primaryColor: "#123ABC", logo: { version: "d".repeat(64) } },
    });
    expect(await listMyInvitations(STRANGER, "pending", deps)).toEqual([]);
  });

  it("refuses an unverified account with 403 account_email_unverified", async () => {
    await invite("unverified@example.com");
    await expect(listMyInvitations(UNVERIFIED, "pending", deps))
      .rejects.toBeInstanceOf(InvitationInboxEmailUnverifiedError);
    await expect(listMyInvitations(UNVERIFIED, "pending", deps))
      .rejects.toMatchObject({ code: "account_email_unverified", category: "authorization" });
  });

  it("answers 404 for someone else's invitation, on every route", async () => {
    const id = await invite("invitee@example.com");
    await expect(acceptMyInvitation(actor(STRANGER), id, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(declineMyInvitation(actor(STRANGER), id, { reason: "no" }, deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(withdrawMyInvitationDecline(actor(STRANGER), id, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(getMyInvitationLogo(STRANGER, id, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("does not list expired, revoked or superseded invitations", async () => {
    await invite("invitee@example.com");
    now = AT + INVITATION_TTL_MS + 1;
    expect(await listMyInvitations(INVITEE, "pending", deps)).toEqual([]);
  });

  it("serves the logo only through an invitation the inbox lists", async () => {
    const id = await invite("invitee@example.com");
    const logo = await getMyInvitationLogo(INVITEE, id, deps);
    expect(logo?.digest).toBe("d".repeat(64));
    now = AT + INVITATION_TTL_MS + 1;
    await expect(getMyInvitationLogo(INVITEE, id, deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

describe("my invitations — answering", () => {
  it("accepting consumes the invitation and files the pending join request", async () => {
    const id = await invite("invitee@example.com");
    const result = await acceptMyInvitation(actor(INVITEE), id, deps);
    expect(result).toMatchObject({ workspaceId, workspaceName: "Acme Legal", role: "sender", joined: false, pending: true });
    expect(store.joinRequests.filter(r => r.invitationId === id && r.state === "pending")).toHaveLength(1);
    expect(intents().some(i => i.notificationType === "WORKSPACE_JOIN_REQUESTED")).toBe(true);
    expect((await listMyInvitations(INVITEE, "accepted", deps)).map(i => i.invitationId)).toEqual([id]);
    await expect(acceptMyInvitation(actor(INVITEE), id, deps)).rejects.toBeInstanceOf(InvitationStateConflictError);
    expect(actions()).toContain("invitation.accepted");
  });

  it("declining requires a reason of 1–500 characters", async () => {
    const id = await invite("invitee@example.com");
    for (const reason of ["", "   ", "x".repeat(501)]) {
      await expect(declineMyInvitation(actor(INVITEE), id, { reason }, deps))
        .rejects.toBeInstanceOf(ApplicationValidationError);
    }
    expect((await listMyInvitations(INVITEE, "pending", deps))).toHaveLength(1);
  });

  it("declining stores the reason, tells the inviter in-app and records the activity", async () => {
    const id = await invite("invitee@example.com");
    now = AT + 1000;
    const view = await declineMyInvitation(actor(INVITEE), id, { reason: "  Wrong firm  " }, deps);
    expect(view).toMatchObject({ status: "declined", declinedAt: AT + 1000, declineReason: "Wrong firm" });
    const declined = intents().filter(i => i.notificationType === "WORKSPACE_INVITATION_DECLINED");
    expect(declined).toHaveLength(1);
    expect(declined[0]?.audience).toEqual({ kind: "USER", userId: OWNER });
    expect(declined[0]?.templateInput).toMatchObject({
      invitationId: id, workspaceName: "Acme Legal", role: "sender",
      inviteeDisplayName: "Ivy Invitee", inviteeEmail: "Invitee@example.com".toLowerCase(), reason: "Wrong firm",
      expiresAt: new Date(AT + INVITATION_TTL_MS).toISOString(),
    });
    const entry = store.activity.find(a => a.action === "invitation.declined");
    expect(entry?.details).toMatchObject({ reason: "Wrong firm" });
    expect(entry === undefined ? "" : describeActivity(entry).summary)
      .toBe("Ivy Invitee declined the invitation: “Wrong firm”");
    expect((await listMyInvitations(INVITEE, "declined", deps)).map(i => i.declineReason)).toEqual(["Wrong firm"]);
  });

  it("withdrawing a decline reopens it, clears the reason and records the activity", async () => {
    const id = await invite("invitee@example.com");
    await declineMyInvitation(actor(INVITEE), id, { reason: "Not now" }, deps);
    const view = await withdrawMyInvitationDecline(actor(INVITEE), id, deps);
    expect(view).toMatchObject({ status: "pending", declinedAt: null, declineReason: null });
    expect((await listMyInvitations(INVITEE, "pending", deps)).map(i => i.invitationId)).toEqual([id]);
    expect(actions()).toContain("invitation.decline_withdrawn");
    const entry = store.activity.find(a => a.action === "invitation.decline_withdrawn");
    expect(entry === undefined ? "" : describeActivity(entry).summary)
      .toBe("Ivy Invitee withdrew their decline and the invitation is open again");
    // Declining again is a NEW notice for the inviter.
    await declineMyInvitation(actor(INVITEE), id, { reason: "Still no" }, deps);
    expect(intents().filter(i => i.notificationType === "WORKSPACE_INVITATION_DECLINED")).toHaveLength(2);
  });

  it("refuses to withdraw with 409 when not declined, expired, or revoked", async () => {
    const id = await invite("invitee@example.com");
    await expect(withdrawMyInvitationDecline(actor(INVITEE), id, deps)).rejects.toBeInstanceOf(InvitationStateConflictError);
    await declineMyInvitation(actor(INVITEE), id, { reason: "No" }, deps);
    now = AT + INVITATION_TTL_MS + 1;
    await expect(withdrawMyInvitationDecline(actor(INVITEE), id, deps)).rejects.toBeInstanceOf(InvitationStateConflictError);
  });

  it("refuses to withdraw with 409 when a newer invitation holds the slot", async () => {
    const first = await invite("invitee@example.com");
    await declineMyInvitation(actor(INVITEE), first, { reason: "No" }, deps);
    await invite("invitee@example.com");
    await expect(withdrawMyInvitationDecline(actor(INVITEE), first, deps))
      .rejects.toBeInstanceOf(InvitationStateConflictError);
  });
});

describe("invitation notices", () => {
  it("tells a VERIFIED account in-app on create and on every resend; nobody otherwise", async () => {
    const id = await invite("invitee@example.com");
    await invite("nobody@example.com");
    await resendWorkspaceInvitation({ actor: actor(OWNER), workspaceId, invitationId: id }, inviteDeps);
    const received = intents().filter(i => i.notificationType === "WORKSPACE_INVITATION_RECEIVED");
    expect(received).toHaveLength(2);
    for (const notice of received) {
      expect(notice.audience).toEqual({ kind: "USER", userId: INVITEE });
      expect(notice.templateInput).toMatchObject({
        invitationId: id, workspaceName: "Acme Legal", role: "sender", recipientName: "Ivy Invitee",
      });
    }
  });

  it("the emailed link's decline tells the inviter too, without a reason", async () => {
    await invite("invitee@example.com");
    await declineWorkspaceInvitation(actor(INVITEE), "invtok_0001", {
      transactions, clock, tokens: inviteDeps.tokens, memberIds: new SequentialMemberIds(),
      joinRequests: joinNotifyDependencies(new FixedClock(AT)),
      currentNormalizedEmail: () => Promise.resolve(assertNormalized("invitee@example.com")),
      notices: invitationNoticeDependencies(new FixedClock(AT)),
    });
    const declined = intents().filter(i => i.notificationType === "WORKSPACE_INVITATION_DECLINED");
    expect(declined).toHaveLength(1);
    expect(declined[0]?.templateInput).not.toHaveProperty("reason");
  });
});
