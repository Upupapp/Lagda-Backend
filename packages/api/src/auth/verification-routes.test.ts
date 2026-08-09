// POST /auth/verify-email and POST /auth/resend-verification.
//
// The route's job is the public contract: which outcomes collapse together,
// what never appears in a body, and that neither endpoint mutates on GET.

import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type {
  ResendVerificationDependencies, VerifyEmailDependencies,
  VerificationTokenDigest, VerificationChallengeId, UserId,
} from "@lagda/application";
import {
  registerVerificationRoutes, VerifyEmailResponseSchema,
  ResendVerificationResponseSchema,
} from "./verification-routes.js";

const CODE = "K7QM-2X9F-P4TB";

interface Built {
  readonly app: FastifyInstance;
  readonly rotations: string[];
}

async function build(options: {
  verifyOutcome?: "verified" | "already-verified" | "invalid";
  resendReason?: "rotated" | "unknown-account" | "already-verified";
} = {}): Promise<Built> {
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true, allErrors: true } },
  });
  const rotations: string[] = [];

  const verifyDependencies = (): VerifyEmailDependencies => ({
    digestSubmitted: raw =>
      raw.replace(/[\s-]/g, "").length === 12
        ? ("a".repeat(64) as VerificationTokenDigest)
        : null,
    clock: { now: () => 1_700_000_000_000 },
    commit: operation => operation({
      challenges: {
        findByTokenDigest: () => Promise.resolve(
          options.verifyOutcome === "invalid"
            ? null
            : {
              challengeId: "evc_1" as VerificationChallengeId,
              userId: "usr_1" as UserId,
              createdAt: 0,
              expiresAt: 1_700_000_000_000 + 86_400_000,
              consumedAt: options.verifyOutcome === "already-verified" ? 1 : null,
              supersededAt: null,
            }),
        consumeIfActive: () => Promise.resolve(true),
        supersedeActiveForUser: () => Promise.resolve(0),
        create: () => Promise.resolve(),
      },
      users: {
        findById: () => Promise.resolve({
          userId: "usr_1" as UserId,
          emailVerifiedAt: options.verifyOutcome === "already-verified" ? 1 : null,
        }),
        findByNormalizedEmail: () => Promise.resolve(null),
        markEmailVerifiedIfUnverified: () => Promise.resolve(true),
      },
    }),
  });

  const resendDependencies = (): ResendVerificationDependencies => ({
    tokens: {
      issue: () => ({ raw: CODE, digest: "b".repeat(64) as VerificationTokenDigest }),
    },
    clock: { now: () => 1_700_000_000_000 },
    newChallengeId: () => "evc_2" as VerificationChallengeId,
    verificationTtlMs: 86_400_000,
    commit: operation => operation({
      challenges: {
        findByTokenDigest: () => Promise.resolve(null),
        consumeIfActive: () => Promise.resolve(false),
        supersedeActiveForUser: () => Promise.resolve(1),
        create() { rotations.push("created"); return Promise.resolve(); },
      },
      users: {
        findById: () => Promise.resolve(null),
        findByNormalizedEmail: () => Promise.resolve(
          options.resendReason === "unknown-account"
            ? null
            : {
              userId: "usr_1" as UserId,
              email: "user@example.com",
              displayName: "User",
              emailVerifiedAt: options.resendReason === "already-verified" ? 1 : null,
              createdAt: 0,
            }),
        markEmailVerifiedIfUnverified: () => Promise.resolve(false),
      },
    }),
  });

  registerVerificationRoutes(app, {
    verifyPath: "/auth/verify-email",
    resendPath: "/auth/resend-verification",
    verifyDependencies,
    resendDependencies,
  });
  await app.ready();
  return { app, rotations };
}

const post = (app: FastifyInstance, url: string, payload: unknown) =>
  app.inject({ method: "POST", url, payload: payload as object });

describe("POST /auth/verify-email", () => {
  it("verifies and returns a stable next action", async () => {
    const { app } = await build({ verifyOutcome: "verified" });
    const response = await post(app, "/auth/verify-email", { code: CODE });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ verified: true, nextAction: "sign-in" });
    await app.close();
  });

  it("treats an ALREADY-VERIFIED account as a success", async () => {
    // A double submit, or a retry after a lost response, must not look like a
    // failure to a user who did nothing wrong.
    const { app } = await build({ verifyOutcome: "already-verified" });
    const response = await post(app, "/auth/verify-email", { code: CODE });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ verified: boolean }>().verified).toBe(true);
    await app.close();
  });

  it("COLLAPSES every failure into one public answer", async () => {
    // Unknown, expired, consumed and superseded are all the same 422. Telling
    // them apart would tell someone submitting random codes which ones once
    // existed.
    const { app } = await build({ verifyOutcome: "invalid" });
    const response = await post(app, "/auth/verify-email", { code: CODE });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code)
      .toBe("INVALID_OR_EXPIRED_VERIFICATION_CODE");
    await app.close();
  });

  it("returns NO account data", async () => {
    const { app } = await build({ verifyOutcome: "verified" });
    const body = (await post(app, "/auth/verify-email", { code: CODE })).body;

    for (const leak of ["usr_1", "user@example.com", "evc_1", "tokenDigest", "userId"]) {
      expect(body).not.toContain(leak);
    }
    await app.close();
  });

  it("rejects unknown fields", async () => {
    const { app } = await build({ verifyOutcome: "verified" });
    for (const extra of [
      { userId: "usr_x" }, { emailVerified: true }, { verifiedAt: 0 },
    ]) {
      expect((await post(app, "/auth/verify-email", { code: CODE, ...extra }))
        .statusCode).toBe(400);
    }
    await app.close();
  });

  it("does NOT verify on a GET", async () => {
    // Email scanners fetch every link in a message. A GET that consumed a code
    // would let a scanner verify an account, or burn the code before the real
    // user sees it.
    const { app } = await build({ verifyOutcome: "verified" });
    expect((await app.inject({ method: "GET", url: "/auth/verify-email?code=K7QM-2X9F-P4TB" }))
      .statusCode).toBe(404);
    await app.close();
  });

  it("declares a CLOSED response schema", () => {
    const schema = VerifyEmailResponseSchema as unknown as {
      additionalProperties?: boolean; properties: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(["nextAction", "verified"]);
  });
});

describe("POST /auth/resend-verification", () => {
  it("gives an IDENTICAL response for unknown, verified and unverified", async () => {
    // The decisive anti-enumeration property. Unlike registration, the caller
    // has asserted nothing about owning this address.
    const responses = [];
    for (const reason of ["unknown-account", "already-verified", "rotated"] as const) {
      const { app } = await build({ resendReason: reason });
      const response = await post(app, "/auth/resend-verification",
        { email: "user@example.com" });
      responses.push({ status: response.statusCode, body: response.body });
      await app.close();
    }

    expect(responses[0]?.status).toBe(202);
    expect(new Set(responses.map(r => r.status)).size).toBe(1);
    expect(new Set(responses.map(r => r.body)).size).toBe(1);
  });

  it("rotates ONLY for an eligible unverified account", async () => {
    const unverified = await build({ resendReason: "rotated" });
    await post(unverified.app, "/auth/resend-verification", { email: "user@example.com" });
    expect(unverified.rotations).toEqual(["created"]);
    await unverified.app.close();

    for (const reason of ["unknown-account", "already-verified"] as const) {
      const { app, rotations } = await build({ resendReason: reason });
      await post(app, "/auth/resend-verification", { email: "user@example.com" });
      // No challenge, and therefore no email.
      expect(rotations).toHaveLength(0);
      await app.close();
    }
  });

  it("never claims an email was sent", async () => {
    // Delivery is asynchronous and, with no notification infrastructure, does
    // not happen at all. `accepted` says what LAGDA did, not what it promises.
    const { app } = await build({ resendReason: "rotated" });
    const body = (await post(app, "/auth/resend-verification",
      { email: "user@example.com" })).body;

    expect(JSON.parse(body)).toEqual({ accepted: true });
    expect(body).not.toMatch(/sent|delivered|inbox/i);
    await app.close();
  });

  it("returns no code and no account data", async () => {
    const { app } = await build({ resendReason: "rotated" });
    const body = (await post(app, "/auth/resend-verification",
      { email: "user@example.com" })).body;

    expect(body).not.toContain(CODE);
    expect(body).not.toContain("usr_1");
    expect(body).not.toContain("user@example.com");
    await app.close();
  });

  it("rejects unknown fields", async () => {
    const { app } = await build({ resendReason: "rotated" });
    for (const extra of [
      { isAdmin: true }, { challengeId: "evc_x" }, { userId: "usr_x" },
    ]) {
      expect((await post(app, "/auth/resend-verification",
        { email: "user@example.com", ...extra })).statusCode).toBe(400);
    }
    await app.close();
  });

  it("declares a CLOSED response schema", () => {
    const schema = ResendVerificationResponseSchema as unknown as {
      additionalProperties?: boolean; properties: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(["accepted"]);
  });

  it("keeps the code out of logs", async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: { level: "trace", stream: { write: (c: string) => { lines.push(c); } } },
      ajv: { customOptions: { removeAdditional: false } },
    });
    const built = await build({ resendReason: "rotated" });
    await built.app.close();

    registerVerificationRoutes(app, {
      verifyPath: "/auth/verify-email",
      resendPath: "/auth/resend-verification",
      verifyDependencies: () => ({
        digestSubmitted: () => "a".repeat(64) as VerificationTokenDigest,
        clock: { now: () => 0 },
        commit: operation => operation({
          challenges: {
            findByTokenDigest: () => Promise.resolve(null),
            consumeIfActive: () => Promise.resolve(false),
            supersedeActiveForUser: () => Promise.resolve(0),
            create: () => Promise.resolve(),
          },
          users: {
            findById: () => Promise.resolve(null),
            findByNormalizedEmail: () => Promise.resolve(null),
            markEmailVerifiedIfUnverified: () => Promise.resolve(false),
          },
        }),
      }),
      resendDependencies: () => ({
        tokens: {
          issue: () => ({
            raw: "MARK-ERCO-DE99", digest: "c".repeat(64) as VerificationTokenDigest,
          }),
        },
        clock: { now: () => 0 },
        newChallengeId: () => "evc_3" as VerificationChallengeId,
        verificationTtlMs: 1000,
        commit: operation => operation({
          challenges: {
            findByTokenDigest: () => Promise.resolve(null),
            consumeIfActive: () => Promise.resolve(false),
            supersedeActiveForUser: () => Promise.resolve(0),
            create: () => Promise.resolve(),
          },
          users: {
            findById: () => Promise.resolve(null),
            findByNormalizedEmail: () => Promise.resolve({
              userId: "usr_1" as UserId, email: "user@example.com",
              displayName: "U", emailVerifiedAt: null, createdAt: 0,
            }),
            markEmailVerifiedIfUnverified: () => Promise.resolve(false),
          },
        }),
      }),
    });
    await app.ready();

    await post(app, "/auth/verify-email", { code: "MARK-ERCO-DE99" });
    await post(app, "/auth/resend-verification", { email: "user@example.com" });

    const captured = lines.join("\n");
    // Neither the submitted code nor the newly issued one reaches a log line.
    expect(captured).not.toContain("MARK-ERCO-DE99");
    expect(captured).not.toContain("MARKERCODE99");
    await app.close();
  });
});
