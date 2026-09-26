// The join-link surface through the REAL `createApp` (078): what is public,
// what needs a session and CSRF, and the single-use, always-approved flow.

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  CSRF_TOKEN_HEADER, IDEMPOTENCY_KEY_HEADER, type UserId,
} from "@lagda/contracts";
import {
  createSessionService, assertNormalized,
  type SessionRepository, type SessionRecord, type NewSession,
  type InvitationDependencies, type AcceptInvitationDependencies,
  type CreateWorkspaceDependencies, type GetWorkspaceDependencies,
  type ListMyWorkspacesDependencies,
  type InvitationTokenFactory, type NormalizedEmail,
  type JoinTicketDependencies, type JoinRequestDependencies,
} from "@lagda/application";
import {
  joinNotifyDependencies,
  FakeTransactionManager, FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import { createApp } from "../app/create-app.js";
import { loadApiConfig, type ApiConfig } from "../config/index.js";
import { SESSION_COOKIE_NAME } from "../security/cookies.js";
import { createSecurityTokenGenerator, createSecurityTokenDigester } from "../security/crypto.js";

const AT = Date.parse("2026-08-10T12:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const INVITEE = "usr_invitee" as UserId;
const OWNER_EMAIL = assertNormalized("owner@example.com");
const INVITEE_EMAIL = assertNormalized("invitee@example.com");
const OTHER = "usr_other" as UserId;
const OTHER_EMAIL = assertNormalized("other@example.com");

const config = (): ApiConfig =>
  loadApiConfig({ NODE_ENV: "test", API_PORT: "8080", LOG_LEVEL: "silent" });

function fakeSessionRepository(): SessionRepository {
  const rows = new Map<string, SessionRecord>();
  return {
    findByTokenHash: hash =>
      Promise.resolve([...rows.values()].find(r => r.tokenHash === hash) ?? null),
    create: (s: NewSession) => {
      rows.set(s.sessionId, { ...s, lastSeenAt: s.createdAt });
      return Promise.resolve();
    },
    touch: () => Promise.resolve(),
    revoke: () => Promise.resolve(),
    revokeAllForUser: () => Promise.resolve(0),
  };
}

/** Sequential and predictable, so a test can name the token it expects. */
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
    digest: (submitted: string) =>
      submitted.startsWith("invtok_") ? (`digest-of-${submitted}` as never) : null,
  };
}

interface Harness {
  readonly app: FastifyInstance;
  readonly transactions: FakeTransactionManager;
  readonly tokens: ReturnType<typeof fakeTokens>;
  readonly signIn: (userId: UserId) => Promise<{ cookie: string; csrf: string }>;
  readonly workspaceId: string;
}

let open: FastifyInstance | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function harness(): Promise<Harness> {
  const sessions = createSessionService({
    sessions: fakeSessionRepository(),
    tokens: createSecurityTokenGenerator(),
    digester: createSecurityTokenDigester(),
    clock: { now: () => Date.now() },
    policy: {
      absoluteLifetimeMs: 7 * 24 * 3_600_000,
      idleTimeoutMs: 8 * 3_600_000,
      touchIntervalMs: 300_000,
    },
  });

  const transactions = new FakeTransactionManager();
  transactions.store.accountEmails.set(OWNER_EMAIL, OWNER);
  transactions.store.accountEmails.set(INVITEE_EMAIL, INVITEE);
  transactions.store.accountEmails.set(OTHER_EMAIL, OTHER);

  const tokens = fakeTokens();
  // ONE generator each, shared across requests — a fresh one per call would
  // hand every record the same id.
  const workspaceIds = new SequentialWorkspaceIds();
  const memberIds = new SequentialMemberIds();
  let nextInvitation = 1;
  const idempotency = {
    digester: createIdempotencyKeyDigester(),
    ids: createIdempotencyRecordIds(),
    clock: new FixedClock(AT),
    policy: { retentionMs: 86_400_000 },
  };

  const invitationDeps = (): InvitationDependencies => ({
    transactions,
    clock: new FixedClock(AT),
    invitationIds: {
      nextWorkspaceInvitationId: () => `inv_${String(nextInvitation++)}` as never,
    },
    tokens,
    links: { build: raw => `https://app.lagda.test/accept-invitation?token=${raw}` },
    scheduleDelivery: () => Promise.resolve(),
    idempotency,
  });

  const acceptDeps = (): AcceptInvitationDependencies => ({
    transactions,
    clock: new FixedClock(AT),
    tokens,
    memberIds,
    joinRequests: joinNotifyDependencies(new FixedClock(AT)),
    currentNormalizedEmail: (userId: UserId) => {
      for (const [email, id] of transactions.store.accountEmails) {
        if (id === userId) return Promise.resolve(email as NormalizedEmail);
      }
      return Promise.resolve(null);
    },
  });

  let nextJoinToken = 1;
  const joinTokens = {
    issue() {
      const raw = `jtoken_${String(nextJoinToken++).padStart(4, "0")}`;
      return { raw, digest: `digest-${raw}` as never };
    },
    digest: (submitted: string) => (submitted.startsWith("jtoken_") ? (`digest-${submitted}` as never) : null),
  };
  const joinNotify = joinNotifyDependencies(new FixedClock(AT));
  const joinTicketDeps = (): JoinTicketDependencies => ({
    transactions, ...joinNotify, tokens: joinTokens,
    secrets: { keyVersion: "v1", seal: raw => `sealed:${raw}`, open: sealed => sealed.replace(/^sealed:/, "") },
  });
  const joinRequestDeps = (): JoinRequestDependencies => ({
    transactions, ...joinNotify, tokens: joinTokens,
    currentAccount: userId => {
      for (const [email, id] of transactions.store.accountEmails) {
        if (id === userId) return Promise.resolve({ email, normalizedEmail: email, emailVerified: true });
      }
      return Promise.resolve(null);
    },
  });

  const app = await createApp({
    config: config(),
    dependencies: {
      databaseHealth: {
    isReachable: () => Promise.resolve(true),
    hasCurrentSchema: () => Promise.resolve(true),
  },
      sessions,
      workspaces: {
        create: (): CreateWorkspaceDependencies => ({
          transactions, clock: new FixedClock(AT), workspaceIds, memberIds, idempotency,
        }),
        list: (): ListMyWorkspacesDependencies => ({ transactions }),
        workspace: (): GetWorkspaceDependencies => ({ transactions }),
        invitations: { management: invitationDeps, redemption: acceptDeps },
        joins: { tickets: joinTicketDeps, requests: joinRequestDeps, linkUrl: raw => `https://app.lagda.test/join/${raw}` },
      },
    },
  });
  open = app;

  const signIn = async (userId: UserId) => {
    const issued = await sessions.issue(userId);
    return {
      cookie: `${SESSION_COOKIE_NAME}=${issued.sessionToken}`,
      csrf: issued.csrfToken,
    };
  };

  // A workspace owned by OWNER, created through the real route.
  const owner = await signIn(OWNER);
  const created = await app.inject({
    method: "POST", url: "/workspaces",
    headers: {
      cookie: owner.cookie, [CSRF_TOKEN_HEADER]: owner.csrf,
      [IDEMPOTENCY_KEY_HEADER]: "ws-setup-key-0001",
    },
    payload: { name: "Acme Legal" },
  });

  return {
    app, transactions, tokens, signIn,
    workspaceId: created.json<{ workspaceId: string }>().workspaceId,
  };
}

interface Auth { readonly cookie: string; readonly csrf: string }

const post = (h: Harness, auth: Auth | null, url: string, payload: Record<string, unknown>) => h.app.inject({
  method: "POST", url, payload,
  headers: auth === null ? {} : { cookie: auth.cookie, [CSRF_TOKEN_HEADER]: auth.csrf },
});
const get = (h: Harness, auth: Auth, url: string) =>
  h.app.inject({ method: "GET", url, headers: { cookie: auth.cookie } });

async function sentLink(h: Harness, owner: Auth) {
  const created = await post(h, owner, `/workspaces/${h.workspaceId}/join-tickets`, { label: "For Juan" });
  const ticketId = created.json<{ ticketId: string }>().ticketId;
  const sent = await post(h, owner, `/workspaces/${h.workspaceId}/join-tickets/${ticketId}/send`, { email: false });
  const linkUrl = sent.json<{ linkUrl: string }>().linkUrl;
  return { ticketId, linkUrl, token: linkUrl.slice(linkUrl.lastIndexOf("/") + 1) };
}

describe("join routes — boundary", () => {
  it("refuses every authenticated route anonymously", async () => {
    const h = await harness();
    const base = `/workspaces/${h.workspaceId}`;
    for (const [method, url] of [
      ["GET", `${base}/join-tickets`], ["POST", `${base}/join-tickets`],
      ["GET", `${base}/join-requests`], ["POST", "/workspace-join/requests"],
    ] as const) {
      const response = await h.app.inject(method === "POST" ? { method, url, payload: {} } : { method, url });
      expect([401, 403], `${method} ${url}`).toContain(response.statusCode);
    }
  });

  it("refuses a state-changing route without CSRF", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);
    const response = await h.app.inject({
      method: "POST", url: `/workspaces/${h.workspaceId}/join-tickets`,
      headers: { cookie: owner.cookie }, payload: { label: "x" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("serves the preview publicly, and previewing uses nothing", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);
    const { token } = await sentLink(h, owner);
    for (let i = 0; i < 2; i++) {
      const preview = await post(h, null, "/workspace-join/preview", { token });
      expect(preview.statusCode).toBe(200);
      expect(preview.json<{ workspaceName: string }>().workspaceName).toBe("Acme Legal");
    }
    expect((await post(h, null, "/workspace-join/preview", { token: "bogus" })).statusCode).toBe(404);
  });
});

describe("join routes — the whole ticket", () => {
  it("is used ONCE, approved with a title and a privilege, and only then is the workspace reachable", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);
    const { token, linkUrl } = await sentLink(h, owner);
    expect(linkUrl).toMatch(/^https:\/\/app\.lagda\.test\/join\/jtoken_/);

    const joiner = await h.signIn(INVITEE);
    const submitted = await post(h, joiner, "/workspace-join/requests",
      { token, fullName: "Juan Dela Cruz", reason: "New associate" });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json()).toMatchObject({ workspaceName: "Acme Legal", state: "pending" });

    // A forwarded copy is dead on arrival.
    const other = await h.signIn(OTHER);
    const late = await post(h, other, "/workspace-join/requests", { token, fullName: "Someone Else" });
    expect(late.statusCode).toBe(410);
    expect((await post(h, null, "/workspace-join/preview", { token })).statusCode).toBe(410);

    expect((await get(h, joiner, "/workspaces")).json<{ workspaces: unknown[] }>().workspaces).toHaveLength(0);

    const pending = await get(h, owner, `/workspaces/${h.workspaceId}/join-requests?state=pending`);
    const [request] = pending.json<{ requests: { requestId: string; email: string }[] }>().requests;
    expect(request?.email).toBe("invitee@example.com");

    const approved = await post(h, owner,
      `/workspaces/${h.workspaceId}/join-requests/${request?.requestId ?? ""}/approve`,
      { roleTitle: "Finance Associate", canRequestDocuments: true });
    expect(approved.statusCode).toBe(200);
    expect((await get(h, joiner, "/workspaces")).json<{ workspaces: unknown[] }>().workspaces).toHaveLength(1);

    expect(h.transactions.store.memberships.find(m => m.userId === INVITEE)).toMatchObject({
      role: "member", roleTitle: "Finance Associate", canRequestDocuments: true, canAssignSigners: false,
    });

    const tickets = await get(h, owner, `/workspaces/${h.workspaceId}/join-tickets`);
    expect(tickets.json<{ tickets: Record<string, unknown>[] }>().tickets[0])
      .toMatchObject({ state: "sent", request: { fullName: "Juan Dela Cruz", state: "approved" } });
  });

  it("withdraw kills the link; send again issues a new one", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);
    const { ticketId, token } = await sentLink(h, owner);
    const withdrawn = await post(h, owner, `/workspaces/${h.workspaceId}/join-tickets/${ticketId}/withdraw`, {});
    expect(withdrawn.json()).toMatchObject({ state: "withdrawn", linkUrl: null });
    expect((await post(h, null, "/workspace-join/preview", { token })).statusCode).toBe(404);
    const again = await post(h, owner, `/workspaces/${h.workspaceId}/join-tickets/${ticketId}/send`, { email: false });
    expect(again.json<{ linkUrl: string }>().linkUrl).not.toContain(token);
  });

  it("a requester can neither manage tickets nor see requests", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);
    const { token } = await sentLink(h, owner);
    const joiner = await h.signIn(INVITEE);
    await post(h, joiner, "/workspace-join/requests", { token, fullName: "Juan" });
    expect((await get(h, joiner, `/workspaces/${h.workspaceId}/join-requests`)).statusCode).toBe(404);
    expect((await post(h, joiner, `/workspaces/${h.workspaceId}/join-tickets`, { label: "x" })).statusCode).toBe(404);
  });
});
