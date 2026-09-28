// 089. The invitee inbox's HTTP contract, through the REAL `createApp`:
// session and CSRF, the verified-address match (403 / 404), the required
// decline reason (422), withdraw (409), accept, and the logo route.

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { CSRF_TOKEN_HEADER, IDEMPOTENCY_KEY_HEADER, type UserId } from "@lagda/contracts";
import {
  createSessionService, assertNormalized,
  type SessionRepository, type SessionRecord, type NewSession,
  type InvitationDependencies, type AcceptInvitationDependencies, type MyInvitationDependencies,
  type CreateWorkspaceDependencies, type GetWorkspaceDependencies,
  type ListMyWorkspacesDependencies, type NormalizedEmail, type InviteeAccount,
} from "@lagda/application";
import {
  joinNotifyDependencies, invitationNoticeDependencies,
  FakeTransactionManager, FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import { createApp } from "../app/create-app.js";
import { loadApiConfig } from "../config/index.js";
import { SESSION_COOKIE_NAME } from "../security/cookies.js";
import { createSecurityTokenGenerator, createSecurityTokenDigester } from "../security/crypto.js";

const AT = Date.parse("2026-09-28T09:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const INVITEE = "usr_invitee" as UserId;
const STRANGER = "usr_stranger" as UserId;
const UNVERIFIED = "usr_unverified" as UserId;

const ACCOUNTS: Record<string, InviteeAccount> = {
  [OWNER]: { normalizedEmail: "owner@example.com", emailVerified: true, displayName: "Olive Owner" },
  [INVITEE]: { normalizedEmail: "invitee@example.com", emailVerified: true, displayName: "Ivy Invitee" },
  [STRANGER]: { normalizedEmail: "stranger@example.com", emailVerified: true, displayName: "Sam" },
  [UNVERIFIED]: { normalizedEmail: "unverified@example.com", emailVerified: false, displayName: "Una" },
};

function fakeSessionRepository(): SessionRepository {
  const rows = new Map<string, SessionRecord>();
  return {
    findByTokenHash: hash => Promise.resolve([...rows.values()].find(r => r.tokenHash === hash) ?? null),
    create: (s: NewSession) => {
      rows.set(s.sessionId, { ...s, lastSeenAt: s.createdAt });
      return Promise.resolve();
    },
    touch: () => Promise.resolve(),
    revoke: () => Promise.resolve(),
    revokeAllForUser: () => Promise.resolve(0),
  };
}

let open: FastifyInstance | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function harness() {
  const sessions = createSessionService({
    sessions: fakeSessionRepository(),
    tokens: createSecurityTokenGenerator(),
    digester: createSecurityTokenDigester(),
    clock: { now: () => Date.now() },
    policy: { absoluteLifetimeMs: 7 * 24 * 3_600_000, idleTimeoutMs: 8 * 3_600_000, touchIntervalMs: 300_000 },
  });
  const transactions = new FakeTransactionManager();
  for (const [id, account] of Object.entries(ACCOUNTS)) {
    transactions.store.accountEmails.set(assertNormalized(account.normalizedEmail), id as UserId);
    if (account.emailVerified) {
      transactions.store.verifiedAccounts.set(account.normalizedEmail, { userId: id as UserId, displayName: account.displayName });
    }
  }
  let nextInvitation = 1;
  let nextToken = 1;
  const idempotency = {
    digester: createIdempotencyKeyDigester(), ids: createIdempotencyRecordIds(),
    clock: new FixedClock(AT), policy: { retentionMs: 86_400_000 },
  };
  const tokens = {
    issue: () => {
      const raw = `invtok_${String(nextToken++).padStart(4, "0")}`;
      return { raw, digest: `digest-of-${raw}` as never };
    },
    digest: (s: string) => (s.startsWith("invtok_") ? `digest-of-${s}` as never : null),
  };
  const workspaceIds = new SequentialWorkspaceIds();
  const memberIds = new SequentialMemberIds();
  const invitationDeps = (): InvitationDependencies => ({
    transactions, clock: new FixedClock(AT),
    invitationIds: { nextWorkspaceInvitationId: () => `inv_${String(nextInvitation++)}` as never },
    tokens, links: { build: raw => `https://app.lagda.test/accept-invitation?token=${raw}` },
    idempotency, notices: invitationNoticeDependencies(new FixedClock(AT)),
  });
  const acceptDeps = (): AcceptInvitationDependencies => ({
    transactions, clock: new FixedClock(AT), tokens, memberIds,
    joinRequests: joinNotifyDependencies(new FixedClock(AT)),
    currentNormalizedEmail: userId => Promise.resolve(
      (ACCOUNTS[userId]?.normalizedEmail ?? null) as NormalizedEmail | null),
  });
  const inboxDeps = (): MyInvitationDependencies => ({
    transactions, clock: new FixedClock(AT),
    joinRequests: joinNotifyDependencies(new FixedClock(AT)),
    notices: invitationNoticeDependencies(new FixedClock(AT)),
    currentAccount: userId => Promise.resolve(ACCOUNTS[userId] ?? null),
  });

  const app = await createApp({
    config: loadApiConfig({ NODE_ENV: "test", API_PORT: "8080", LOG_LEVEL: "silent" }),
    dependencies: {
      databaseHealth: { isReachable: () => Promise.resolve(true), hasCurrentSchema: () => Promise.resolve(true) },
      sessions,
      workspaces: {
        create: (): CreateWorkspaceDependencies => ({
          transactions, clock: new FixedClock(AT), workspaceIds, memberIds, idempotency,
        }),
        list: (): ListMyWorkspacesDependencies => ({ transactions }),
        workspace: (): GetWorkspaceDependencies => ({ transactions }),
        invitations: { management: invitationDeps, redemption: acceptDeps, inbox: inboxDeps },
      },
    },
  });
  open = app;

  const signIn = async (userId: UserId) => {
    const issued = await sessions.issue(userId);
    return { cookie: `${SESSION_COOKIE_NAME}=${issued.sessionToken}`, csrf: issued.csrfToken };
  };
  const owner = await signIn(OWNER);
  const created = await app.inject({
    method: "POST", url: "/workspaces",
    headers: { cookie: owner.cookie, [CSRF_TOKEN_HEADER]: owner.csrf, [IDEMPOTENCY_KEY_HEADER]: "ws-setup-key-0001" },
    payload: { name: "Acme Legal" },
  });
  const workspaceId = created.json<{ workspaceId: string }>().workspaceId;
  await transactions.runForWorkspace(workspaceId as never, async uow => {
    await uow.branding.saveLogo({ bytes: new Uint8Array([137, 80, 78, 71]), width: 4, height: 4, digest: "e".repeat(64) }, AT);
  });
  const invite = async (email: string) => {
    const response = await app.inject({
      method: "POST", url: `/workspaces/${workspaceId}/invitations`,
      headers: {
        cookie: owner.cookie, [CSRF_TOKEN_HEADER]: owner.csrf,
        [IDEMPOTENCY_KEY_HEADER]: `invite-key-${email.padEnd(12, "x")}`,
      },
      payload: { email, role: "sender" },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ invitationId: string }>().invitationId;
  };
  return { app, transactions, signIn, workspaceId, invite };
}

type Auth = { cookie: string; csrf: string };
const post = (h: Awaited<ReturnType<typeof harness>>, auth: Auth, url: string, payload?: unknown) =>
  h.app.inject({
    method: "POST", url, headers: { cookie: auth.cookie, [CSRF_TOKEN_HEADER]: auth.csrf },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

describe("my invitation routes", () => {
  it("refuses every route anonymously", async () => {
    const h = await harness();
    for (const [method, url] of [
      ["GET", "/me/invitations"],
      ["POST", "/me/invitations/inv_1/accept"],
      ["POST", "/me/invitations/inv_1/decline"],
      ["POST", "/me/invitations/inv_1/withdraw-decline"],
      ["GET", "/me/invitations/inv_1/branding/logo"],
    ] as const) {
      const response = await h.app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("refuses a write without CSRF", async () => {
    const h = await harness();
    const id = await h.invite("invitee@example.com");
    const invitee = await h.signIn(INVITEE);
    const response = await h.app.inject({
      method: "POST", url: `/me/invitations/${id}/accept`, headers: { cookie: invitee.cookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("lists the caller's pending invitations with branding and a recipient-safe logo url", async () => {
    const h = await harness();
    const id = await h.invite("Invitee@Example.com");
    await h.invite("other@example.com");
    const invitee = await h.signIn(INVITEE);
    const response = await h.app.inject({ method: "GET", url: "/me/invitations", headers: { cookie: invitee.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const { items } = response.json<{ items: Record<string, unknown>[] }>();
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      invitationId: id, workspaceId: h.workspaceId, workspaceName: "Acme Legal", role: "sender",
      invitedBy: { displayName: "Someone" }, status: "pending",
      createdAt: new Date(AT).toISOString(), expiresAt: new Date(AT + 7 * 86_400_000).toISOString(),
      declinedAt: null, declineReason: null,
      branding: {
        displayName: "Acme Legal", primaryColor: null,
        logo: { version: "e".repeat(64), url: `/me/invitations/${id}/branding/logo?v=${"e".repeat(64)}` },
      },
    });
    const logo = await h.app.inject({
      method: "GET", url: `/me/invitations/${id}/branding/logo`, headers: { cookie: invitee.cookie },
    });
    expect(logo.statusCode).toBe(200);
    expect(logo.headers["content-type"]).toBe("image/png");
    expect(logo.headers["cache-control"]).toBe("private, max-age=300");
  });

  it("answers 403 account_email_unverified and 404 for somebody else's invitation", async () => {
    const h = await harness();
    const id = await h.invite("invitee@example.com");
    const unverified = await h.signIn(UNVERIFIED);
    const refused = await h.app.inject({ method: "GET", url: "/me/invitations", headers: { cookie: unverified.cookie } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("account_email_unverified");
    const stranger = await h.signIn(STRANGER);
    expect((await post(h, stranger, `/me/invitations/${id}/accept`)).statusCode).toBe(404);
    expect((await h.app.inject({
      method: "GET", url: `/me/invitations/${id}/branding/logo`, headers: { cookie: stranger.cookie },
    })).statusCode).toBe(404);
  });

  it("decline requires a reason; withdraw reopens; a second withdraw is 409", async () => {
    const h = await harness();
    const id = await h.invite("invitee@example.com");
    const invitee = await h.signIn(INVITEE);
    expect((await post(h, invitee, `/me/invitations/${id}/decline`, {})).statusCode).toBe(422);
    expect((await post(h, invitee, `/me/invitations/${id}/decline`, { reason: "" })).statusCode).toBe(422);
    expect((await post(h, invitee, `/me/invitations/${id}/decline`, { reason: "   " })).statusCode).toBe(422);
    expect((await post(h, invitee, `/me/invitations/${id}/decline`, { reason: "x".repeat(501) })).statusCode).toBe(422);
    const declined = await post(h, invitee, `/me/invitations/${id}/decline`, { reason: "Wrong firm" });
    expect(declined.statusCode).toBe(200);
    expect(declined.json()).toMatchObject({ status: "declined", declineReason: "Wrong firm", declinedAt: new Date(AT).toISOString() });
    const list = await h.app.inject({
      method: "GET", url: "/me/invitations?status=declined", headers: { cookie: invitee.cookie },
    });
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(1);
    const reopened = await post(h, invitee, `/me/invitations/${id}/withdraw-decline`);
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toMatchObject({ status: "pending", declinedAt: null, declineReason: null });
    const again = await post(h, invitee, `/me/invitations/${id}/withdraw-decline`);
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { code: string } }>().error.code).toBe("invitation_state_conflict");
  });

  it("accept with no body files the pending join request, like the emailed link", async () => {
    const h = await harness();
    const id = await h.invite("invitee@example.com");
    const invitee = await h.signIn(INVITEE);
    const accepted = await post(h, invitee, `/me/invitations/${id}/accept`);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({
      workspaceId: h.workspaceId, workspaceName: "Acme Legal", role: "sender", joined: false, pending: true,
    });
    expect(h.transactions.store.joinRequests.filter(r => r.state === "pending")).toHaveLength(1);
    expect((await post(h, invitee, `/me/invitations/${id}/accept`)).statusCode).toBe(409);
    expect((await post(h, invitee, `/me/invitations/${id}/decline`, { reason: "late" })).statusCode).toBe(409);
  });

  it("refuses an unknown status and unexpected decline fields", async () => {
    const h = await harness();
    const id = await h.invite("invitee@example.com");
    const invitee = await h.signIn(INVITEE);
    expect((await h.app.inject({
      method: "GET", url: "/me/invitations?status=revoked", headers: { cookie: invitee.cookie },
    })).statusCode).toBe(422);
    expect((await post(h, invitee, `/me/invitations/${id}/decline`, { reason: "no", role: "owner" })).statusCode).toBe(422);
  });
});
