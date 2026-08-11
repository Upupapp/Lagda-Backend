// The decline and cancel surfaces' HTTP contract, through the REAL `createApp`.
//
// What this file proves that the use-case suites cannot: both routes are
// actually COMPOSED — OD-154 existed because they were not — and each one
// refuses before it reaches a use case when the credential it needs is absent.

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
    // `signingAccess` is required: the recipient realm's routes are registered
    // together, because they all share one CSRF validator. NO `workspaces` key
    // — `createApp` refuses to register workspace routes without a session
    // service, which is a guard worth keeping, so the cancel route's
    // composition is asserted separately below.
    dependencies: {
      signingAccess: unreachable,
      signingDecline: unreachable,
    } as never,
  });
  app = created;
  return created;
}

describe("POST /signing/decline", () => {
  it("is registered — the route OD-154 recorded as missing now exists", async () => {
    const instance = await withRoutes();
    const response = await instance.inject({
      method: "POST", url: "/signing/decline", payload: { reason: "not-agree" },
    });
    // Anything but 404. A recipient could reach the Decline page and had
    // nowhere to send the decision; that is what this proves is fixed.
    expect(response.statusCode).not.toBe(404);
  });

  it("refuses without a recipient session, before touching a use case", async () => {
    const instance = await withRoutes();
    const response = await instance.inject({
      method: "POST", url: "/signing/decline", payload: { reason: "not-agree" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "RECIPIENT_AUTHENTICATION_REQUIRED" },
    });
  });

  it("refuses without recipient CSRF", async () => {
    const instance = await withRoutes();
    const response = await instance.inject({
      method: "POST", url: "/signing/decline",
      cookies: { [RECIPIENT_SESSION_COOKIE_NAME]: "r".repeat(43) },
      payload: { reason: "not-agree" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "RECIPIENT_CSRF_REQUIRED" } });
  });

  it("refuses a reason outside the closed vocabulary", async () => {
    const instance = await withRoutes();
    const response = await instance.inject({
      method: "POST", url: "/signing/decline",
      headers: { [CSRF_TOKEN_HEADER]: "c".repeat(43) },
      cookies: { [RECIPIENT_SESSION_COOKIE_NAME]: "r".repeat(43) },
      payload: { reason: "because-i-said-so" },
    });
    // 422, the app's own convention for a well-formed body that violates the
    // schema. What matters is that it never reaches the use case.
    expect(response.statusCode).toBe(422);
  });

  it("refuses a free-text note — the schema has nowhere to put one", async () => {
    // The product's page offers an optional textarea and this body does not
    // accept it. A field that cannot arrive cannot be logged or stored, which
    // is stronger than accepting it and discarding it (§78).
    const instance = await withRoutes();
    const response = await instance.inject({
      method: "POST", url: "/signing/decline",
      headers: { [CSRF_TOKEN_HEADER]: "c".repeat(43) },
      cookies: { [RECIPIENT_SESSION_COOKIE_NAME]: "r".repeat(43) },
      payload: { reason: "not-agree", note: "The indemnity clause is wrong." },
    });
    expect(response.statusCode).toBe(422);
  });
});

describe("the cancel route's composition", () => {
  // ── Why this is a source assertion and not an inject ──────────────────────
  //
  // `createApp` refuses to register workspace routes without a session
  // service, so exercising the cancel route over HTTP needs the full
  // authenticated harness. What OD-154 was actually about is narrower and is
  // what this checks: the route module is IMPORTED and REGISTERED, inside the
  // authenticated scope, beside Send.
  //
  // The use-case suite proves the behaviour; this proves it is reachable.
  const source = readFileSync(
    join(import.meta.dirname, "..", "app", "create-app.ts"), "utf8");

  it("imports the cancel route module", () => {
    expect(source).toContain("registerCancelRoutes");
  });

  it("registers it on the AUTHENTICATED scope, not the root instance", () => {
    // `scope`, not `app`. Session validation, CSRF and rate limiting come from
    // where it is registered — the same argument Send's registration makes.
    expect(source).toMatch(/registerCancelRoutes\(scope,/);
  });

  it("registers it only when the dependency is supplied", () => {
    expect(source).toContain("workspaces.cancelSigningRequest !== undefined");
  });
});
