// Conditional GET, through the REAL `createApp`: every JSON answer to a GET
// carries a weak ETag; the same tag sent back in If-None-Match gets a 304
// with no body; a changed answer, a different method, an error and a route
// with its own strong ETag are left alone.

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import {
  createSessionService,
  type SessionRepository, type SessionRecord, type NewSession,
  type CreateWorkspaceDependencies, type GetWorkspaceDependencies,
  type ListMyWorkspacesDependencies,
} from "@lagda/application";
import {
  FakeTransactionManager, FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import { createApp } from "./create-app.js";
import { loadApiConfig } from "../config/index.js";
import { SESSION_COOKIE_NAME } from "../security/cookies.js";
import { createSecurityTokenGenerator, createSecurityTokenDigester } from "../security/crypto.js";

const AT = Date.parse("2026-10-03T10:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const WORKSPACE = "ws_etag" as WorkspaceId;

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
  transactions.store.workspaces.set(WORKSPACE, { workspaceId: WORKSPACE, name: "Acme Legal", createdAt: AT });
  transactions.store.memberships.push(
    { memberId: "mem_owner" as WorkspaceMemberId, workspaceId: WORKSPACE, userId: OWNER, role: "owner", createdAt: AT },
  );
  const app = await createApp({
    config: loadApiConfig({ NODE_ENV: "test", API_PORT: "8080", LOG_LEVEL: "silent" }),
    dependencies: {
      databaseHealth: { isReachable: () => Promise.resolve(true), hasCurrentSchema: () => Promise.resolve(true) },
      sessions,
      workspaces: {
        create: (): CreateWorkspaceDependencies => ({
          transactions, clock: new FixedClock(AT),
          workspaceIds: new SequentialWorkspaceIds(), memberIds: new SequentialMemberIds(),
          idempotency: {
            digester: createIdempotencyKeyDigester(), ids: createIdempotencyRecordIds(),
            clock: new FixedClock(AT), policy: { retentionMs: 24 * 3_600_000 },
          },
        }),
        list: (): ListMyWorkspacesDependencies => ({ transactions }),
        workspace: (): GetWorkspaceDependencies => ({ transactions }),
        members: {
          administration: () => ({ transactions, clock: new FixedClock(AT) }),
          access: () => ({ transactions }),
        },
      },
    },
  });
  open = app;
  const cookie = `${SESSION_COOKIE_NAME}=${(await sessions.issue(OWNER)).sessionToken}`;
  return { app, cookie, transactions };
}

describe("conditional GET", () => {
  it("tags a JSON answer and returns 304 with no body for the same tag", async () => {
    const { app, cookie } = await harness();
    const first = await app.inject({ method: "GET", url: "/workspaces", headers: { cookie } });
    expect(first.statusCode).toBe(200);
    const etag = first.headers["etag"];
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(first.headers["cache-control"]).toBe("no-store"); // unchanged: no browser cache

    const again = await app.inject({ method: "GET", url: "/workspaces", headers: { cookie, "if-none-match": String(etag) } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
    expect(again.headers["etag"]).toBe(etag);
    expect(["0", undefined]).toContain(again.headers["content-length"]);
  });

  it("answers in full once the answer changes, with a new tag", async () => {
    const { app, cookie, transactions } = await harness();
    const first = await app.inject({ method: "GET", url: "/workspaces", headers: { cookie } });
    const etag = String(first.headers["etag"]);
    transactions.store.workspaces.set(WORKSPACE, { workspaceId: WORKSPACE, name: "Acme Legal Group", createdAt: AT });
    const after = await app.inject({ method: "GET", url: "/workspaces", headers: { cookie, "if-none-match": etag } });
    expect(after.statusCode).toBe(200);
    expect(after.headers["etag"]).not.toBe(etag);
    expect(after.json<{ workspaces: { name: string }[] }>().workspaces[0]?.name).toBe("Acme Legal Group");
  });

  it("accepts a list of tags, as a browser may send", async () => {
    const { app, cookie } = await harness();
    const first = await app.inject({ method: "GET", url: "/workspaces", headers: { cookie } });
    const etag = String(first.headers["etag"]);
    const again = await app.inject({
      method: "GET", url: "/workspaces", headers: { cookie, "if-none-match": `W/"other", ${etag}` },
    });
    expect(again.statusCode).toBe(304);
  });

  it("never tags an error, and a 401 is a 401 whatever the client sends", async () => {
    const { app } = await harness();
    const anonymous = await app.inject({ method: "GET", url: "/workspaces", headers: { "if-none-match": 'W/"x"' } });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers["etag"]).toBeUndefined();
    expect(anonymous.json<{ error: { code: string } }>().error.code).toBe("auth_required");
  });

  it("exposes the tag and allows the header across origins", async () => {
    const sessions = createSessionService({
      sessions: fakeSessionRepository(), tokens: createSecurityTokenGenerator(), digester: createSecurityTokenDigester(),
      clock: { now: () => Date.now() },
      policy: { absoluteLifetimeMs: 7 * 24 * 3_600_000, idleTimeoutMs: 8 * 3_600_000, touchIntervalMs: 300_000 },
    });
    const app = await createApp({
      config: loadApiConfig({ NODE_ENV: "test", API_PORT: "8080", LOG_LEVEL: "silent", CORS_ORIGINS: "https://app.example" }),
      dependencies: {
        databaseHealth: { isReachable: () => Promise.resolve(true), hasCurrentSchema: () => Promise.resolve(true) },
        sessions,
      },
    });
    open = app;
    const preflight = await app.inject({
      method: "OPTIONS", url: "/workspaces",
      headers: { origin: "https://app.example", "access-control-request-method": "GET", "access-control-request-headers": "if-none-match" },
    });
    expect(String(preflight.headers["access-control-allow-headers"]).toLowerCase()).toContain("if-none-match");
    const response = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://app.example" } });
    expect(String(response.headers["access-control-expose-headers"]).toLowerCase()).toContain("etag");
  });
});
