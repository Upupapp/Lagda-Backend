// Registration against REAL PostgreSQL and REAL Argon2id.
//
// The two things that cannot be proven with fakes:
//
//   * the unique constraint actually stops two simultaneous registrations;
//   * the stored hash is genuinely Argon2id with the parameters LAGDA chose.
//
// Composed here because it wires the application use case to the database and
// the hashing adapter, which is the composition root's job.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  registerUser, normalizeEmail, EmailAlreadyRegisteredError,
  type RegisterUserDependencies, type UserId, type VerificationChallengeId,
  type PasswordHash,
} from "@lagda/application";
import {
  createTestDatabase, hasIntegrationDatabase,
  createUserRepository, createVerificationChallengeRepository,
  type LagdaDatabase,
} from "@lagda/db";
import {
  createArgon2PasswordHasher, describeHash, ARGON2_PARAMETERS,
  PasswordHasherConfigError,
} from "@lagda/api";
import { createVerificationTokenFactory, buildVerificationUrl } from "@lagda/api";
import { truncateAccounts } from "@lagda/db";

const PASSWORD = "correct horse battery staple";
const TERMS = "2026-01-01";
const TTL = 24 * 60 * 60 * 1000;

describe.skipIf(!hasIntegrationDatabase())("registration", () => {
  let database: LagdaDatabase;
  const hasher = createArgon2PasswordHasher();
  const tokens = createVerificationTokenFactory();

  beforeAll(async () => { database = await createTestDatabase(); }, 60_000);
  afterAll(async () => { await database?.close(); });

  beforeEach(async () => {
    await truncateAccounts(database);
  });

  let seq = 0;
  function deps(): RegisterUserDependencies {
    seq += 1;
    const run = seq;
    return {
      users: createUserRepository(database.db),
      challenges: createVerificationChallengeRepository(database.db),
      hasher,
      tokens,
      clock: { now: () => Date.now() },
      newUserId: () => `usr_${String(run)}_${String(Date.now() % 100000)}` as UserId,
      newChallengeId: () =>
        `evc_${String(run)}_${String(Date.now() % 100000)}` as VerificationChallengeId,
      // One transaction for the user and the challenge together.
      commit: operation => database.db.transaction().execute(trx => operation({
        users: createUserRepository(trx),
        challenges: createVerificationChallengeRepository(trx),
      })),
      termsVersion: TERMS,
      verificationTtlMs: TTL,
    };
  }

  const register = (email: string, password = PASSWORD) => registerUser({
    email, password, displayName: "New User",
    organization: "Mabini Legal", intendedUse: "legal-professional",
    acceptedTerms: true,
  }, deps());

  // ── The account ──────────────────────────────────────────────────────────

  it("creates an unverified account with an Argon2id hash", async () => {
    const result = await register("New.User@Example.com");
    expect(result.outcome).toBe("registered");

    const row = await database.db.selectFrom("users").selectAll().executeTakeFirstOrThrow();
    expect(row.normalized_email).toBe("new.user@example.com");
    expect(row.email).toBe("New.User@Example.com");
    // NEVER verified by registration alone.
    expect(row.email_verified_at).toBeNull();
    expect(row.terms_version).toBe(TERMS);

    // The stored credential is genuinely Argon2id with LAGDA's parameters -
    // parsed from the PHC string rather than taken on trust from the library.
    const described = describeHash(row.password_hash);
    expect(described?.algorithm).toBe("argon2id");
    expect(described?.memoryCost).toBe(ARGON2_PARAMETERS.memoryCost);
    expect(described?.timeCost).toBe(ARGON2_PARAMETERS.timeCost);
  }, 60_000);

  it("stores NO plaintext password anywhere in the row", async () => {
    const marker = "DO_NOT_LOG_REGISTRATION_PASSWORD";
    await register("plain@example.com", marker);

    // Every column, serialized. The password must appear in none of them.
    const rows = await database.db.selectFrom("users").selectAll().execute();
    expect(JSON.stringify(rows)).not.toContain(marker);
    // And the hash is not the password with extra characters around it.
    expect(rows[0]?.password_hash).not.toContain(marker);
  }, 60_000);

  it("verifies the stored hash, and rejects a wrong password", async () => {
    await register("verify@example.com");
    const row = await database.db.selectFrom("users").selectAll().executeTakeFirstOrThrow();

    expect(await hasher.verify(PASSWORD, row.password_hash as PasswordHash)).toBe(true);
    expect(await hasher.verify("wrong password entirely", row.password_hash as PasswordHash))
      .toBe(false);
  }, 60_000);

  it("produces a DIFFERENT hash for the same password each time", async () => {
    // Per-hash random salt. Identical hashes would mean two users with the same
    // password are visibly identical in the database.
    const a = await hasher.hash(PASSWORD);
    const b = await hasher.hash(PASSWORD);
    expect(a).not.toBe(b);
    expect(await hasher.verify(PASSWORD, a)).toBe(true);
    expect(await hasher.verify(PASSWORD, b)).toBe(true);
  }, 60_000);

  // ── Duplicates ───────────────────────────────────────────────────────────

  it("treats a case variant as the SAME account", async () => {
    await register("User@Example.com");
    const second = await register("user@example.com");

    expect(second).toMatchObject({
      outcome: "rejected", failure: { kind: "email-already-registered" },
    });
    const count = await database.db.selectFrom("users").selectAll().execute();
    expect(count).toHaveLength(1);
  }, 60_000);

  it("SIMULTANEOUS registrations create exactly ONE user", async () => {
    // The property an application pre-check cannot provide: both attempts pass
    // the lookup, and only the unique constraint decides. Run through
    // independent transactions, which is what two API requests are.
    const email = "race@example.com";
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => register(email)));

    const registered = results.filter(r =>
      r.status === "fulfilled" && r.value.outcome === "registered");
    const duplicates = results.filter(r =>
      r.status === "fulfilled" && r.value.outcome === "rejected");

    expect(registered).toHaveLength(1);
    expect(duplicates.length + registered.length).toBe(6);

    const rows = await database.db.selectFrom("users").selectAll()
      .where("normalized_email", "=", email).execute();
    expect(rows).toHaveLength(1);
  }, 120_000);

  it("NEVER overwrites an existing account's password", async () => {
    // Account takeover. A second registration for the same address must leave
    // the original credential untouched.
    await register("victim@example.com", "original password here");
    const before = await database.db.selectFrom("users").selectAll().executeTakeFirstOrThrow();

    const second = await register("victim@example.com", "attacker password here");
    expect(second).toMatchObject({ failure: { kind: "email-already-registered" } });

    const after = await database.db.selectFrom("users").selectAll().executeTakeFirstOrThrow();
    expect(after.password_hash).toBe(before.password_hash);
    // The original password still works; the attacker's does not.
    expect(await hasher.verify("original password here", after.password_hash as PasswordHash))
      .toBe(true);
    expect(await hasher.verify("attacker password here", after.password_hash as PasswordHash))
      .toBe(false);
  }, 90_000);

  it("raises the application error, never a raw PostgreSQL constraint error", async () => {
    await register("dup@example.com");
    const repository = createUserRepository(database.db);
    const email = normalizeEmail("dup@example.com");
    if (email.outcome !== "ok") throw new Error("fixture");

    await expect(repository.create({
      userId: "usr_dup" as UserId,
      normalizedEmail: email.normalized,
      email: "dup@example.com",
      passwordHash: await hasher.hash(PASSWORD),
      displayName: "Dup", organization: null, intendedUse: null,
      termsVersion: TERMS, termsAcceptedAt: Date.now(), createdAt: Date.now(),
    })).rejects.toBeInstanceOf(EmailAlreadyRegisteredError);
  }, 60_000);

  // ── Verification challenge ───────────────────────────────────────────────

  it("stores a token DIGEST, never the raw token", async () => {
    const result = await register("challenge@example.com");
    expect(result.outcome).toBe("registered");
    if (result.outcome !== "registered") return;

    const row = await database.db.selectFrom("email_verification_challenges")
      .selectAll().executeTakeFirstOrThrow();

    expect(row.token_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(row.token_digest).not.toBe(result.verificationToken);
    // The raw token appears nowhere in the stored row.
    expect(JSON.stringify(row)).not.toContain(result.verificationToken);
    // Not yet consumed - only BACKEND-21 does that.
    expect(row.consumed_at).toBeNull();
    // Expiry is set and in the future.
    expect(row.expires_at.getTime()).toBeGreaterThan(row.created_at.getTime());
  }, 60_000);

  it("issues unpredictable tokens with distinct digests", () => {
    const issued = Array.from({ length: 20 }, () => tokens.issue());
    expect(new Set(issued.map(t => t.raw)).size).toBe(20);
    expect(new Set(issued.map(t => t.digest)).size).toBe(20);
    // BACKEND-21 changed the credential from a 43-character link token to a
    // 12-character Crockford base32 code the user TYPES, because that is what
    // the real verification page collects. Grouped as XXXX-XXXX-XXXX.
    expect(issued[0]?.raw).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it("builds the verification URL from CONFIGURATION, not a Host header", () => {
    const { raw } = tokens.issue();
    const url = buildVerificationUrl("https://app.lagda.example/", raw);
    // `code`, not `token` - the parameter name follows the credential.
    expect(url.startsWith("https://app.lagda.example/verify-email?code=")).toBe(true);
    // The token is URL-encoded, so a token containing reserved characters
    // cannot alter the query string.
    expect(url).toContain(encodeURIComponent(raw));
  });

  it("rolls back BOTH writes when the challenge insert fails", async () => {
    // A user with no challenge could never verify their email.
    const base = deps();
    await expect(registerUser({
      email: "rollback@example.com", password: PASSWORD, displayName: "R",
      acceptedTerms: true,
    }, {
      ...base,
      commit: operation => database.db.transaction().execute(async (trx) => {
        await operation({
          users: createUserRepository(trx),
          challenges: {
            create: () => Promise.reject(new Error("challenge insert failed")),
          },
        });
      }),
    })).rejects.toThrow("challenge insert failed");

    const users = await database.db.selectFrom("users").selectAll()
      .where("normalized_email", "=", "rollback@example.com").execute();
    expect(users).toHaveLength(0);
  }, 60_000);

  // ── Configuration floors ─────────────────────────────────────────────────

  it("REFUSES Argon2 parameters weaker than policy", () => {
    // Configuration that could set memoryCost: 8 would look like it was hashing
    // passwords while providing almost none of the protection.
    expect(() => createArgon2PasswordHasher({ memoryCost: 1024 }))
      .toThrow(PasswordHasherConfigError);
    expect(() => createArgon2PasswordHasher({ timeCost: 1 }))
      .toThrow(PasswordHasherConfigError);
    // The declared parameters are accepted.
    expect(createArgon2PasswordHasher(ARGON2_PARAMETERS)).toBeDefined();
  });

  it("flags a hash made with weaker parameters for rehashing", async () => {
    // BACKEND-20 can upgrade a hash on successful login, when the plaintext is
    // briefly available again.
    const weak = createArgon2PasswordHasher({ memoryCost: 19_456, timeCost: 2 });
    const current = createArgon2PasswordHasher({ memoryCost: 65_536, timeCost: 3 });
    const oldHash = await weak.hash(PASSWORD);

    expect(current.needsRehash(oldHash)).toBe(true);
    expect(weak.needsRehash(oldHash)).toBe(false);
    // And the old hash still verifies, so raising parameters is not a breaking
    // change for existing accounts.
    expect(await current.verify(PASSWORD, oldHash)).toBe(true);
  }, 90_000);

  it("returns false rather than throwing for a corrupt stored hash", async () => {
    expect(await hasher.verify(PASSWORD, "not-a-hash" as PasswordHash)).toBe(false);
  });

  // ── The session foreign key ──────────────────────────────────────────────

  it("lets a session reference a real account, and refuses an unknown one", async () => {
    // Migration 004 anticipated this FK; 008 adds it.
    await register("session@example.com");
    const user = await database.db.selectFrom("users").selectAll().executeTakeFirstOrThrow();

    await expect(database.db.insertInto("user_sessions").values({
      session_id: "ses_ok", user_id: user.user_id,
      token_hash: "b".repeat(64), csrf_token_hash: "c".repeat(64),
      created_at: new Date(), last_seen_at: new Date(),
      expires_at: new Date(Date.now() + 3_600_000), revoked_at: null,
    }).execute()).resolves.toBeDefined();

    await expect(database.db.insertInto("user_sessions").values({
      session_id: "ses_bad", user_id: "usr_does_not_exist",
      token_hash: "d".repeat(64), csrf_token_hash: "e".repeat(64),
      created_at: new Date(), last_seen_at: new Date(),
      expires_at: new Date(Date.now() + 3_600_000), revoked_at: null,
    }).execute()).rejects.toThrow();
  }, 60_000);

  it("refuses a stored credential that is not Argon2id", async () => {
    // A database CHECK, so a bug that wrote a plaintext password or a weaker
    // hash is refused by PostgreSQL rather than discovered at login.
    const email = normalizeEmail("checkconstraint@example.com");
    if (email.outcome !== "ok") throw new Error("fixture");
    await expect(database.db.insertInto("users").values({
      user_id: "usr_bad_hash", email: "checkconstraint@example.com",
      normalized_email: email.normalized,
      password_hash: "plaintext-password",
      display_name: "Bad", organization: null, intended_use: null,
      email_verified_at: null, terms_version: TERMS,
      terms_accepted_at: new Date(), created_at: new Date(),
    }).execute()).rejects.toThrow();
  }, 60_000);
});

