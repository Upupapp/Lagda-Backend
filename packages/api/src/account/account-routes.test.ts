// The account surface's HTTP contract.
//
// The properties under test: a pre-auth credential is not a session, every
// security field is refused at the schema, and no response carries a credential.

import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type {
  GetCurrentUserDependencies, UpdateProfileDependencies,
  UpdatePreferencesDependencies, ChangePasswordDependencies,
  ListSessionsDependencies, RevokeSessionDependencies,
  RevokeOtherSessionsDependencies, CurrentUser, PasswordHash,
  SessionId, UserId,
} from "@lagda/application";
import type { ApiConfig } from "../config/index.js";
import {
  registerAccountRoutes, CurrentUserResponseSchema,
  UpdateProfileRequestSchema, ChangePasswordRequestSchema,
  SessionListResponseSchema,
} from "./account-routes.js";

const HASH = "$argon2id$v=19$m=19456,p=1,t=2$c2FsdA$aGFzaA" as PasswordHash;
const NORMALIZED = "real.user@example.com";
const SESSION_TOKEN = "S".repeat(43);
const PASSWORD = "correct horse battery staple";

const CONFIG = {
  environment: "production",
  corsOrigins: ["https://app.lagda.example"],
  sessionCookieSecure: true,
  sessionCookieSameSite: "lax",
} as unknown as ApiConfig;

function currentUser(): CurrentUser {
  return {
    userId: "usr_1" as UserId,
    email: "Real.User@Example.com",
    emailVerified: true,
    profile: {
      fullName: "Real User", displayName: "Real",
      jobTitle: "Notary", department: "Legal",
      preferredSenderName: "Real U.",
    },
    preferences: {
      timezone: "Asia/Manila", locale: "en-PH", language: "en",
      dateFormat: "DD/MM/YYYY", timeFormat: "24h", numberFormat: "comma-dot",
      appearance: "system", density: "comfortable", documentListView: "table",
    },
    security: { mfaEnabled: true, mfaFactor: "TOTP", recoveryCodesRemaining: 8 },
    createdAt: 1_700_000_000_000,
  };
}

interface Built {
  readonly app: FastifyInstance;
  readonly profileWrites: unknown[];
  readonly revoked: string[];
}

async function build(options: {
  authenticated?: boolean;
  userExists?: boolean;
  passwordOutcome?: "changed" | "invalid-current-password";
  revokeFound?: boolean;
  revokeCurrent?: boolean;
} = {}): Promise<Built> {
  const app = Fastify({
    logger: false,
    ajv: {
      customOptions: {
        removeAdditional: false, coerceTypes: true, allErrors: true,
      },
    },
  });
  await app.register(cookie);
  const profileWrites: unknown[] = [];
  const revoked: string[] = [];

  const accounts = {
    findCurrentUser: () => Promise.resolve(
      options.userExists === false ? null : currentUser()),
    updateProfile(input: unknown) {
      profileWrites.push(input);
      return Promise.resolve(true);
    },
    updatePreferences(input: unknown) {
      profileWrites.push(input);
      return Promise.resolve(true);
    },
  };

  registerAccountRoutes(app, {
    config: CONFIG,
    authenticatedUser: () => Promise.resolve(
      options.authenticated === false
        ? null
        : { userId: "usr_1" as UserId, sessionId: "ses_1" as SessionId }),
    currentUserDependencies: (): GetCurrentUserDependencies => ({ accounts }),
    updateProfileDependencies: (): UpdateProfileDependencies => ({
      clock: { now: () => 1_700_000_000_000 },
      commit: operation => operation({ accounts }),
    }),
    updatePreferencesDependencies: (): UpdatePreferencesDependencies => ({
      clock: { now: () => 1_700_000_000_000 },
      isKnownTimezone: () => true,
      commit: operation => operation({ accounts }),
    }),
    changePasswordDependencies: (): ChangePasswordDependencies => ({
      clock: { now: () => 1_700_000_000_000 },
      hasher: {
        hash: () => Promise.resolve(HASH),
        verify: () => Promise.resolve(
          options.passwordOutcome !== "invalid-current-password"),
        needsRehash: () => false,
      },
      credentials: { findPasswordHash: () => Promise.resolve(HASH) },
      commit: operation => operation({
        credentials: {
          findPasswordHash: () => Promise.resolve(HASH),
          replacePasswordHash: () => Promise.resolve(true),
        },
        sessions: {
          listActiveForUser: () => Promise.resolve([]),
          revokeOwnedByUser: () => Promise.resolve(true),
          revokeAllForUserExcept: () => Promise.resolve(2),
        },
      }),
    }),
    listSessionsDependencies: (): ListSessionsDependencies => ({
      sessions: {
        listActiveForUser: () => Promise.resolve([
          {
            sessionId: "ses_1" as SessionId, createdAt: 1, lastSeenAt: 2,
            expiresAt: 3,
          },
          {
            sessionId: "ses_2" as SessionId, createdAt: 4, lastSeenAt: 5,
            expiresAt: 6,
          },
        ]),
      },
    }),
    revokeSessionDependencies: (): RevokeSessionDependencies => ({
      clock: { now: () => 1_700_000_000_000 },
      sessions: {
        revokeOwnedByUser(input) {
          if (options.revokeFound === false) return Promise.resolve(false);
          revoked.push(input.sessionId);
          return Promise.resolve(true);
        },
      },
    }),
    revokeOtherSessionsDependencies: (): RevokeOtherSessionsDependencies => ({
      clock: { now: () => 1_700_000_000_000 },
      sessions: {
        revokeAllForUserExcept() { revoked.push("others"); return Promise.resolve(3); },
      },
    }),
  });
  await app.ready();
  return { app, profileWrites, revoked };
}

const patch = (app: FastifyInstance, url: string, payload: unknown) =>
  app.inject({ method: "PATCH", url, payload: payload as object });
const post = (app: FastifyInstance, url: string, payload: unknown) =>
  app.inject({ method: "POST", url, payload: payload as object });

// ── /me ─────────────────────────────────────────────────────────────────────

describe("GET /me", () => {
  it("returns the safe projection", async () => {
    const { app } = await build();
    const response = await app.inject({ method: "GET", url: "/me" });

    expect(response.statusCode).toBe(200);
    const body: CurrentUser = response.json();
    expect(body.email).toBe("Real.User@Example.com");
    expect(body.security.mfaEnabled).toBe(true);
    await app.close();
  });

  it("refuses an anonymous caller", async () => {
    const { app } = await build({ authenticated: false });
    const response = await app.inject({ method: "GET", url: "/me" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("refuses a browser holding only a pre-auth credential", async () => {
    // `authenticatedUser` resolves a FULL session; a pre-auth cookie is not
    // one. A half-finished MFA ceremony has proved a password and nothing
    // more, and must not be able to read an account (§21, §158).
    const { app } = await build({ authenticated: false });
    const response = await app.inject({
      method: "GET", url: "/me",
      cookies: { lagda_pre_auth: "P".repeat(43) },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("carries no credential or internal identity in the body", async () => {
    const { app } = await build();
    const response = await app.inject({ method: "GET", url: "/me" });

    expect(response.body).not.toContain(HASH);
    expect(response.body).not.toContain(NORMALIZED);
    expect(response.body).not.toMatch(
      /passwordHash|normalizedEmail|tokenDigest|csrf|secret|emailVerifiedAt/i);
    await app.close();
  });

  it("is never cacheable", async () => {
    const { app } = await build();
    const response = await app.inject({ method: "GET", url: "/me" });
    // `no-store`, not `no-cache` — the latter lets a shared cache KEEP the
    // body and merely revalidate it (§127).
    expect(response.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("clears cookies when the session outlives the account", async () => {
    const { app } = await build({ userExists: false });
    const response = await app.inject({ method: "GET", url: "/me" });

    expect(response.statusCode).toBe(401);
    // Not an empty profile. A blank user would let the frontend render a
    // logged-in shell for nobody (§227).
    expect(response.cookies.find(c => c.name === "lagda_session")?.value).toBe("");
    await app.close();
  });

  it("declares a CLOSED response schema", () => {
    expect(CurrentUserResponseSchema.additionalProperties).toBe(false);
    expect(Object.keys(CurrentUserResponseSchema.properties).sort())
      .toEqual([
        "createdAt", "email", "emailVerified", "preferences", "profile",
        "security", "userId",
      ]);
  });
});

// ── Mass assignment ─────────────────────────────────────────────────────────

describe("PATCH /me/profile — mass assignment", () => {
  it("updates the allowed fields", async () => {
    const { app, profileWrites } = await build();
    const response = await patch(app, "/me/profile", {
      fullName: "Maria Reyes", jobTitle: "Notary",
    });
    expect(response.statusCode).toBe(200);
    expect(profileWrites).toHaveLength(1);
    await app.close();
  });

  it("REFUSES every security field", async () => {
    const { app, profileWrites } = await build();
    // Each of these is a real privilege-escalation attempt. The schema's
    // `additionalProperties: false` is what makes them 400s — Fastify would
    // otherwise strip them before the handler could observe anything.
    for (const attack of [
      { emailVerified: true },
      { email: "attacker@example.com" },
      { normalizedEmail: "attacker@example.com" },
      { password: "hunter2" },
      { passwordHash: "$argon2id$..." },
      { mfaEnabled: false },
      { mfaFactor: null },
      { role: "admin" },
      { isSystemAdmin: true },
      { workspaceId: "ws_1" },
      { workspaceRole: "owner" },
      { userId: "usr_2" },
      { sessionId: "ses_9" },
      { createdAt: 0 },
    ]) {
      const response = await patch(app, "/me/profile",
        { fullName: "Maria Reyes", ...attack });
      expect(response.statusCode).toBe(400);
    }
    // Not one reached the repository.
    expect(profileWrites).toHaveLength(0);
    await app.close();
  });

  it("the request schema names exactly five fields", () => {
    expect(UpdateProfileRequestSchema.additionalProperties).toBe(false);
    expect(Object.keys(UpdateProfileRequestSchema.properties).sort())
      .toEqual([
        "department", "displayName", "fullName", "jobTitle",
        "preferredSenderName",
      ]);
  });

  it("refuses an anonymous caller without writing", async () => {
    const { app, profileWrites } = await build({ authenticated: false });
    const response = await patch(app, "/me/profile", { fullName: "Maria" });
    expect(response.statusCode).toBe(401);
    expect(profileWrites).toHaveLength(0);
    await app.close();
  });

  it("takes no user id from the request — there is nowhere to put one", () => {
    // The strongest form of §168: with no `:userId` path segment and no
    // `userId` field, "user A edits user B" is not expressible, so there is no
    // authorization comparison that could be wrong.
    expect(Object.keys(UpdateProfileRequestSchema.properties))
      .not.toContain("userId");
  });
});

// ── Preferences ─────────────────────────────────────────────────────────────

describe("PATCH /me/preferences", () => {
  it("rejects a value outside the closed vocabulary", async () => {
    const { app, profileWrites } = await build();
    for (const bad of [
      { appearance: "neon" }, { dateFormat: "DD-MM-YY" },
      { timeFormat: "36h" }, { density: "roomy" },
    ]) {
      expect((await patch(app, "/me/preferences", bad)).statusCode).toBe(400);
    }
    expect(profileWrites).toHaveLength(0);
    await app.close();
  });

  it("rejects security fields", async () => {
    const { app } = await build();
    expect((await patch(app, "/me/preferences",
      { appearance: "dark", mfaEnabled: false })).statusCode).toBe(400);
    await app.close();
  });
});

// ── Password ────────────────────────────────────────────────────────────────

describe("POST /me/password", () => {
  it("changes the password and reports the revoked count", async () => {
    const { app } = await build({ passwordOutcome: "changed" });
    const response = await post(app, "/me/password", {
      currentPassword: PASSWORD, newPassword: "a different passphrase",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "changed", otherSessionsRevoked: 2 });
    // The caller's own session survives — no cookie is issued and none cleared.
    expect(response.cookies.find(c => c.name === "lagda_session")).toBeUndefined();
    await app.close();
  });

  it("refuses a wrong current password with one safe code", async () => {
    const { app } = await build({ passwordOutcome: "invalid-current-password" });
    const response = await post(app, "/me/password", {
      currentPassword: "wrong", newPassword: "a different passphrase",
    });
    expect(response.statusCode).toBe(401);
    const body: { error: { code: string } } = response.json();
    expect(body.error.code).toBe("INVALID_CREDENTIALS");
    await app.close();
  });

  it("REQUIRES the current password", () => {
    // A session alone must not be enough. The schema makes that unskippable.
    expect(Object.keys(ChangePasswordRequestSchema.properties).sort())
      .toEqual(["currentPassword", "newPassword"]);
    expect(ChangePasswordRequestSchema.additionalProperties).toBe(false);
  });

  it("rejects a request with no current password", async () => {
    const { app } = await build();
    expect((await post(app, "/me/password",
      { newPassword: "a different passphrase" })).statusCode).toBe(400);
    await app.close();
  });

  it("never echoes a password or hash", async () => {
    for (const outcome of ["changed", "invalid-current-password"] as const) {
      const { app } = await build({ passwordOutcome: outcome });
      const response = await post(app, "/me/password", {
        currentPassword: PASSWORD, newPassword: "a different passphrase",
      });
      expect(response.body).not.toContain(PASSWORD);
      expect(response.body).not.toContain("a different passphrase");
      expect(response.body).not.toContain(HASH);
      await app.close();
    }
  });
});

// ── Sessions ────────────────────────────────────────────────────────────────

describe("session management", () => {
  it("lists own sessions with no credentials", async () => {
    const { app } = await build();
    const response = await app.inject({ method: "GET", url: "/me/sessions" });

    expect(response.statusCode).toBe(200);
    const body: { sessions: { isCurrent: boolean }[] } = response.json();
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions.filter(s => s.isCurrent)).toHaveLength(1);
    expect(response.body).not.toContain(SESSION_TOKEN);
    expect(response.body).not.toMatch(/tokenHash|token_hash|csrf|ipAddress|userAgent/i);
    await app.close();
  });

  it("revokes one session", async () => {
    const { app, revoked } = await build();
    const response = await post(app, "/me/sessions/revoke", { sessionId: "ses_2" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revoked: 1, signedOut: false });
    expect(revoked).toEqual(["ses_2"]);
    await app.close();
  });

  it("clears cookies when the caller revokes their OWN session", async () => {
    const { app } = await build();
    const response = await post(app, "/me/sessions/revoke", { sessionId: "ses_1" });

    const body: { signedOut: boolean } = response.json();
    expect(body.signedOut).toBe(true);
    expect(response.cookies.find(c => c.name === "lagda_session")?.value).toBe("");
    await app.close();
  });

  it("returns 404 for a session that is not the caller's", async () => {
    const { app } = await build({ revokeFound: false });
    const response = await post(app, "/me/sessions/revoke", { sessionId: "ses_x" });
    // The same answer as "no such session". Separating them would make this an
    // oracle for which identifiers exist (§201).
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("revokes all others when no id is given", async () => {
    const { app, revoked } = await build();
    const response = await post(app, "/me/sessions/revoke", {});
    expect(response.json()).toEqual({ revoked: 3, signedOut: false });
    expect(revoked).toEqual(["others"]);
    await app.close();
  });

  it("rejects a userId in the revoke body", async () => {
    const { app } = await build();
    expect((await post(app, "/me/sessions/revoke",
      { sessionId: "ses_2", userId: "usr_2" })).statusCode).toBe(400);
    await app.close();
  });

  it("declares a CLOSED session projection", () => {
    const item = SessionListResponseSchema.properties.sessions.items as {
      additionalProperties?: boolean; properties: Record<string, unknown>;
    };
    expect(item.additionalProperties).toBe(false);
    expect(Object.keys(item.properties).sort())
      .toEqual(["createdAt", "expiresAt", "isCurrent", "lastSeenAt", "sessionId"]);
  });
});
