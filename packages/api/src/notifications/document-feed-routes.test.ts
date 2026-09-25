// The document notification feed over HTTP.
//
// Fake session STORE; real session service, cookies, CSRF check, schema
// validation and error handler. What is worth proving at THIS layer rather
// than the use case: that the one state-changing route refuses a request
// without the CSRF token, that its body is BOUNDED, that `read` survives a
// round trip across separate requests, and that `scope` is a closed set.

import { describe, it, expect, afterEach } from "vitest";
import { CSRF_TOKEN_HEADER, type UserId } from "@lagda/contracts";
import {
  createSessionService,
  type SessionRepository, type SessionRecord, type NewSession,
  type CreateWorkspaceDependencies, type GetWorkspaceDependencies,
  type ListMyWorkspacesDependencies, MAX_STATE_CHANGE_IDS,
} from "@lagda/application";
import {
  FakeTransactionManager, FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import type { WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app/create-app.js";
import { loadApiConfig, type ApiConfig } from "../config/index.js";
import { SESSION_COOKIE_NAME } from "../security/cookies.js";
import { createSecurityTokenGenerator, createSecurityTokenDigester } from "../security/crypto.js";

const AT = Date.parse("2026-08-10T09:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const COLLEAGUE = "usr_colleague" as UserId;
const WORKSPACE = "ws_feed" as WorkspaceId;
const FEED = `/workspaces/${WORKSPACE}/document-notifications`;
const STATE = `${FEED}/state`;

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
    touch: (id, at) => {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, lastSeenAt: at });
      return Promise.resolve();
    },
    revoke: (id, at, reason) => {
      const row = rows.get(id);
      if (row && row.revokedAt === undefined) {
        rows.set(id, { ...row, revokedAt: at, revocationReason: reason });
      }
      return Promise.resolve();
    },
    revokeAllForUser: () => Promise.resolve(0),
  };
}

interface Harness {
  readonly app: FastifyInstance;
  readonly transactions: FakeTransactionManager;
  readonly signIn: (userId: UserId) => Promise<{ cookie: string; csrf: string }>;
}

function seed(transactions: FakeTransactionManager): void {
  const store = transactions.store;
  store.workspaces.set(WORKSPACE, { workspaceId: WORKSPACE, name: "Acme Legal", createdAt: AT });
  store.memberships.push(
    {
      memberId: "mem_owner" as WorkspaceMemberId, workspaceId: WORKSPACE,
      userId: OWNER, role: "owner", createdAt: AT,
    },
    {
      memberId: "mem_colleague" as WorkspaceMemberId, workspaceId: WORKSPACE,
      userId: COLLEAGUE, role: "owner", createdAt: AT,
    },
  );

  // One document the OWNER sent, one the COLLEAGUE sent to somebody else.
  for (const [id, title, createdBy] of [
    ["sreq_mine", "Office Lease", OWNER],
    ["sreq_theirs", "Colleague's NDA", COLLEAGUE],
  ] as const) {
    store.signingRequests.push({
      signingRequestId: id as never,
      workspaceId: WORKSPACE,
      documentId: `doc_${id}` as never,
      documentTitle: title,
      sourceArtifactId: "art_1" as never,
      state: "sent",
      createdByUserId: createdBy,
      createdAt: AT,
      sentAt: AT,
    } as never);
    store.evidence.push({
      evidenceEventId: `ev_${id}` as never,
      workspaceId: WORKSPACE,
      signingRequestId: id as never,
      eventType: "transaction-sent",
      eventVersion: 1,
      actor: { type: "system" },
      occurredAt: id === "sreq_mine" ? AT + 1000 : AT + 2000,
      recordedAt: AT,
    } as never);
  }
}

async function build(): Promise<Harness> {
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
  seed(transactions);

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
          transactions,
          clock: new FixedClock(AT),
          workspaceIds: new SequentialWorkspaceIds(),
          memberIds: new SequentialMemberIds(),
          idempotency: {
            digester: createIdempotencyKeyDigester(),
            ids: createIdempotencyRecordIds(),
            clock: new FixedClock(AT),
            policy: { retentionMs: 24 * 3_600_000 },
          },
        }),
        list: (): ListMyWorkspacesDependencies => ({ transactions }),
        workspace: (): GetWorkspaceDependencies => ({ transactions }),
        documentFeed: () => ({
          transactions,
          accountEmailOf: () => Promise.resolve(null),
        }),
      },
    },
  });

  return {
    app, transactions,
    signIn: async (userId: UserId) => {
      const issued = await sessions.issue(userId);
      return {
        cookie: `${SESSION_COOKIE_NAME}=${issued.sessionToken}`,
        csrf: issued.csrfToken,
      };
    },
  };
}

let open: FastifyInstance | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function harness(): Promise<Harness> {
  const built = await build();
  open = built.app;
  return built;
}

interface Row { id: string; documentTitle: string; read: boolean }

describe("document notification feed routes", () => {
  it("refuses both routes anonymously", async () => {
    const h = await harness();
    const get = await h.app.inject({ method: "GET", url: FEED });
    const post = await h.app.inject({ method: "POST", url: STATE, payload: { ids: ["ev_sreq_mine"], read: true } });
    expect(get.statusCode).toBe(401);
    expect(post.statusCode).toBe(401);
  });

  it("refuses to mark read without the CSRF token", async () => {
    // The feed's one state change. It sits in the workspace scope, so
    // `requireSession` checks CSRF — this proves that actually happens.
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);

    const response = await h.app.inject({
      method: "POST", url: STATE, headers: { cookie },
      payload: { ids: ["ev_sreq_mine"], read: true },
    });

    expect(response.statusCode).toBe(403);
    expect(h.transactions.store.notificationStates).toHaveLength(0);
  });

  it("persists read state across separate requests", async () => {
    const h = await harness();
    const { cookie, csrf } = await h.signIn(OWNER);

    const first = (await h.app.inject({ method: "GET", url: FEED, headers: { cookie } }))
      .json<{ notifications: Row[] }>().notifications;
    expect(first.map(row => row.read)).toEqual([false]);

    const marked = await h.app.inject({
      method: "POST", url: STATE,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: { ids: first.map(row => row.id), read: true },
    });
    expect(marked.statusCode).toBe(200);
    expect(marked.json<{ updated: number }>().updated).toBe(1);

    const second = (await h.app.inject({ method: "GET", url: FEED, headers: { cookie } }))
      .json<{ notifications: Row[] }>().notifications;
    expect(second.map(row => row.read)).toEqual([true]);
  });

  it("defaults to `mine`, and `scope=workspace` widens it", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);

    const mine = (await h.app.inject({ method: "GET", url: FEED, headers: { cookie } }))
      .json<{ notifications: Row[] }>().notifications;
    const all = (await h.app.inject({ method: "GET", url: `${FEED}?scope=workspace`, headers: { cookie } }))
      .json<{ notifications: Row[] }>().notifications;

    expect(mine.map(row => row.documentTitle)).toEqual(["Office Lease"]);
    expect(all.map(row => row.documentTitle)).toEqual(["Colleague's NDA", "Office Lease"]);
  });

  it("refuses a scope outside the closed set", async () => {
    const h = await harness();
    const { cookie } = await h.signIn(OWNER);

    const response = await h.app.inject({
      method: "GET", url: `${FEED}?scope=everyone`, headers: { cookie },
    });

    // 422: this app routes every schema failure through `validationFailed`,
    // one envelope, rather than Fastify's default 400.
    expect(response.statusCode).toBe(422);
  });

  it("bounds the mark-read body", async () => {
    const h = await harness();
    const { cookie, csrf } = await h.signIn(OWNER);
    const post = (payload: unknown) => h.app.inject({
      method: "POST", url: STATE,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: payload as Record<string, unknown>,
    });

    // Empty, oversized, and a smuggled field are all refused before the use
    // case runs (422 — see `validationFailed`).
    expect((await post({ ids: [], read: true })).statusCode).toBe(422);
    const tooMany = Array.from({ length: MAX_STATE_CHANGE_IDS + 1 }, (_, i) => `ev_${String(i)}`);
    expect((await post({ ids: tooMany, read: true })).statusCode).toBe(422);
    expect((await post({ ids: ["ev_sreq_mine"], read: true, userId: COLLEAGUE })).statusCode).toBe(422);
    // Naming neither half of the state is refused too.
    expect((await post({ ids: ["ev_sreq_mine"] })).statusCode).toBe(422);
    expect(h.transactions.store.notificationStates).toHaveLength(0);
  });

  it("marks for the session's reader only — a colleague's badge is untouched", async () => {
    const h = await harness();
    const owner = await h.signIn(OWNER);
    const colleague = await h.signIn(COLLEAGUE);

    await h.app.inject({
      method: "POST", url: STATE,
      headers: { cookie: owner.cookie, [CSRF_TOKEN_HEADER]: owner.csrf },
      payload: { ids: ["ev_sreq_mine", "ev_sreq_theirs"], read: true },
    });

    const colleagueView = (await h.app.inject({
      method: "GET", url: `${FEED}?scope=workspace`, headers: { cookie: colleague.cookie },
    })).json<{ notifications: Row[] }>().notifications;

    expect(colleagueView.every(row => !row.read)).toBe(true);
  });
});
