// The workspace surface's HTTP contract, through the REAL `createApp`.
//
// This is the first suite in the repository that exercises a protected product
// route inside the actual application factory rather than a hand-built Fastify
// instance with the hook attached by the test. That distinction is the whole
// point: BACKEND-19..24 each specified a pre-auth refusal, CSRF and a rate
// limit, and each demonstrated them against a test double because no route was
// composed (OD-069). Everything below flows through the same plugin order,
// error handler and encapsulation that production uses.
//
// The session STORE is a fake, because a session repository is PostgreSQL's job
// and the integration suite owns it. The session SERVICE, the cookies, the CSRF
// check and the scope are all real.

import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  CSRF_TOKEN_HEADER, IDEMPOTENCY_KEY_HEADER,
  type UserId, type RequestId,
} from "@lagda/contracts";
import {
  createSessionService, createAbuseLimiter,
  type SessionRepository, type SessionRecord, type NewSession,
  type RateLimitCounterRepository,
  type CreateWorkspaceDependencies, type GetWorkspaceDependencies,
  type ListMyWorkspacesDependencies, type SessionId,
} from "@lagda/application";
import {
  FakeTransactionManager, FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import { createApp } from "../app/create-app.js";
import { loadApiConfig, type ApiConfig } from "../config/index.js";
import { SESSION_COOKIE_NAME } from "../security/cookies.js";
import { createSecurityTokenGenerator, createSecurityTokenDigester } from "../security/crypto.js";
import { createRateLimitScopeDigester } from "../security/rate-limit-plugin.js";
import { registerWorkspaceRoutes } from "./workspace-routes.js";
import { buildLoggerOptions } from "../logging/index.js";
import { createLogCapture, type LogCapture } from "../logging/testing.js";
import type { MetricsRecorder } from "../observability/metrics.js";
import { mapError } from "../errors/index.js";

const AT = Date.parse("2026-08-09T09:00:00.000Z");
const USER = "usr_owner" as UserId;
const OTHER = "usr_other" as UserId;

const config = (over: Partial<NodeJS.ProcessEnv> = {}): ApiConfig =>
  loadApiConfig({ NODE_ENV: "test", API_PORT: "8080", LOG_LEVEL: "silent", ...over });

function fakeSessionRepository(): SessionRepository & { rows: Map<string, SessionRecord> } {
  const rows = new Map<string, SessionRecord>();
  return {
    rows,
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
  /** Signs a user in and returns the cookie header plus their CSRF token. */
  // An arrow PROPERTY, not a method signature. `const { signIn } = harness()`
  // detaches a method from its object, which `@typescript-eslint/unbound-method`
  // flags — correctly, since a method closing over `this` would break there.
  readonly signIn: (userId: UserId) => Promise<{ cookie: string; csrf: string }>;
}

/** In-memory counters. The atomic SQL increment is the integration suite's job. */
function fakeCounters(): RateLimitCounterRepository {
  const counts = new Map<string, number>();
  return {
    increment: input => {
      const key = `${input.policyId}|${input.scopeType}|${input.scopeKey}|${String(input.windowStart)}`;
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return Promise.resolve(next);
    },
    deleteExpired: () => Promise.resolve(0),
  };
}

async function build(over: { withLimiter?: boolean } = {}): Promise<Harness> {
  const repository = fakeSessionRepository();
  const sessions = createSessionService({
    sessions: repository,
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
  // ONE generator for the whole app, not one per request. A fresh
  // `SequentialWorkspaceIds` per call would hand every workspace the id `ws_1`,
  // and the suite would silently be testing a single overwritten row. The real
  // generator is random and shared for the same reason.
  const workspaceIds = new SequentialWorkspaceIds();
  const memberIds = new SequentialMemberIds();
  const idempotency = {
    digester: createIdempotencyKeyDigester(),
    ids: createIdempotencyRecordIds(),
    clock: new FixedClock(AT),
    policy: { retentionMs: 24 * 3_600_000 },
  };

  const app = await createApp({
    config: config(),
    dependencies: {
      databaseHealth: { isReachable: () => Promise.resolve(true) },
      sessions,
      ...(over.withLimiter === true
        ? {
            limiter: createAbuseLimiter({
              counters: fakeCounters(),
              digester: createRateLimitScopeDigester(),
              clock: { now: () => Date.now() },
            }),
          }
        : {}),
      workspaces: {
        create: (): CreateWorkspaceDependencies => ({
          transactions,
          clock: new FixedClock(AT),
          workspaceIds,
          memberIds,
          idempotency,
        }),
        list: (): ListMyWorkspacesDependencies => ({ transactions }),
        workspace: (): GetWorkspaceDependencies => ({ transactions }),
      },
    },
  });

  return {
    app,
    transactions,
    signIn: async (userId: UserId) => {
      const issued = await sessions.issue(userId);
      const cookie = `${SESSION_COOKIE_NAME}=${issued.sessionToken}`;
      // The value the browser would read from the readable CSRF cookie and echo
      // back in the header.
      return { cookie, csrf: issued.csrfToken };
    },
  };
}

let open: FastifyInstance | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function harness(over: Parameters<typeof build>[0] = {}): Promise<Harness> {
  const built = await build(over);
  open = built.app;
  return built;
}

const createBody = (name: string) => ({ name });

// ── Authentication ──────────────────────────────────────────────────────────

describe("workspace routes — authentication", () => {
  it("refuses an anonymous create with 401 and writes nothing", async () => {
    const { app, transactions } = await harness();

    const response = await app.inject({
      method: "POST", url: "/workspaces",
      headers: { [IDEMPOTENCY_KEY_HEADER]: "anon-key-0001" },
      payload: createBody("Acme"),
    });

    expect(response.statusCode).toBe(401);
    expect(transactions.store.workspaces.size).toBe(0);
  });

  it("refuses an anonymous list, get and update", async () => {
    const { app } = await harness();
    for (const [method, url] of [
      ["GET", "/workspaces"],
      ["GET", "/workspaces/ws_1"],
      ["PATCH", "/workspaces/ws_1"],
    ] as const) {
      const response = await app.inject({
        method, url,
        ...(method === "PATCH" ? { payload: createBody("x") } : {}),
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it("refuses a browser holding only a PRE-AUTH credential", async () => {
    // A half-finished MFA ceremony has proved a password and nothing more. The
    // pre-auth cookie is a DIFFERENT name scoped to `/auth`, so presenting it
    // where a session cookie belongs resolves to no session at all — the
    // request is anonymous, and the scope refuses it (§160).
    const { app, transactions } = await harness();

    const response = await app.inject({
      method: "POST", url: "/workspaces",
      headers: {
        cookie: `lagda_pre_auth=${"P".repeat(43)}`,
        [IDEMPOTENCY_KEY_HEADER]: "preauth-key-001",
      },
      payload: createBody("Acme"),
    });

    expect(response.statusCode).toBe(401);
    expect(transactions.store.workspaces.size).toBe(0);
  });

  it("keeps /health public — the scope did not escape to the root", async () => {
    // The failure this catches: wrapping `requireSession` in `fastify-plugin`,
    // which would hoist the hook to the root instance and require a session on
    // the liveness probe an orchestrator calls.
    const { app } = await harness();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});

// ── CSRF ────────────────────────────────────────────────────────────────────

describe("workspace routes — CSRF", () => {
  it("refuses a create with a valid session and NO CSRF token", async () => {
    const { app, transactions, signIn } = await harness();
    const { cookie } = await signIn(USER);

    const response = await app.inject({
      method: "POST", url: "/workspaces",
      headers: { cookie, [IDEMPOTENCY_KEY_HEADER]: "csrf-key-000001" },
      payload: createBody("Acme"),
    });

    expect(response.statusCode).toBe(403);
    // Refused BEFORE the transaction, so nothing exists to clean up.
    expect(transactions.store.workspaces.size).toBe(0);
  });

  it("refuses a create with the WRONG CSRF token", async () => {
    const { app, transactions, signIn } = await harness();
    const { cookie } = await signIn(USER);

    const response = await app.inject({
      method: "POST", url: "/workspaces",
      headers: {
        cookie,
        [CSRF_TOKEN_HEADER]: "N".repeat(43),
        [IDEMPOTENCY_KEY_HEADER]: "csrf-key-000002",
      },
      payload: createBody("Acme"),
    });

    expect(response.statusCode).toBe(403);
    expect(transactions.store.workspaces.size).toBe(0);
  });

  it("refuses a rename without CSRF", async () => {
    const { app, signIn } = await harness();
    const { cookie, csrf } = await signIn(USER);
    const created = await create(app, cookie, csrf, "Acme", "rename-csrf-001");

    const response = await app.inject({
      method: "PATCH", url: `/workspaces/${created.workspaceId}`,
      headers: { cookie },
      payload: createBody("Hijacked"),
    });
    expect(response.statusCode).toBe(403);

    const after = await app.inject({
      method: "GET", url: `/workspaces/${created.workspaceId}`, headers: { cookie },
    });
    expect(after.json<{ name: string }>().name).toBe("Acme");
  });

  it("does NOT require CSRF on the read paths", async () => {
    // GET must not change state, which is the assumption the exemption rests
    // on — and every workspace read here is a GET.
    const { app, signIn } = await harness();
    const { cookie } = await signIn(USER);
    expect((await app.inject({
      method: "GET", url: "/workspaces", headers: { cookie },
    })).statusCode).toBe(200);
  });
});

// ── Create ──────────────────────────────────────────────────────────────────

async function create(
  app: FastifyInstance, cookie: string, csrf: string, name: string, key: string,
): Promise<{ workspaceId: string; name: string; role: string; createdAt: number }> {
  const response = await app.inject({
    method: "POST", url: "/workspaces",
    headers: { cookie, [CSRF_TOKEN_HEADER]: csrf, [IDEMPOTENCY_KEY_HEADER]: key },
    payload: { name },
  });
  if (response.statusCode !== 201) {
    throw new Error(`create failed: ${String(response.statusCode)} ${response.body}`);
  }
  return response.json();
}

describe("workspace routes — create", () => {
  it("creates a workspace and its owner membership", async () => {
    const { app, transactions, signIn } = await harness();
    const { cookie, csrf } = await signIn(USER);

    const created = await create(app, cookie, csrf, "Northbridge Legal", "create-key-0001");

    expect(created.role).toBe("owner");
    expect(transactions.store.workspaces.size).toBe(1);
    expect(transactions.store.memberships).toHaveLength(1);
    expect(transactions.store.memberships[0]?.userId).toBe(USER);
  });

  it("REJECTS a body that nominates another owner", async () => {
    // §167. `additionalProperties: false` is the control; the field never
    // reaches the handler, so there is no comparison to get wrong.
    const { app, transactions, signIn } = await harness();
    const { cookie, csrf } = await signIn(USER);

    const response = await app.inject({
      method: "POST", url: "/workspaces",
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf, [IDEMPOTENCY_KEY_HEADER]: "spoof-key-0001" },
      payload: { name: "Acme", ownerUserId: OTHER },
    });

    expect(response.statusCode).toBe(422);
    expect(transactions.store.workspaces.size).toBe(0);
  });

  it("REJECTS every privileged field a client might try", async () => {
    const { app, signIn } = await harness();
    const { cookie, csrf } = await signIn(USER);

    const payloads = [
      { name: "A", workspaceId: "ws_chosen" },
      { name: "A", id: "ws_chosen" },
      { name: "A", role: "owner" },
      { name: "A", createdBy: OTHER },
      { name: "A", userId: OTHER },
      { name: "A", createdAt: 0 },
      { name: "A", archivedAt: 0 },
      { name: "A", plan: "enterprise" },
      { name: "A", isEnterprise: true },
      { name: "A", slug: "acme" },
    ];

    for (const [index, payload] of payloads.entries()) {
      const response = await app.inject({
        method: "POST", url: "/workspaces",
        headers: {
          cookie, [CSRF_TOKEN_HEADER]: csrf,
          [IDEMPOTENCY_KEY_HEADER]: `field-key-${String(index).padStart(4, "0")}`,
        },
        payload,
      });
      expect(response.statusCode).toBe(422);
    }
  });

  it("requires an Idempotency-Key", async () => {
    const { app, transactions, signIn } = await harness();
    const { cookie, csrf } = await signIn(USER);

    const response = await app.inject({
      method: "POST", url: "/workspaces",
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: createBody("Acme"),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code)
      .toBe("idempotency_key_required");
    expect(transactions.store.workspaces.size).toBe(0);
  });

  it("replays the SAME workspace for a retried request", async () => {
    const { app, transactions, signIn } = await harness();
    const { cookie, csrf } = await signIn(USER);

    const first = await create(app, cookie, csrf, "Acme", "replay-key-00001");
    const second = await create(app, cookie, csrf, "Acme", "replay-key-00001");

    expect(second.workspaceId).toBe(first.workspaceId);
    expect(transactions.store.workspaces.size).toBe(1);
    expect(transactions.store.memberships).toHaveLength(1);
  });

  it("REFUSES a reused key with a different name, and creates nothing", async () => {
    const { app, transactions, signIn } = await harness();
    const { cookie, csrf } = await signIn(USER);

    await create(app, cookie, csrf, "Acme", "conflict-key-0001");
    const response = await app.inject({
      method: "POST", url: "/workspaces",
      headers: {
        cookie, [CSRF_TOKEN_HEADER]: csrf, [IDEMPOTENCY_KEY_HEADER]: "conflict-key-0001",
      },
      payload: createBody("Something else"),
    });

    expect(response.statusCode).toBe(409);
    expect(transactions.store.workspaces.size).toBe(1);
  });

  it("returns 201 and no field beyond the projection", async () => {
    const { app, signIn } = await harness();
    const { cookie, csrf } = await signIn(USER);

    const response = await app.inject({
      method: "POST", url: "/workspaces",
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf, [IDEMPOTENCY_KEY_HEADER]: "shape-key-00001" },
      payload: createBody("Acme"),
    });

    expect(response.statusCode).toBe(201);
    expect(Object.keys(response.json<object>()).sort())
      .toEqual(["createdAt", "name", "role", "workspaceId"]);
  });

  it("is never cacheable", async () => {
    const { app, signIn } = await harness();
    const { cookie } = await signIn(USER);
    const response = await app.inject({
      method: "GET", url: "/workspaces", headers: { cookie },
    });
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

// ── List ────────────────────────────────────────────────────────────────────

describe("workspace routes — list", () => {
  it("returns only the caller's workspaces", async () => {
    const { app, signIn } = await harness();
    const mine = await signIn(USER);
    const theirs = await signIn(OTHER);

    await create(app, mine.cookie, mine.csrf, "Mine", "list-key-000001");
    await create(app, theirs.cookie, theirs.csrf, "Theirs", "list-key-000002");

    const response = await app.inject({
      method: "GET", url: "/workspaces", headers: { cookie: mine.cookie },
    });
    const body = response.json<{ workspaces: { name: string }[] }>();

    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]?.name).toBe("Mine");
  });

  it("returns an empty array, never null, for a user with none", async () => {
    const { app, signIn } = await harness();
    const { cookie } = await signIn(USER);
    const response = await app.inject({
      method: "GET", url: "/workspaces", headers: { cookie },
    });
    expect(response.json<{ workspaces: unknown[] }>().workspaces).toEqual([]);
  });

  it("carries the caller's role and no permission matrix", async () => {
    const { app, signIn } = await harness();
    const { cookie, csrf } = await signIn(USER);
    await create(app, cookie, csrf, "Acme", "role-key-000001");

    const [entry] = (await app.inject({
      method: "GET", url: "/workspaces", headers: { cookie },
    })).json<{ workspaces: Record<string, unknown>[] }>().workspaces;

    expect(entry?.["role"]).toBe("owner");
    expect(Object.keys(entry ?? {}).sort())
      .toEqual(["createdAt", "joinedAt", "name", "role", "workspaceId"]);
  });
});

// ── Get and update ──────────────────────────────────────────────────────────

describe("workspace routes — get and update", () => {
  it("returns a workspace to its member", async () => {
    const { app, signIn } = await harness();
    const { cookie, csrf } = await signIn(USER);
    const created = await create(app, cookie, csrf, "Acme", "get-key-0000001");

    const response = await app.inject({
      method: "GET", url: `/workspaces/${created.workspaceId}`, headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ name: string }>().name).toBe("Acme");
  });

  it("HIDES another tenant's workspace behind a 404", async () => {
    const { app, signIn } = await harness();
    const mine = await signIn(USER);
    const theirs = await signIn(OTHER);
    const foreign = await create(app, theirs.cookie, theirs.csrf, "Theirs", "hide-key-0000001");

    const response = await app.inject({
      method: "GET", url: `/workspaces/${foreign.workspaceId}`,
      headers: { cookie: mine.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("answers a real foreign workspace and a fictional one IDENTICALLY", async () => {
    // The enumeration oracle this closes: any difference in status, code or
    // message would confirm which workspace IDs exist.
    const { app, signIn } = await harness();
    const mine = await signIn(USER);
    const theirs = await signIn(OTHER);
    const foreign = await create(app, theirs.cookie, theirs.csrf, "Theirs", "oracle-key-00001");

    const real = await app.inject({
      method: "GET", url: `/workspaces/${foreign.workspaceId}`,
      headers: { cookie: mine.cookie },
    });
    const fake = await app.inject({
      method: "GET", url: "/workspaces/ws_does_not_exist",
      headers: { cookie: mine.cookie },
    });

    expect(real.statusCode).toBe(fake.statusCode);
    const a = real.json<{ error: { code: string; message: string } }>();
    const b = fake.json<{ error: { code: string; message: string } }>();
    expect(a.error.code).toBe(b.error.code);
    expect(a.error.message).toBe(b.error.message);
  });

  it("lets the owner rename it and keeps the tenant identity", async () => {
    const { app, signIn } = await harness();
    const { cookie, csrf } = await signIn(USER);
    const created = await create(app, cookie, csrf, "Acme", "patch-key-0000001");

    const response = await app.inject({
      method: "PATCH", url: `/workspaces/${created.workspaceId}`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: createBody("Acme Legal"),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ name: string; workspaceId: string }>();
    expect(body.name).toBe("Acme Legal");
    expect(body.workspaceId).toBe(created.workspaceId);
  });

  it("refuses a rename from a non-member with 404", async () => {
    const { app, signIn } = await harness();
    const mine = await signIn(USER);
    const theirs = await signIn(OTHER);
    const foreign = await create(app, theirs.cookie, theirs.csrf, "Theirs", "cross-key-0000001");

    const response = await app.inject({
      method: "PATCH", url: `/workspaces/${foreign.workspaceId}`,
      headers: { cookie: mine.cookie, [CSRF_TOKEN_HEADER]: mine.csrf },
      payload: createBody("Hijacked"),
    });

    expect(response.statusCode).toBe(404);

    const still = await app.inject({
      method: "GET", url: `/workspaces/${foreign.workspaceId}`,
      headers: { cookie: theirs.cookie },
    });
    expect(still.json<{ name: string }>().name).toBe("Theirs");
  });

  it("REJECTS a workspaceId in the body", async () => {
    // §41/§42. There is no body field, so a value cannot disagree with the path
    // and no reconciliation rule exists to get wrong.
    const { app, signIn } = await harness();
    const { cookie, csrf } = await signIn(USER);
    const created = await create(app, cookie, csrf, "Acme", "body-key-00000001");

    const response = await app.inject({
      method: "PATCH", url: `/workspaces/${created.workspaceId}`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: { name: "Renamed", workspaceId: "ws_somewhere_else" },
    });

    expect(response.statusCode).toBe(422);
  });

  it("REJECTS a lifecycle or role field on the metadata patch", async () => {
    const { app, signIn } = await harness();
    const { cookie, csrf } = await signIn(USER);
    const created = await create(app, cookie, csrf, "Acme", "life-key-00000001");

    for (const payload of [
      { name: "A", archivedAt: 1 },
      { name: "A", role: "owner" },
      { name: "A", ownerUserId: OTHER },
      { name: "A", plan: "enterprise" },
      { name: "A", billingEmail: "billing@example.com" },
    ]) {
      const response = await app.inject({
        method: "PATCH", url: `/workspaces/${created.workspaceId}`,
        headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
        payload,
      });
      expect(response.statusCode).toBe(422);
    }
  });

  it("reports an invalid name with 422 and leaves the stored one alone", async () => {
    const { app, signIn } = await harness();
    const { cookie, csrf } = await signIn(USER);
    const created = await create(app, cookie, csrf, "Acme", "invalid-key-00001");

    const response = await app.inject({
      method: "PATCH", url: `/workspaces/${created.workspaceId}`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
      payload: { name: "   " },
    });

    expect(response.statusCode).toBe(422);
    const after = await app.inject({
      method: "GET", url: `/workspaces/${created.workspaceId}`, headers: { cookie },
    });
    expect(after.json<{ name: string }>().name).toBe("Acme");
  });
});

// ── Absent by design ────────────────────────────────────────────────────────

describe("workspace routes — what does not exist", () => {
  it("exposes NO hard-delete endpoint", async () => {
    // §183. Deletion has retention consequences nobody has decided (BACKEND-55),
    // and a `DELETE` that quietly archived instead would be worse than neither.
    const { app, signIn } = await harness();
    const { cookie, csrf } = await signIn(USER);
    const created = await create(app, cookie, csrf, "Acme", "delete-key-000001");

    const response = await app.inject({
      method: "DELETE", url: `/workspaces/${created.workspaceId}`,
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf },
    });
    expect(response.statusCode).toBe(404);

    // Still there.
    expect((await app.inject({
      method: "GET", url: `/workspaces/${created.workspaceId}`, headers: { cookie },
    })).statusCode).toBe(200);
  });

  it("exposes no archive, restore, leave, transfer, member or invitation route", async () => {
    const { app, signIn } = await harness();
    const { cookie, csrf } = await signIn(USER);
    const created = await create(app, cookie, csrf, "Acme", "absent-key-000001");
    const base = `/workspaces/${created.workspaceId}`;

    for (const [method, url] of [
      ["POST", `${base}/archive`],
      ["POST", `${base}/restore`],
      ["POST", `${base}/leave`],
      ["POST", `${base}/transfer-ownership`],
      ["GET", `${base}/members`],
      ["POST", `${base}/invitations`],
      ["GET", `${base}/roles`],
      ["GET", `${base}/teams`],
    ] as const) {
      const response = await app.inject({
        method, url, headers: { cookie, [CSRF_TOKEN_HEADER]: csrf }, payload: {},
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });
});

// ── Rate limiting ───────────────────────────────────────────────────────────

describe("workspace routes — rate limit", () => {
  it("returns 429 once the per-user create policy is exhausted", async () => {
    const { app, transactions, signIn } = await harness({ withLimiter: true });
    const { cookie, csrf } = await signIn(USER);

    // The policy allows 10 per hour.
    for (let i = 0; i < 10; i++) {
      await create(app, cookie, csrf, `Workspace ${String(i)}`, `limit-key-${String(i).padStart(5, "0")}`);
    }

    const response = await app.inject({
      method: "POST", url: "/workspaces",
      headers: { cookie, [CSRF_TOKEN_HEADER]: csrf, [IDEMPOTENCY_KEY_HEADER]: "limit-key-99999" },
      payload: createBody("Eleventh"),
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBeDefined();
    // The limiter runs before the transaction, so nothing was written.
    expect(transactions.store.workspaces.size).toBe(10);
  });

  it("counts per user, so one caller cannot exhaust another's allowance", async () => {
    const { app, signIn } = await harness({ withLimiter: true });
    const mine = await signIn(USER);
    const theirs = await signIn(OTHER);

    for (let i = 0; i < 10; i++) {
      await create(app, mine.cookie, mine.csrf, `W${String(i)}`, `scope-key-${String(i).padStart(5, "0")}`);
    }

    const response = await app.inject({
      method: "POST", url: "/workspaces",
      headers: {
        cookie: theirs.cookie, [CSRF_TOKEN_HEADER]: theirs.csrf,
        [IDEMPOTENCY_KEY_HEADER]: "scope-key-other1",
      },
      payload: createBody("Theirs"),
    });
    expect(response.statusCode).toBe(201);
  });
});

// ── Telemetry ───────────────────────────────────────────────────────────────
//
// Built on a bare Fastify instance with a capture stream, because `createApp`
// constructs its own logger from config and there is no reason to add a
// production seam so a test can read it. The routes registered here are the
// same function production composes.

describe("workspace routes — telemetry", () => {
  async function logging(): Promise<{
    app: FastifyInstance; capture: LogCapture; transactions: FakeTransactionManager;
  }> {
    const capture = createLogCapture();
    const transactions = new FakeTransactionManager();
    const workspaceIds = new SequentialWorkspaceIds();
    const memberIds = new SequentialMemberIds();
    const app = Fastify({
      logger: { ...buildLoggerOptions(config({ LOG_LEVEL: "debug" })), level: "debug",
        stream: capture.stream },
      ajv: { customOptions: { removeAdditional: false, coerceTypes: true, allErrors: true } },
    });

    // The canonical mapper, so a 404 here is produced the same way production
    // produces it. A test instance with no error handler would report every
    // application error as a 500 and the assertions would be about Fastify's
    // default, not about this route.
    app.setErrorHandler((error, request, reply) => {
      const mapped = mapError(error, request.id as RequestId);
      void reply.status(mapped.status).send(mapped.body);
    });

    registerWorkspaceRoutes(app, {
      authenticatedUser: () => Promise.resolve({
        userId: USER, sessionId: "ses_fixture" as SessionId,
      }),
      createWorkspaceDependencies: (): CreateWorkspaceDependencies => ({
        transactions,
        clock: new FixedClock(AT),
        workspaceIds,
        memberIds,
        idempotency: {
          digester: createIdempotencyKeyDigester(),
          ids: createIdempotencyRecordIds(),
          clock: new FixedClock(AT),
          policy: { retentionMs: 24 * 3_600_000 },
        },
      }),
      listDependencies: (): ListMyWorkspacesDependencies => ({ transactions }),
      workspaceDependencies: (): GetWorkspaceDependencies => ({ transactions }),
      metrics,
    });
    await app.ready();
    return { app, capture, transactions };
  }

  const recorded: { name: string; labels?: Record<string, string> }[] = [];
  const metrics = {
    increment: (name: string, labels?: Record<string, string>) => {
      recorded.push({ name, ...(labels === undefined ? {} : { labels }) });
    },
    observe: () => undefined,
    gauge: () => undefined,
  } as unknown as MetricsRecorder;

  it("never puts a workspace NAME in a routine log line", async () => {
    // §125/§184. A name can carry the client, the matter or the counterparty.
    // Operational logs get the ID.
    const { app, capture } = await logging();
    const secret = "Everest Acquisition Holdings";

    const response = await app.inject({
      method: "POST", url: "/workspaces",
      headers: { [IDEMPOTENCY_KEY_HEADER]: "logname-key-00001" },
      payload: { name: secret },
    });
    expect(response.statusCode).toBe(201);

    expect(capture.raw()).not.toContain(secret);
    expect(capture.raw()).not.toContain("Everest");
    await app.close();
  });

  it("emits workspace.created with the id, the actor and an outcome", async () => {
    const { app, capture } = await logging();
    const created = await app.inject({
      method: "POST", url: "/workspaces",
      headers: { [IDEMPOTENCY_KEY_HEADER]: "logevent-key-0001" },
      payload: { name: "Acme" },
    });

    const line = capture.lines().find(l => l["event"] === "workspace.created");
    expect(line).toBeDefined();
    expect(line?.["workspaceId"]).toBe(created.json<{ workspaceId: string }>().workspaceId);
    expect(line?.["actorUserId"]).toBe(USER);
    expect(line?.["result"]).toBe("success");
    // No name anywhere on the event.
    expect(line?.["name"]).toBeUndefined();
    await app.close();
  });

  it("emits workspace.updated with CHANGED FIELDS, never their values", async () => {
    const { app, capture } = await logging();
    const created = await app.inject({
      method: "POST", url: "/workspaces",
      headers: { [IDEMPOTENCY_KEY_HEADER]: "logpatch-key-0001" },
      payload: { name: "Acme" },
    });
    const id = created.json<{ workspaceId: string }>().workspaceId;
    capture.clear();

    await app.inject({
      method: "PATCH", url: `/workspaces/${id}`,
      payload: { name: "Confidential Matter 4471" },
    });

    const line = capture.lines().find(l => l["event"] === "workspace.updated");
    expect(line?.["changedFields"]).toEqual(["name"]);
    expect(capture.raw()).not.toContain("Confidential Matter 4471");
    await app.close();
  });

  it("emits tenant_access_denied for a cross-tenant read, revealing nothing to the client",
    async () => {
      const { app, capture } = await logging();
      const response = await app.inject({ method: "GET", url: "/workspaces/ws_someone_else" });

      expect(response.statusCode).toBe(404);
      const line = capture.lines().find(l => l["securityEvent"] === "tenant_access_denied");
      expect(line?.["result"]).toBe("denied");
      // The RESPONSE says nothing about the other tenant.
      expect(response.body).not.toContain("member");
      await app.close();
    });

  it("uses NO unbounded label on the workspace metric", async () => {
    // §126/§185. One series per tenant is how a metrics backend falls over, and
    // a workspace name in a label is business data in a metrics store.
    recorded.length = 0;
    const { app } = await logging();
    await app.inject({
      method: "POST", url: "/workspaces",
      headers: { [IDEMPOTENCY_KEY_HEADER]: "logmetric-key-001" },
      payload: { name: "Everest Acquisition Holdings" },
    });

    const workspaceMetrics = recorded.filter(m => m.name === "workspace_operations_total");
    expect(workspaceMetrics.length).toBeGreaterThan(0);
    for (const metric of workspaceMetrics) {
      expect(Object.keys(metric.labels ?? {}).sort())
        .toEqual(["operation", "processRole", "result"]);
      expect(JSON.stringify(metric.labels)).not.toContain("Everest");
    }
    await app.close();
  });
});
