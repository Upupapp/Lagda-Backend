// The gate: no identity route ships without a decision about its limit.

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { IDENTITY_PATHS, ACCOUNT_RATE_LIMITED_PATHS } from "../app/identity-routes.js";
import { IDENTITY_ROUTE_POLICIES, applyIdentityRateLimits } from "./identity-rate-limit.js";
import {
  RATE_LIMIT_POLICIES, createAbuseLimiter, type RateLimitCounterRepository,
} from "@lagda/application";
import { createApp } from "../app/create-app.js";
import { loadApiConfig } from "../config/index.js";
import { createRateLimitScopeDigester } from "./rate-limit-plugin.js";
import { noopMetrics } from "../observability/metrics.js";

describe("identity rate limits", () => {
  /**
   * Every path, not most of them.
   *
   * The defect this replaces was not a wrong limit -- it was ELEVEN routes
   * with no limit at all, in a file that mentioned rate limiting nowhere. A
   * new auth route is exactly the kind of thing that arrives without one, so
   * the table has to be checked against the paths rather than trusted.
   */
  it("covers every identity path", () => {
    const paths = [...Object.values(IDENTITY_PATHS), ...Object.values(ACCOUNT_RATE_LIMITED_PATHS)];
    expect(paths.length).toBeGreaterThan(10);
    const missing = paths.filter((p) => IDENTITY_ROUTE_POLICIES[p] === undefined);
    expect(missing, "identity routes with no rate-limit decision").toEqual([]);
  });

  it("lists no path that is not a route", () => {
    const paths = new Set<string>([
      ...Object.values(IDENTITY_PATHS), ...Object.values(ACCOUNT_RATE_LIMITED_PATHS),
    ]);
    const stale = Object.keys(IDENTITY_ROUTE_POLICIES).filter((p) => !paths.has(p));
    expect(stale, "a policy entry for a path that no longer exists").toEqual([]);
  });

  it("names only policies that exist", () => {
    for (const [path, policies] of Object.entries(IDENTITY_ROUTE_POLICIES)) {
      for (const id of [policies.ip, policies.account, policies.user]) {
        if (id === undefined) continue;
        expect(
          Object.keys(RATE_LIMIT_POLICIES), `${path} names an unknown policy`,
        ).toContain(id);
      }
    }
  });

  /**
   * The routes that take a password or a code must be limited by IP.
   *
   * Stated as a property rather than left to the table's contents, because the
   * table is the thing that could be edited wrongly. An account bucket alone
   * would let one source spray many addresses; these are the routes where that
   * is a credential-stuffing run.
   */
  it("limits every credential-accepting route by address", () => {
    for (const path of [
      IDENTITY_PATHS.signIn, IDENTITY_PATHS.register,
      IDENTITY_PATHS.resetPassword, IDENTITY_PATHS.mfaVerify,
      IDENTITY_PATHS.forgotPassword, IDENTITY_PATHS.verifyEmail,
    ]) {
      expect(IDENTITY_ROUTE_POLICIES[path]?.ip, `${path} has no IP limit`)
        .toBeDefined();
    }
  });

  /**
   * Sign-in and reset-request must ALSO have an account bucket.
   *
   * These are the two routes an attacker points at one victim from many
   * addresses -- password guessing and reset-mail flooding. An IP limit does
   * not touch either.
   */
  it("limits the per-victim routes by account too", () => {
    for (const path of [IDENTITY_PATHS.signIn, IDENTITY_PATHS.forgotPassword]) {
      expect(IDENTITY_ROUTE_POLICIES[path]?.account, `${path} has no account limit`)
        .toBeDefined();
    }
  });
});

// ── The hook, over HTTP ─────────────────────────────────────────────────────
//
// Everything above checks the TABLE. Nothing checked that the hook reads it
// for a real request — and `/me/password` is the case where that matters: it
// is registered by the account module, not an auth module, and it sat in this
// scope with no entry and no limit.
describe("the hook over HTTP", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  function counters(): RateLimitCounterRepository {
    const map = new Map<string, number>();
    return {
      increment: (i) => {
        const key = `${i.policyId}|${i.scopeType}|${i.scopeKey}|${String(i.windowStart)}`;
        const next = (map.get(key) ?? 0) + 1;
        map.set(key, next);
        return Promise.resolve(next);
      },
      deleteExpired: () => Promise.resolve(0),
    };
  }

  async function build(): Promise<FastifyInstance> {
    const built = await createApp({
      config: loadApiConfig({ NODE_ENV: "test", API_PORT: "8080", LOG_LEVEL: "silent" }),
      dependencies: {
        databaseHealth: {
          isReachable: () => Promise.resolve(true),
          hasCurrentSchema: () => Promise.resolve(true),
        },
      },
    });
    const limiter = createAbuseLimiter({
      counters: counters(), digester: createRateLimitScopeDigester(),
      clock: { now: () => Date.parse("2026-09-25T10:00:00.000Z") },
    });
    await built.register((scope, _opts, done) => {
      // Stands in for the session plugin: the user bucket keys on the
      // authenticated actor, taken from the header so two users can differ.
      scope.addHook("onRequest", (request, _reply, next) => {
        const userId = request.headers["x-test-user"];
        (request as unknown as { auth: unknown }).auth = {
          status: "authenticated",
          actor: { userId: typeof userId === "string" ? userId : "usr_1" },
        };
        next();
      });
      applyIdentityRateLimits(scope, { limiter, metrics: noopMetrics });
      scope.post(ACCOUNT_RATE_LIMITED_PATHS.changePassword, (_r, reply) => { void reply.send({ ok: true }); });
      done();
    });
    await built.ready();
    app = built;
    return built;
  }

  const attempt = (a: FastifyInstance, user = "usr_1") => a.inject({
    method: "POST", url: ACCOUNT_RATE_LIMITED_PATHS.changePassword,
    headers: { "x-test-user": user }, payload: {},
  });

  it("limits password change per user, then answers 429", async () => {
    const a = await build();
    const limit = RATE_LIMIT_POLICIES["account.password.change.user"].limit;
    for (let i = 0; i < limit; i += 1) {
      expect((await attempt(a)).statusCode, `attempt ${String(i + 1)}`).toBe(200);
    }
    expect((await attempt(a)).statusCode).toBe(429);
  });

  it("counts each user separately", async () => {
    const a = await build();
    const limit = RATE_LIMIT_POLICIES["account.password.change.user"].limit;
    for (let i = 0; i < limit; i += 1) await attempt(a, "usr_1");
    expect((await attempt(a, "usr_1")).statusCode).toBe(429);
    // Another account's budget is untouched by the first one exhausting its own.
    expect((await attempt(a, "usr_2")).statusCode).toBe(200);
  });
});

