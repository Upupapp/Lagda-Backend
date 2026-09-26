// 078: single-use join links, always approved.

import { describe, it, expect, beforeEach } from "vitest";
import type { UserId, WorkspaceId } from "@lagda/contracts";
import type { SessionId } from "../common/ports/session.js";
import {
  FakeTransactionManager, InMemoryStore, FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  joinNotifyDependencies,
} from "../test-support/fakes.js";
import { createIdempotencyKeyDigester, createIdempotencyRecordIds } from "../test-support/idempotency-support.js";
import { CreateWorkspace } from "./create-workspace.js";
import {
  createJoinTicket, updateJoinTicketDraft, sendJoinTicket, withdrawJoinTicket, listJoinTickets,
  previewJoinLink, submitJoinRequest, listJoinRequests, approveJoinRequest, declineJoinRequest,
  updateMemberAccess, JoinLinkInvalidError, JoinLinkUsedError, JoinAlreadyMemberError,
  JoinRequestPendingError, JoinEmailUnverifiedError,
  type JoinTicketDependencies, type JoinRequestDependencies,
} from "./workspace-join.js";
import { requireCapability } from "./workspace-access.js";
import { ResourceConflictError, ResourceNotFoundError } from "../common/errors/index.js";

const AT = Date.parse("2026-09-26T08:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const ADMIN = "usr_admin" as UserId;
const JUAN = "usr_juan" as UserId;
const ANA = "usr_ana" as UserId;
const actor = (userId: UserId) => ({ actorType: "user" as const, userId, sessionId: `ses_${userId}` as SessionId });

function tokens() {
  let n = 0;
  return {
    issue: () => { const raw = `jtoken_${String(++n).padStart(4, "0")}`; return { raw, digest: `digest-${raw}` as never }; },
    digest: (s: string) => (s.startsWith("jtoken_") ? `digest-${s}` as never : null),
  };
}
const secrets = { keyVersion: "v1", seal: (raw: string) => `sealed:${raw}`, open: (s: string) => s.replace(/^sealed:/, "") };

let store: InMemoryStore;
let transactions: FakeTransactionManager;
let ticketDeps: JoinTicketDependencies;
let requestDeps: JoinRequestDependencies;
let workspaceId: WorkspaceId;
const verified = new Set<UserId>([OWNER, ADMIN, JUAN, ANA]);
const emails: Record<string, string> = {
  [OWNER]: "owner@acme.test", [ADMIN]: "admin@acme.test", [JUAN]: "juan@example.com", [ANA]: "ana@example.com",
};

beforeEach(async () => {
  store = new InMemoryStore();
  transactions = new FakeTransactionManager(store);
  for (const [id, email] of Object.entries(emails)) store.accountEmails.set(email, id as UserId);
  const created = await new CreateWorkspace({
    transactions, clock: new FixedClock(AT), workspaceIds: new SequentialWorkspaceIds(),
    memberIds: new SequentialMemberIds(),
    idempotency: {
      digester: createIdempotencyKeyDigester(), ids: createIdempotencyRecordIds(),
      clock: new FixedClock(AT), policy: { retentionMs: 86_400_000 },
    },
  }).execute({ actor: actor(OWNER), name: "Acme Legal" });
  workspaceId = created.workspaceId;
  store.memberships.push({ memberId: "mem_admin" as never, workspaceId, userId: ADMIN, role: "administrator", createdAt: AT });

  const notify = joinNotifyDependencies(new FixedClock(AT));
  const t = tokens();
  ticketDeps = { transactions, ...notify, tokens: t, secrets };
  requestDeps = {
    transactions, ...notify, tokens: t,
    currentAccount: userId => Promise.resolve(emails[userId] === undefined ? null : {
      email: emails[userId], normalizedEmail: emails[userId], emailVerified: verified.has(userId),
    }),
  };
});

async function sentTicket(email = false) {
  const draft = await createJoinTicket(actor(OWNER), workspaceId, { label: "For Juan", recipientEmail: "juan@example.com" }, ticketDeps);
  const sent = await sendJoinTicket(actor(OWNER), workspaceId, draft.ticketId, { email }, ticketDeps);
  return { ticketId: draft.ticketId, token: sent.linkToken! };
}

const intents = (type: string) => [...store.notificationIntents.values()].filter(i => i.notificationType === type);
const destinations = (type: string) => {
  const ids = new Set(intents(type).map(i => i.notificationIntentId));
  return [...store.notificationDeliveries.values()].filter(d => ids.has(d.notificationIntentId)).map(d => d.destination).sort();
};

describe("tickets", () => {
  it("starts as a Draft with no live link, and only a draft can be edited", async () => {
    const draft = await createJoinTicket(actor(OWNER), workspaceId, { label: "For Maria" }, ticketDeps);
    expect(draft).toMatchObject({ state: "draft", linkToken: null });
    const edited = await updateJoinTicketDraft(actor(OWNER), workspaceId, draft.ticketId,
      { label: "For Maria — HR", recipientEmail: "maria@example.com" }, ticketDeps);
    expect(edited).toMatchObject({ label: "For Maria — HR", recipientEmail: "maria@example.com" });
    await sendJoinTicket(actor(OWNER), workspaceId, draft.ticketId, { email: false }, ticketDeps);
    await expect(updateJoinTicketDraft(actor(OWNER), workspaceId, draft.ticketId, { label: "x" }, ticketDeps))
      .rejects.toBeInstanceOf(ResourceConflictError);
  });

  it("sending creates a live link and can email it to the ticket's address", async () => {
    const { ticketId, token } = await sentTicket(true);
    expect(token).toMatch(/^jtoken_/);
    const [email] = intents("WORKSPACE_JOIN_LINK");
    expect(email).toMatchObject({ audience: { kind: "WORKSPACE_JOIN_TICKET", joinTicketId: ticketId } });
  });

  it("refuses to email a ticket with no address", async () => {
    const draft = await createJoinTicket(actor(OWNER), workspaceId, { label: "Open" }, ticketDeps);
    await expect(sendJoinTicket(actor(OWNER), workspaceId, draft.ticketId, { email: true }, ticketDeps))
      .rejects.toThrow(/email address/);
  });

  it("withdrawing kills the link at once; sending again issues a NEW link and the old one stays dead", async () => {
    const { ticketId, token } = await sentTicket();
    const withdrawn = await withdrawJoinTicket(actor(OWNER), workspaceId, ticketId, ticketDeps);
    expect(withdrawn).toMatchObject({ state: "withdrawn", linkToken: null });
    await expect(previewJoinLink(token, requestDeps)).rejects.toBeInstanceOf(JoinLinkInvalidError);

    const again = await sendJoinTicket(actor(OWNER), workspaceId, ticketId, { email: false }, ticketDeps);
    expect(again.state).toBe("sent");
    expect(again.linkToken).not.toBe(token);
    await expect(previewJoinLink(token, requestDeps)).rejects.toBeInstanceOf(JoinLinkInvalidError);
    await expect(previewJoinLink(again.linkToken!, requestDeps)).resolves.toMatchObject({ workspaceName: "Acme Legal" });
  });

  it("only owners and administrators manage tickets", async () => {
    store.memberships.push({ memberId: "mem_juan" as never, workspaceId, userId: JUAN, role: "member", createdAt: AT });
    await expect(createJoinTicket(actor(JUAN), workspaceId, { label: "x" }, ticketDeps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(createJoinTicket(actor(ADMIN), workspaceId, { label: "x" }, ticketDeps)).resolves.toBeTruthy();
  });
});

describe("the join link", () => {
  it("previews the workspace and who sent it, without using the link", async () => {
    const { token } = await sentTicket();
    await expect(previewJoinLink(token, requestDeps)).resolves.toEqual({
      workspaceName: "Acme Legal", invitedByName: "Acme Legal",
    });
    await expect(previewJoinLink(token, requestDeps)).resolves.toBeTruthy();
  });

  it("refuses a malformed or unknown link as invalid", async () => {
    await expect(previewJoinLink("nope", requestDeps)).rejects.toBeInstanceOf(JoinLinkInvalidError);
    await expect(previewJoinLink("jtoken_9999", requestDeps)).rejects.toBeInstanceOf(JoinLinkInvalidError);
  });

  it("is single-use: the first request uses it, anyone after is told it was used", async () => {
    const { token } = await sentTicket();
    const sent = await submitJoinRequest(actor(JUAN), token, { fullName: "Juan Dela Cruz", reason: "New associate" }, requestDeps);
    expect(sent).toMatchObject({ state: "pending", workspaceName: "Acme Legal" });
    await expect(previewJoinLink(token, requestDeps)).rejects.toBeInstanceOf(JoinLinkUsedError);
    await expect(submitJoinRequest(actor(ANA), token, { fullName: "Ana Reyes" }, requestDeps))
      .rejects.toBeInstanceOf(JoinLinkUsedError);
  });

  it("never joins directly — the requester is not a member until approved", async () => {
    const { token } = await sentTicket();
    await submitJoinRequest(actor(JUAN), token, { fullName: "Juan Dela Cruz" }, requestDeps);
    expect(store.memberships.some(m => m.userId === JUAN)).toBe(false);
  });

  it("records the account's verified email, never a typed one, and tells every owner and admin", async () => {
    const { token } = await sentTicket();
    await submitJoinRequest(actor(JUAN), token, { fullName: "Juan Dela Cruz" }, requestDeps);
    const [request] = await listJoinRequests(actor(OWNER), workspaceId, "pending", ticketDeps);
    expect(request).toMatchObject({ email: "juan@example.com", fullName: "Juan Dela Cruz", ticketLabel: "For Juan" });
    expect(destinations("WORKSPACE_JOIN_REQUESTED"))
      .toEqual(["admin@acme.test", "owner@acme.test"]);
  });

  it("refuses an unverified account, a current member, and a second pending request", async () => {
    verified.delete(ANA);
    const a = await sentTicket();
    await expect(submitJoinRequest(actor(ANA), a.token, { fullName: "Ana Reyes" }, requestDeps))
      .rejects.toBeInstanceOf(JoinEmailUnverifiedError);
    verified.add(ANA);

    await expect(submitJoinRequest(actor(ADMIN), a.token, { fullName: "Admin" }, requestDeps))
      .rejects.toBeInstanceOf(JoinAlreadyMemberError);

    await submitJoinRequest(actor(JUAN), a.token, { fullName: "Juan Dela Cruz" }, requestDeps);
    const b = await sentTicket();
    await expect(submitJoinRequest(actor(JUAN), b.token, { fullName: "Juan Dela Cruz" }, requestDeps))
      .rejects.toBeInstanceOf(JoinRequestPendingError);
  });
});

describe("approval", () => {
  async function pendingRequestId() {
    const { token } = await sentTicket();
    const sent = await submitJoinRequest(actor(JUAN), token, { fullName: "Juan Dela Cruz" }, requestDeps);
    return sent.requestId;
  }

  it("approving makes a New Comer (member) with no privileges and tells the requester", async () => {
    const requestId = await pendingRequestId();
    await approveJoinRequest(actor(OWNER), workspaceId, requestId, {}, ticketDeps);
    const member = store.memberships.find(m => m.userId === JUAN);
    expect(member).toMatchObject({ role: "member", roleTitle: null, canRequestDocuments: false, canAssignSigners: false });
    expect(destinations("WORKSPACE_JOIN_DECIDED")).toEqual(["juan@example.com"]);
    await expect(requireCapability(JUAN, workspaceId, "document.create", { transactions }))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("approving can set a typed title and grant the two privileges, which then work", async () => {
    const requestId = await pendingRequestId();
    await approveJoinRequest(actor(ADMIN), workspaceId, requestId,
      { roleTitle: "Finance Associate", canRequestDocuments: true, canAssignSigners: true }, ticketDeps);
    expect(store.memberships.find(m => m.userId === JUAN))
      .toMatchObject({ roleTitle: "Finance Associate", canRequestDocuments: true, canAssignSigners: true });
    await expect(requireCapability(JUAN, workspaceId, "upload-request.create", { transactions })).resolves.toBeTruthy();
    await expect(requireCapability(JUAN, workspaceId, "signing-request.send", { transactions })).resolves.toBeTruthy();
    // Neither privilege reaches workspace administration.
    await expect(requireCapability(JUAN, workspaceId, "membership.role.change", { transactions }))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("declining leaves them out, and a request is decided once", async () => {
    const requestId = await pendingRequestId();
    await declineJoinRequest(actor(OWNER), workspaceId, requestId, ticketDeps);
    expect(store.memberships.some(m => m.userId === JUAN)).toBe(false);
    await expect(approveJoinRequest(actor(OWNER), workspaceId, requestId, {}, ticketDeps))
      .rejects.toBeInstanceOf(ResourceConflictError);
  });

  it("a plain member cannot approve or change privileges", async () => {
    const requestId = await pendingRequestId();
    store.memberships.push({ memberId: "mem_ana" as never, workspaceId, userId: ANA, role: "member", createdAt: AT });
    await expect(approveJoinRequest(actor(ANA), workspaceId, requestId, {}, ticketDeps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(updateMemberAccess(actor(ANA), workspaceId, "mem_ana", { canAssignSigners: true }, ticketDeps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("owners and admins can change a member's title and privileges any time", async () => {
    store.memberships.push({ memberId: "mem_ana" as never, workspaceId, userId: ANA, role: "member", createdAt: AT });
    await updateMemberAccess(actor(ADMIN), workspaceId, "mem_ana", { roleTitle: "HR Officer", canRequestDocuments: true }, ticketDeps);
    expect(store.memberships.find(m => m.userId === ANA))
      .toMatchObject({ roleTitle: "HR Officer", canRequestDocuments: true, canAssignSigners: false });
  });

  it("the Sent list shows who used a link and the outcome", async () => {
    const requestId = await pendingRequestId();
    await approveJoinRequest(actor(OWNER), workspaceId, requestId, {}, ticketDeps);
    const [ticket] = await listJoinTickets(actor(OWNER), workspaceId, ticketDeps);
    expect(ticket).toMatchObject({ state: "sent", request: { fullName: "Juan Dela Cruz", state: "approved" } });
    expect(ticket!.usedAt).not.toBeNull();
  });
});
