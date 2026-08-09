// The HTTP surface, exercised through `app.inject()`.
//
// No TCP port, no free-port race, no cleanup. Every assertion here is about
// what a client actually receives — status, headers, body — because that is the
// only thing a security claim about an HTTP API can rest on.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { REQUEST_ID_HEADER } from "@lagda/contracts";
import { createApp } from "./app/create-app.js";
import { loadApiConfig, ApiConfigError, type ApiConfig } from "./config/index.js";
import type { AppDependencies } from "./app/dependencies.js";
import { createShutdown } from "./server/shutdown.js";

const BASE_ENV = {
  NODE_ENV: "test",
  API_PORT: "8080",
  LOG_LEVEL: "silent",
} as const;

const config = (over: Partial<NodeJS.ProcessEnv> = {}): ApiConfig =>
  loadApiConfig({ ...BASE_ENV, ...over });

const deps = (reachable = true): AppDependencies => ({
  databaseHealth: { isReachable: () => Promise.resolve(reachable) },
});

describe("configuration", () => {
  it("rejects TRUST_PROXY=true outright", () => {
    // The single most dangerous setting in this file. `true` trusts the whole
    // X-Forwarded-For chain, letting any client choose the IP that would be
    // recorded as signing evidence.
    expect(() => config({ TRUST_PROXY: "true" })).toThrow(ApiConfigError);
  });

  it("defaults trust proxy to none", () => {
    expect(config().trustProxy).toEqual({ mode: "none" });
  });

  it("accepts an explicit hop count", () => {
    expect(config({ TRUST_PROXY: "1" }).trustProxy).toEqual({ mode: "hops", hops: 1 });
  });

  it("rejects a wildcard CORS origin", () => {
    expect(() => config({ CORS_ORIGINS: "*" })).toThrow(/must not contain/i);
  });

  it("rejects a CORS origin with a path", () => {
    // `https://app.lagda.io/` never equals the browser's `Origin` header, so it
    // would silently allow nothing while looking correct in the config file.
    expect(() => config({ CORS_ORIGINS: "https://app.lagda.io/app" })).toThrow(ApiConfigError);
  });

  it("rejects a non-numeric port rather than defaulting", () => {
    expect(() => config({ API_PORT: "8080abc" })).toThrow(ApiConfigError);
  });

  it("rejects a plaintext CORS origin in production", () => {
    expect(() => loadApiConfig({
      ...BASE_ENV, NODE_ENV: "production", CORS_ORIGINS: "http://app.lagda.io",
    })).toThrow(/plaintext/i);
  });

  it("defaults to loopback, not every interface", () => {
    expect(config().host).toBe("127.0.0.1");
  });
});

describe("the API", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await createApp({ config: config(), dependencies: deps() });
  });

  afterEach(async () => {
    await app.close();
  });

  // ── Health and readiness ─────────────────────────────────────────────────

  it("answers liveness with 200", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("answers liveness even when the database is unreachable", async () => {
    // Liveness must not depend on PostgreSQL. Restarting the API does not fix
    // the database, and an orchestrator that restarts on a database blip turns
    // a recoverable dependency failure into an outage.
    const down = await createApp({ config: config(), dependencies: deps(false) });
    const response = await down.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    await down.close();
  });

  it("discloses nothing about the environment in the health response", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    const body = response.body;
    for (const leak of ["postgres", "NODE_ENV", "test", "127.0.0.1", "node", "fastify"]) {
      expect(body.toLowerCase()).not.toContain(leak.toLowerCase());
    }
    expect(Object.keys(response.json())).toEqual(["status"]);
  });

  it("reports readiness when the database answers", async () => {
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
  });

  it("returns 503 when the database is unreachable", async () => {
    const down = await createApp({ config: config(), dependencies: deps(false) });
    const response = await down.inject({ method: "GET", url: "/ready" });
    // The STATUS CODE carries the signal. A 200 with `{"status":"not-ready"}`
    // means every orchestrator probe passes forever.
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not-ready" });
    await down.close();
  });

  it("leaks no database detail when readiness fails", async () => {
    const down = await createApp({
      config: config(),
      dependencies: {
        databaseHealth: {
          isReachable: () =>
            Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:5432 password authentication failed")),
        },
      },
    });
    const response = await down.inject({ method: "GET", url: "/ready" });
    for (const secret of ["ECONNREFUSED", "10.0.0.5", "5432", "password"]) {
      expect(response.body).not.toContain(secret);
    }
    await down.close();
  });

  it("marks health and readiness as uncacheable", async () => {
    for (const url of ["/health", "/ready"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  // ── Request identity ─────────────────────────────────────────────────────

  it("returns a request id on every response", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.headers[REQUEST_ID_HEADER.toLowerCase()]).toMatch(/^req_[a-f0-9]{32}$/);
  });

  it("returns a request id on a 404 too", async () => {
    // The response most likely to be reported to support is the one that failed.
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.headers[REQUEST_ID_HEADER.toLowerCase()]).toMatch(/^req_/);
  });

  it("puts the same request id in the header and the error body", async () => {
    const response = await app.inject({ method: "GET", url: "/nope" });
    const header = response.headers[REQUEST_ID_HEADER.toLowerCase()];
    expect(response.json<{ error: { requestId: string } }>().error.requestId).toBe(header);
  });

  it("generates a distinct id per request", async () => {
    const ids = new Set<unknown>();
    for (let i = 0; i < 5; i += 1) {
      const response = await app.inject({ method: "GET", url: "/health" });
      ids.add(response.headers[REQUEST_ID_HEADER.toLowerCase()]);
    }
    expect(ids.size).toBe(5);
  });

  it("ignores a client-supplied request id", async () => {
    // API_CONVENTIONS §9: the server always generates it, because a client value
    // flows into logs. A client-chosen value could also inject CRLF into a
    // response header.
    const response = await app.inject({
      method: "GET", url: "/health",
      headers: { "request-id": "attacker-controlled\r\nX-Injected: yes" },
    });
    const id = response.headers[REQUEST_ID_HEADER.toLowerCase()];
    expect(id).toMatch(/^req_[a-f0-9]{32}$/);
    expect(response.headers["x-injected"]).toBeUndefined();
  });

  // ── Errors ───────────────────────────────────────────────────────────────

  it("returns the canonical envelope for an unknown route", async () => {
    const response = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("not_found");
    expect(response.headers["content-type"]).toMatch(/application\/json/);
  });

  it("returns JSON, not HTML, for a framework-level failure", async () => {
    const response = await app.inject({ method: "POST", url: "/health" });
    // 404 because no POST route is registered — the point is the shape.
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body.trimStart().startsWith("<")).toBe(false);
  });

  // ── Security headers ─────────────────────────────────────────────────────

  it("sets the security headers that matter for a JSON API", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    // Content sniffing is the one that bites a JSON API: without it a browser
    // may reinterpret a response as HTML and execute it.
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBeDefined();
  });

  it("does not advertise the framework", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers["server"]).toBeUndefined();
  });
});

// ── Validation, response serialization, CORS, proxy ────────────────────────
//
// These need routes that do not exist in production. Registered on a
// test-local app so no product endpoint is invented to make a test possible.

describe("request and response handling", () => {
  let app: FastifyInstance;

  async function buildWithProbeRoutes(over: Partial<NodeJS.ProcessEnv> = {}): Promise<FastifyInstance> {
    const built = await createApp({ config: config(over), dependencies: deps() });

    built.post("/probe/strict", {
      schema: {
        body: Type.Object({ expected: Type.String() }, { additionalProperties: false }),
        response: { 200: Type.Object({ ok: Type.Boolean() }) },
      },
    }, (_request, reply) => { void reply.send({ ok: true }); });

    built.get("/probe/query", {
      schema: {
        querystring: Type.Object({ limit: Type.Integer({ minimum: 1 }) }),
        response: { 200: Type.Object({ limit: Type.Integer() }) },
      },
    }, (request, reply) => {
      const { limit } = request.query as { limit: number };
      void reply.send({ limit });
    });

    built.get("/probe/leaky", {
      schema: {
        response: {
          200: Type.Object({ safe: Type.String() }, { additionalProperties: false }),
        },
      },
    }, (_request, reply) => {
      // A handler returning MORE than its contract. Serialization must strip it.
      void reply.send({ safe: "public", secretToken: "sk_live_must_not_escape" });
    });

    built.get("/probe/ip", {}, (request, reply) => {
      lastObservedIp = request.ip;
      void reply.send({ ok: true });
    });

    built.get("/probe/boom", {}, () => {
      throw new Error("connection to postgres://lagda:hunter2@10.0.0.5/lagda failed");
    });

    await built.ready();
    return built;
  }

  let lastObservedIp = "";

  afterEach(async () => {
    await app?.close();
    lastObservedIp = "";
  });

  it("accepts a valid body", async () => {
    app = await buildWithProbeRoutes();
    const response = await app.inject({
      method: "POST", url: "/probe/strict", payload: { expected: "value" },
    });
    expect(response.statusCode).toBe(200);
  });

  it("REJECTS an unknown body field rather than stripping it", async () => {
    // Mass assignment in one line. Stripping would hide a stale client; a
    // silently-ignored `unexpectedAdmin` is how privilege escalation ships.
    app = await buildWithProbeRoutes();
    const response = await app.inject({
      method: "POST", url: "/probe/strict",
      payload: { expected: "value", unexpectedAdmin: true },
    });

    expect(response.statusCode).toBe(422);
    const body = response.json<{ error: { code: string; details?: { field: string }[] } }>();
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details?.some(d => d.field === "unexpectedAdmin")).toBe(true);
  });

  it("reports a missing required field by name", async () => {
    app = await buildWithProbeRoutes();
    const response = await app.inject({ method: "POST", url: "/probe/strict", payload: {} });
    const body = response.json<{ error: { details?: { field: string }[] } }>();
    expect(body.error.details?.[0]?.field).toBe("expected");
  });

  it("returns 400, not 422, for malformed JSON", async () => {
    // The body could not be interpreted at all. 422 means valid JSON with
    // invalid content, and conflating them loses a real distinction.
    app = await buildWithProbeRoutes();
    const response = await app.inject({
      method: "POST", url: "/probe/strict",
      headers: { "content-type": "application/json" },
      payload: "{ this is not json",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("validation_error");
  });

  it("exposes no validator internals in a validation error", async () => {
    app = await buildWithProbeRoutes();
    const response = await app.inject({
      method: "POST", url: "/probe/strict", payload: { expected: 42 },
    });
    for (const leak of ["instancePath", "schemaPath", "keyword", "ajv", "#/properties"]) {
      expect(response.body).not.toContain(leak);
    }
  });

  it("coerces a numeric query parameter but rejects garbage", async () => {
    app = await buildWithProbeRoutes();
    const good = await app.inject({ method: "GET", url: "/probe/query?limit=10" });
    expect(good.json()).toEqual({ limit: 10 });

    // `parseInt("10abc")` would give 10. Ajv's type-directed coercion does not.
    const bad = await app.inject({ method: "GET", url: "/probe/query?limit=10abc" });
    expect(bad.statusCode).toBe(422);
  });

  it("STRIPS an undeclared field from a response", async () => {
    // The security property that TypeScript cannot provide. A handler that
    // returns a database row must not leak columns the contract never promised.
    app = await buildWithProbeRoutes();
    const response = await app.inject({ method: "GET", url: "/probe/leaky" });

    expect(response.json()).toEqual({ safe: "public" });
    expect(response.body).not.toContain("secretToken");
    expect(response.body).not.toContain("sk_live_must_not_escape");
  });

  it("returns a generic 500 that leaks no credential from the thrown error", async () => {
    app = await buildWithProbeRoutes();
    const response = await app.inject({ method: "GET", url: "/probe/boom" });

    expect(response.statusCode).toBe(500);
    for (const secret of ["postgres://", "hunter2", "10.0.0.5", "lagda:", "at Object"]) {
      expect(response.body).not.toContain(secret);
    }
    const body = response.json<{ error: { code: string; message: string; requestId: string } }>();
    expect(body.error.code).toBe("internal_error");
    expect(body.error.requestId).toMatch(/^req_/);
    // Still correlatable: the request ID in the response finds the log line
    // that has the stack.
    expect(response.headers[REQUEST_ID_HEADER.toLowerCase()]).toBe(body.error.requestId);
  });

  it("enforces the JSON body limit", async () => {
    app = await buildWithProbeRoutes({ REQUEST_BODY_LIMIT: "256" });
    const response = await app.inject({
      method: "POST", url: "/probe/strict",
      payload: { expected: "x".repeat(1024) },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json<{ error: { code: string } }>().error.code).toBeDefined();
  });

  // ── CORS ─────────────────────────────────────────────────────────────────

  it("allows an exactly-matching origin with credentials", async () => {
    app = await buildWithProbeRoutes({ CORS_ORIGINS: "https://app.lagda.io" });
    const response = await app.inject({
      method: "GET", url: "/health", headers: { origin: "https://app.lagda.io" },
    });
    expect(response.headers["access-control-allow-origin"]).toBe("https://app.lagda.io");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("refuses a lookalike origin", async () => {
    // What a substring check would have admitted.
    app = await buildWithProbeRoutes({ CORS_ORIGINS: "https://app.lagda.io" });
    for (const origin of [
      "https://app.lagda.io.attacker.example",
      "https://evil.com",
      "http://app.lagda.io",
      "https://app.lagda.io:8443",
    ]) {
      const response = await app.inject({ method: "GET", url: "/health", headers: { origin } });
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("never combines a wildcard with credentials", async () => {
    app = await buildWithProbeRoutes({ CORS_ORIGINS: "https://app.lagda.io" });
    const response = await app.inject({
      method: "GET", url: "/health", headers: { origin: "https://app.lagda.io" },
    });
    expect(response.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("answers a preflight without requiring authentication", async () => {
    app = await buildWithProbeRoutes({ CORS_ORIGINS: "https://app.lagda.io" });
    const response = await app.inject({
      method: "OPTIONS", url: "/health",
      headers: {
        origin: "https://app.lagda.io",
        "access-control-request-method": "GET",
      },
    });
    expect(response.statusCode).toBeLessThan(300);
  });

  // ── Proxy trust ──────────────────────────────────────────────────────────

  it("does NOT adopt a spoofed forwarded IP when proxy trust is off", async () => {
    // The default. Without it, any client could choose the IP that would later
    // be written into signing evidence.
    app = await buildWithProbeRoutes();
    await app.inject({
      method: "GET", url: "/probe/ip",
      headers: { "x-forwarded-for": "203.0.113.99" },
      remoteAddress: "127.0.0.1",
    });

    expect(lastObservedIp).not.toBe("203.0.113.99");
    expect(lastObservedIp).toBe("127.0.0.1");
  });

  it("adopts a forwarded IP only when a hop count is configured", async () => {
    app = await buildWithProbeRoutes({ TRUST_PROXY: "1" });
    await app.inject({
      method: "GET", url: "/probe/ip",
      headers: { "x-forwarded-for": "203.0.113.99" },
      remoteAddress: "127.0.0.1",
    });

    expect(lastObservedIp).toBe("203.0.113.99");
  });
});

// ── OpenAPI ────────────────────────────────────────────────────────────────

describe("OpenAPI generation", () => {
  it("generates a document from the route schemas", async () => {
    const app = await createApp({ config: config(), dependencies: deps() });
    await app.ready();
    const document = app.swagger() as {
      paths: Record<string, unknown>;
      components?: { schemas?: Record<string, unknown> };
    };

    // Not a snapshot of the whole document — that breaks on every unrelated
    // change. These are the properties that matter.
    expect(Object.keys(document.paths)).toContain("/health");
    expect(Object.keys(document.paths)).toContain("/ready");
    expect(document.components?.schemas?.["ApiError"]).toBeDefined();
    await app.close();
  });

  it("exposes no OpenAPI route over HTTP", async () => {
    // Generation without exposure. Publishing the document is a separate
    // decision (OD-029), not a side effect of enabling generation.
    const app = await createApp({ config: config(), dependencies: deps() });
    for (const url of ["/documentation", "/docs", "/openapi.json", "/swagger.json"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
    }
    await app.close();
  });
});

// ── Shutdown ───────────────────────────────────────────────────────────────

describe("shutdown", () => {
  it("closes every target in order", async () => {
    const closed: string[] = [];
    const shutdown = createShutdown({
      targets: [
        { name: "http", close: () => { closed.push("http"); return Promise.resolve(); } },
        { name: "database", close: () => { closed.push("database"); return Promise.resolve(); } },
      ],
      timeoutMs: 1000, log: () => undefined, exit: () => undefined,
    });

    await shutdown();
    // HTTP first: closing the pool while requests are in flight fails requests
    // that were about to succeed.
    expect(closed).toEqual(["http", "database"]);
  });

  it("is idempotent under two signals", async () => {
    // SIGTERM then SIGINT moments later is ordinary orchestrator behaviour.
    // Closing the pool twice throws during cleanup.
    let closes = 0;
    const shutdown = createShutdown({
      targets: [{ name: "database", close: () => { closes += 1; return Promise.resolve(); } }],
      timeoutMs: 1000, log: () => undefined, exit: () => undefined,
    });

    await Promise.all([shutdown(), shutdown(), shutdown()]);
    expect(closes).toBe(1);
  });

  it("still closes later targets when one fails", async () => {
    const closed: string[] = [];
    const shutdown = createShutdown({
      targets: [
        { name: "http", close: () => Promise.reject(new Error("stuck")) },
        { name: "database", close: () => { closed.push("database"); return Promise.resolve(); } },
      ],
      timeoutMs: 1000, log: () => undefined, exit: () => undefined,
    });

    await shutdown();
    expect(closed).toEqual(["database"]);
  });
});
