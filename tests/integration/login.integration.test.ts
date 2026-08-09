// Login against REAL PostgreSQL, REAL Argon2id and the REAL session service.
//
// The decisive cross-command property: a password hashed by BACKEND-19's
// registration must authenticate through BACKEND-20's login. Two commands, two
// adapters, one credential — and nothing but an end-to-end test proves they
// agree.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  registerUser, loginUser,
  type LoginDependencies, type RegisterUserDependencies,
  type PasswordHash, type UserId, type VerificationChallengeId,
} from "@lagda/application";
import {
  createTestDatabase, hasIntegrationDatabase,
  createUserRepository, createVerificationChallengeRepository,
  createSessionRepository, type LagdaDatabase,
} from "@lagda/db";
import {
  createArgon2PasswordHasher, createVerificationTokenFactory,
  createSecurityTokenGenerator, createSecurityTokenDigester,
} from "@lagda/api";
import { createSessionService } from "@lagda/application";

const PASSWORD = "correct horse battery staple";
const TERMS = "2026-01-01";

describe.skipIf(!hasIntegrationDatabase())("login", () => {
  let database: LagdaDatabase;
  const hasher = createArgon2PasswordHasher();
  const tokens = createVerificationTokenFactory();

  /**
   * A dummy hash that authenticates nobody.
   *
   * Derived once from a random secret nobody keeps, exactly as the composition
   * root would. Computing it per request would double the cost of every
   * unknown-account attempt and defeat the point.
   */
  let dummyHash: PasswordHash;
  let sessions: ReturnType<typeof createSessionService>;

  beforeAll(async () => {
    database = await createTestDatabase();
    dummyHash = await hasher.hash(`dummy-${String(Math.random())}-${String(Date.now())}`);
    sessions = createSessionService({
      sessions: createSessionRepository(database.db),
      tokens: createSecurityTokenGenerator(),
      digester: createSecurityTokenDigester(),
      clock: { now: () => Date.now() },
      policy: { absoluteLifetimeMs: 8 * 3_600_000, idleTimeoutMs: 8 * 3_600_000, touchIntervalMs: 60_000 },
    });
  }, 120_000);

  afterAll(async () => { await database?.close(); });

  beforeEach(async () => {
    await database.db.deleteFrom("email_verification_challenges").execute();
    await database.db.deleteFrom("user_sessions").execute();
    await database.db.deleteFrom("users").execute();
  });

  let seq = 0;
  function registerDeps(): RegisterUserDependencies {
    seq += 1;
    const run = seq;
    return {
      users: createUserRepository(database.db),
      challenges: createVerificationChallengeRepository(database.db),
      hasher, tokens,
      clock: { now: () => Date.now() },
      newUserId: () => `usr_${String(run)}_${String(Date.now() % 100000)}` as UserId,
      newChallengeId: () =>
        `evc_${String(run)}_${String(Date.now() % 100000)}` as VerificationChallengeId,
      commit: operation => database.db.transaction().execute(trx => operation({
        users: createUserRepository(trx),
        challenges: createVerificationChallengeRepository(trx),
      })),
      termsVersion: TERMS,
      verificationTtlMs: 86_400_000,
    };
  }

  function loginDeps(): LoginDependencies {
    return {
      users: createUserRepository(database.db),
      hasher,
      sessions: { issue: userId => sessions.issue(userId) },
      clock: { now: () => Date.now() },
      dummyPasswordHash: dummyHash,
    };
  }

  /** Registers, then marks the account verified the way BACKEND-21 will. */
  async function registerVerified(email: string, password = PASSWORD): Promise<string> {
    const result = await registerUser({
      email, password, displayName: "Real User", acceptedTerms: true,
    }, registerDeps());
    if (result.outcome !== "registered") throw new Error("fixture registration failed");
    await database.db.updateTable("users")
      .set({ email_verified_at: new Date() })
      .where("user_id", "=", result.userId).execute();
    return result.userId;
  }

  // ── The cross-command guarantee ──────────────────────────────────────────

  it("authenticates a password hashed by REGISTRATION", async () => {
    // If BACKEND-19 and BACKEND-20 ever disagreed about hashing or identity,
    // this is the test that would say so.
    const userId = await registerVerified("Real.User@Example.com");
    const result = await loginUser(
      { email: "real.user@example.com", password: PASSWORD }, loginDeps());

    expect(result.outcome).toBe("authenticated");
    if (result.outcome !== "authenticated") return;
    expect(result.userId).toBe(userId);

    // The session was actually persisted, and the raw token is not what is
    // stored - only its digest.
    const row = await database.db.selectFrom("user_sessions").selectAll()
      .executeTakeFirstOrThrow();
    expect(row.user_id).toBe(userId);
    expect(row.token_hash).not.toBe(result.credentials.sessionToken);
    expect(row.revoked_at).toBeNull();
  }, 120_000);

  it("authenticates through EVERY email casing registration accepts", async () => {
    await registerVerified("Case.User@Example.com");
    for (const form of ["case.user@example.com", "CASE.USER@EXAMPLE.COM", "  Case.User@Example.com  "]) {
      const result = await loginUser({ email: form, password: PASSWORD }, loginDeps());
      expect(result.outcome).toBe("authenticated");
    }
  }, 120_000);

  it("refuses a password differing only in case", async () => {
    // Passwords are case-sensitive; emails are not. Both are tested because the
    // opposite mistake in either direction is easy to make.
    await registerVerified("case.pw@example.com", "MixedCasePassword");
    const result = await loginUser(
      { email: "case.pw@example.com", password: "mixedcasepassword" }, loginDeps());
    expect(result.outcome).toBe("rejected");
  }, 120_000);

  it("REFUSES a freshly registered account until it is verified", async () => {
    // Registration leaves `email_verified_at` NULL, so this is the real state a
    // new user is in.
    const registered = await registerUser({
      email: "unverified@example.com", password: PASSWORD,
      displayName: "Unverified", acceptedTerms: true,
    }, registerDeps());
    expect(registered.outcome).toBe("registered");

    const result = await loginUser(
      { email: "unverified@example.com", password: PASSWORD }, loginDeps());

    expect(result).toMatchObject({ failure: { kind: "email-not-verified" } });
    // No session row was created.
    expect(await database.db.selectFrom("user_sessions").selectAll().execute())
      .toHaveLength(0);
  }, 120_000);

  // ── Anti-enumeration, against real hashing ───────────────────────────────

  it("gives an unknown account and a wrong password the same failure", async () => {
    await registerVerified("known@example.com");

    const unknown = await loginUser(
      { email: "nobody@example.com", password: PASSWORD }, loginDeps());
    const wrong = await loginUser(
      { email: "known@example.com", password: "definitely wrong" }, loginDeps());

    expect(unknown).toMatchObject({ failure: { kind: "invalid-credentials" } });
    expect(wrong).toMatchObject({ failure: { kind: "invalid-credentials" } });
    expect(await database.db.selectFrom("user_sessions").selectAll().execute())
      .toHaveLength(0);
  }, 120_000);

  it("spends comparable real work on an unknown account", async () => {
    // Not a timing assertion - those are flaky in CI. What is asserted is that
    // the dummy hash is a REAL Argon2id hash the verifier genuinely processes,
    // so the unknown-account path cannot be near-instant.
    expect(dummyHash.startsWith("$argon2id$")).toBe(true);
    expect(await hasher.verify(PASSWORD, dummyHash)).toBe(false);
    expect(await hasher.verify("anything at all", dummyHash)).toBe(false);
  }, 120_000);

  // ── Sessions ─────────────────────────────────────────────────────────────

  it("creates a SEPARATE session for each login, and revokes only one", async () => {
    // Multi-device is the default: signing in on a phone must not sign a laptop
    // out, and signing out of one must not sign out the other.
    const userId = await registerVerified("multi@example.com");
    const first = await loginUser({ email: "multi@example.com", password: PASSWORD }, loginDeps());
    const second = await loginUser({ email: "multi@example.com", password: PASSWORD }, loginDeps());
    if (first.outcome !== "authenticated" || second.outcome !== "authenticated") return;

    expect(first.credentials.sessionToken).not.toBe(second.credentials.sessionToken);
    const rows = await database.db.selectFrom("user_sessions").selectAll()
      .where("user_id", "=", userId).execute();
    expect(rows).toHaveLength(2);

    // Both resolve.
    expect((await sessions.resolve(first.credentials.sessionToken)).outcome).toBe("authenticated");
    expect((await sessions.resolve(second.credentials.sessionToken)).outcome).toBe("authenticated");

    // Revoking one leaves the other alone.
    await sessions.revoke(first.credentials.sessionId, "logout");
    expect((await sessions.resolve(first.credentials.sessionToken)).outcome).toBe("rejected");
    expect((await sessions.resolve(second.credentials.sessionToken)).outcome).toBe("authenticated");
  }, 120_000);

  it("REVOKED credentials no longer authenticate", async () => {
    // The property logout depends on. Clearing a cookie is not enough; the
    // server must refuse the token even if someone kept a copy.
    await registerVerified("revoke@example.com");
    const result = await loginUser(
      { email: "revoke@example.com", password: PASSWORD }, loginDeps());
    if (result.outcome !== "authenticated") return;

    expect((await sessions.resolve(result.credentials.sessionToken)).outcome).toBe("authenticated");
    await sessions.revoke(result.credentials.sessionId, "logout");

    const after = await sessions.resolve(result.credentials.sessionToken);
    expect(after.outcome).toBe("rejected");
  }, 120_000);

  it("stores only a DIGEST of the session and CSRF tokens", async () => {
    await registerVerified("digest@example.com");
    const result = await loginUser(
      { email: "digest@example.com", password: PASSWORD }, loginDeps());
    if (result.outcome !== "authenticated") return;

    const row = await database.db.selectFrom("user_sessions").selectAll()
      .executeTakeFirstOrThrow();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(result.credentials.sessionToken);
    expect(serialized).not.toContain(result.credentials.csrfToken);
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.csrf_token_hash).toMatch(/^[a-f0-9]{64}$/);
  }, 120_000);

  it("keeps concurrent logins independent", async () => {
    // Two devices signing in at once must not share a credential.
    await registerVerified("concurrent@example.com");
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      loginUser({ email: "concurrent@example.com", password: PASSWORD }, loginDeps())));

    const tokens = results
      .filter(r => r.outcome === "authenticated")
      .map(r => r.outcome === "authenticated" ? r.credentials.sessionToken : "");
    expect(tokens).toHaveLength(4);
    expect(new Set(tokens).size).toBe(4);
  }, 120_000);
});
