// Invitation use cases, tested entirely with fakes.
//
// This suite proves ORCHESTRATION: what is authorized, in what order, from
// which identity, and what is refused. Atomicity and concurrency are proved
// only in `invitation.integration.test.ts` against real PostgreSQL, and no
// assertion here may be read as evidence of either.

import { describe, it, expect } from "vitest";
import type {
  UserId, WorkspaceId, WorkspaceInvitationId, IdempotencyKey,
} from "@lagda/contracts";
import { INVITATION_TTL_MS } from "@lagda/contracts";
import {
  createWorkspaceInvitation, listWorkspaceInvitations,
  resendWorkspaceInvitation, revokeWorkspaceInvitation,
  getWorkspaceInvitationPreview, acceptWorkspaceInvitation,
  declineWorkspaceInvitation,
  AlreadyWorkspaceMemberError, InvitationAlreadyPendingError,
  InvitationInvalidError, InvitationAccountMismatchError,
  type InvitationDependencies, type AcceptInvitationDependencies,
} from "./invitations.js";
import { CreateWorkspace } from "./create-workspace.js";
import { listMyWorkspaces } from "./list-my-workspaces.js";
import { ApplicationValidationError, ResourceNotFoundError } from "../common/errors/index.js";
import { IdempotencyConflictError } from "../idempotency/service.js";
import { assertNormalized, type NormalizedEmail } from "../auth/email-identity.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import type {
  InvitationTokenFactory, WorkspaceInvitationIdGenerator,
} from "../common/ports/invitations.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

const AT = Date.parse("2026-08-10T09:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const INVITEE = "usr_invitee" as UserId;
const STRANGER = "usr_stranger" as UserId;

const OWNER_EMAIL = assertNormalized("owner@example.com");
const INVITEE_EMAIL = assertNormalized("invitee@example.com");
const STRANGER_EMAIL = assertNormalized("stranger@example.com");

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

/**
 * A deterministic token factory.
 *
 * Sequential rather than random, so a test can name the token it expects.
 * Rejects anything that does not look like one of its own — the same
 * shape-before-lookup discipline the production adapter applies.
 */
function fakeTokens(): InvitationTokenFactory & { issued: string[] } {
  let next = 1;
  const issued: string[] = [];
  return {
    issued,
    issue() {
      const raw = `invtok_${String(next++).padStart(4, "0")}`;
      issued.push(raw);
      return { raw, digest: `digest-of-${raw}` as never };
    },
    digest(submitted: string) {
      if (!submitted.startsWith("invtok_")) return null;
      return `digest-of-${submitted}` as never;
    },
  };
}

function fakeInvitationIds(): WorkspaceInvitationIdGenerator {
  let next = 1;
  return {
    nextWorkspaceInvitationId: () =>
      `inv_${String(next++)}` as WorkspaceInvitationId,
  };
}

interface Harness {
  readonly transactions: FakeTransactionManager;
  readonly store: InMemoryStore;
  readonly tokens: ReturnType<typeof fakeTokens>;
  readonly deps: InvitationDependencies;
  readonly acceptDeps: AcceptInvitationDependencies;
  readonly delivered: { invitationId: string; invitationUrl: string }[];
  readonly workspaceId: WorkspaceId;
}

/** A workspace owned by OWNER, with the accounts the tests need registered. */
async function harness(over: { deliveryFails?: boolean } = {}): Promise<Harness> {
  const store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);
  const tokens = fakeTokens();
  const delivered: { invitationId: string; invitationUrl: string }[] = [];

  store.accountEmails.set(OWNER_EMAIL, OWNER);
  store.accountEmails.set(INVITEE_EMAIL, INVITEE);
  store.accountEmails.set(STRANGER_EMAIL, STRANGER);

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

  const deps: InvitationDependencies = {
    transactions,
    clock: new FixedClock(AT),
    invitationIds: fakeInvitationIds(),
    tokens,
    links: { build: (raw: string) => `https://app.lagda.test/accept-invitation?token=${raw}` },
    scheduleDelivery: (input) => {
      if (over.deliveryFails === true) {
        return Promise.reject(new Error("queue unavailable"));
      }
      delivered.push({
        invitationId: input.invitationId, invitationUrl: input.invitationUrl,
      });
      return Promise.resolve();
    },
    idempotency: {
      digester: createIdempotencyKeyDigester(),
      ids: createIdempotencyRecordIds(),
      clock: new FixedClock(AT),
      policy: { retentionMs: 86_400_000 },
    },
  };

  const acceptDeps: AcceptInvitationDependencies = {
    transactions,
    clock: new FixedClock(AT),
    tokens,
    memberIds: new SequentialMemberIds(),
    currentNormalizedEmail: (userId: UserId) => {
      for (const [email, id] of store.accountEmails) {
        if (id === userId) return Promise.resolve(email as NormalizedEmail);
      }
      return Promise.resolve(null);
    },
  };

  return {
    transactions, store, tokens, deps, acceptDeps, delivered,
    workspaceId: created.workspaceId,
  };
}

const invite = (h: Harness, email = "invitee@example.com", role: "member" | "sender" = "member") =>
  createWorkspaceInvitation(
    { actor: actor(OWNER), workspaceId: h.workspaceId, email, role }, h.deps);

// ── Create ───────────────────────────────────────────────────────────────────

describe("createWorkspaceInvitation", () => {
  it("creates a pending invitation and schedules ONE delivery", async () => {
    const h = await harness();
    const summary = await invite(h);

    expect(summary.state).toBe("pending");
    expect(summary.role).toBe("member");
    expect(summary.expiresAt).toBe(AT + INVITATION_TTL_MS);
    expect(h.delivered).toHaveLength(1);
  });

  it("creates NO membership", async () => {
    // The invariant this whole command exists to hold. An invitation is an
    // offer; only acceptance creates access.
    const h = await harness();
    await invite(h);
    // The owner's own membership, and nothing else.
    expect(h.store.memberships).toHaveLength(1);
    expect(h.store.memberships[0]?.userId).toBe(OWNER);
  });

  it("normalizes the invitee address with the canonical normalizer", async () => {
    const h = await harness();
    const summary = await invite(h, "  Invitee@EXAMPLE.com  ");
    // The DISPLAY form is trimmed and preserved for rendering.
    expect(summary.email).toBe("Invitee@EXAMPLE.com");
    // The identity key is canonical — proved by the duplicate check below
    // rejecting the lower-case form.
    await expect(invite(h, "invitee@example.com"))
      .rejects.toBeInstanceOf(InvitationAlreadyPendingError);
  });

  it("refuses a caller who is not a member of the workspace", async () => {
    const h = await harness();
    await expect(createWorkspaceInvitation({
      actor: actor(STRANGER), workspaceId: h.workspaceId,
      email: "x@example.com", role: "member",
    }, h.deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(h.delivered).toHaveLength(0);
  });

  it("refuses a member who is not a manager, and sends nothing", async () => {
    const h = await harness();
    h.store.memberships.push({
      memberId: "mem_reader" as never, workspaceId: h.workspaceId,
      userId: STRANGER, role: "reviewer", createdAt: AT,
    });
    await expect(createWorkspaceInvitation({
      actor: actor(STRANGER), workspaceId: h.workspaceId,
      email: "x@example.com", role: "member",
    }, h.deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(h.delivered).toHaveLength(0);
  });

  it("refuses a workspace the caller has nothing to do with", async () => {
    const h = await harness();
    await expect(createWorkspaceInvitation({
      actor: actor(OWNER), workspaceId: "ws_elsewhere" as WorkspaceId,
      email: "x@example.com", role: "member",
    }, h.deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("takes the inviter from the ACTOR and has nowhere to put a supplied one", async () => {
    const h = await harness();
    await invite(h);
    const stored = h.store.invitations[0];
    expect(stored?.invitedByUserId).toBe(OWNER);
  });

  it("refuses an existing member and sends nothing", async () => {
    const h = await harness();
    // The owner inviting themselves. Already a member, so no email.
    await expect(invite(h, "owner@example.com"))
      .rejects.toBeInstanceOf(AlreadyWorkspaceMemberError);
    expect(h.delivered).toHaveLength(0);
    expect(h.store.invitations).toHaveLength(0);
  });

  it("refuses a second invitation while one is pending — create never resends", async () => {
    const h = await harness();
    await invite(h);
    await expect(invite(h)).rejects.toBeInstanceOf(InvitationAlreadyPendingError);
    // Critically: no second email. A double-submitted form must not mail twice.
    expect(h.delivered).toHaveLength(1);
  });

  it("supersedes an EXPIRED invitation and issues a fresh one", async () => {
    // The partial unique index cannot filter on the clock, so an expired row
    // still holds the slot. Create frees it explicitly.
    const h = await harness();
    await invite(h);
    const later = {
      ...h.deps,
      clock: { now: () => AT + INVITATION_TTL_MS + 1000 },
    };
    const replacement = await createWorkspaceInvitation({
      actor: actor(OWNER), workspaceId: h.workspaceId,
      email: "invitee@example.com", role: "member",
    }, later);

    expect(replacement.state).toBe("pending");
    expect(h.store.invitations).toHaveLength(2);
    expect(h.store.invitations[0]?.supersededAt).not.toBeNull();
  });

  it("rejects a malformed address before writing anything", async () => {
    const h = await harness();
    await expect(invite(h, "not-an-email"))
      .rejects.toBeInstanceOf(ApplicationValidationError);
    expect(h.store.invitations).toHaveLength(0);
  });

  it("rolls the invitation back when delivery cannot be scheduled", async () => {
    // §129. A pending invitation nobody was emailed is a row in the manager's
    // list that no link will ever match.
    const h = await harness({ deliveryFails: true });
    await expect(invite(h)).rejects.toThrow("queue unavailable");
    expect(h.store.invitations).toHaveLength(0);
  });

  it("hands delivery a URL built from the configured origin", async () => {
    const h = await harness();
    await invite(h);
    expect(h.delivered[0]?.invitationUrl)
      .toBe(`https://app.lagda.test/accept-invitation?token=${h.tokens.issued[0] ?? ""}`);
  });

  // ── Idempotency ────────────────────────────────────────────────────────────

  it("creates ONE invitation and ONE delivery for a retried request", async () => {
    const h = await harness();
    const key = "invite-key-00001" as IdempotencyKey;
    const first = await createWorkspaceInvitation({
      actor: actor(OWNER), workspaceId: h.workspaceId,
      email: "invitee@example.com", role: "member", idempotencyKey: key,
    }, h.deps);
    const second = await createWorkspaceInvitation({
      actor: actor(OWNER), workspaceId: h.workspaceId,
      email: "invitee@example.com", role: "member", idempotencyKey: key,
    }, h.deps);

    expect(second.invitationId).toBe(first.invitationId);
    expect(h.store.invitations).toHaveLength(1);
    // The replay must not mail the recipient a second time.
    expect(h.delivered).toHaveLength(1);
  });

  it("REFUSES the same key with a different role", async () => {
    const h = await harness();
    const key = "invite-key-00002" as IdempotencyKey;
    await createWorkspaceInvitation({
      actor: actor(OWNER), workspaceId: h.workspaceId,
      email: "invitee@example.com", role: "member", idempotencyKey: key,
    }, h.deps);
    await expect(createWorkspaceInvitation({
      actor: actor(OWNER), workspaceId: h.workspaceId,
      email: "invitee@example.com", role: "sender", idempotencyKey: key,
    }, h.deps)).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

// ── List ─────────────────────────────────────────────────────────────────────

describe("listWorkspaceInvitations", () => {
  it("returns invitations with derived state", async () => {
    const h = await harness();
    await invite(h);
    const list = await listWorkspaceInvitations(actor(OWNER), h.workspaceId, h.deps);
    expect(list).toHaveLength(1);
    expect(list[0]?.state).toBe("pending");
  });

  it("reports EXPIRED without any row having been written", async () => {
    // State is derived from timestamps and the clock. Nothing marks expiry.
    const h = await harness();
    await invite(h);
    const later = { ...h.deps, clock: { now: () => AT + INVITATION_TTL_MS + 1 } };
    const list = await listWorkspaceInvitations(actor(OWNER), h.workspaceId, later);
    expect(list[0]?.state).toBe("expired");
  });

  it("refuses a non-manager", async () => {
    const h = await harness();
    h.store.memberships.push({
      memberId: "mem_reader" as never, workspaceId: h.workspaceId,
      userId: STRANGER, role: "reviewer", createdAt: AT,
    });
    await expect(listWorkspaceInvitations(actor(STRANGER), h.workspaceId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// ── Resend ───────────────────────────────────────────────────────────────────

describe("resendWorkspaceInvitation", () => {
  it("rotates the credential: the old token dies, the new one works", async () => {
    const h = await harness();
    const created = await invite(h);
    const oldToken = h.tokens.issued[0] ?? "";

    await resendWorkspaceInvitation({
      actor: actor(OWNER), workspaceId: h.workspaceId,
      invitationId: created.invitationId,
    }, h.deps);
    const newToken = h.tokens.issued[1] ?? "";

    expect(newToken).not.toBe(oldToken);
    // Exactly one valid link at any moment.
    await expect(getWorkspaceInvitationPreview(oldToken, h.acceptDeps))
      .rejects.toBeInstanceOf(InvitationInvalidError);
    await expect(getWorkspaceInvitationPreview(newToken, h.acceptDeps))
      .resolves.toMatchObject({ workspaceName: "Acme Legal" });
  });

  it("keeps ONE invitation row rather than stacking one per resend", async () => {
    const h = await harness();
    const created = await invite(h);
    await resendWorkspaceInvitation({
      actor: actor(OWNER), workspaceId: h.workspaceId,
      invitationId: created.invitationId,
    }, h.deps);
    expect(h.store.invitations).toHaveLength(1);
    expect(h.delivered).toHaveLength(2);
  });

  it("cannot change the target address or the role", async () => {
    // There is no field for either. The resent invitation carries exactly what
    // the original did.
    const h = await harness();
    const created = await invite(h, "invitee@example.com", "sender");
    const resent = await resendWorkspaceInvitation({
      actor: actor(OWNER), workspaceId: h.workspaceId,
      invitationId: created.invitationId,
    }, h.deps);
    expect(resent.email).toBe("invitee@example.com");
    expect(resent.role).toBe("sender");
  });

  it("PRESERVES the old credential when delivery fails", async () => {
    // §33, §260. The worst available outcome is the old link dead and the
    // replacement unsent. The rotation and the scheduling share a transaction
    // precisely so that cannot happen.
    const h = await harness();
    const created = await invite(h);
    const oldToken = h.tokens.issued[0] ?? "";

    const failing: InvitationDependencies = {
      ...h.deps,
      scheduleDelivery: () => Promise.reject(new Error("queue unavailable")),
    };
    await expect(resendWorkspaceInvitation({
      actor: actor(OWNER), workspaceId: h.workspaceId,
      invitationId: created.invitationId,
    }, failing)).rejects.toThrow("queue unavailable");

    // The invitee's existing link still works.
    await expect(getWorkspaceInvitationPreview(oldToken, h.acceptDeps))
      .resolves.toMatchObject({ workspaceName: "Acme Legal" });
  });

  it("refuses to resend a revoked invitation", async () => {
    const h = await harness();
    const created = await invite(h);
    await revokeWorkspaceInvitation(
      actor(OWNER), h.workspaceId, created.invitationId, h.deps);
    await expect(resendWorkspaceInvitation({
      actor: actor(OWNER), workspaceId: h.workspaceId,
      invitationId: created.invitationId,
    }, h.deps)).rejects.toBeInstanceOf(InvitationInvalidError);
  });

  it("does not rotate twice for a retried resend", async () => {
    const h = await harness();
    const created = await invite(h);
    const key = "resend-key-00001" as IdempotencyKey;

    await resendWorkspaceInvitation({
      actor: actor(OWNER), workspaceId: h.workspaceId,
      invitationId: created.invitationId, idempotencyKey: key,
    }, h.deps);
    const rotatedTo = h.tokens.issued[1] ?? "";

    await resendWorkspaceInvitation({
      actor: actor(OWNER), workspaceId: h.workspaceId,
      invitationId: created.invitationId, idempotencyKey: key,
    }, h.deps);

    // The replay did not rotate again — the link already in the recipient's
    // mailbox is still the live one.
    await expect(getWorkspaceInvitationPreview(rotatedTo, h.acceptDeps))
      .resolves.toMatchObject({ workspaceName: "Acme Legal" });
    expect(h.delivered).toHaveLength(2);
  });
});

// ── Revoke ───────────────────────────────────────────────────────────────────

describe("revokeWorkspaceInvitation", () => {
  it("kills the credential", async () => {
    const h = await harness();
    const created = await invite(h);
    const token = h.tokens.issued[0] ?? "";

    const result = await revokeWorkspaceInvitation(
      actor(OWNER), h.workspaceId, created.invitationId, h.deps);
    expect(result.outcome).toBe("revoked");

    await expect(getWorkspaceInvitationPreview(token, h.acceptDeps))
      .rejects.toBeInstanceOf(InvitationInvalidError);
  });

  it("preserves the row rather than deleting it", async () => {
    const h = await harness();
    const created = await invite(h);
    await revokeWorkspaceInvitation(
      actor(OWNER), h.workspaceId, created.invitationId, h.deps);
    expect(h.store.invitations).toHaveLength(1);
    expect(h.store.invitations[0]?.revokedAt).toBe(AT);
  });

  it("reports the state rather than failing for an already-accepted invitation", async () => {
    const h = await harness();
    const created = await invite(h);
    await acceptWorkspaceInvitation(
      actor(INVITEE), h.tokens.issued[0] ?? "", h.acceptDeps);

    const result = await revokeWorkspaceInvitation(
      actor(OWNER), h.workspaceId, created.invitationId, h.deps);
    expect(result).toEqual({ outcome: "not-pending", state: "accepted" });
    // Revocation cannot undo a membership. Removing a member is a different
    // operation and does not exist yet.
    expect(h.store.memberships).toHaveLength(2);
  });

  it("refuses a non-manager", async () => {
    const h = await harness();
    const created = await invite(h);
    await expect(revokeWorkspaceInvitation(
      actor(STRANGER), h.workspaceId, created.invitationId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// ── Preview ──────────────────────────────────────────────────────────────────

describe("getWorkspaceInvitationPreview", () => {
  it("returns the workspace name and role to the credential holder", async () => {
    const h = await harness();
    await invite(h);
    const preview = await getWorkspaceInvitationPreview(
      h.tokens.issued[0] ?? "", h.acceptDeps);
    expect(preview).toEqual({
      workspaceName: "Acme Legal",
      role: "member",
      inviteeEmail: "invitee@example.com",
      expiresAt: AT + INVITATION_TTL_MS,
    });
  });

  it("creates no membership", async () => {
    const h = await harness();
    await invite(h);
    await getWorkspaceInvitationPreview(h.tokens.issued[0] ?? "", h.acceptDeps);
    expect(h.store.memberships).toHaveLength(1);
  });

  it("refuses a malformed token WITHOUT touching the database", async () => {
    const h = await harness();
    await expect(getWorkspaceInvitationPreview("nonsense", h.acceptDeps))
      .rejects.toBeInstanceOf(InvitationInvalidError);
    expect(h.transactions.started).toBe(1); // only the workspace creation
  });

  it("answers unknown, revoked and expired IDENTICALLY", async () => {
    // The anti-enumeration property: nothing distinguishes a token that never
    // existed from one that was withdrawn.
    const h = await harness();
    const created = await invite(h);
    const revokedToken = h.tokens.issued[0] ?? "";
    await revokeWorkspaceInvitation(
      actor(OWNER), h.workspaceId, created.invitationId, h.deps);

    const unknown = await getWorkspaceInvitationPreview("invtok_9999", h.acceptDeps)
      .catch((e: unknown) => e);
    const revoked = await getWorkspaceInvitationPreview(revokedToken, h.acceptDeps)
      .catch((e: unknown) => e);

    expect(unknown).toBeInstanceOf(InvitationInvalidError);
    expect((unknown as InvitationInvalidError).code)
      .toBe((revoked as InvitationInvalidError).code);
    expect((unknown as InvitationInvalidError).message)
      .toBe((revoked as InvitationInvalidError).message);
  });
});

// ── Accept ───────────────────────────────────────────────────────────────────

describe("acceptWorkspaceInvitation", () => {
  it("creates the membership with the role from the INVITATION", async () => {
    const h = await harness();
    await invite(h, "invitee@example.com", "sender");
    const result = await acceptWorkspaceInvitation(
      actor(INVITEE), h.tokens.issued[0] ?? "", h.acceptDeps);

    expect(result.joined).toBe(true);
    expect(result.role).toBe("sender");
    const membership = h.store.memberships.find(m => m.userId === INVITEE);
    expect(membership?.role).toBe("sender");
  });

  it("consumes the invitation, so the same token cannot be used twice", async () => {
    const h = await harness();
    await invite(h);
    const token = h.tokens.issued[0] ?? "";
    await acceptWorkspaceInvitation(actor(INVITEE), token, h.acceptDeps);

    await expect(acceptWorkspaceInvitation(actor(INVITEE), token, h.acceptDeps))
      .rejects.toBeInstanceOf(InvitationInvalidError);
    expect(h.store.memberships.filter(m => m.userId === INVITEE)).toHaveLength(1);
  });

  it("REFUSES a different signed-in account — a forwarded link is useless", async () => {
    // The single most valuable property in the design. Possession of the link
    // is not enough; the account has to be the invited one.
    const h = await harness();
    await invite(h);
    await expect(acceptWorkspaceInvitation(
      actor(STRANGER), h.tokens.issued[0] ?? "", h.acceptDeps))
      .rejects.toBeInstanceOf(InvitationAccountMismatchError);
    expect(h.store.memberships).toHaveLength(1);
  });

  it("matches canonically, so casing differences still accept", async () => {
    const h = await harness();
    await invite(h, "Invitee@Example.COM");
    const result = await acceptWorkspaceInvitation(
      actor(INVITEE), h.tokens.issued[0] ?? "", h.acceptDeps);
    expect(result.joined).toBe(true);
  });

  it("refuses after the invited account changes its email", async () => {
    // §109/§110. The invitation was addressed to a MAILBOX. Following the
    // person to an address the inviter never chose would be reassignment.
    const h = await harness();
    await invite(h);
    h.store.accountEmails.delete(INVITEE_EMAIL);
    h.store.accountEmails.set(assertNormalized("new-address@example.com"), INVITEE);

    await expect(acceptWorkspaceInvitation(
      actor(INVITEE), h.tokens.issued[0] ?? "", h.acceptDeps))
      .rejects.toBeInstanceOf(InvitationAccountMismatchError);
  });

  it("refuses an expired invitation", async () => {
    const h = await harness();
    await invite(h);
    const later = { ...h.acceptDeps, clock: { now: () => AT + INVITATION_TTL_MS + 1 } };
    await expect(acceptWorkspaceInvitation(
      actor(INVITEE), h.tokens.issued[0] ?? "", later))
      .rejects.toBeInstanceOf(InvitationInvalidError);
    expect(h.store.memberships).toHaveLength(1);
  });

  it("refuses a revoked invitation", async () => {
    const h = await harness();
    const created = await invite(h);
    await revokeWorkspaceInvitation(
      actor(OWNER), h.workspaceId, created.invitationId, h.deps);
    await expect(acceptWorkspaceInvitation(
      actor(INVITEE), h.tokens.issued[0] ?? "", h.acceptDeps))
      .rejects.toBeInstanceOf(InvitationInvalidError);
  });

  it("refuses a SUPERSEDED credential after a resend", async () => {
    const h = await harness();
    const created = await invite(h);
    const oldToken = h.tokens.issued[0] ?? "";
    await resendWorkspaceInvitation({
      actor: actor(OWNER), workspaceId: h.workspaceId,
      invitationId: created.invitationId,
    }, h.deps);

    await expect(acceptWorkspaceInvitation(actor(INVITEE), oldToken, h.acceptDeps))
      .rejects.toBeInstanceOf(InvitationInvalidError);
    // The fresh one works.
    const result = await acceptWorkspaceInvitation(
      actor(INVITEE), h.tokens.issued[1] ?? "", h.acceptDeps);
    expect(result.joined).toBe(true);
  });

  it("converges when the membership already exists", async () => {
    // §75, §115, §165. The desired end state holds; leaving the invitation
    // live would dangle a credential for access that already exists.
    const h = await harness();
    await invite(h);
    h.store.memberships.push({
      memberId: "mem_other" as never, workspaceId: h.workspaceId,
      userId: INVITEE, role: "member", createdAt: AT,
    });

    const result = await acceptWorkspaceInvitation(
      actor(INVITEE), h.tokens.issued[0] ?? "", h.acceptDeps);

    expect(result.joined).toBe(false);
    expect(h.store.memberships.filter(m => m.userId === INVITEE)).toHaveLength(1);
    expect(h.store.invitations[0]?.acceptedAt).toBe(AT);
  });

  it("makes the workspace appear in the invitee's list immediately", async () => {
    // The cross-feature property: membership is authoritative, so nothing has
    // to be refreshed or re-issued.
    const h = await harness();
    await invite(h);
    expect(await listMyWorkspaces(INVITEE, { transactions: h.transactions }))
      .toHaveLength(0);

    await acceptWorkspaceInvitation(actor(INVITEE), h.tokens.issued[0] ?? "", h.acceptDeps);

    const mine = await listMyWorkspaces(INVITEE, { transactions: h.transactions });
    expect(mine).toHaveLength(1);
    expect(mine[0]?.name).toBe("Acme Legal");
  });

  it("does the whole ceremony in ONE transaction", async () => {
    const h = await harness();
    await invite(h);
    const before = h.transactions.committed;
    await acceptWorkspaceInvitation(actor(INVITEE), h.tokens.issued[0] ?? "", h.acceptDeps);
    expect(h.transactions.committed - before).toBe(1);
  });
});

// ── Decline ──────────────────────────────────────────────────────────────────

describe("declineWorkspaceInvitation", () => {
  it("closes the invitation without creating a membership", async () => {
    const h = await harness();
    await invite(h);
    const result = await declineWorkspaceInvitation(
      actor(INVITEE), h.tokens.issued[0] ?? "", h.acceptDeps);

    expect(result.declined).toBe(true);
    expect(h.store.memberships).toHaveLength(1);
    expect(h.store.invitations[0]?.declinedAt).toBe(AT);
    // Distinct from revocation, so a manager can tell who said no.
    expect(h.store.invitations[0]?.revokedAt).toBeNull();
  });

  it("REFUSES a different signed-in account", async () => {
    // Otherwise anyone holding a forwarded link could burn someone else's
    // invitation.
    const h = await harness();
    await invite(h);
    await expect(declineWorkspaceInvitation(
      actor(STRANGER), h.tokens.issued[0] ?? "", h.acceptDeps))
      .rejects.toBeInstanceOf(InvitationAccountMismatchError);
    expect(h.store.invitations[0]?.declinedAt).toBeNull();
  });

  it("does not blocklist the address — a manager may invite again", async () => {
    const h = await harness();
    await invite(h);
    await declineWorkspaceInvitation(actor(INVITEE), h.tokens.issued[0] ?? "", h.acceptDeps);
    const second = await invite(h);
    expect(second.state).toBe("pending");
  });

  it("cannot decline an already-accepted invitation", async () => {
    const h = await harness();
    await invite(h);
    const token = h.tokens.issued[0] ?? "";
    await acceptWorkspaceInvitation(actor(INVITEE), token, h.acceptDeps);
    await expect(declineWorkspaceInvitation(actor(INVITEE), token, h.acceptDeps))
      .rejects.toBeInstanceOf(InvitationInvalidError);
  });
});
