// 079. The activity log: each administrative change leaves exactly one entry,
// written with the change, and only owners, administrators and auditors read it.

import { describe, it, expect, beforeEach } from "vitest";
import type { UserId, WorkspaceId } from "@lagda/contracts";
import type { SessionId } from "../common/ports/session.js";
import {
  FakeTransactionManager, InMemoryStore, FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  joinNotifyDependencies,
} from "../test-support/fakes.js";
import { createIdempotencyKeyDigester, createIdempotencyRecordIds } from "../test-support/idempotency-support.js";
import { CreateWorkspace } from "./create-workspace.js";
import { updateWorkspace } from "./get-workspace.js";
import { changeWorkspaceMemberRole, removeWorkspaceMember } from "./members.js";
import {
  createJoinTicket, sendJoinTicket, withdrawJoinTicket, submitJoinRequest, approveJoinRequest,
  declineJoinRequest, listJoinRequests, updateMemberAccess,
  type JoinTicketDependencies, type JoinRequestDependencies,
} from "./workspace-join.js";
import {
  listWorkspaceActivity, describeActivity, encodeActivityCursor, ActivityCursorInvalidError,
} from "./activity.js";
import { ResourceNotFoundError } from "../common/errors/index.js";

const AT = Date.parse("2026-09-26T08:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const ADMIN = "usr_admin" as UserId;
const AUDITOR = "usr_auditor" as UserId;
const JUAN = "usr_juan" as UserId;
const ANA = "usr_ana" as UserId;
const actor = (userId: UserId) => ({ actorType: "user" as const, userId, sessionId: `ses_${userId}` as SessionId });

let store: InMemoryStore;
let transactions: FakeTransactionManager;
let workspaceId: WorkspaceId;
let ticketDeps: JoinTicketDependencies;
let requestDeps: JoinRequestDependencies;

const emails: Record<string, string> = {
  [OWNER]: "owner@acme.test", [ADMIN]: "admin@acme.test", [AUDITOR]: "audit@acme.test",
  [JUAN]: "juan@example.com", [ANA]: "ana@example.com",
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
  for (const [memberId, userId, role] of [
    ["mem_admin", ADMIN, "administrator"], ["mem_auditor", AUDITOR, "auditor"], ["mem_ana", ANA, "member"],
  ] as const) {
    store.memberships.push({ memberId: memberId as never, workspaceId, userId, role, createdAt: AT });
  }

  let n = 0;
  const tokens = {
    issue: () => { const raw = `jtoken_${String(++n)}`; return { raw, digest: `digest-${raw}` as never }; },
    digest: (s: string) => (s.startsWith("jtoken_") ? `digest-${s}` as never : null),
  };
  const notify = joinNotifyDependencies(new FixedClock(AT));
  ticketDeps = {
    transactions, ...notify, tokens,
    secrets: { keyVersion: "v1", seal: raw => `sealed:${raw}`, open: s => s.replace(/^sealed:/, "") },
  };
  requestDeps = {
    transactions, ...notify, tokens,
    currentAccount: userId => Promise.resolve(emails[userId] === undefined ? null : {
      email: emails[userId], normalizedEmail: emails[userId], emailVerified: true,
    }),
  };
});

const actions = () => store.activity.map(a => a.action);
const read = (userId: UserId, input: Parameters<typeof listWorkspaceActivity>[2] = {}) =>
  listWorkspaceActivity(actor(userId), workspaceId, input, { transactions });

describe("recording", () => {
  it("records the workspace's creation", () => {
    expect(store.activity).toHaveLength(1);
    expect(store.activity[0]).toMatchObject({
      action: "workspace.created", actorUserId: OWNER, occurredAt: AT, details: { name: "Acme Legal" },
    });
  });

  it("records a rename with both names, and nothing for an unchanged name", async () => {
    await updateWorkspace(OWNER, workspaceId, { name: "Acme Law" }, { transactions });
    await updateWorkspace(OWNER, workspaceId, { name: "Acme Law" }, { transactions });
    expect(actions()).toEqual(["workspace.created", "workspace.renamed"]);
    expect(store.activity[1]?.details).toMatchObject({ from: "Acme Legal", to: "Acme Law" });
  });

  it("records a role change and a removal, naming the member even after they are gone", async () => {
    const deps = { transactions, clock: new FixedClock(AT) };
    await changeWorkspaceMemberRole(actor(OWNER), workspaceId, "mem_ana" as never, "sender", deps);
    await removeWorkspaceMember(actor(OWNER), workspaceId, "mem_ana" as never, deps);
    const [changed, removed] = store.activity.slice(1);
    expect(changed).toMatchObject({ action: "member.role_changed", details: { fromRole: "member", toRole: "sender" } });
    expect(removed).toMatchObject({ action: "member.removed", details: { role: "sender", targetEmail: "ana@example.com" } });
  });

  it("records the whole life of a join link and its request", async () => {
    const draft = await createJoinTicket(actor(ADMIN), workspaceId, { label: "For Juan", recipientEmail: "juan@example.com" }, ticketDeps);
    const sent = await sendJoinTicket(actor(ADMIN), workspaceId, draft.ticketId, { email: true }, ticketDeps);
    await submitJoinRequest(actor(JUAN), sent.linkToken ?? "", { fullName: "Juan Dela Cruz" }, requestDeps);
    const [request] = await listJoinRequests(actor(OWNER), workspaceId, "pending", ticketDeps);
    await approveJoinRequest(actor(OWNER), workspaceId, request?.requestId ?? "", { roleTitle: "Paralegal" }, ticketDeps);

    expect(actions().slice(1)).toEqual([
      "join_link.created", "join_link.sent", "join_request.submitted", "join_request.approved",
    ]);
    const submitted = store.activity.find(a => a.action === "join_request.submitted");
    // Not a member yet, so the name is the one typed on the join page.
    expect(submitted?.details).toMatchObject({ actorName: "Juan Dela Cruz", email: "juan@example.com", label: "For Juan" });
    expect(store.activity.find(a => a.action === "join_link.sent")?.details)
      .toMatchObject({ emailedTo: "juan@example.com", again: false });
  });

  it("records withdraw, send-again, decline and an access change", async () => {
    const draft = await createJoinTicket(actor(OWNER), workspaceId, { label: "Front desk" }, ticketDeps);
    await sendJoinTicket(actor(OWNER), workspaceId, draft.ticketId, { email: false }, ticketDeps);
    await withdrawJoinTicket(actor(OWNER), workspaceId, draft.ticketId, ticketDeps);
    const again = await sendJoinTicket(actor(OWNER), workspaceId, draft.ticketId, { email: false }, ticketDeps);
    await submitJoinRequest(actor(JUAN), again.linkToken ?? "", { fullName: "Juan Dela Cruz" }, requestDeps);
    const [request] = await listJoinRequests(actor(OWNER), workspaceId, "pending", ticketDeps);
    await declineJoinRequest(actor(OWNER), workspaceId, request?.requestId ?? "", ticketDeps);
    await updateMemberAccess(actor(OWNER), workspaceId, "mem_ana", { canAssignSigners: true }, ticketDeps);

    expect(actions().slice(1)).toEqual([
      "join_link.created", "join_link.sent", "join_link.withdrawn", "join_link.sent",
      "join_request.submitted", "join_request.declined", "member.access_changed",
    ]);
    expect(store.activity.filter(a => a.action === "join_link.sent").map(a => a.details["again"]))
      .toEqual([false, true]);
  });

  it("records nothing when the change itself fails", async () => {
    const deps = { transactions, clock: new FixedClock(AT) };
    await expect(removeWorkspaceMember(actor(ANA), workspaceId, "mem_admin" as never, deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(actions()).toEqual(["workspace.created"]);
  });
});

describe("reading", () => {
  it("is for owners, administrators and auditors only", async () => {
    await expect(read(OWNER)).resolves.toBeTruthy();
    await expect(read(ADMIN)).resolves.toBeTruthy();
    await expect(read(AUDITOR)).resolves.toBeTruthy();
    await expect(read(ANA)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(read(JUAN)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("shows newest first as plain sentences", async () => {
    await updateWorkspace(OWNER, workspaceId, { name: "Acme Law" }, { transactions, clock: new FixedClock(AT + 1000) });
    const { events } = await read(OWNER);
    expect(events[0]).toMatchObject({ action: "workspace.renamed", category: "workspace" });
    expect(events[0]?.summary).toBe("usr_owner renamed the workspace from “Acme Legal” to “Acme Law”");
    expect(events[1]?.summary).toBe("usr_owner created the workspace “Acme Legal”");
  });

  it("pages with a cursor and filters by category", async () => {
    for (let i = 0; i < 5; i++) {
      await createJoinTicket(actor(OWNER), workspaceId, { label: `Link ${String(i)}` }, ticketDeps);
    }
    const first = await read(OWNER, { limit: 4 });
    expect(first.events).toHaveLength(4);
    expect(first.nextCursor).not.toBeNull();
    const second = await read(OWNER, { limit: 4, cursor: first.nextCursor });
    expect(second.events).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.events, ...second.events].map(e => e.eventId);
    expect(new Set(ids).size).toBe(6);

    const links = await read(OWNER, { category: "links" });
    expect(links.events.map(e => e.action)).toEqual(Array(5).fill("join_link.created"));
    expect((await read(OWNER, { category: "teams" })).events).toEqual([]);
  });

  it("refuses a cursor it did not issue", async () => {
    await expect(read(OWNER, { cursor: "not-a-cursor" })).rejects.toBeInstanceOf(ActivityCursorInvalidError);
    expect(encodeActivityCursor({ occurredAt: 1, eventId: "act_1" })).not.toContain(".");
  });
});

describe("the sentences", () => {
  it("names a New Comer by the role label and lists privileges", () => {
    expect(describeActivity({
      action: "join_request.approved",
      details: { actorName: "Ana Reyes", targetName: "Juan", role: "member", roleTitle: null, canRequestDocuments: true, canAssignSigners: false },
    }).summary).toBe("Ana Reyes approved Juan's join request as New Comer, with request documents");
    expect(describeActivity({
      action: "join_link.sent",
      details: { actorName: "Ana Reyes", label: "Front desk", again: true, emailedTo: "x@example.com" },
    }).summary).toBe("Ana Reyes sent the join link “Front desk” again with a new link by email to x@example.com");
  });
});
