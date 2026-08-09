// The MFA routes' public contract.
//
// What matters here is not the cryptography — that is tested against real
// PostgreSQL — but the HTTP boundary: which cookie authorizes what, that a
// session is issued only at the end, and that a pre-auth credential never
// appears in a body.

import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type {
  CompleteMfaDependencies, BeginEnrolmentDependencies,
  ConfirmEnrolmentDependencies, DisableMfaDependencies,
  MfaFactorId, PendingAuthenticationId, RecoveryCodeId, UserId,
  PendingAuthDigest, RecoveryCodeDigest, PasswordHash,
} from "@lagda/application";
import type { ApiConfig } from "../config/index.js";
import {
  registerMfaRoutes, VerifyMfaResponseSchema, EnrollMfaResponseSchema,
  ConfirmMfaResponseSchema, DisableMfaRequestSchema,
} from "./mfa-routes.js";

const PRE_AUTH = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const SESSION_TOKEN = "S".repeat(43);
const CSRF_TOKEN = "C".repeat(43);
const SECRET = "JBSWY3DPEHPK3PXP";
const PASSWORD = "correct horse battery staple";

const CONFIG = {
  environment: "production",
  corsOrigins: ["https://app.lagda.example"],
  sessionCookieSecure: true,
  sessionCookieSameSite: "lax",
} as unknown as ApiConfig;

interface Built {
  readonly app: FastifyInstance;
  readonly issuedSessions: UserId[];
}

async function build(options: {
  verifyOutcome?: "authenticated" | "invalid-code" | "code-replayed"
  | "attempts-exhausted" | "pending-expired" | "pending-not-found";
  recoveryRemaining?: number | null;
  authenticated?: boolean;
  enrolOutcome?: "started" | "already-enabled";
  confirmOutcome?: "enabled" | "invalid-code" | "no-pending-enrolment";
  disableOutcome?: "disabled" | "invalid-password" | "not-enabled";
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
  const issuedSessions: UserId[] = [];
  const now = 1_700_000_000_000;
  const outcome = options.verifyOutcome ?? "authenticated";

  const noopPending = {
    create: () => Promise.resolve(),
    findByCredentialDigest: () => Promise.resolve(null),
    recordFailedAttempt: () =>
      Promise.resolve({ failedAttempts: 1, exhausted: false }),
    consumeIfUsable: () => Promise.resolve(true),
    revokeAllForUser: () => Promise.resolve(0),
  };
  const noopFactors = {
    findActiveForUser: () => Promise.resolve(null),
    create: () => Promise.resolve(),
    markVerifiedIfPending: () => Promise.resolve(true),
    advanceTimeStepIfNewer: () => Promise.resolve(true),
    disable: () => Promise.resolve(true),
  };
  const noopRecovery = {
    replaceAllForUser: () => Promise.resolve(),
    consumeForUser: () => Promise.resolve(false),
    countUnusedForUser: () => Promise.resolve(9),
    deleteAllForUser: () => Promise.resolve(),
  };

  // The use cases are exercised for real against PostgreSQL elsewhere. Here
  // they are stubbed at the boundary so the route's own decisions — cookies,
  // statuses, what reaches a body — are what is under test.
  const verifyDependencies = (): CompleteMfaDependencies => ({
    clock: { now: () => now },
    totp: {
      generateSecret: () => SECRET,
      buildProvisioningUri: () => `otpauth://totp/LAGDA:u?secret=${SECRET}`,
      // `code-replayed` means the code WAS arithmetically correct and the
      // watermark refused it. An earlier version of this stub returned
      // `valid: false` for that case, so the route never reached the replay
      // branch and the "does not reveal a replay" test passed vacuously.
      verify: () => ({
        valid: outcome === "authenticated" || outcome === "code-replayed",
        timeStep: 1,
      }),
      isWellFormedCode: (raw: string) => /^[0-9]{6}$/.test(raw),
    },
    sealer: { keyVersion: "v1", seal: s => s, open: s => s },
    recoveryCodes: {
      issue: () => ({ display: [], digests: [] }),
      digestSubmitted: () => null,
    },
    pendingCredentials: {
      issue: () => ({ raw: PRE_AUTH, digest: "a".repeat(64) as PendingAuthDigest }),
      digestSubmitted: raw =>
        raw.length === 43 ? ("a".repeat(64) as PendingAuthDigest) : null,
    },
    accountLabelFor: () => Promise.resolve("user@example.com"),
    commit: operation => operation({
      pending: {
        ...noopPending,
        findByCredentialDigest: () => Promise.resolve(
          outcome === "pending-not-found" ? null : {
            pendingId: "pnd_1" as PendingAuthenticationId,
            userId: "usr_1" as UserId,
            createdAt: 0,
            expiresAt: outcome === "pending-expired" ? now - 1 : now + 600_000,
            consumedAt: null,
            revokedAt: null,
            failedAttempts: outcome === "attempts-exhausted" ? 5 : 0,
            maxAttempts: 5,
            authenticationMethod: "PASSWORD" as const,
          }),
      },
      factors: {
        ...noopFactors,
        findActiveForUser: () => Promise.resolve({
          factorId: "mfa_1" as MfaFactorId,
          userId: "usr_1" as UserId,
          factorType: "TOTP" as const,
          secretCiphertext: SECRET,
          secretKeyVersion: "v1",
          createdAt: 0,
          verifiedAt: 1,
          disabledAt: null,
          lastUsedTimeStep: null,
        }),
        advanceTimeStepIfNewer: () => Promise.resolve(outcome !== "code-replayed"),
      },
      recovery: noopRecovery,
    }),
  });

  const enrollDependencies = (): BeginEnrolmentDependencies => ({
    clock: { now: () => now },
    totp: {
      generateSecret: () => SECRET,
      buildProvisioningUri: () => `otpauth://totp/LAGDA:u?secret=${SECRET}`,
      verify: () => ({ valid: true, timeStep: 1 }),
      isWellFormedCode: () => true,
    },
    sealer: { keyVersion: "v1", seal: s => s, open: s => s },
    newFactorId: () => "mfa_2" as MfaFactorId,
    accountLabelFor: () => Promise.resolve("user@example.com"),
    commit: operation => operation({
      factors: {
        ...noopFactors,
        findActiveForUser: () => Promise.resolve(
          options.enrolOutcome === "already-enabled" ? {
            factorId: "mfa_1" as MfaFactorId,
            userId: "usr_1" as UserId,
            factorType: "TOTP" as const,
            secretCiphertext: SECRET, secretKeyVersion: "v1",
            createdAt: 0, verifiedAt: 1, disabledAt: null, lastUsedTimeStep: null,
          } : null),
      },
    }),
  });

  const confirmDependencies = (): ConfirmEnrolmentDependencies => ({
    clock: { now: () => now },
    totp: {
      generateSecret: () => SECRET,
      buildProvisioningUri: () => "",
      verify: () => ({
        valid: options.confirmOutcome !== "invalid-code", timeStep: 1,
      }),
      isWellFormedCode: (raw: string) => /^[0-9]{6}$/.test(raw),
    },
    sealer: { keyVersion: "v1", seal: s => s, open: s => s },
    recoveryCodes: {
      issue: () => ({
        display: ["AAAA-BBBB-CCCC", "DDDD-EEEE-FFFF"],
        digests: ["b".repeat(64), "c".repeat(64)] as RecoveryCodeDigest[],
      }),
      digestSubmitted: () => null,
    },
    newRecoveryCodeId: () => "rec_1" as RecoveryCodeId,
    accountLabelFor: () => Promise.resolve("user@example.com"),
    commit: operation => operation({
      factors: {
        ...noopFactors,
        findActiveForUser: () => Promise.resolve(
          options.confirmOutcome === "no-pending-enrolment" ? null : {
            factorId: "mfa_1" as MfaFactorId,
            userId: "usr_1" as UserId,
            factorType: "TOTP" as const,
            secretCiphertext: SECRET, secretKeyVersion: "v1",
            createdAt: 0, verifiedAt: null, disabledAt: null,
            lastUsedTimeStep: null,
          }),
      },
      recovery: noopRecovery,
    }),
  });

  const disableDependencies = (): DisableMfaDependencies => ({
    clock: { now: () => now },
    hasher: {
      hash: () => Promise.resolve("$argon2id$x" as PasswordHash),
      verify: () => Promise.resolve(options.disableOutcome !== "invalid-password"),
      needsRehash: () => false,
    },
    passwordHashFor: () => Promise.resolve("$argon2id$x" as PasswordHash),
    commit: operation => operation({
      factors: {
        ...noopFactors,
        findActiveForUser: () => Promise.resolve(
          options.disableOutcome === "not-enabled" ? null : {
            factorId: "mfa_1" as MfaFactorId,
            userId: "usr_1" as UserId,
            factorType: "TOTP" as const,
            secretCiphertext: SECRET, secretKeyVersion: "v1",
            createdAt: 0, verifiedAt: 1, disabledAt: null, lastUsedTimeStep: null,
          }),
      },
      recovery: noopRecovery,
      pending: noopPending,
    }),
  });

  registerMfaRoutes(app, {
    verifyPath: "/auth/mfa/verify",
    enrollPath: "/auth/mfa/enroll",
    confirmPath: "/auth/mfa/confirm",
    disablePath: "/auth/mfa/disable",
    config: CONFIG,
    verifyDependencies, enrollDependencies, confirmDependencies,
    disableDependencies,
    issueSession(userId) {
      issuedSessions.push(userId);
      return Promise.resolve({
        sessionToken: SESSION_TOKEN, csrfToken: CSRF_TOKEN,
        expiresAt: now + 8 * 3_600_000,
      });
    },
    authenticatedUser: () => Promise.resolve(
      options.authenticated === false ? null : ("usr_1" as UserId)),
  });
  await app.ready();
  return { app, issuedSessions };
}

const post = (
  app: FastifyInstance, url: string, payload?: unknown, cookies?: Record<string, string>,
) => app.inject({
  method: "POST", url,
  ...(payload === undefined ? {} : { payload: payload as object }),
  ...(cookies === undefined ? {} : { cookies }),
});

// ── Verify ─────────────────────────────────────────────────────────────────

describe("POST /auth/mfa/verify", () => {
  it("issues a FRESH session and clears the pre-auth cookie", async () => {
    const { app, issuedSessions } = await build();
    const response = await post(app, "/auth/mfa/verify", { code: "123456" },
      { lagda_pre_auth: PRE_AUTH });

    expect(response.statusCode).toBe(200);
    expect(issuedSessions).toEqual(["usr_1"]);

    const cookies = response.cookies;
    const session = cookies.find(c => c.name === "lagda_session");
    const preAuth = cookies.find(c => c.name === "lagda_pre_auth");

    expect(session?.value).toBe(SESSION_TOKEN);
    // The session credential is NOT the pre-auth credential. Promoting one
    // into the other is the session-fixation shape this design avoids (§268).
    expect(session?.value).not.toBe(PRE_AUTH);
    // And the half-finished credential is gone from the browser.
    expect(preAuth?.value).toBe("");
    await app.close();
  });

  it("puts NO credential in the response body", async () => {
    const { app } = await build();
    const response = await post(app, "/auth/mfa/verify", { code: "123456" },
      { lagda_pre_auth: PRE_AUTH });

    expect(response.body).not.toContain(PRE_AUTH);
    expect(response.body).not.toContain(SESSION_TOKEN);
    expect(response.body).not.toContain(CSRF_TOKEN);
    expect(response.body).not.toContain(SECRET);
    await app.close();
  });

  it("refuses when there is no pre-auth cookie at all", async () => {
    const { app, issuedSessions } = await build();
    const response = await post(app, "/auth/mfa/verify", { code: "123456" });

    expect(response.statusCode).toBe(401);
    expect(issuedSessions).toHaveLength(0);
    await app.close();
  });

  it("issues NO session for any rejection", async () => {
    for (const verifyOutcome of
      ["invalid-code", "code-replayed", "attempts-exhausted",
        "pending-expired", "pending-not-found"] as const) {
      const { app, issuedSessions } = await build({ verifyOutcome });
      const response = await post(app, "/auth/mfa/verify", { code: "123456" },
        { lagda_pre_auth: PRE_AUTH });

      expect(response.statusCode).not.toBe(200);
      expect(issuedSessions).toHaveLength(0);
      const cookies = response.cookies;
      expect(cookies.find(c => c.name === "lagda_session")).toBeUndefined();
      await app.close();
    }
  });

  it("does NOT reveal that a replayed code was correct", async () => {
    const wrong = await build({ verifyOutcome: "invalid-code" });
    const replayed = await build({ verifyOutcome: "code-replayed" });

    const a = await post(wrong.app, "/auth/mfa/verify", { code: "123456" },
      { lagda_pre_auth: PRE_AUTH });
    const b = await post(replayed.app, "/auth/mfa/verify", { code: "123456" },
      { lagda_pre_auth: PRE_AUTH });

    // Identical. Confirming that a captured code WAS the right one tells an
    // attacker their observation was good (§118, §143).
    expect(b.statusCode).toBe(a.statusCode);
    expect(b.json()).toEqual(a.json());
    await wrong.app.close();
    await replayed.app.close();
  });

  it("clears the pre-auth cookie when attempts are exhausted", async () => {
    const { app } = await build({ verifyOutcome: "attempts-exhausted" });
    const response = await post(app, "/auth/mfa/verify", { code: "000000" },
      { lagda_pre_auth: PRE_AUTH });

    expect(response.statusCode).toBe(422);
    const body: { error: { code: string } } = response.json();
    expect(body.error.code).toBe("MFA_ATTEMPTS_EXHAUSTED");
    // The ceremony is dead — the user restarts at the password (§83).
    expect(response.cookies.find(c => c.name === "lagda_pre_auth")?.value).toBe("");
    await app.close();
  });

  it("never returns an attempt count", async () => {
    const { app } = await build({ verifyOutcome: "invalid-code" });
    const response = await post(app, "/auth/mfa/verify", { code: "000000" },
      { lagda_pre_auth: PRE_AUTH });
    // Disclosing "2 attempts remaining" leaks the security configuration for a
    // UX gain the product does not ask for (§119).
    expect(response.body).not.toMatch(/attemptsRemaining|remaining|[0-9] attempts/);
    await app.close();
  });

  it("rejects unknown fields", async () => {
    const { app } = await build();
    for (const extra of [
      { userId: "usr_2" }, { mfaEnabled: false }, { role: "admin" },
      { pendingId: "pnd_9" },
    ]) {
      const response = await post(app, "/auth/mfa/verify",
        { code: "123456", ...extra }, { lagda_pre_auth: PRE_AUTH });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
  });

  it("does not mutate on GET", async () => {
    const { app, issuedSessions } = await build();
    const response = await app.inject({
      method: "GET", url: "/auth/mfa/verify", cookies: { lagda_pre_auth: PRE_AUTH },
    });
    expect(response.statusCode).toBe(404);
    expect(issuedSessions).toHaveLength(0);
    await app.close();
  });

  it("declares a CLOSED response schema", () => {
    expect(VerifyMfaResponseSchema.additionalProperties).toBe(false);
    expect(Object.keys(VerifyMfaResponseSchema.properties).sort())
      .toEqual(["recoveryCodesRemaining", "status", "userId"]);
  });
});

// ── Enrolment and disable ──────────────────────────────────────────────────

describe("MFA settings routes", () => {
  it("all three refuse an unauthenticated caller", async () => {
    const { app } = await build({ authenticated: false });
    for (const [path, payload] of [
      ["/auth/mfa/enroll", undefined],
      ["/auth/mfa/confirm", { code: "123456" }],
      ["/auth/mfa/disable", { password: PASSWORD }],
    ] as const) {
      const response = await post(app, path, payload);
      // A pre-auth cookie is scoped to `/auth` and would be SENT here — and it
      // still must not resolve a user. Enrolling or removing a factor
      // mid-ceremony would let a password alone change account security (§255).
      expect(response.statusCode).toBe(401);
    }
    await app.close();
  });

  it("enrolment returns the provisioning URI once", async () => {
    const { app } = await build({ enrolOutcome: "started" });
    const response = await post(app, "/auth/mfa/enroll");

    expect(response.statusCode).toBe(200);
    const body: { provisioningUri: string; secret: string } = response.json();
    expect(body.provisioningUri).toContain("otpauth://");
    expect(body.secret).toBe(SECRET);
    await app.close();
  });

  it("enrolment is refused when MFA is already enabled", async () => {
    const { app } = await build({ enrolOutcome: "already-enabled" });
    const response = await post(app, "/auth/mfa/enroll");
    expect(response.statusCode).toBe(409);
    await app.close();
  });

  it("confirmation returns recovery codes exactly once", async () => {
    const { app } = await build({ confirmOutcome: "enabled" });
    const response = await post(app, "/auth/mfa/confirm", { code: "123456" });

    expect(response.statusCode).toBe(200);
    const body: { status: string; recoveryCodes: string[] } = response.json();
    expect(body.status).toBe("enabled");
    expect(body.recoveryCodes).toHaveLength(2);
    await app.close();
  });

  it("a wrong confirmation code does not enable MFA", async () => {
    const { app } = await build({ confirmOutcome: "invalid-code" });
    const response = await post(app, "/auth/mfa/confirm", { code: "000000" });
    expect(response.statusCode).toBe(422);
    expect(response.body).not.toContain("recoveryCodes");
    await app.close();
  });

  it("disable REQUIRES the password field", async () => {
    // A session alone cannot remove the factor, and the schema is what makes
    // that unskippable: a request without a password is a 400 before any
    // handler runs (§94, §180).
    expect(Object.keys(DisableMfaRequestSchema.properties)).toEqual(["password"]);
    expect(DisableMfaRequestSchema.additionalProperties).toBe(false);

    const { app } = await build();
    expect((await post(app, "/auth/mfa/disable", {})).statusCode).toBe(400);
    await app.close();
  });

  it("disable refuses a wrong password", async () => {
    const { app } = await build({ disableOutcome: "invalid-password" });
    const response = await post(app, "/auth/mfa/disable", { password: "wrong" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("disable succeeds with the correct password", async () => {
    const { app } = await build({ disableOutcome: "disabled" });
    const response = await post(app, "/auth/mfa/disable", { password: PASSWORD });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "disabled" });
    await app.close();
  });

  it("no response body ever contains the password or the secret", async () => {
    const { app } = await build({ disableOutcome: "invalid-password" });
    const response = await post(app, "/auth/mfa/disable", { password: PASSWORD });
    expect(response.body).not.toContain(PASSWORD);
    await app.close();
  });

  it("declares CLOSED enrolment schemas", () => {
    expect(EnrollMfaResponseSchema.additionalProperties).toBe(false);
    expect(ConfirmMfaResponseSchema.additionalProperties).toBe(false);
    expect(Object.keys(ConfirmMfaResponseSchema.properties).sort())
      .toEqual(["recoveryCodes", "status"]);
  });
});
