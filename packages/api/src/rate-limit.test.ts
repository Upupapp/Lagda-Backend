// Rate limiting: policy semantics, HTTP behaviour, and ordering.
//
// Ordering is the part worth testing hardest. A limit that fires *after* the
// work it was meant to prevent is not a limit — and the pipeline has four
// controls whose relative order each protect something different.

import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { UserId, WorkspaceId } from "@lagda/contracts";
import {
  createAbuseLimiter, windowStartFor, RateLimitedError, AbuseControlUnavailableError,
  RATE_LIMIT_POLICIES, policyById, assertPoliciesValid,
  createIdempotencyService,
  type RateLimitCounterRepository, type RateLimitScope, type RateLimitPolicy,
  type IdempotencyRepository, type IdempotencyRecordId, type IdempotencyKeyDigest,
  type RequestFingerprint,
} from "@lagda/application";
import { createHash } from "node:crypto";
import { createApp } from "./app/create-app.js";
import { loadApiConfig, type ApiConfig } from "./config/index.js";
import {
  applyIpRateLimit, createRateLimitScopeDigester,
} from "./security/rate-limit-plugin.js";
import { createInMemoryMetrics, noopMetrics } from "./observability/metrics.js";
import { createLogCapture } from "./logging/testing.js";
import { buildLoggerOptions } from "./logging/index.js";

const config = (over: Partial<NodeJS.ProcessEnv> = {}): ApiConfig =>
  loadApiConfig({ NODE_ENV: "test", API_PORT: "8080", LOG_LEVEL: "silent", ...over });

const AT = Date.parse("2026-08-09T10:00:00.000Z");

/** In-memory counters. Behaviour only — concurrency is the integration suite. */
function fakeCounters(): RateLimitCounterRepository & { map: Map<string, number> } {
  const map = new Map<string, number>();
  return {
    map,
    increment: (i) => {
      const key = `${i.policyId}|${i.scopeType}|${i.scopeKey}|${String(i.windowStart)}`;
      const next = (map.get(key) ?? 0) + 1;
      map.set(key, next);
      return Promise.resolve(next);
    },
    deleteExpired: () => Promise.resolve(0),
  };
}

function limiterAt(now: () => number, counters = fakeCounters()) {
  return {
    counters,
    limiter: createAbuseLimiter({
      counters,
      digester: createRateLimitScopeDigester(),
      clock: { now },
    }),
  };
}

const IP: RateLimitScope = { type: "ip", ipAddress: "203.0.113.1" };

// ── Policy registry ─────────────────────────────────────────────────────────

describe("policy registry", () => {
  it("is valid", () => {
    expect(() => { assertPoliciesValid(); }).not.toThrow();
  });

  it("sources every threshold", () => {
    // An unsourced number is one nobody can defend when it blocks a customer.
    for (const policy of Object.values(RATE_LIMIT_POLICIES)) {
      expect(policy.source, policy.id).toMatch(/handoff/);
    }
  });

  it("carries the thresholds the handoff specifies", () => {
    // Verbatim from §317, §145 and §583 — not industry defaults.
    expect(RATE_LIMIT_POLICIES["auth.signin.ip"].limit).toBe(5);
    expect(RATE_LIMIT_POLICIES["auth.signin.ip"].windowMs).toBe(60_000);
    expect(RATE_LIMIT_POLICIES["otp.deliver.account"].limit).toBe(3);
    expect(RATE_LIMIT_POLICIES["otp.deliver.account"].windowMs).toBe(600_000);
    expect(RATE_LIMIT_POLICIES["otp.verify.challenge"].limit).toBe(5);
    expect(RATE_LIMIT_POLICIES["otp.verify.challenge"].windowMs).toBe(900_000);
    expect(RATE_LIMIT_POLICIES["verification.public.ip"].limit).toBe(20);
    expect(RATE_LIMIT_POLICIES["api.write.user"].limit).toBe(100);
    expect(RATE_LIMIT_POLICIES["search.query.user"].limit).toBe(120);
    expect(RATE_LIMIT_POLICIES["commands.execute.user"].limit).toBe(60);
  });

  it("fails closed for credential-guessing policies", () => {
    // Unlimited password or OTP guessing during a database blip is worse than
    // refusing the operation during one.
    for (const id of ["auth.signin.ip", "auth.signin.account",
                      "otp.deliver.account", "otp.verify.challenge"] as const) {
      expect(RATE_LIMIT_POLICIES[id].failureMode, id).toBe("fail-closed");
    }
  });

  it("rejects a policy that would disable itself", () => {
    // A limit of 0 silently disables the operation it protects.
    expect(() => {
      assertPoliciesValid({
        bad: { id: "bad", scopeType: "ip", limit: 0, windowMs: 60_000,
               failureMode: "fail-closed", source: "test" } satisfies RateLimitPolicy,
      });
    }).toThrow(/at least one/);
  });

  it("rejects an unsourced threshold", () => {
    expect(() => {
      assertPoliciesValid({
        bad: { id: "bad", scopeType: "ip", limit: 5, windowMs: 60_000,
               failureMode: "fail-closed", source: "" } satisfies RateLimitPolicy,
      });
    }).toThrow(/where its threshold came from/);
  });

  it("throws on an unknown policy rather than skipping the check", () => {
    // A silent skip is a disabled control that looks enabled.
    expect(() => policyById("does.not.exist" as never)).toThrow(/Unknown rate-limit policy/);
  });
});

// ── Counter semantics ───────────────────────────────────────────────────────

describe("limiter", () => {
  const policy = policyById("auth.signin.ip");

  it("allows exactly the limit, then rejects", async () => {
    const { limiter } = limiterAt(() => AT);

    for (let i = 1; i <= 5; i += 1) {
      const decision = await limiter.check([{ policy, scope: IP }]);
      expect(decision.allowed, `request ${String(i)}`).toBe(true);
    }
    // The sixth. "5 per minute" means five succeed.
    const sixth = await limiter.check([{ policy, scope: IP }]);
    expect(sixth.allowed).toBe(false);
  });

  it("reports remaining accurately", async () => {
    const { limiter } = limiterAt(() => AT);
    const first = await limiter.check([{ policy, scope: IP }]);
    expect(first.allowed && first.remaining).toBe(4);
  });

  it("resets in the next window", async () => {
    // No sleeping. A test that waits 60 seconds for a window is a test nobody
    // runs.
    let now = AT;
    const { limiter } = limiterAt(() => now);
    for (let i = 0; i < 6; i += 1) await limiter.check([{ policy, scope: IP }]);

    now = AT + 60_000;
    expect((await limiter.check([{ policy, scope: IP }])).allowed).toBe(true);
  });

  it("keeps counting past the threshold", async () => {
    // An attacker who stops being counted once blocked hammers the endpoint for
    // free, and the spike that reveals the attack vanishes from the metrics.
    const { limiter, counters } = limiterAt(() => AT);
    for (let i = 0; i < 8; i += 1) await limiter.check([{ policy, scope: IP }]);
    expect([...counters.map.values()][0]).toBe(8);
  });

  it("separates different IPs", async () => {
    const { limiter } = limiterAt(() => AT);
    for (let i = 0; i < 6; i += 1) await limiter.check([{ policy, scope: IP }]);

    const other = await limiter.check([
      { policy, scope: { type: "ip", ipAddress: "203.0.113.2" } },
    ]);
    expect(other.allowed).toBe(true);
  });

  it("separates different policies for one scope", async () => {
    const { limiter } = limiterAt(() => AT);
    for (let i = 0; i < 6; i += 1) await limiter.check([{ policy, scope: IP }]);

    const verification = await limiter.check([
      { policy: policyById("verification.public.ip"), scope: IP },
    ]);
    expect(verification.allowed).toBe(true);
  });

  it("separates different users and workspaces", async () => {
    const { limiter } = limiterAt(() => AT);
    const userPolicy = policyById("api.write.user");
    const a: RateLimitScope = { type: "user", userId: "usr_a" as UserId };
    const b: RateLimitScope = { type: "user", userId: "usr_b" as UserId };

    for (let i = 0; i < 101; i += 1) await limiter.check([{ policy: userPolicy, scope: a }]);
    expect((await limiter.check([{ policy: userPolicy, scope: a }])).allowed).toBe(false);
    expect((await limiter.check([{ policy: userPolicy, scope: b }])).allowed).toBe(true);
  });

  it("requires ALL policies to allow", async () => {
    // The reason one operation carries several: per-IP alone is defeated by
    // address rotation, per-account alone by spraying from one host.
    const { limiter } = limiterAt(() => AT);
    const account: RateLimitScope = { type: "account", accountKey: "a@example.com" };

    for (let i = 0; i < 6; i += 1) {
      await limiter.check([{ policy: policyById("auth.signin.account"), scope: account }]);
    }

    const both = await limiter.check([
      { policy: policyById("auth.signin.ip"), scope: IP },
      { policy: policyById("auth.signin.account"), scope: account },
    ]);
    // The IP is fresh; the account is not. Refused.
    expect(both.allowed).toBe(false);
  });

  it("refuses a scope that does not match the policy", async () => {
    // Counting IPs against a per-user limit enforces something nobody intended.
    const { limiter } = limiterAt(() => AT);
    await expect(limiter.check([
      { policy: policyById("api.write.user"), scope: IP },
    ])).rejects.toThrow(/expects a user scope/);
  });

  it("rounds Retry-After up", async () => {
    // Rounding down would return a client while still blocked, burning another
    // attempt and looking like the limiter is broken.
    const { limiter } = limiterAt(() => AT + 59_500);
    for (let i = 0; i < 6; i += 1) await limiter.check([{ policy, scope: IP }]);
    const decision = await limiter.check([{ policy, scope: IP }]);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.retryAfterSeconds).toBe(1);
  });

  it("computes window starts deterministically", () => {
    expect(windowStartFor(AT + 1234, 60_000)).toBe(windowStartFor(AT + 5678, 60_000));
    expect(windowStartFor(AT, 60_000)).not.toBe(windowStartFor(AT + 60_000, 60_000));
  });

  // ── Failure modes ─────────────────────────────────────────────────────────

  it("FAILS CLOSED for a credential policy when the store is down", async () => {
    const limiter = createAbuseLimiter({
      counters: { increment: () => Promise.reject(new Error("db down")),
                  deleteExpired: () => Promise.resolve(0) },
      digester: createRateLimitScopeDigester(),
      clock: { now: () => AT },
    });
    // A distinct error from RateLimitedError, so a caller is never told "slow
    // down" when the truth is "the limiter is broken".
    await expect(limiter.check([{ policy, scope: IP }]))
      .rejects.toThrow(AbuseControlUnavailableError);
  });

  it("FAILS OPEN for a volumetric policy when the store is down", async () => {
    const limiter = createAbuseLimiter({
      counters: { increment: () => Promise.reject(new Error("db down")),
                  deleteExpired: () => Promise.resolve(0) },
      digester: createRateLimitScopeDigester(),
      clock: { now: () => AT },
    });
    // A public verification page being briefly unlimited beats it being down.
    const decision = await limiter.check([
      { policy: policyById("verification.public.ip"), scope: IP },
    ]);
    expect(decision.allowed).toBe(true);
  });
});

// ── Scope digests ───────────────────────────────────────────────────────────

describe("scope digests", () => {
  const digester = createRateLimitScopeDigester();

  it("digests personal data and keeps operational IDs plain", () => {
    // An IP and an email are personal data the counter table need not hold
    // reversibly. A user ID is already an operational identifier elsewhere, and
    // hashing it would block an investigation for no privacy gain.
    expect(digester.digest(IP)).toMatch(/^[a-f0-9]{64}$/);
    expect(digester.digest({ type: "account", accountKey: "a@example.com" }))
      .toMatch(/^[a-f0-9]{64}$/);
    expect(digester.digest({ type: "user", userId: "usr_a" as UserId })).toBe("usr_a");
  });

  it("never contains the raw value", () => {
    expect(digester.digest({ type: "account", accountKey: "victim@example.com" }))
      .not.toContain("victim");
    expect(digester.digest(IP)).not.toContain("203.0.113");
  });

  it("normalizes account case", () => {
    // Otherwise an attacker alternating case gets a fresh counter each time.
    expect(digester.digest({ type: "account", accountKey: "A@Example.COM" }))
      .toBe(digester.digest({ type: "account", accountKey: "a@example.com" }));
  });

  it("domain-separates scope types", () => {
    // A user ID equal to a challenge ID must not share a counter.
    expect(digester.digest({ type: "challenge", challengeId: "x" }))
      .not.toBe(digester.digest({ type: "recipient", recipientId: "x" }));
  });
});

// ── HTTP ────────────────────────────────────────────────────────────────────

describe("HTTP behaviour", () => {
  let app: FastifyInstance;
  afterEach(async () => { await app?.close(); });

  async function build(over: Partial<NodeJS.ProcessEnv> = {}, now = () => AT) {
    const metrics = createInMemoryMetrics();
    const { limiter, counters } = limiterAt(now);
    app = await createApp({
      config: config(over),
      dependencies: { databaseHealth: { isReachable: () => Promise.resolve(true) } },
      metrics,
    });

    await app.register((scope, _opts, done) => {
      applyIpRateLimit(scope, ["auth.signin.ip"], { limiter, metrics });
      scope.get("/test/limited", (_r, reply) => { void reply.send({ ok: true }); });
      scope.post("/test/limited", (_r, reply) => { void reply.send({ ok: true }); });
      done();
    });
    await app.ready();
    return { metrics, counters };
  }

  it("returns a canonical 429 with Retry-After", async () => {
    await build();
    for (let i = 0; i < 5; i += 1) {
      expect((await app.inject({ method: "GET", url: "/test/limited" })).statusCode).toBe(200);
    }

    const blocked = await app.inject({ method: "GET", url: "/test/limited" });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    const body = blocked.json<{ error: { code: string; requestId: string } }>();
    expect(body.error.code).toBe("rate_limited");
    // The canonical envelope, with the CURRENT request's ID.
    expect(body.error.requestId).toMatch(/^req_/);
    expect(blocked.headers["x-request-id"]).toBe(body.error.requestId);
  });

  it("leaks no policy, count or scope in the response", async () => {
    await build();
    for (let i = 0; i < 6; i += 1) await app.inject({ method: "GET", url: "/test/limited" });
    const blocked = await app.inject({ method: "GET", url: "/test/limited" });

    // "2 attempts left" is a gift to an attacker; a policy name tells them
    // which dimension to rotate.
    for (const leak of ["auth.signin", "remaining", "count", "203.0.113", "policy"]) {
      expect(blocked.body).not.toContain(leak);
    }
  });

  it("does NOT count a CORS preflight", async () => {
    // A preflight precedes every non-simple mutation; counting it would halve
    // each browser client's usable limit.
    await build({ CORS_ORIGINS: "https://app.lagda.io" });

    for (let i = 0; i < 10; i += 1) {
      await app.inject({
        method: "OPTIONS", url: "/test/limited",
        headers: { origin: "https://app.lagda.io", "access-control-request-method": "POST" },
      });
    }
    expect((await app.inject({ method: "GET", url: "/test/limited" })).statusCode).toBe(200);
  });

  it("leaves health and readiness unlimited", async () => {
    await build();
    // Orchestrator probes are frequent by design.
    for (let i = 0; i < 20; i += 1) {
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    }
  });

  it("IGNORES a spoofed forwarded header when proxy trust is off", async () => {
    // The default. Without it an attacker picks a fresh bucket per request and
    // the limiter is decorative.
    await build();
    for (let i = 0; i < 5; i += 1) {
      await app.inject({ method: "GET", url: "/test/limited", remoteAddress: "10.0.0.1" });
    }

    const spoofed = await app.inject({
      method: "GET", url: "/test/limited",
      headers: { "x-forwarded-for": "198.51.100.99" },
      remoteAddress: "10.0.0.1",
    });
    // Same bucket as the socket address, so still blocked.
    expect(spoofed.statusCode).toBe(429);
  });

  it("uses the forwarded IP when a proxy hop IS trusted", async () => {
    await build({ TRUST_PROXY: "1" });
    for (let i = 0; i < 5; i += 1) {
      await app.inject({
        method: "GET", url: "/test/limited",
        headers: { "x-forwarded-for": "198.51.100.1" }, remoteAddress: "10.0.0.1",
      });
    }

    const other = await app.inject({
      method: "GET", url: "/test/limited",
      headers: { "x-forwarded-for": "198.51.100.2" }, remoteAddress: "10.0.0.1",
    });
    // A different forwarded client is a different bucket.
    expect(other.statusCode).toBe(200);
  });

  it("records a bounded metric with no identifiers", async () => {
    const { metrics } = await build();
    for (let i = 0; i < 6; i += 1) await app.inject({ method: "GET", url: "/test/limited" });

    const rejection = metrics.samples.find(s => s.name === "rate_limit_rejections_total");
    expect(rejection?.labels).toEqual({
      policy: "auth.signin.ip", route: "/test/limited", processRole: "api",
    });
    // No IP, no digest, no count.
    expect(JSON.stringify(metrics.samples)).not.toContain("203.0.113");
  });
});

// ── Ordering ────────────────────────────────────────────────────────────────

describe("ordering with idempotency", () => {
  let app: FastifyInstance;
  afterEach(async () => { await app?.close(); });

  it("a rate-limited request NEVER claims an idempotency key", async () => {
    // If it did, an attacker could exhaust the limit while still burning
    // idempotency records — and a 429 would leave a claim with no operation.
    let claims = 0;
    const idempotency: IdempotencyRepository = {
      claim: () => { claims += 1; return Promise.resolve({ kind: "claimed" as const }); },
      complete: () => Promise.resolve(),
      find: () => Promise.resolve(null),
      deleteExpired: () => Promise.resolve(0),
    };
    const service = createIdempotencyService({
      repository: idempotency,
      digester: {
        digestKey: (k) => createHash("sha256").update(k).digest("hex") as IdempotencyKeyDigest,
        fingerprint: (c) => createHash("sha256").update(c).digest("hex") as RequestFingerprint,
      },
      ids: { nextIdempotencyRecordId: () => "idem_1" as IdempotencyRecordId },
      clock: { now: () => AT },
      policy: { retentionMs: 86_400_000 },
    });

    const { limiter } = limiterAt(() => AT);
    app = await createApp({
      config: config(),
      dependencies: { databaseHealth: { isReachable: () => Promise.resolve(true) } },
    });

    await app.register((scope, _opts, done) => {
      // Rate limit in `onRequest`; the idempotent work in the handler. The
      // limiter therefore runs first by construction, not by convention.
      applyIpRateLimit(scope, ["auth.signin.ip"], { limiter, metrics: noopMetrics });
      scope.post("/test/mutate", async (_request, reply) => {
        const outcome = await service.execute({
          key: "key-abcdef123456" as never,
          operation: "signingRequest.send",
          scope: { type: "workspace", workspaceId: "ws_a" as WorkspaceId },
          request: { a: 1 },
          execute: () => Promise.resolve({ statusCode: 201, body: { ok: true } }),
        });
        void reply.status(outcome.statusCode).send(outcome.body);
      });
      done();
    });
    await app.ready();

    for (let i = 0; i < 5; i += 1) {
      await app.inject({ method: "POST", url: "/test/mutate", payload: {} });
    }
    expect(claims).toBe(5);

    const blocked = await app.inject({ method: "POST", url: "/test/mutate", payload: {} });

    expect(blocked.statusCode).toBe(429);
    // Unchanged: the sixth request never reached the idempotency layer.
    expect(claims).toBe(5);
  });

  it("a replay is still counted", async () => {
    // Exempting replays would make the idempotency key a rate-limit bypass:
    // send the same key forever and pay nothing.
    const { limiter, counters } = limiterAt(() => AT);
    app = await createApp({
      config: config(),
      dependencies: { databaseHealth: { isReachable: () => Promise.resolve(true) } },
    });
    await app.register((scope, _opts, done) => {
      applyIpRateLimit(scope, ["auth.signin.ip"], { limiter, metrics: noopMetrics });
      scope.post("/test/replay", (_r, reply) => { void reply.send({ replayed: true }); });
      done();
    });
    await app.ready();

    for (let i = 0; i < 3; i += 1) {
      await app.inject({ method: "POST", url: "/test/replay", payload: {} });
    }
    expect([...counters.map.values()][0]).toBe(3);
  });
});

describe("logging", () => {
  it("logs the policy and route, never the address", async () => {
    // Wired to the app's ACTUAL logger. The first version of this test built a
    // capture the app never wrote to, so it asserted something trivially true.
    const capture = createLogCapture();
    const { limiter } = limiterAt(() => AT);
    const app = Fastify({
      logger: { ...buildLoggerOptions(config({ LOG_LEVEL: "debug" })), level: "debug",
                stream: capture.stream },
    });
    applyIpRateLimit(app, ["auth.signin.ip"], { limiter, metrics: noopMetrics });
    app.get("/test/x", (_r, reply) => { void reply.send({ ok: true }); });
    app.setErrorHandler((error, _request, reply) => {
      void reply.status(error instanceof RateLimitedError ? 429 : 500).send({ e: 1 });
    });
    await app.ready();

    for (let i = 0; i < 7; i += 1) {
      await app.inject({ method: "GET", url: "/test/x", remoteAddress: "203.0.113.77" });
    }
    await app.close();

    const raw = capture.raw();
    // The policy is a bounded, code-defined value and belongs in the log.
    expect(raw).toContain("auth.signin.ip");
    expect(raw).toContain("rate_limit_triggered");
    // The address is not.
    expect(raw).not.toContain("203.0.113.77");
  });
});
