// POST /auth/register.
//
// The route's job is validation, mapping and ordering. The pipeline itself is
// tested elsewhere; what is asserted here is what the route refuses, what it
// never returns, and what it never causes to happen.

import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type {
  NewUser, PasswordHash, RegisterUserDependencies, UserId,
  VerificationChallengeId, VerificationTokenDigest,
} from "@lagda/application";
import { registerAuthRoutes, RegisterResponseSchema } from "./register-route.js";

const VALID_BODY = {
  email: "New.User@Example.com",
  password: "correct horse battery staple",
  name: "New User",
  organization: "Mabini Legal",
  intendedUse: "legal-professional",
  consent: true,
};

interface Built {
  readonly app: FastifyInstance;
  readonly hashCalls: string[];
  readonly created: NewUser[];
  readonly delivered: { email: string; rawToken: string }[];
}

async function build(options: {
  existing?: boolean;
  rateLimited?: boolean;
  withDelivery?: boolean;
} = {}): Promise<Built> {
  // The SAME ajv configuration production uses. Fastify's default strips
  // unknown properties instead of rejecting them, so a bare instance would test
  // different behaviour than the app actually has.
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true, allErrors: true } },
  });
  const hashCalls: string[] = [];
  const created: NewUser[] = [];
  const delivered: { email: string; rawToken: string }[] = [];

  // Stands in for the real rate-limit plugin: an onRequest hook, which is what
  // makes it run before the handler and therefore before any hashing.
  if (options.rateLimited === true) {
    app.addHook("onRequest", (_request, reply, done) => {
      void reply.status(429).send({
        error: { code: "RATE_LIMITED", message: "Too many registration attempts." },
      });
      done();
    });
  }

  const users = {
    create(user: NewUser) { created.push(user); return Promise.resolve(); },
    findByNormalizedEmail: () => Promise.resolve(
      options.existing === true
        ? {
          userId: "usr_existing" as UserId, email: "x@y.com", displayName: "X",
          emailVerifiedAt: null, createdAt: 0,
        }
        : null),
    findAuthByNormalizedEmail: () => Promise.resolve(null),
  };
  const challenges = { create: () => Promise.resolve() };

  const dependencies = (): RegisterUserDependencies => ({
    users, challenges,
    hasher: {
      hash(plaintext: string) {
        hashCalls.push(plaintext);
        return Promise.resolve(
          "$argon2id$v=19$m=19456,p=1,t=2$c2FsdA$aGFzaA" as PasswordHash);
      },
      verify: () => Promise.resolve(false),
      needsRehash: () => false,
    },
    tokens: {
      issue: () => ({
        raw: "RAW_VERIFICATION_TOKEN", digest: "a".repeat(64) as VerificationTokenDigest,
      }),
    },
    clock: { now: () => 1_700_000_000_000 },
    newUserId: () => "usr_1" as UserId,
    newChallengeId: () => "evc_1" as VerificationChallengeId,
    commit: operation => operation({ users, challenges }),
    termsVersion: "2026-01-01",
    verificationTtlMs: 86_400_000,
  });

  registerAuthRoutes(app, {
    path: "/auth/register",
    dependencies,
    ...(options.withDelivery === true
      ? {
        deliverVerification: (input) => {
          delivered.push({ email: input.email, rawToken: input.rawToken });
          return Promise.resolve();
        },
      }
      : {}),
  });
  await app.ready();
  return { app, hashCalls, created, delivered };
}

/** Minimal dependencies for a route registered outside `build()`. */
function deps(created: NewUser[]): RegisterUserDependencies {
  const users = {
    create(user: NewUser) { created.push(user); return Promise.resolve(); },
    findByNormalizedEmail: () => Promise.resolve(null),
    findAuthByNormalizedEmail: () => Promise.resolve(null),
  };
  const challenges = { create: () => Promise.resolve() };
  return {
    users, challenges,
    hasher: {
      hash: () => Promise.resolve(
        "$argon2id$v=19$m=19456,p=1,t=2$c2FsdA$aGFzaA" as PasswordHash),
      verify: () => Promise.resolve(false),
      needsRehash: () => false,
    },
    tokens: {
      issue: () => ({ raw: "RAW", digest: "a".repeat(64) as VerificationTokenDigest }),
    },
    clock: { now: () => 0 },
    newUserId: () => "usr_1" as UserId,
    newChallengeId: () => "evc_1" as VerificationChallengeId,
    commit: operation => operation({ users, challenges }),
    termsVersion: "2026-01-01",
    verificationTtlMs: 86_400_000,
  };
}

const post = (app: FastifyInstance, payload: unknown) =>
  app.inject({ method: "POST", url: "/auth/register", payload: payload as object });

describe("POST /auth/register", () => {
  it("registers and returns only safe fields", async () => {
    const { app } = await build();
    const response = await post(app, VALID_BODY);

    expect(response.statusCode).toBe(201);
    const body = response.json<Record<string, unknown>>();
    expect(body).toEqual({
      userId: "usr_1",
      email: "New.User@Example.com",
      emailVerified: false,
      nextAction: "verify-email",
    });

    // Nothing internal escapes: no hash, no normalized email, no token, no
    // digest, no session credential.
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      "argon2", "passwordHash", "password_hash", "normalizedEmail",
      "new.user@example.com", "RAW_VERIFICATION_TOKEN", "verificationToken",
      "tokenDigest", "sessionToken",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    await app.close();
  });

  it("creates NO SESSION — registration does not log a user in", async () => {
    // Measured from the real frontend: CreateAccount.tsx navigates to
    // /verify-email and marks the user email-verification-required. A session
    // here would authenticate an unverified mailbox.
    const { app } = await build();
    const response = await post(app, VALID_BODY);

    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(JSON.stringify(response.json())).not.toContain("csrf");
    await app.close();
  });

  it("REJECTS unknown fields rather than ignoring them", async () => {
    // Mass assignment. Ignoring them works until someone spreads the DTO.
    const { app, created } = await build();
    for (const extra of [
      { role: "admin" }, { isAdmin: true }, { emailVerified: true },
      { userId: "usr_attacker" }, { createdAt: 0 }, { accountStatus: "active" },
    ]) {
      const response = await post(app, { ...VALID_BODY, ...extra });
      expect(response.statusCode).toBe(400);
    }
    expect(created).toHaveLength(0);
    await app.close();
  });

  it("requires consent to be exactly true", async () => {
    const { app, hashCalls } = await build();
    expect((await post(app, { ...VALID_BODY, consent: false })).statusCode).toBe(400);
    const { consent: _omitted, ...withoutConsent } = VALID_BODY;
    expect((await post(app, withoutConsent)).statusCode).toBe(400);
    // Neither attempt reached the hasher.
    expect(hashCalls).toHaveLength(0);
    await app.close();
  });

  it("rejects a malformed email and a short password before hashing", async () => {
    const { app, hashCalls } = await build();
    expect((await post(app, { ...VALID_BODY, email: "not-an-email" })).statusCode).toBe(422);
    expect((await post(app, { ...VALID_BODY, password: "short" })).statusCode).toBe(400);
    expect(hashCalls).toHaveLength(0);
    await app.close();
  });

  it("returns 409 for an email that is already registered", async () => {
    // A deliberate decision: at signup the user has already asserted this
    // address is theirs, so saying an account exists reveals nothing they did
    // not just claim - and hiding it produces a "successful" registration that
    // can never be logged into. Login and password reset make their OWN
    // anti-enumeration decisions.
    const { app } = await build({ existing: true });
    const response = await post(app, VALID_BODY);

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code)
      .toBe("EMAIL_ALREADY_REGISTERED");
    await app.close();
  });

  it("RATE LIMITS before spending any Argon2 work", async () => {
    // The ordering that keeps a memory-hard hash from becoming an
    // unauthenticated DoS primitive. Asserted by observing that the hasher was
    // never called, not by reading the code.
    const { app, hashCalls, created } = await build({ rateLimited: true });
    const response = await post(app, VALID_BODY);

    expect(response.statusCode).toBe(429);
    expect(hashCalls).toHaveLength(0);
    expect(created).toHaveLength(0);
    await app.close();
  });

  it("never claims an email was sent when no delivery exists", async () => {
    // The response says what to do next, not what LAGDA did. With no
    // notification infrastructure, "verificationEmailSent: true" would be false.
    const { app, delivered } = await build();
    const body = (await post(app, VALID_BODY)).json<Record<string, unknown>>();

    expect(delivered).toHaveLength(0);
    expect(Object.keys(body)).not.toContain("verificationEmailSent");
    expect(JSON.stringify(body)).not.toMatch(/sent|email has been/i);
    expect(body["nextAction"]).toBe("verify-email");
    await app.close();
  });

  it("hands the raw token ONLY to a delivery component, never to the client", async () => {
    const { app, delivered } = await build({ withDelivery: true });
    const response = await post(app, VALID_BODY);

    expect(delivered).toEqual([
      { email: "New.User@Example.com", rawToken: "RAW_VERIFICATION_TOKEN" },
    ]);
    expect(response.body).not.toContain("RAW_VERIFICATION_TOKEN");
    await app.close();
  });

  it("keeps the password out of logs and out of the response", async () => {
    const marker = "DO_NOT_LOG_REGISTRATION_PASSWORD";
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        level: "trace",
        // Capture everything the logger emits, including request logging.
        stream: { write: (chunk: string) => { lines.push(chunk); } },
      },
    });

    const hashCalls: string[] = [];
    registerAuthRoutes(app, {
      path: "/auth/register",
      dependencies: () => ({
        users: {
          create: () => Promise.resolve(),
          findByNormalizedEmail: () => Promise.resolve(null),
          findAuthByNormalizedEmail: () => Promise.resolve(null),
        },
        challenges: { create: () => Promise.resolve() },
        hasher: {
          hash(plaintext: string) {
            hashCalls.push(plaintext);
            return Promise.resolve(
              "$argon2id$v=19$m=19456,p=1,t=2$c2FsdA$aGFzaA" as PasswordHash);
          },
          verify: () => Promise.resolve(false),
          needsRehash: () => false,
        },
        tokens: {
          issue: () => ({
            raw: "RAW_VERIFICATION_TOKEN",
            digest: "a".repeat(64) as VerificationTokenDigest,
          }),
        },
        clock: { now: () => 0 },
        newUserId: () => "usr_1" as UserId,
        newChallengeId: () => "evc_1" as VerificationChallengeId,
        commit: operation => operation({
          users: {
            create: () => Promise.resolve(),
            findByNormalizedEmail: () => Promise.resolve(null),
            findAuthByNormalizedEmail: () => Promise.resolve(null),
          },
          challenges: { create: () => Promise.resolve() },
        }),
        termsVersion: "2026-01-01",
        verificationTtlMs: 86_400_000,
      }),
    });
    await app.ready();

    const response = await post(app, { ...VALID_BODY, password: marker });
    expect(response.statusCode).toBe(201);
    // It reached the hasher, and nothing else.
    expect(hashCalls).toEqual([marker]);

    const captured = lines.join("\n");
    expect(captured).not.toContain(marker);
    // Nor did the verification token.
    expect(captured).not.toContain("RAW_VERIFICATION_TOKEN");
    expect(response.body).not.toContain(marker);
    await app.close();
  });

  it("bounds an absurdly long password at the schema, before hashing", async () => {
    const { app, hashCalls } = await build();
    const response = await post(app, { ...VALID_BODY, password: "a".repeat(5000) });

    expect(response.statusCode).toBe(400);
    expect(hashCalls).toHaveLength(0);
    await app.close();
  });

  it("does not accept a body that is not an object", async () => {
    const { app } = await build();
    const response = await app.inject({
      method: "POST", url: "/auth/register",
      payload: "\"just a string\"",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("passes only mapped fields to the use case", async () => {
    // Explicit mapping, never a spread of the request body.
    const { app, created } = await build();
    await post(app, VALID_BODY);

    const written = created[0];
    expect(written?.displayName).toBe("New User");
    expect(written?.organization).toBe("Mabini Legal");
    expect(written?.intendedUse).toBe("legal-professional");
    expect(written?.userId).toBe("usr_1");
    await app.close();
  });

  it("MEASURES what a default-configured app does with unknown fields", async () => {
    // Fastify's default ajv strips them, so the schema rejects nothing and the
    // request succeeds. Recorded as a measured framework behaviour rather than
    // assumed: it is the reason `createApp` sets `removeAdditional: false`, and
    // the reason a handler-level guard cannot substitute - by the time the
    // handler runs the field is already gone.
    const app = Fastify({ logger: false });
    const created: NewUser[] = [];
    registerAuthRoutes(app, { path: "/auth/register", dependencies: () => deps(created) });
    await app.ready();

    const response = await post(app, { ...VALID_BODY, role: "admin" });
    expect(response.statusCode).toBe(201);
    // The field was STRIPPED, not honoured: nothing about it reached the user.
    expect(Object.keys(created[0] ?? {})).not.toContain("role");
    await app.close();
  });

  it("declares a CLOSED response schema", () => {
    // What actually stops a stray field reaching a client: Fastify serializes
    // the response THROUGH this schema, so an extra property added in the
    // handler is dropped. That makes a leak assertion unable to observe the
    // failure, which is why the schema itself is asserted.
    const schema = RegisterResponseSchema as unknown as {
      additionalProperties?: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort())
      .toEqual(["email", "emailVerified", "nextAction", "userId"]);
  });

  it("accepts a registration without the optional fields", async () => {
    const { app, created } = await build();
    const response = await post(app, {
      email: "minimal@example.com", password: "a valid password",
      name: "Minimal User", consent: true,
    });

    expect(response.statusCode).toBe(201);
    expect(created[0]?.organization).toBeNull();
    expect(created[0]?.intendedUse).toBeNull();
    await app.close();
  });
});
