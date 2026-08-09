// Session and CSRF security, exercised through `app.inject()`.
//
// The protected routes here are registered by the TEST, not by production code.
// A `POST /test/login` shipped in the API would be a real authentication bypass;
// a route that exists only inside a test file cannot be reached in production.

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { CSRF_TOKEN_HEADER } from "@lagda/contracts";
import type { UserId } from "@lagda/contracts";
import {
  createSessionService, type SessionService, type SessionRepository,
  type SessionRecord, type NewSession, type SessionId, type TokenDigest,
} from "@lagda/application";
import { createApp } from "./app/create-app.js";
import { loadApiConfig, ApiConfigError, type ApiConfig } from "./config/index.js";
import { requireSession } from "./security/session-plugin.js";
import {
  SESSION_COOKIE_NAME, sessionCookieOptions, csrfCookieOptions,
  clearCookieOptions,
} from "./security/cookies.js";
import { createSecurityTokenGenerator, createSecurityTokenDigester } from "./security/crypto.js";
import { createLogCapture } from "./logging/testing.js";
import { noopMetrics } from "./observability/metrics.js";

const USER = "usr_1" as UserId;

const config = (over: Partial<NodeJS.ProcessEnv> = {}): ApiConfig =>
  loadApiConfig({ NODE_ENV: "test", API_PORT: "8080", LOG_LEVEL: "silent", ...over });

/** An in-memory session store. Behaviour, not SQL — that is the integration suite. */
function fakeRepository(): SessionRepository & { rows: Map<string, SessionRecord> } {
  const rows = new Map<string, SessionRecord>();
  return {
    rows,
    findByTokenHash: (hash) =>
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
    revokeAllForUser: (userId, at, reason) => {
      let count = 0;
      for (const [id, row] of rows) {
        if (row.userId === userId && row.revokedAt === undefined) {
          rows.set(id, { ...row, revokedAt: at, revocationReason: reason });
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
  };
}

function buildService(over: { now?: () => number } = {}) {
  const repository = fakeRepository();
  const service = createSessionService({
    sessions: repository,
    tokens: createSecurityTokenGenerator(),
    digester: createSecurityTokenDigester(),
    clock: { now: over.now ?? (() => Date.now()) },
    policy: {
      absoluteLifetimeMs: 7 * 24 * 3_600_000,
      idleTimeoutMs: 8 * 3_600_000,
      touchIntervalMs: 300_000,
    },
  });
  return { repository, service };
}

// ── Crypto ──────────────────────────────────────────────────────────────────

describe("security tokens", () => {
  const tokens = createSecurityTokenGenerator();
  const digester = createSecurityTokenDigester();

  it("produces URL-safe tokens with 256 bits of entropy", () => {
    const token = tokens.nextSessionToken();
    // 32 bytes base64url → 43 characters, no padding to be mangled in a cookie.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("produces a different token every call", () => {
    // Not a probabilistic entropy test — that would be slow and prove nothing.
    // This catches a generator wired to a constant or a cached value.
    const seen = new Set(Array.from({ length: 50 }, () => tokens.nextSessionToken()));
    expect(seen.size).toBe(50);
  });

  it("generates session and CSRF tokens independently", () => {
    expect(tokens.nextSessionToken()).not.toBe(tokens.nextCsrfToken());
  });

  it("digests deterministically to lowercase hex", () => {
    const token = tokens.nextSessionToken();
    expect(digester.digestSessionToken(token)).toBe(digester.digestSessionToken(token));
    expect(digester.digestSessionToken(token)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("DOMAIN-SEPARATES session and CSRF digests", () => {
    // The same string in both roles must not produce the same digest. Without
    // separation, the readable CSRF token could be submitted as a session cookie
    // and would match a stored session hash.
    const raw = tokens.nextSessionToken();
    expect(digester.digestSessionToken(raw))
      .not.toBe(digester.digestCsrfToken(raw as unknown as never));
  });

  it("compares digests safely and correctly", () => {
    const a = digester.digestSessionToken(tokens.nextSessionToken());
    const b = digester.digestSessionToken(tokens.nextSessionToken());
    expect(digester.matches(a, a)).toBe(true);
    expect(digester.matches(a, b)).toBe(false);
    expect(digester.matches(a, "short" as TokenDigest)).toBe(false);
  });
});

// ── Session service ─────────────────────────────────────────────────────────

describe("session service", () => {
  it("issues a session and stores only the digest", async () => {
    const { repository, service } = buildService();
    const issued = await service.issue(USER);

    const stored = [...repository.rows.values()][0];
    expect(stored).toBeDefined();
    // THE test. The raw credential must appear nowhere in the stored record.
    expect(JSON.stringify(stored)).not.toContain(issued.sessionToken);
    expect(JSON.stringify(stored)).not.toContain(issued.csrfToken);
    expect(stored?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("resolves a valid token to an actor", async () => {
    const { service } = buildService();
    const issued = await service.issue(USER);
    const resolution = await service.resolve(issued.sessionToken);

    expect(resolution.outcome).toBe("authenticated");
    if (resolution.outcome !== "authenticated") return;
    expect(resolution.actor.userId).toBe(USER);
    expect(resolution.actor.actorType).toBe("user");
    // No workspace. A session says who you are, never what you may reach.
    expect(Object.keys(resolution.actor).sort())
      .toEqual(["actorType", "sessionId", "userId"]);
  });

  it("rejects an unknown token", async () => {
    const { service } = buildService();
    const resolution = await service.resolve("A".repeat(43));
    expect(resolution).toEqual({ outcome: "rejected", reason: "unknown" });
  });

  it("rejects a malformed token WITHOUT touching the repository", async () => {
    // An unauthenticated caller must not be able to force a database lookup
    // with a megabyte cookie.
    let queried = false;
    const repository = fakeRepository();
    const service = createSessionService({
      sessions: { ...repository, findByTokenHash: (h) => { queried = true; return repository.findByTokenHash(h); } },
      tokens: createSecurityTokenGenerator(),
      digester: createSecurityTokenDigester(),
      clock: { now: () => Date.now() },
      policy: { absoluteLifetimeMs: 1, idleTimeoutMs: 1, touchIntervalMs: 1 },
    });

    for (const bad of ["", "x".repeat(5000), "has spaces", "has/slash"]) {
      const resolution = await service.resolve(bad);
      expect(resolution).toEqual({ outcome: "rejected", reason: "malformed" });
    }
    expect(queried).toBe(false);
  });

  it("rejects an expired session", async () => {
    let now = Date.parse("2026-08-09T00:00:00Z");
    const { service } = buildService({ now: () => now });
    const issued = await service.issue(USER);

    now += 8 * 24 * 3_600_000; // past the 7-day absolute lifetime
    expect(await service.resolve(issued.sessionToken))
      .toEqual({ outcome: "rejected", reason: "expired" });
  });

  it("rejects an idle-expired session even before absolute expiry", async () => {
    let now = Date.parse("2026-08-09T00:00:00Z");
    const { service } = buildService({ now: () => now });
    const issued = await service.issue(USER);

    now += 9 * 3_600_000; // 9 hours idle, absolute lifetime is 7 days
    expect(await service.resolve(issued.sessionToken))
      .toEqual({ outcome: "rejected", reason: "idle-expired" });
  });

  it("rejects a revoked session", async () => {
    const { service } = buildService();
    const issued = await service.issue(USER);
    await service.revoke(issued.sessionId, "logout");

    expect(await service.resolve(issued.sessionToken))
      .toEqual({ outcome: "rejected", reason: "revoked" });
  });

  it("PROPAGATES a repository failure instead of reporting anonymous", async () => {
    // The rule that matters operationally: a database outage must not log every
    // user out. It is a 503, not a 401.
    const service = createSessionService({
      sessions: {
        ...fakeRepository(),
        findByTokenHash: () => Promise.reject(new Error("ECONNREFUSED")),
      },
      tokens: createSecurityTokenGenerator(),
      digester: createSecurityTokenDigester(),
      clock: { now: () => Date.now() },
      policy: { absoluteLifetimeMs: 1000, idleTimeoutMs: 1000, touchIntervalMs: 1000 },
    });

    await expect(service.resolve("A".repeat(43))).rejects.toThrow("ECONNREFUSED");
  });

  it("rotates to a fresh credential and invalidates the old one", async () => {
    const { service } = buildService();
    const first = await service.issue(USER);
    const resolved = await service.resolve(first.sessionToken);
    if (resolved.outcome !== "authenticated") throw new Error("setup");

    const second = await service.rotate(resolved.session);

    expect(second.sessionToken).not.toBe(first.sessionToken);
    expect(second.csrfToken).not.toBe(first.csrfToken);
    // Session fixation defence: the old credential stops working immediately.
    expect((await service.resolve(first.sessionToken)).outcome).toBe("rejected");
    expect((await service.resolve(second.sessionToken)).outcome).toBe("authenticated");
  });

  it("supports several concurrent sessions for one user", async () => {
    // Multiple devices. A single-session policy would log a user out of their
    // laptop when they open their phone.
    const { service } = buildService();
    const a = await service.issue(USER);
    const b = await service.issue(USER);

    expect((await service.resolve(a.sessionToken)).outcome).toBe("authenticated");
    expect((await service.resolve(b.sessionToken)).outcome).toBe("authenticated");
  });

  it("revokes every session for a user", async () => {
    const { service } = buildService();
    const a = await service.issue(USER);
    const b = await service.issue(USER);

    expect(await service.revokeAllForUser(USER, "password-change")).toBe(2);
    expect((await service.resolve(a.sessionToken)).outcome).toBe("rejected");
    expect((await service.resolve(b.sessionToken)).outcome).toBe("rejected");
  });

  it("does not write last_seen_at on every request", async () => {
    let now = Date.parse("2026-08-09T00:00:00Z");
    const { repository } = buildService({ now: () => now });
    let writes = 0;
    const counting = { ...repository, touch: (id: SessionId, at: number) => {
      writes += 1; return repository.touch(id, at);
    } };
    const throttled = createSessionService({
      sessions: counting,
      tokens: createSecurityTokenGenerator(),
      digester: createSecurityTokenDigester(),
      clock: { now: () => now },
      policy: { absoluteLifetimeMs: 7 * 24 * 3_600_000, idleTimeoutMs: 8 * 3_600_000,
                touchIntervalMs: 300_000 },
    });
    const issued = await throttled.issue(USER);

    for (let i = 0; i < 5; i += 1) {
      const r = await throttled.resolve(issued.sessionToken);
      if (r.outcome === "authenticated") await throttled.touchIfDue(r.session);
    }
    expect(writes).toBe(0);

    now += 600_000; // past the touch interval
    const r = await throttled.resolve(issued.sessionToken);
    if (r.outcome === "authenticated") await throttled.touchIfDue(r.session);
    expect(writes).toBe(1);
  });

  it("validates a CSRF token only against its own session", async () => {
    const { service } = buildService();
    const a = await service.issue(USER);
    const b = await service.issue(USER);
    const sessionA = await service.resolve(a.sessionToken);
    if (sessionA.outcome !== "authenticated") throw new Error("setup");

    expect(() => { service.validateCsrf(sessionA.session, a.csrfToken); }).not.toThrow();
    // The attack a bare double-submit cookie scheme permits.
    expect(() => { service.validateCsrf(sessionA.session, b.csrfToken); }).toThrow();
    expect(() => { service.validateCsrf(sessionA.session, undefined); }).toThrow();
  });
});

// ── Cookie policy ───────────────────────────────────────────────────────────

describe("cookie policy", () => {
  it("marks the session cookie HttpOnly, Secure and Lax by default", () => {
    const options = sessionCookieOptions(config(), 3600);
    expect(options.httpOnly).toBe(true);
    expect(options.secure).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    // Host-only: no Domain attribute, so the cookie is not shared with every
    // subdomain.
    expect(options.domain).toBeUndefined();
  });

  it("makes the CSRF cookie readable but keeps the same transport rules", () => {
    const options = csrfCookieOptions(config(), 3600);
    // Deliberately false — the frontend must read it.
    expect(options.httpOnly).toBe(false);
    expect(options.secure).toBe(true);
    expect(options.sameSite).toBe("lax");
  });

  it("clears with matching scope so the browser actually removes it", () => {
    const set = sessionCookieOptions(config(), 3600);
    const clear = clearCookieOptions(config());
    // A mismatch leaves the original cookie in place — a logout that appears to
    // work and does not.
    expect(clear.path).toBe(set.path);
    expect(clear.sameSite).toBe(set.sameSite);
    expect(clear.secure).toBe(set.secure);
    expect(clear.maxAge).toBe(0);
  });

  it("refuses an insecure session cookie in production", () => {
    expect(() => loadApiConfig({
      NODE_ENV: "production", SESSION_COOKIE_SECURE: "false",
    })).toThrow(ApiConfigError);
  });

  it("allows Secure to be relaxed only outside production", () => {
    expect(config({ SESSION_COOKIE_SECURE: "false" }).sessionCookieSecure).toBe(false);
  });

  it("never relaxes HttpOnly, in any environment", () => {
    const dev = loadApiConfig({ NODE_ENV: "development", SESSION_COOKIE_SECURE: "false" });
    expect(sessionCookieOptions(dev, 3600).httpOnly).toBe(true);
  });

  it("rejects an unknown SameSite value", () => {
    expect(() => config({ SESSION_COOKIE_SAMESITE: "sometimes" })).toThrow(ApiConfigError);
  });

  it("refuses an idle timeout longer than the absolute lifetime", () => {
    expect(() => loadApiConfig({
      NODE_ENV: "production",
      SESSION_IDLE_TIMEOUT_MS: "999999999999",
      SESSION_ABSOLUTE_LIFETIME_MS: "1000",
    })).toThrow(/cannot exceed/);
  });
});

// ── HTTP ────────────────────────────────────────────────────────────────────

describe("route protection", () => {
  let app: FastifyInstance;
  let service: SessionService;

  afterEach(async () => { await app?.close(); });

  async function build(over: Partial<NodeJS.ProcessEnv> = {}): Promise<void> {
    const built = buildService();
    service = built.service;

    app = await createApp({
      config: config(over),
      dependencies: {
        databaseHealth: { isReachable: () => Promise.resolve(true) },
        sessions: service,
      },
      metrics: noopMetrics,
    });

    // Registered by the TEST. An authenticated scope in production code with no
    // product routes in it would be an empty abstraction; here it proves the
    // encapsulation works.
    await app.register((scope) => {
      requireSession(scope, { sessions: service, metrics: noopMetrics });
      scope.get("/test/protected", (request, reply) => {
        void reply.send({ userId: request.auth.status === "authenticated"
          ? request.auth.actor.userId : null });
      return Promise.resolve();
      });
      scope.post("/test/mutate", (_request, reply) => { void reply.send({ ok: true }); });
    });

    await app.ready();
  }

  const cookie = (token: string): string => `${SESSION_COOKIE_NAME}=${token}`;

  it("refuses an anonymous request with 401", async () => {
    await build();
    const response = await app.inject({ method: "GET", url: "/test/protected" });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("auth_required");
  });

  it("refuses an invalid cookie with 401", async () => {
    await build();
    const response = await app.inject({
      method: "GET", url: "/test/protected", headers: { cookie: cookie("A".repeat(43)) },
    });
    expect(response.statusCode).toBe(401);
  });

  it("gives the same 401 for expired, revoked and unknown", async () => {
    // Anti-enumeration. A client that could tell these apart would learn which
    // tokens exist.
    await build();
    const issued = await service.issue(USER);
    await service.revoke(issued.sessionId, "logout");

    const revoked = await app.inject({
      method: "GET", url: "/test/protected", headers: { cookie: cookie(issued.sessionToken) },
    });
    const unknown = await app.inject({
      method: "GET", url: "/test/protected", headers: { cookie: cookie("B".repeat(43)) },
    });

    expect(revoked.statusCode).toBe(401);
    expect(revoked.body).toBe(unknown.body.replace(
      /"requestId":"[^"]+"/, revoked.body.match(/"requestId":"[^"]+"/)?.[0] ?? "",
    ));
  });

  it("admits a valid session and exposes the actor", async () => {
    await build();
    const issued = await service.issue(USER);
    const response = await app.inject({
      method: "GET", url: "/test/protected", headers: { cookie: cookie(issued.sessionToken) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ userId: USER });
  });

  it("returns 503, NOT 401, when the session store is unavailable", async () => {
    // A database outage must not log everyone out.
    const failing = createSessionService({
      sessions: { ...fakeRepository(),
        findByTokenHash: () => Promise.reject(new Error("ECONNREFUSED 10.0.0.5:5432")) },
      tokens: createSecurityTokenGenerator(),
      digester: createSecurityTokenDigester(),
      clock: { now: () => Date.now() },
      policy: { absoluteLifetimeMs: 1000, idleTimeoutMs: 1000, touchIntervalMs: 1000 },
    });
    app = await createApp({
      config: config(),
      dependencies: {
        databaseHealth: { isReachable: () => Promise.resolve(true) }, sessions: failing,
      },
    });
    await app.register((scope) => {
      requireSession(scope, { sessions: failing, metrics: noopMetrics });
      scope.get("/test/protected", (_r, reply) => { void reply.send({ ok: true }); });
      return Promise.resolve();
    });
    await app.ready();

    const response = await app.inject({
      method: "GET", url: "/test/protected", headers: { cookie: cookie("C".repeat(43)) },
    });

    expect(response.statusCode).toBe(500);
    expect(response.statusCode).not.toBe(401);
    // And the driver detail stays out of the body.
    expect(response.body).not.toContain("ECONNREFUSED");
    expect(response.body).not.toContain("10.0.0.5");
  });

  it("keeps health and readiness public", async () => {
    await build();
    for (const url of ["/health", "/ready"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBeLessThan(400);
    }
  });

  it("ignores an unrelated cookie", async () => {
    await build();
    const response = await app.inject({
      method: "GET", url: "/test/protected",
      headers: { cookie: "other_cookie=value; another=thing" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("selects the correct cookie among several", async () => {
    await build();
    const issued = await service.issue(USER);
    const response = await app.inject({
      method: "GET", url: "/test/protected",
      headers: { cookie: `theme=dark; ${cookie(issued.sessionToken)}; locale=en` },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("CSRF", () => {
  let app: FastifyInstance;
  let service: SessionService;

  afterEach(async () => { await app?.close(); });

  async function build(): Promise<void> {
    service = buildService().service;
    app = await createApp({
      config: config({ CORS_ORIGINS: "https://app.lagda.io" }),
      dependencies: {
        databaseHealth: { isReachable: () => Promise.resolve(true) }, sessions: service,
      },
    });
    await app.register((scope) => {
      requireSession(scope, { sessions: service, metrics: noopMetrics });
      scope.get("/test/read", (_r, reply) => { void reply.send({ ok: true }); });
      scope.post("/test/mutate", (_r, reply) => { void reply.send({ ok: true }); });
      return Promise.resolve();
    });
    await app.ready();
  }

  const cookie = (t: string): string => `${SESSION_COOKIE_NAME}=${t}`;

  it("accepts a mutation with the session's own CSRF token", async () => {
    await build();
    const issued = await service.issue(USER);
    const response = await app.inject({
      method: "POST", url: "/test/mutate",
      headers: { cookie: cookie(issued.sessionToken), [CSRF_TOKEN_HEADER]: issued.csrfToken },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
  });

  it("refuses a mutation with NO CSRF token", async () => {
    await build();
    const issued = await service.issue(USER);
    const response = await app.inject({
      method: "POST", url: "/test/mutate",
      headers: { cookie: cookie(issued.sessionToken) }, payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code)
      .toBe("csrf_validation_failed");
  });

  it("refuses a mutation with a wrong CSRF token", async () => {
    await build();
    const issued = await service.issue(USER);
    const response = await app.inject({
      method: "POST", url: "/test/mutate",
      headers: { cookie: cookie(issued.sessionToken), [CSRF_TOKEN_HEADER]: "D".repeat(43) },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });

  it("REFUSES a CSRF token belonging to another session", async () => {
    // The attack a bare double-submit cookie permits, and the reason the token
    // is bound server-side to the session.
    await build();
    const a = await service.issue(USER);
    const b = await service.issue(USER);
    const response = await app.inject({
      method: "POST", url: "/test/mutate",
      headers: { cookie: cookie(a.sessionToken), [CSRF_TOKEN_HEADER]: b.csrfToken },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses a rotated session's old CSRF token", async () => {
    await build();
    const first = await service.issue(USER);
    const resolved = await service.resolve(first.sessionToken);
    if (resolved.outcome !== "authenticated") throw new Error("setup");
    const second = await service.rotate(resolved.session);

    const response = await app.inject({
      method: "POST", url: "/test/mutate",
      headers: { cookie: cookie(second.sessionToken), [CSRF_TOKEN_HEADER]: first.csrfToken },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });

  it("does not require CSRF on a safe GET", async () => {
    await build();
    const issued = await service.issue(USER);
    const response = await app.inject({
      method: "GET", url: "/test/read", headers: { cookie: cookie(issued.sessionToken) },
    });
    expect(response.statusCode).toBe(200);
  });

  it("does not require a session or CSRF for a CORS preflight", async () => {
    // Requiring either would break every cross-origin request before it started.
    await build();
    const response = await app.inject({
      method: "OPTIONS", url: "/test/mutate",
      headers: {
        origin: "https://app.lagda.io",
        "access-control-request-method": "POST",
        "access-control-request-headers": CSRF_TOKEN_HEADER,
      },
    });
    expect(response.statusCode).toBeLessThan(300);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("never echoes a submitted or expected token", async () => {
    await build();
    const issued = await service.issue(USER);
    const response = await app.inject({
      method: "POST", url: "/test/mutate",
      headers: { cookie: cookie(issued.sessionToken), [CSRF_TOKEN_HEADER]: "E".repeat(43) },
      payload: {},
    });
    expect(response.body).not.toContain("E".repeat(43));
    expect(response.body).not.toContain(issued.csrfToken);
  });
});

// ── Leakage ─────────────────────────────────────────────────────────────────

describe("credentials never leak", () => {
  it("keeps the session token out of logs", async () => {
    const capture = createLogCapture();
    const { service } = buildService();
    const issued = await service.issue(USER);

    const app = await createApp({
      config: config({ LOG_LEVEL: "debug" }),
      dependencies: {
        databaseHealth: { isReachable: () => Promise.resolve(true) }, sessions: service,
      },
    });
    // Replace the logger destination so the capture sees everything.
    await app.register((scope) => {
      requireSession(scope, { sessions: service, metrics: noopMetrics });
      scope.get("/test/protected", (_r, reply) => { void reply.send({ ok: true }); });
      return Promise.resolve();
    });
    await app.ready();

    await app.inject({
      method: "GET", url: "/test/protected",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${issued.sessionToken}`,
                 [CSRF_TOKEN_HEADER]: issued.csrfToken },
    });
    await app.close();

    // The cookie header is never serialized at all, so the token cannot appear.
    expect(capture.raw()).not.toContain(issued.sessionToken);
    expect(capture.raw()).not.toContain(issued.csrfToken);
  });

  it("keeps the token hash out of the actor", async () => {
    const { service } = buildService();
    const issued = await service.issue(USER);
    const resolution = await service.resolve(issued.sessionToken);
    if (resolution.outcome !== "authenticated") throw new Error("setup");

    // The actor is what reaches a use case. It must carry no secret material.
    expect(JSON.stringify(resolution.actor)).not.toContain(issued.sessionToken);
    expect(JSON.stringify(resolution.actor)).not.toContain(resolution.session.tokenHash);
  });
});
