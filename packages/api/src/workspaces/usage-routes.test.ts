// The usage summary's HTTP contract, through the REAL `createApp`: the real
// session service, cookies, error handler and encapsulation, with fake
// persistence. Counting itself is proved on PostgreSQL.

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
  createIdempotencyKeyDigester, createIdempotencyRecordIds, fakeUsage,
} from "@lagda/application/test-support";
import { createApp } from "../app/create-app.js";
import { loadApiConfig } from "../config/index.js";
import { SESSION_COOKIE_NAME } from "../security/cookies.js";
import { createSecurityTokenGenerator, createSecurityTokenDigester } from "../security/crypto.js";

const AT = Date.parse("2026-09-26T10:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const MEMBER = "usr_member" as UserId;
const STRANGER = "usr_stranger" as UserId;
const WORKSPACE = "ws_usage" as WorkspaceId;
const URL = `/workspaces/${WORKSPACE}/usage`;

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
  fakeUsage.counts.clear();
  fakeUsage.queries.length = 0;
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
    { memberId: "mem_member" as WorkspaceMemberId, workspaceId: WORKSPACE, userId: MEMBER, role: "member", createdAt: AT },
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
  const cookieFor = async (userId: UserId) =>
    `${SESSION_COOKIE_NAME}=${(await sessions.issue(userId)).sessionToken}`;
  return { app, cookieFor };
}

describe("GET /workspaces/:workspaceId/usage", () => {
  it("returns the full summary to any member, uncacheable", async () => {
    const { app, cookieFor } = await harness();
    fakeUsage.counts.set(WORKSPACE, {
      documents: { total: 3, uploadedThisMonth: 1 },
      signingRequests: { sentThisMonth: 2, sentTotal: 4, inProgress: 1, completedThisMonth: 1, completedTotal: 3 },
      members: 2, templates: 5, contacts: 6, storageBytes: 2048,
    });
    const response = await app.inject({ method: "GET", url: URL, headers: { cookie: await cookieFor(MEMBER) } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<{ period: { start: number; end: number } }>();
    expect(body).toMatchObject({
      documents: { total: 3, uploadedThisMonth: 1 },
      signingRequests: { sentThisMonth: 2, sentTotal: 4, inProgress: 1, completedThisMonth: 1, completedTotal: 3 },
      members: 2, templates: 5, contacts: 6, verificationsThisMonth: 0, storageBytes: 2048,
    });
    // The UTC month of the injected clock, with an inclusive end.
    expect(body.period).toEqual({
      start: Date.parse("2026-09-01T00:00:00.000Z"),
      end: Date.parse("2026-10-01T00:00:00.000Z") - 1,
    });
  });

  it("refuses an anonymous caller", async () => {
    const { app } = await harness();
    expect((await app.inject({ method: "GET", url: URL })).statusCode).toBe(401);
    expect(fakeUsage.queries).toHaveLength(0);
  });

  it("answers a non-member as if the workspace did not exist", async () => {
    const { app, cookieFor } = await harness();
    const response = await app.inject({ method: "GET", url: URL, headers: { cookie: await cookieFor(STRANGER) } });
    expect(response.statusCode).toBe(404);
    expect(fakeUsage.queries).toHaveLength(0);
  });
});
