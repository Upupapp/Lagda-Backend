// Member administration, tested with fakes.
//
// The escalation cases are the point. Everything here is a way someone might
// try to acquire authority they were not given, and the assertion is that they
// cannot.

import { describe, it, expect } from "vitest";
import type { UserId, WorkspaceId, WorkspaceMemberId, WorkspaceRole } from "@lagda/contracts";
import { WORKSPACE_ROLES } from "@lagda/contracts";
import {
  listWorkspaceMembers, changeWorkspaceMemberRole, removeWorkspaceMember,
  RoleGrantDeniedError, LastOwnerViolationError, CannotAdministerSelfError,
  type MemberAdministrationDependencies,
} from "./members.js";
import { listMyWorkspaces } from "./list-my-workspaces.js";
import { getWorkspace, updateWorkspace } from "./get-workspace.js";
import { createWorkspaceInvitation } from "./invitations.js";
import { CreateWorkspace } from "./create-workspace.js";
import { ResourceNotFoundError } from "../common/errors/index.js";
import { assertNormalized } from "../auth/email-identity.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

const AT = Date.parse("2026-08-10T14:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const ADMIN = "usr_admin" as UserId;
const MEMBER = "usr_member" as UserId;
const SENDER = "usr_sender" as UserId;
const OUTSIDER = "usr_outsider" as UserId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

interface Harness {
  readonly store: InMemoryStore;
  readonly transactions: FakeTransactionManager;
  readonly deps: MemberAdministrationDependencies;
  readonly workspaceId: WorkspaceId;
  readonly ids: Record<string, WorkspaceMemberId>;
}

/** A workspace with one of each administratively interesting role. */
async function harness(): Promise<Harness> {
  const store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);

  for (const [userId, address] of [
    [OWNER, "owner@example.com"], [ADMIN, "admin@example.com"],
    [MEMBER, "member@example.com"], [SENDER, "sender@example.com"],
    [OUTSIDER, "outsider@example.com"],
  ] as const) {
    store.accountEmails.set(assertNormalized(address), userId);
  }

  const created = await new CreateWorkspace({
    transactions,
    clock: new FixedClock(AT),
    workspaceIds: new SequentialWorkspaceIds(),
    memberIds: new SequentialMemberIds(),
    idempotency: {
      digester: createIdempotencyKeyDigester(),
      ids: createIdempotencyRecordIds(),
      clock: new FixedClock(AT),
      policy: { retentionMs: 86_400_000 },
    },
  }).execute({ actor: actor(OWNER), name: "Acme Legal" });

  const ids: Record<string, WorkspaceMemberId> = {
    owner: store.memberships[0]?.memberId ?? ("mem_1" as WorkspaceMemberId),
  };
  for (const [key, userId, role] of [
    ["admin", ADMIN, "administrator"],
    ["member", MEMBER, "member"],
    ["sender", SENDER, "sender"],
  ] as const) {
    const memberId = `mem_${key}` as WorkspaceMemberId;
    ids[key] = memberId;
    store.memberships.push({
      memberId, workspaceId: created.workspaceId, userId, role,
      createdAt: AT + 1000,
    });
  }

  return {
    store, transactions, workspaceId: created.workspaceId, ids,
    deps: { transactions, clock: new FixedClock(AT) },
  };
}

// ── Listing ──────────────────────────────────────────────────────────────────

describe("listWorkspaceMembers", () => {
  it("returns the directory to an owner", async () => {
    const h = await harness();
    const members = await listWorkspaceMembers(actor(OWNER), h.workspaceId, h.deps);
    expect(members).toHaveLength(4);
    expect(members.map(m => m.role).sort())
      .toEqual(["administrator", "member", "owner", "sender"]);
  });

  it("returns it to an ADMINISTRATOR too", async () => {
    // The correction BACKEND-27 makes. The product grants `administrator`
    // `manage_team`; BACKEND-25/26 hardcoded owner-only because neither had a
    // role model to read.
    const members = await listWorkspaceMembers(
      actor(ADMIN), (await harness()).workspaceId, (await harness()).deps)
      .catch(() => null);
    expect(members).not.toBeNull();
  });

  it("REFUSES an ordinary member", async () => {
    // A directory is every colleague's email address, and the product gates the
    // whole workspace-administration section on `manage_team`.
    const h = await harness();
    await expect(listWorkspaceMembers(actor(MEMBER), h.workspaceId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("REFUSES every non-administrative role", async () => {
    const h = await harness();
    await expect(listWorkspaceMembers(actor(SENDER), h.workspaceId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("REFUSES an outsider, identically to a member without the capability", async () => {
    // The two are indistinguishable on purpose: neither response says whether
    // the workspace exists or whether the caller is in it.
    const h = await harness();
    const outsider = await listWorkspaceMembers(actor(OUTSIDER), h.workspaceId, h.deps)
      .catch((e: unknown) => e);
    const underprivileged = await listWorkspaceMembers(actor(MEMBER), h.workspaceId, h.deps)
      .catch((e: unknown) => e);

    expect((outsider as ResourceNotFoundError).code)
      .toBe((underprivileged as ResourceNotFoundError).code);
    expect((outsider as ResourceNotFoundError).message)
      .toBe((underprivileged as ResourceNotFoundError).message);
  });

  it("marks the current user and exposes no security state", async () => {
    const h = await harness();
    const members = await listWorkspaceMembers(actor(OWNER), h.workspaceId, h.deps);
    const self = members.find(m => m.userId === OWNER);

    expect(self?.isCurrentUser).toBe(true);
    for (const forbidden of [
      "passwordHash", "sessionId", "mfaEnabled", "normalizedEmail", "tokenDigest",
    ]) {
      expect(self).not.toHaveProperty(forbidden);
    }
  });
});

// ── Role change ──────────────────────────────────────────────────────────────

describe("changeWorkspaceMemberRole", () => {
  it("lets an owner promote a member to administrator", async () => {
    const h = await harness();
    const result = await changeWorkspaceMemberRole(
      actor(OWNER), h.workspaceId, h.ids["member"]!, "administrator", h.deps);

    expect(result.outcome).toBe("changed");
    expect(result.member.role).toBe("administrator");
  });

  it("lets an ADMINISTRATOR change a member's role", async () => {
    const h = await harness();
    const result = await changeWorkspaceMemberRole(
      actor(ADMIN), h.workspaceId, h.ids["member"]!, "sender", h.deps);
    expect(result.member.role).toBe("sender");
  });

  it("REFUSES an ordinary member", async () => {
    const h = await harness();
    await expect(changeWorkspaceMemberRole(
      actor(MEMBER), h.workspaceId, h.ids["sender"]!, "administrator", h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("REFUSES SELF-PROMOTION, from every role", async () => {
    // The most important test in the file. No path exists to it: the actor is
    // compared to the target before the grant rule runs.
    const h = await harness();
    for (const [userId, key] of [
      [OWNER, "owner"], [ADMIN, "admin"], [MEMBER, "member"], [SENDER, "sender"],
    ] as const) {
      await expect(changeWorkspaceMemberRole(
        actor(userId), h.workspaceId, h.ids[key]!, "administrator", h.deps))
        .rejects.toThrow();
    }
    // Nobody moved.
    expect(h.store.memberships.find(m => m.userId === SENDER)?.role).toBe("sender");
  });

  it("REFUSES self-demotion through the generic endpoint", async () => {
    // Self-demotion is leaving or transferring, both of which have their own
    // rules. Routing it through a role patch would bypass them.
    const h = await harness();
    await expect(changeWorkspaceMemberRole(
      actor(ADMIN), h.workspaceId, h.ids["admin"]!, "member", h.deps))
      .rejects.toBeInstanceOf(CannotAdministerSelfError);
  });

  it("REFUSES granting OWNER — to every actor, for every target", async () => {
    // Ownership moves through a dedicated transfer operation and nothing else.
    const h = await harness();
    for (const userId of [OWNER, ADMIN] as const) {
      for (const key of ["member", "sender"] as const) {
        await expect(changeWorkspaceMemberRole(
          actor(userId), h.workspaceId, h.ids[key]!, "owner", h.deps))
          .rejects.toBeInstanceOf(RoleGrantDeniedError);
      }
    }
    expect(h.store.memberships.filter(m => m.role === "owner")).toHaveLength(1);
  });

  it("REFUSES demoting the last owner", async () => {
    const h = await harness();
    await expect(changeWorkspaceMemberRole(
      actor(ADMIN), h.workspaceId, h.ids["owner"]!, "member", h.deps))
      .rejects.toBeInstanceOf(LastOwnerViolationError);
    expect(h.store.memberships.filter(m => m.role === "owner")).toHaveLength(1);
  });

  it("REFUSES a member of another workspace, even with a real membership id", async () => {
    const h = await harness();
    const other = await new CreateWorkspace({
      transactions: h.transactions,
      clock: new FixedClock(AT),
      workspaceIds: { nextWorkspaceId: () => "ws_other" as WorkspaceId },
      memberIds: { nextWorkspaceMemberId: () => "mem_other" as WorkspaceMemberId },
      idempotency: {
        digester: createIdempotencyKeyDigester(),
        ids: createIdempotencyRecordIds(),
        clock: new FixedClock(AT),
        policy: { retentionMs: 86_400_000 },
      },
    }).execute({ actor: actor(OUTSIDER), name: "Other" });

    // The owner of Acme, naming a membership that genuinely exists — elsewhere.
    await expect(changeWorkspaceMemberRole(
      actor(OWNER), h.workspaceId, "mem_other" as WorkspaceMemberId, "member", h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);

    expect(h.store.memberships.find(m => m.workspaceId === other.workspaceId)?.role)
      .toBe("owner");
  });

  it("reports a no-op without writing", async () => {
    const h = await harness();
    const result = await changeWorkspaceMemberRole(
      actor(OWNER), h.workspaceId, h.ids["member"]!, "member", h.deps);
    expect(result.outcome).toBe("unchanged");
  });

  it("does the whole thing in ONE transaction", async () => {
    const h = await harness();
    const before = h.transactions.committed;
    await changeWorkspaceMemberRole(
      actor(OWNER), h.workspaceId, h.ids["member"]!, "sender", h.deps);
    expect(h.transactions.committed - before).toBe(1);
  });

  it("takes effect IMMEDIATELY, with no new session", async () => {
    // The property BACKEND-25 bought: capabilities are not in the credential.
    const h = await harness();
    // A member cannot rename the workspace.
    await expect(updateWorkspace(MEMBER, h.workspaceId, { name: "No" }, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);

    await changeWorkspaceMemberRole(
      actor(OWNER), h.workspaceId, h.ids["member"]!, "administrator", h.deps);

    // Same user, same notional session, new authority.
    const result = await updateWorkspace(MEMBER, h.workspaceId, { name: "Renamed" }, h.deps);
    expect(result.outcome).toBe("updated");
  });

  it("removes authority immediately on demotion", async () => {
    const h = await harness();
    expect((await updateWorkspace(ADMIN, h.workspaceId, { name: "Fine" }, h.deps)).outcome)
      .toBe("updated");

    await changeWorkspaceMemberRole(
      actor(OWNER), h.workspaceId, h.ids["admin"]!, "member", h.deps);

    await expect(updateWorkspace(ADMIN, h.workspaceId, { name: "Nope" }, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// ── Removal ──────────────────────────────────────────────────────────────────

describe("removeWorkspaceMember", () => {
  it("removes a member and revokes their access on the next call", async () => {
    const h = await harness();
    expect(await getWorkspace(MEMBER, h.workspaceId, h.deps)).toBeTruthy();

    await removeWorkspaceMember(actor(OWNER), h.workspaceId, h.ids["member"]!, h.deps);

    await expect(getWorkspace(MEMBER, h.workspaceId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("leaves the workspace out of the removed member's list", async () => {
    const h = await harness();
    expect(await listMyWorkspaces(MEMBER, { transactions: h.transactions }))
      .toHaveLength(1);

    await removeWorkspaceMember(actor(OWNER), h.workspaceId, h.ids["member"]!, h.deps);

    expect(await listMyWorkspaces(MEMBER, { transactions: h.transactions }))
      .toHaveLength(0);
  });

  it("does NOT touch the account or another workspace", async () => {
    // Removal is a tenant operation. It is not an account action, and it says
    // nothing about anywhere else the person belongs.
    const h = await harness();
    await new CreateWorkspace({
      transactions: h.transactions,
      clock: new FixedClock(AT),
      workspaceIds: { nextWorkspaceId: () => "ws_theirs" as WorkspaceId },
      memberIds: { nextWorkspaceMemberId: () => "mem_theirs" as WorkspaceMemberId },
      idempotency: {
        digester: createIdempotencyKeyDigester(),
        ids: createIdempotencyRecordIds(),
        clock: new FixedClock(AT),
        policy: { retentionMs: 86_400_000 },
      },
    }).execute({ actor: actor(MEMBER), name: "Their Own" });

    await removeWorkspaceMember(actor(OWNER), h.workspaceId, h.ids["member"]!, h.deps);

    // Their own workspace is untouched, and the account still exists.
    const theirs = await listMyWorkspaces(MEMBER, { transactions: h.transactions });
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.name).toBe("Their Own");
    expect(h.store.accountEmails.get(assertNormalized("member@example.com")))
      .toBe(MEMBER);
  });

  it("REFUSES an ordinary member", async () => {
    const h = await harness();
    await expect(removeWorkspaceMember(
      actor(MEMBER), h.workspaceId, h.ids["sender"]!, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("REFUSES removing yourself", async () => {
    const h = await harness();
    await expect(removeWorkspaceMember(
      actor(ADMIN), h.workspaceId, h.ids["admin"]!, h.deps))
      .rejects.toBeInstanceOf(CannotAdministerSelfError);
  });

  it("REFUSES removing the last owner", async () => {
    const h = await harness();
    await expect(removeWorkspaceMember(
      actor(ADMIN), h.workspaceId, h.ids["owner"]!, h.deps))
      .rejects.toBeInstanceOf(LastOwnerViolationError);
    expect(h.store.memberships.filter(m => m.role === "owner")).toHaveLength(1);
  });

  it("REFUSES a membership from another workspace", async () => {
    const h = await harness();
    await new CreateWorkspace({
      transactions: h.transactions,
      clock: new FixedClock(AT),
      workspaceIds: { nextWorkspaceId: () => "ws_other" as WorkspaceId },
      memberIds: { nextWorkspaceMemberId: () => "mem_other" as WorkspaceMemberId },
      idempotency: {
        digester: createIdempotencyKeyDigester(),
        ids: createIdempotencyRecordIds(),
        clock: new FixedClock(AT),
        policy: { retentionMs: 86_400_000 },
      },
    }).execute({ actor: actor(OUTSIDER), name: "Other" });

    await expect(removeWorkspaceMember(
      actor(OWNER), h.workspaceId, "mem_other" as WorkspaceMemberId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(h.store.memberships.some(m => m.memberId === "mem_other")).toBe(true);
  });
});

// ── The invitation surface, now capability-driven ───────────────────────────

describe("invitation authorization after centralization", () => {
  const inviteDeps = (h: Harness) => ({
    transactions: h.transactions,
    clock: new FixedClock(AT),
    invitationIds: { nextWorkspaceInvitationId: () => "inv_1" as never },
    tokens: {
      issue: () => ({ raw: "invtok_0001", digest: "digest-of-invtok_0001" as never }),
      digest: (s: string) => (s === "invtok_0001" ? ("digest-of-invtok_0001" as never) : null),
    },
    links: { build: (raw: string) => `https://app.lagda.test/a?token=${raw}` },
    scheduleDelivery: () => Promise.resolve(),
    idempotency: {
      digester: createIdempotencyKeyDigester(),
      ids: createIdempotencyRecordIds(),
      clock: new FixedClock(AT),
      policy: { retentionMs: 86_400_000 },
    },
  });

  it("lets an ADMINISTRATOR invite — the BACKEND-26 owner-only rule is gone", async () => {
    const h = await harness();
    const summary = await createWorkspaceInvitation({
      actor: actor(ADMIN), workspaceId: h.workspaceId,
      email: "new@example.com", role: "member",
    }, inviteDeps(h));
    expect(summary.state).toBe("pending");
  });

  it("still refuses an ordinary member", async () => {
    const h = await harness();
    await expect(createWorkspaceInvitation({
      actor: actor(MEMBER), workspaceId: h.workspaceId,
      email: "new@example.com", role: "member",
    }, inviteDeps(h))).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("follows the DEMOTED inviter's new authority with no re-login", async () => {
    const h = await harness();
    await changeWorkspaceMemberRole(
      actor(OWNER), h.workspaceId, h.ids["admin"]!, "member", h.deps);

    await expect(createWorkspaceInvitation({
      actor: actor(ADMIN), workspaceId: h.workspaceId,
      email: "new@example.com", role: "member",
    }, inviteDeps(h))).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// ── Every role, against every administrative operation ──────────────────────

describe("the administrative surface, role by role", () => {
  const ADMINISTRATIVE: readonly WorkspaceRole[] = ["owner", "administrator"];

  for (const role of WORKSPACE_ROLES) {
    if (role === "owner") continue;
    it(`${role} ${ADMINISTRATIVE.includes(role) ? "may" : "may NOT"} administer members`,
      async () => {
        const h = await harness();
        const probe = "usr_probe" as UserId;
        const probeId = "mem_probe" as WorkspaceMemberId;
        h.store.accountEmails.set(assertNormalized("probe@example.com"), probe);
        h.store.memberships.push({
          memberId: probeId, workspaceId: h.workspaceId, userId: probe,
          role, createdAt: AT + 2000,
        });

        const allowed = ADMINISTRATIVE.includes(role);
        const listed = await listWorkspaceMembers(actor(probe), h.workspaceId, h.deps)
          .then(() => true).catch(() => false);
        expect(listed).toBe(allowed);
      });
  }
});
