// The skip surface's (069) HTTP contract, through the REAL `createApp`.
//
// Mirrors `signing-decline-routes.test.ts`: proves the route is actually
// COMPOSED and refuses before it reaches a use case when the credential it
// needs is absent. Skip's body schema is empty (no reason, no note — an
// approver's skip needs no explanation), so the 422 case here is any field
// arriving at all, not a closed-vocabulary violation.

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CSRF_TOKEN_HEADER } from "@lagda/contracts";
import { createApp } from "../app/create-app.js";
import { loadApiConfig, type ApiConfig } from "../config/index.js";
import { RECIPIENT_SESSION_COOKIE_NAME } from "../security/cookies.js";

const config = (): ApiConfig =>
  loadApiConfig({ NODE_ENV: "test", API_PORT: "8080", LOG_LEVEL: "silent" });

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * An app with the routes registered and dependency factories that THROW.
 *
 * Deliberate: every assertion below is about a refusal that must happen BEFORE
 * the use case is reached. If a handler ever calls one of these, the test fails
 * with the throw rather than passing on a 401 that came from somewhere else.
 */
async function withRoutes(): Promise<FastifyInstance> {
  const unreachable = (): never => {
    throw new Error("dependencies resolved — the handler did not refuse first");
  };
  const created = await createApp({
    config: config(),
    dependencies: {
      signingAccess: unreachable,
      signingSkip: unreachable,
    } as never,
  });
  app = created;
  return created;
}

describe("POST /signing/skip", () => {
  it("is registered, alongside decline", async () => {
    const instance = await withRoutes();
    const response = await instance.inject({
      method: "POST", url: "/signing/skip", payload: {},
    });
    expect(response.statusCode).not.toBe(404);
  });

  it("refuses without a recipient session, before touching a use case", async () => {
    const instance = await withRoutes();
    const response = await instance.inject({
      method: "POST", url: "/signing/skip", payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "RECIPIENT_AUTHENTICATION_REQUIRED" },
    });
  });

  it("refuses without recipient CSRF", async () => {
    const instance = await withRoutes();
    const response = await instance.inject({
      method: "POST", url: "/signing/skip",
      cookies: { [RECIPIENT_SESSION_COOKIE_NAME]: "r".repeat(43) },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "RECIPIENT_CSRF_REQUIRED" } });
  });

  it("refuses any field in the body — the schema has nowhere to put one", async () => {
    // Unlike decline, skip needs no reason at all. A field that cannot arrive
    // cannot be logged or stored, which is stronger than accepting it and
    // discarding it (§78, same reasoning decline's note test uses).
    const instance = await withRoutes();
    const response = await instance.inject({
      method: "POST", url: "/signing/skip",
      headers: { [CSRF_TOKEN_HEADER]: "c".repeat(43) },
      cookies: { [RECIPIENT_SESSION_COOKIE_NAME]: "r".repeat(43) },
      payload: { reason: "not-agree" },
    });
    expect(response.statusCode).toBe(422);
  });
});

describe("the skip route's composition", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "app", "create-app.ts"), "utf8");

  it("imports the skip route module", () => {
    expect(source).toContain("registerSigningSkipRoutes");
  });

  it("registers it only when the dependency is supplied", () => {
    expect(source).toContain("dependencies.signingSkip !== undefined");
  });
});
