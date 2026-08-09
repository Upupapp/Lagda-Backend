// POST /auth/sign-in and POST /auth/sign-out.
//
// What is asserted here is the HTTP surface: which cookies are written, what
// never appears in a body, that an incoming cookie cannot be promoted, and that
// logout actually revokes server-side rather than only clearing a cookie.

import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type {
  AuthUserRecord, IssuedCredentials, LoginDependencies, NormalizedEmail,
  PasswordHash, SessionId, UserId,
} from "@lagda/application";
import { registerSessionRoutes, SignInResponseSchema } from "./session-routes.js";
import type { ApiConfig } from "../config/index.js";

const DUMMY = "$argon2id$v=19$m=19456,p=1,t=2$ZHVtbXk$ZHVtbXk" as PasswordHash;
const REAL = "$argon2id$v=19$m=19456,p=1,t=2$cmVhbA$cmVhbA" as PasswordHash;
const PASSWORD = "correct horse battery staple";

// The REAL field names the cookie helpers read. A fake config with invented
// names silently produced cookies with no Secure flag, which the test caught.
const CONFIG = {
  environment: "production",
  corsOrigins: ["https://app.lagda.example"],
  sessionCookieSecure: true,
  sessionCookieSameSite: "lax",
} as unknown as ApiConfig;

function verifiedAccount(overrides: Partial<AuthUserRecord> = {}): AuthUserRecord {
  return {
    userId: "usr_1" as UserId, email: "User@Example.com", displayName: "Real User",
    emailVerifiedAt: 1_700_000_000_000, createdAt: 0,
    normalizedEmail: "user@example.com" as NormalizedEmail, passwordHash: REAL,
    ...overrides,
  };
}

interface Built {
  readonly app: FastifyInstance;
  readonly revoked: string[];
  readonly issuedTokens: string[];
  readonly verifyCalls: string[];
}

async function build(options: {
  found?: AuthUserRecord | null;
  passwordCorrect?: boolean;
  sessionId?: string;
  failRevoke?: boolean;
  failIssue?: boolean;
} = {}): Promise<Built> {
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true, allErrors: true } },
  });
  await app.register(cookie);

  const revoked: string[] = [];
  const issuedTokens: string[] = [];
  const verifyCalls: string[] = [];
  let counter = 0;

  // Stands in for BACKEND-13's session plugin: whatever `auth` the request has
  // been decorated with by the time the handler runs.
  if (options.sessionId !== undefined) {
    app.addHook("onRequest", (request, _reply, done) => {
      (request as { auth?: unknown }).auth = { sessionId: options.sessionId };
      done();
    });
  }

  const dependencies = (): LoginDependencies => ({
    users: {
      findAuthByNormalizedEmail: () => Promise.resolve(
        options.found === undefined ? verifiedAccount() : options.found),
    },
    hasher: {
      hash: () => Promise.resolve(REAL),
      verify(_password: string, hash: PasswordHash) {
        verifyCalls.push(hash);
        if (hash === DUMMY) return Promise.resolve(false);
        return Promise.resolve(options.passwordCorrect ?? true);
      },
      needsRehash: () => false,
    },
    sessions: {
      issue(userId: UserId): Promise<IssuedCredentials> {
        if (options.failIssue === true) return Promise.reject(new Error("db down"));
        counter += 1;
        const token = `SESSION_TOKEN_${String(counter)}`;
        issuedTokens.push(token);
        return Promise.resolve({
          sessionId: `ses_${String(counter)}_${userId}` as SessionId,
          sessionToken: token,
          csrfToken: `CSRF_TOKEN_${String(counter)}`,
          expiresAt: Date.now() + 8 * 3_600_000,
        });
      },
    },
    clock: { now: () => 1_700_000_000_000 },
    dummyPasswordHash: DUMMY,
  });

  registerSessionRoutes(app, {
    signInPath: "/auth/sign-in",
    signOutPath: "/auth/sign-out",
    config: CONFIG,
    dependencies,
    revokeSession(sessionId: string) {
      if (options.failRevoke === true) return Promise.reject(new Error("db down"));
      revoked.push(sessionId);
      return Promise.resolve();
    },
  });
  await app.ready();
  return { app, revoked, issuedTokens, verifyCalls };
}

const signIn = (app: FastifyInstance, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST", url: "/auth/sign-in",
    payload: payload as object,
    headers: { origin: "https://app.lagda.example", ...headers },
  });

const cookiesOf = (response: { headers: Record<string, unknown> }): string[] => {
  const raw = response.headers["set-cookie"];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw as string[] : [raw as string];
};

describe("POST /auth/sign-in", () => {
  it("authenticates and sets BOTH credentials as cookies", async () => {
    const { app } = await build();
    const response = await signIn(app, { email: "user@example.com", password: PASSWORD });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      userId: "usr_1", email: "User@Example.com",
      displayName: "Real User", emailVerified: true,
    });

    const cookies = cookiesOf(response).join("\n");
    expect(cookies).toContain("lagda_session=");
    expect(cookies).toContain("lagda_csrf=");
    await app.close();
  });

  it("NEVER puts a raw token in the response body", async () => {
    const { app } = await build();
    const response = await signIn(app, { email: "user@example.com", password: PASSWORD });

    // The tokens went into cookies and nowhere else.
    expect(response.body).not.toContain("SESSION_TOKEN_1");
    expect(response.body).not.toContain("CSRF_TOKEN_1");
    for (const forbidden of ["sessionToken", "csrfToken", "passwordHash", "argon2", "sessionId"]) {
      expect(response.body).not.toContain(forbidden);
    }
    await app.close();
  });

  it("marks the session cookie HttpOnly and Secure, and the CSRF cookie readable", async () => {
    // The asymmetry is deliberate: the session cookie must be unreadable to
    // JavaScript, while the CSRF token has to be readable so the client can
    // echo it back in a header.
    const { app } = await build();
    const cookies = cookiesOf(await signIn(app, {
      email: "user@example.com", password: PASSWORD,
    }));

    const session = cookies.find(c => c.startsWith("lagda_session=")) ?? "";
    const csrf = cookies.find(c => c.startsWith("lagda_csrf=")) ?? "";

    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/Secure/i);
    expect(session).toMatch(/SameSite/i);
    expect(session).toMatch(/Path=\//);
    expect(csrf).not.toMatch(/HttpOnly/i);
    expect(csrf).toMatch(/Secure/i);

    // Max-Age must be a plausible session lifetime in SECONDS. Passing an
    // absolute epoch-millisecond timestamp here produced Max-Age=1.7e12 - a
    // cookie the browser would keep for 50 000 years, long after the server
    // session had expired or been revoked.
    const maxAge = Number(/Max-Age=(\d+)/i.exec(session)?.[1] ?? "0");
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(24 * 60 * 60);
    await app.close();
  });

  it("gives an unknown account and a wrong password IDENTICAL responses", async () => {
    // Compared byte for byte, minus the request id which legitimately differs.
    const unknown = await build({ found: null });
    const wrong = await build({ passwordCorrect: false });

    const a = await signIn(unknown.app, { email: "nobody@example.com", password: PASSWORD });
    const b = await signIn(wrong.app, { email: "user@example.com", password: "wrong pass" });

    expect(a.statusCode).toBe(b.statusCode);
    expect(a.statusCode).toBe(401);
    expect(a.body).toBe(b.body);
    expect(cookiesOf(a)).toHaveLength(0);
    expect(cookiesOf(b)).toHaveLength(0);

    await unknown.app.close();
    await wrong.app.close();
  });

  it("runs a real verification for an unknown account", async () => {
    const { app, verifyCalls } = await build({ found: null });
    await signIn(app, { email: "nobody@example.com", password: PASSWORD });
    expect(verifyCalls).toEqual([DUMMY]);
    await app.close();
  });

  it("REFUSES an unverified account with its own status, after a correct password", async () => {
    const { app } = await build({ found: verifiedAccount({ emailVerifiedAt: null }) });
    const response = await signIn(app, { email: "user@example.com", password: PASSWORD });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code)
      .toBe("EMAIL_VERIFICATION_REQUIRED");
    // And no session was created.
    expect(cookiesOf(response)).toHaveLength(0);
    await app.close();
  });

  it("PREVENTS session fixation — an incoming cookie is never promoted", async () => {
    // The attack: an attacker plants a session cookie in a victim's browser and
    // waits for them to log in. If login adopted that credential, the attacker
    // would then hold an authenticated session.
    const { app, issuedTokens } = await build();
    const response = await signIn(app, {
      email: "user@example.com", password: PASSWORD,
    }, { cookie: "lagda_session=ATTACKER_PLANTED_TOKEN" });

    expect(response.statusCode).toBe(200);
    const cookies = cookiesOf(response).join("\n");
    // A brand new credential, and NOT the one that was handed in.
    expect(cookies).toContain("SESSION_TOKEN_1");
    expect(cookies).not.toContain("ATTACKER_PLANTED_TOKEN");
    expect(issuedTokens).toEqual(["SESSION_TOKEN_1"]);
    await app.close();
  });

  it("issues a distinct credential per login", async () => {
    const { app } = await build();
    const first = cookiesOf(await signIn(app, {
      email: "user@example.com", password: PASSWORD,
    })).join("\n");
    const second = cookiesOf(await signIn(app, {
      email: "user@example.com", password: PASSWORD,
    })).join("\n");

    expect(first).toContain("SESSION_TOKEN_1");
    expect(second).toContain("SESSION_TOKEN_2");
    expect(second).not.toContain("SESSION_TOKEN_1");
    await app.close();
  });

  it("REJECTS a cross-site origin before doing credential work", async () => {
    // Login CSRF: a forged login makes a victim's browser authenticate as the
    // attacker, who can then observe what the victim does in that account.
    const { app, verifyCalls } = await build();
    const response = await signIn(app, {
      email: "user@example.com", password: PASSWORD,
    }, { origin: "https://evil.example" });

    expect(response.statusCode).toBe(403);
    expect(verifyCalls).toHaveLength(0);
    expect(cookiesOf(response)).toHaveLength(0);
    await app.close();
  });

  it("allows a same-origin request that sends no Origin header", async () => {
    // Browsers omit Origin on some same-origin requests; rejecting an absent
    // header would break legitimate logins.
    const { app } = await build();
    const response = await app.inject({
      method: "POST", url: "/auth/sign-in",
      payload: { email: "user@example.com", password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("rejects unknown fields", async () => {
    const { app } = await build();
    for (const extra of [{ role: "admin" }, { userId: "usr_x" }, { emailVerified: true }]) {
      const response = await signIn(app, {
        email: "user@example.com", password: PASSWORD, ...extra,
      });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
  });

  it("sets NO cookie when session persistence fails", async () => {
    // A correct password whose session could not be stored is not a login.
    const { app } = await build({ failIssue: true });
    const response = await signIn(app, { email: "user@example.com", password: PASSWORD });

    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(cookiesOf(response)).toHaveLength(0);
    await app.close();
  });

  it("keeps the password out of logs and the response", async () => {
    const marker = "DO_NOT_LOG_LOGIN_PASSWORD";
    const lines: string[] = [];
    const app = Fastify({
      logger: { level: "trace", stream: { write: (c: string) => { lines.push(c); } } },
      ajv: { customOptions: { removeAdditional: false } },
    });
    await app.register(cookie);
    registerSessionRoutes(app, {
      signInPath: "/auth/sign-in", signOutPath: "/auth/sign-out", config: CONFIG,
      dependencies: () => ({
        users: { findAuthByNormalizedEmail: () => Promise.resolve(verifiedAccount()) },
        hasher: {
          hash: () => Promise.resolve(REAL),
          verify: () => Promise.resolve(true),
          needsRehash: () => false,
        },
        sessions: {
          issue: () => Promise.resolve({
            sessionId: "ses_1" as SessionId, sessionToken: "SESSION_TOKEN_SECRET",
            csrfToken: "CSRF_TOKEN_SECRET", expiresAt: Date.now() + 1000,
          }),
        },
        clock: { now: () => 0 },
        dummyPasswordHash: DUMMY,
      }),
      revokeSession: () => Promise.resolve(),
    });
    await app.ready();

    const response = await app.inject({
      method: "POST", url: "/auth/sign-in",
      payload: { email: "user@example.com", password: marker },
    });
    expect(response.statusCode).toBe(200);

    const captured = lines.join("\n");
    expect(captured).not.toContain(marker);
    expect(captured).not.toContain("SESSION_TOKEN_SECRET");
    expect(captured).not.toContain("CSRF_TOKEN_SECRET");
    expect(response.body).not.toContain(marker);
    await app.close();
  });

  it("declares a CLOSED sign-in response schema", () => {
    // What actually keeps a stray field out of the body: Fastify serializes
    // THROUGH this schema, so an extra property added in the handler is
    // dropped. That makes a leak assertion unable to observe the failure, which
    // is why the schema itself is asserted.
    const schema = SignInResponseSchema as unknown as {
      additionalProperties?: boolean; properties: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort())
      .toEqual(["displayName", "email", "emailVerified", "userId"]);
  });
});

describe("POST /auth/sign-out", () => {
  const signOut = (app: FastifyInstance) =>
    app.inject({ method: "POST", url: "/auth/sign-out" });

  it("REVOKES the server session and clears both cookies", async () => {
    // Clearing a cookie alone leaves a credential that still authenticates if
    // it was ever copied.
    const { app, revoked } = await build({ sessionId: "ses_active" });
    const response = await signOut(app);

    expect(response.statusCode).toBe(204);
    expect(revoked).toEqual(["ses_active"]);

    const cookies = cookiesOf(response).join("\n");
    expect(cookies).toContain("lagda_session=");
    expect(cookies).toContain("lagda_csrf=");
    // Cleared, i.e. expired immediately.
    expect(cookies).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
    await app.close();
  });

  it("is safe to repeat, and safe with no session at all", async () => {
    // Two tabs, a retry after a dropped response, a stale cookie — none may be
    // a 500.
    const withSession = await build({ sessionId: "ses_active" });
    expect((await signOut(withSession.app)).statusCode).toBe(204);
    expect((await signOut(withSession.app)).statusCode).toBe(204);
    expect(withSession.revoked).toEqual(["ses_active", "ses_active"]);
    await withSession.app.close();

    const withoutSession = await build();
    const response = await signOut(withoutSession.app);
    expect(response.statusCode).toBe(204);
    // The cookie is still cleared, which is locally defensive.
    expect(cookiesOf(response).join("\n")).toContain("lagda_session=");
    await withoutSession.app.close();
  });

  it("does NOT claim success when server revocation fails", async () => {
    // The browser credential is cleared regardless, but the session may still
    // be valid to whoever copied it. Reporting 204 would hide that.
    const { app } = await build({ sessionId: "ses_active", failRevoke: true });
    const response = await signOut(app);

    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code)
      .toBe("SESSION_REVOCATION_FAILED");
    // Cleared anyway.
    expect(cookiesOf(response).join("\n")).toContain("lagda_session=");
    await app.close();
  });

  it("is a POST, not a GET", async () => {
    // A GET logout can be fired by an <img> tag on any page on the internet.
    const { app } = await build({ sessionId: "ses_active" });
    expect((await app.inject({ method: "GET", url: "/auth/sign-out" })).statusCode).toBe(404);
    await app.close();
  });

  it("clears cookies with the same scope they were written with", async () => {
    // A mismatched Path or name leaves the original cookie in place and the
    // user stays signed in.
    const { app } = await build({ sessionId: "ses_active" });
    const signInCookies = cookiesOf(await signIn(app, {
      email: "user@example.com", password: PASSWORD,
    }));
    const signOutCookies = cookiesOf(await signOut(app));

    for (const name of ["lagda_session", "lagda_csrf"]) {
      const wrote = signInCookies.find(c => c.startsWith(`${name}=`)) ?? "";
      const cleared = signOutCookies.find(c => c.startsWith(`${name}=`)) ?? "";
      expect(wrote).toBeTruthy();
      expect(cleared).toBeTruthy();
      const pathOf = (c: string) => /Path=([^;]*)/i.exec(c)?.[1];
      expect(pathOf(cleared)).toBe(pathOf(wrote));
    }
    await app.close();
  });

  it("emits no session identifier in the response", async () => {
    const { app } = await build({ sessionId: "ses_active" });
    const response = await signOut(app);
    expect(response.body).not.toContain("ses_active");
    await app.close();
  });
});
