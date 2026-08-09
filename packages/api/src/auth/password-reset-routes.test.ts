// POST /auth/forgot-password and POST /auth/reset-password.
//
// The route's job is the PUBLIC contract: what every outcome collapses to, what
// never appears in a body, which cookies are cleared and which are not, and
// that neither endpoint mutates on GET.

import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type {
  RequestPasswordResetDependencies, ResetPasswordDependencies,
  ResetTokenDigest, PasswordResetChallengeId, PasswordHash, UserId,
} from "@lagda/application";
import type { ApiConfig } from "../config/index.js";
import {
  registerPasswordResetRoutes, ForgotPasswordResponseSchema,
  ResetPasswordResponseSchema, ResetPasswordRequestSchema,
} from "./password-reset-routes.js";

// A real 43-character base64url token, so schema and shape checks are exercised
// with the thing the generator actually produces.
const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const PASSWORD = "correct horse battery staple";
const HASH = "$argon2id$v=19$m=19456,p=1,t=2$c2FsdA$aGFzaA" as PasswordHash;

// The REAL field names the cookie helpers read.
const CONFIG = {
  environment: "production",
  corsOrigins: ["https://app.lagda.example"],
  sessionCookieSecure: true,
  sessionCookieSameSite: "lax",
} as unknown as ApiConfig;

interface Built {
  readonly app: FastifyInstance;
  readonly created: string[];
  readonly hashed: string[];
  readonly revoked: UserId[];
  readonly consumeOrder: string[];
}

async function build(options: {
  accountExists?: boolean;
  challengeState?: "active" | "missing" | "consumed" | "superseded" | "expired";
  consumeWins?: boolean;
} = {}): Promise<Built> {
  const app = Fastify({
    logger: false,
    ajv: {
      customOptions: {
        removeAdditional: false, coerceTypes: true, allErrors: true,
      },
    },
  });
  // The route CLEARS cookies on success, which needs the cookie plugin. Without
  // it the success path is a 500 — found by this test, not by reasoning.
  await app.register(cookie);
  const created: string[] = [];
  const hashed: string[] = [];
  const revoked: UserId[] = [];
  const consumeOrder: string[] = [];
  const now = 1_700_000_000_000;
  const state = options.challengeState ?? "active";

  const challenge = state === "missing" ? null : {
    challengeId: "prc_1" as PasswordResetChallengeId,
    userId: "usr_1" as UserId,
    createdAt: 0,
    expiresAt: state === "expired" ? now - 1 : now + 3_600_000,
    consumedAt: state === "consumed" ? 1 : null,
    supersededAt: state === "superseded" ? 1 : null,
  };

  const requestDependencies = (): RequestPasswordResetDependencies => ({
    tokens: {
      issue: () => ({ raw: TOKEN, digest: "b".repeat(64) as ResetTokenDigest }),
    },
    clock: { now: () => now },
    newChallengeId: () => "prc_2" as PasswordResetChallengeId,
    resetTtlMs: 3_600_000,
    commit: operation => operation({
      challenges: {
        findByTokenDigest: () => Promise.resolve(null),
        consumeIfActive: () => Promise.resolve(false),
        supersedeActiveForUser: () => Promise.resolve(0),
        create() { created.push("created"); return Promise.resolve(); },
      },
      users: {
        findByNormalizedEmail: () => Promise.resolve(
          options.accountExists === false ? null : {
            userId: "usr_1" as UserId,
            email: "user@example.com",
            displayName: "User",
            emailVerifiedAt: now,
            createdAt: 0,
          }),
        replacePasswordHash: () => Promise.resolve(true),
      },
    }),
  });

  const resetDependencies = (): ResetPasswordDependencies => ({
    digestSubmitted: raw =>
      raw.length === 43 ? ("a".repeat(64) as ResetTokenDigest) : null,
    hasher: {
      hash(plaintext: string) {
        hashed.push(plaintext);
        consumeOrder.push("hash");
        return Promise.resolve(HASH);
      },
      verify: () => Promise.resolve(false),
      needsRehash: () => false,
    },
    clock: { now: () => now },
    peek: () => Promise.resolve(challenge),
    commit: operation => operation({
      challenges: {
        findByTokenDigest: () => Promise.resolve(challenge),
        consumeIfActive() {
          consumeOrder.push("consume");
          return Promise.resolve(options.consumeWins !== false);
        },
        supersedeActiveForUser: () => Promise.resolve(0),
        create: () => Promise.resolve(),
      },
      users: {
        findByNormalizedEmail: () => Promise.resolve(null),
        replacePasswordHash: () => Promise.resolve(true),
      },
      sessions: {
        revokeAllForUser(userId) { revoked.push(userId); return Promise.resolve(2); },
      },
    }),
  });

  registerPasswordResetRoutes(app, {
    forgotPath: "/auth/forgot-password",
    resetPath: "/auth/reset-password",
    config: CONFIG,
    requestDependencies,
    resetDependencies,
  });
  await app.ready();
  return { app, created, hashed, revoked, consumeOrder };
}

const post = (app: FastifyInstance, url: string, payload: unknown) =>
  app.inject({ method: "POST", url, payload: payload as object });

// ── Forgot password ────────────────────────────────────────────────────────

describe("POST /auth/forgot-password", () => {
  it("accepts a known address with a generic body", async () => {
    const { app, created } = await build({ accountExists: true });
    const response = await post(app, "/auth/forgot-password",
      { email: "user@example.com" });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
    expect(created).toHaveLength(1);
    await app.close();
  });

  it("returns the IDENTICAL response for an unknown address", async () => {
    const known = await build({ accountExists: true });
    const knownResponse = await post(known.app, "/auth/forgot-password",
      { email: "user@example.com" });

    const unknown = await build({ accountExists: false });
    const unknownResponse = await post(unknown.app, "/auth/forgot-password",
      { email: "nobody@example.com" });

    // Status, body and header set must match. Anything that differs is an
    // account-existence oracle, including a stray header (§21, §186).
    expect(unknownResponse.statusCode).toBe(knownResponse.statusCode);
    expect(unknownResponse.json()).toEqual(knownResponse.json());
    expect(Object.keys(unknownResponse.headers).sort())
      .toEqual(Object.keys(knownResponse.headers).sort());
    // And no challenge was created for the unknown address.
    expect(unknown.created).toHaveLength(0);

    await known.app.close();
    await unknown.app.close();
  });

  it("never returns 404 for an unknown address", async () => {
    const { app } = await build({ accountExists: false });
    const response = await post(app, "/auth/forgot-password",
      { email: "nobody@example.com" });
    expect(response.statusCode).not.toBe(404);
    await app.close();
  });

  it("rejects unknown fields", async () => {
    const { app } = await build();
    for (const extra of [
      { isAdmin: true }, { userId: "usr_2" }, { role: "admin" },
      { password: "hunter2" }, { verified: true },
    ]) {
      const response = await post(app, "/auth/forgot-password",
        { email: "user@example.com", ...extra });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
  });

  it("does not mutate on GET", async () => {
    const { app, created } = await build();
    const response = await app.inject({
      method: "GET", url: "/auth/forgot-password?email=user@example.com",
    });
    expect(response.statusCode).toBe(404);
    expect(created).toHaveLength(0);
    await app.close();
  });

  it("the response schema cannot carry account information", () => {
    const properties = Object.keys(ForgotPasswordResponseSchema.properties);
    expect(properties).toEqual(["accepted"]);
    expect(ForgotPasswordResponseSchema.additionalProperties).toBe(false);
  });
});

// ── Reset password ─────────────────────────────────────────────────────────

describe("POST /auth/reset-password", () => {
  it("resets, and directs the user to sign in", async () => {
    const { app, revoked } = await build({ challengeState: "active" });
    const response = await post(app, "/auth/reset-password",
      { token: TOKEN, newPassword: PASSWORD });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ passwordReset: true, nextAction: "sign-in" });
    expect(revoked).toEqual(["usr_1"]);
    await app.close();
  });

  it("issues NO session cookie and NO CSRF cookie", async () => {
    const { app } = await build({ challengeState: "active" });
    const response = await post(app, "/auth/reset-password",
      { token: TOKEN, newPassword: PASSWORD });

    const cookies = response.cookies;
    // Both appear, and both are CLEARED — never set to a credential (§115).
    for (const name of ["lagda_session", "lagda_csrf"]) {
      const cookie = cookies.find(c => c.name === name);
      expect(cookie).toBeDefined();
      expect(cookie?.value).toBe("");
    }
    await app.close();
  });

  it("collapses every token failure into ONE code", async () => {
    const codes = new Set<string>();
    for (const challengeState of
      ["missing", "consumed", "superseded", "expired"] as const) {
      const { app } = await build({ challengeState });
      const response = await post(app, "/auth/reset-password",
        { token: TOKEN, newPassword: PASSWORD });

      expect(response.statusCode).toBe(422);
      const body: { error: { code: string; message: string } } = response.json();
      codes.add(body.error.code);
      // And the message never names the state.
      expect(body.error.message).not.toMatch(/consumed|superseded|used|unknown/i);
      await app.close();
    }
    // Four distinct internal states, one public answer (§120).
    expect([...codes]).toEqual(["INVALID_OR_EXPIRED_RESET_TOKEN"]);
  });

  it("a malformed token is rejected with the same code, and never hashed", async () => {
    const { app, hashed } = await build({ challengeState: "active" });
    const response = await post(app, "/auth/reset-password",
      { token: "too-short", newPassword: PASSWORD });

    expect(response.statusCode).toBe(422);
    const body: { error: { code: string } } = response.json();
    expect(body.error.code)
      .toBe("INVALID_OR_EXPIRED_RESET_TOKEN");
    // Argon2 was never reached. A malformed token that still costs a hash is a
    // free denial-of-service primitive (§105, §251).
    expect(hashed).toHaveLength(0);
    await app.close();
  });

  it("a policy-rejected password is refused BEFORE hashing", async () => {
    const { app, hashed } = await build({ challengeState: "active" });
    const response = await post(app, "/auth/reset-password",
      { token: TOKEN, newPassword: "short" });

    expect(response.statusCode).toBe(422);
    const body: { error: { code: string } } = response.json();
    expect(body.error.code)
      .toBe("INVALID_PASSWORD");
    expect(hashed).toHaveLength(0);
    await app.close();
  });

  it("a dead token is refused BEFORE hashing", async () => {
    const { app, hashed } = await build({ challengeState: "consumed" });
    await post(app, "/auth/reset-password",
      { token: TOKEN, newPassword: PASSWORD });
    expect(hashed).toHaveLength(0);
    await app.close();
  });

  it("hashes BEFORE the transaction, and consumes inside it", async () => {
    const { app, consumeOrder } = await build({ challengeState: "active" });
    await post(app, "/auth/reset-password",
      { token: TOKEN, newPassword: PASSWORD });

    // Argon2 must not run inside a transaction holding row locks (§59, §252),
    // and consumption must happen after it, in the transaction (§60).
    expect(consumeOrder).toEqual(["hash", "consume"]);
    await app.close();
  });

  it("a lost consume race returns the generic failure, not a success", async () => {
    const { app, revoked } = await build({
      challengeState: "active", consumeWins: false,
    });
    const response = await post(app, "/auth/reset-password",
      { token: TOKEN, newPassword: PASSWORD });

    expect(response.statusCode).toBe(422);
    // And crucially: no sessions were revoked, because no password changed.
    expect(revoked).toHaveLength(0);
    await app.close();
  });

  it("rejects unknown fields, including a second identity claim", async () => {
    const { app } = await build({ challengeState: "active" });
    for (const extra of [
      { userId: "usr_2" }, { email: "other@example.com" },
      { emailVerified: true }, { role: "admin" }, { sessionId: "ses_1" },
    ]) {
      const response = await post(app, "/auth/reset-password",
        { token: TOKEN, newPassword: PASSWORD, ...extra });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
  });

  it("does not mutate on GET", async () => {
    const { app, hashed, revoked } = await build({ challengeState: "active" });
    const response = await app.inject({
      method: "GET", url: `/auth/reset-password?token=${TOKEN}`,
    });
    // The reset LINK is a GET to the frontend page. This endpoint is not it —
    // a scanner prefetching the link cannot burn the token (§46, §47, §191).
    expect(response.statusCode).toBe(404);
    expect(hashed).toHaveLength(0);
    expect(revoked).toHaveLength(0);
    await app.close();
  });

  it("the response schema cannot carry a token, user or session count", () => {
    const properties = Object.keys(ResetPasswordResponseSchema.properties).sort();
    expect(properties).toEqual(["nextAction", "passwordReset"]);
    expect(ResetPasswordResponseSchema.additionalProperties).toBe(false);
  });

  it("the request schema accepts exactly two fields", () => {
    const properties = Object.keys(ResetPasswordRequestSchema.properties).sort();
    expect(properties).toEqual(["newPassword", "token"]);
    expect(ResetPasswordRequestSchema.additionalProperties).toBe(false);
  });

  it("no response body ever contains the submitted token or password", async () => {
    for (const challengeState of ["active", "missing", "expired"] as const) {
      const { app } = await build({ challengeState });
      const response = await post(app, "/auth/reset-password",
        { token: TOKEN, newPassword: PASSWORD });
      expect(response.body).not.toContain(TOKEN);
      expect(response.body).not.toContain(PASSWORD);
      expect(response.body).not.toContain(HASH);
      await app.close();
    }
  });
});
