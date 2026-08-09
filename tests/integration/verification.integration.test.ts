// Email verification against REAL PostgreSQL.
//
// Single-use, supersession and the two races are properties of the DATABASE,
// not of application logic — a conditional UPDATE and a partial unique index
// are what enforce them. Fakes cannot demonstrate either.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  registerUser, loginUser, verifyEmail, resendEmailVerification,
  type LoginDependencies, type RegisterUserDependencies,
  type ResendVerificationDependencies, type VerifyEmailDependencies,
  type PasswordHash, type UserId, type VerificationChallengeId,
} from "@lagda/application";
import {
  createTestDatabase, hasIntegrationDatabase, createUserRepository,
  createVerificationChallengeRepository, createVerificationRepository,
  createVerifiableUserRepository, createSessionRepository, type LagdaDatabase,
} from "@lagda/db";
import {
  createArgon2PasswordHasher, createVerificationTokenFactory,
  createSecurityTokenGenerator, createSecurityTokenDigester,
  digestSubmittedCode, canonicalizeVerificationCode, buildVerificationUrl,
} from "@lagda/api";
import { createSessionService } from "@lagda/application";

const PASSWORD = "correct horse battery staple";
const TTL = 24 * 60 * 60 * 1000;

describe.skipIf(!hasIntegrationDatabase())("email verification", () => {
  let database: LagdaDatabase;
  const hasher = createArgon2PasswordHasher();
  const tokens = createVerificationTokenFactory();
  let dummyHash: PasswordHash;
  let sessions: ReturnType<typeof createSessionService>;

  beforeAll(async () => {
    database = await createTestDatabase();
    dummyHash = await hasher.hash(`dummy-${String(Date.now())}`);
    sessions = createSessionService({
      sessions: createSessionRepository(database.db),
      tokens: createSecurityTokenGenerator(),
      digester: createSecurityTokenDigester(),
      clock: { now: () => Date.now() },
      policy: {
        absoluteLifetimeMs: 8 * 3_600_000,
        idleTimeoutMs: 8 * 3_600_000,
        touchIntervalMs: 60_000,
      },
    });
  }, 120_000);

  afterAll(async () => { await database?.close(); });

  beforeEach(async () => {
    await database.db.deleteFrom("email_verification_challenges").execute();
    await database.db.deleteFrom("user_sessions").execute();
    await database.db.deleteFrom("users").execute();
  });

  let seq = 0;
  let issuedCode = "";

  function registerDeps(): RegisterUserDependencies {
    seq += 1;
    const run = seq;
    return {
      users: createUserRepository(database.db),
      challenges: createVerificationChallengeRepository(database.db),
      hasher,
      tokens: {
        issue() {
          const issued = tokens.issue();
          issuedCode = issued.raw;
          return issued;
        },
      },
      clock: { now: () => Date.now() },
      newUserId: () => `usr_${String(run)}_${String(Date.now() % 100000)}` as UserId,
      newChallengeId: () =>
        `evc_${String(run)}_${String(Date.now() % 100000)}` as VerificationChallengeId,
      commit: operation => database.db.transaction().execute(trx => operation({
        users: createUserRepository(trx),
        challenges: createVerificationChallengeRepository(trx),
      })),
      termsVersion: "2026-01-01",
      verificationTtlMs: TTL,
    };
  }

  const verifyDeps = (): VerifyEmailDependencies => ({
    digestSubmitted: digestSubmittedCode,
    clock: { now: () => Date.now() },
    commit: operation => database.db.transaction().execute(trx => operation({
      challenges: createVerificationRepository(trx),
      users: createVerifiableUserRepository(trx),
    })),
  });

  function resendDeps(overrides: {
    failDelivery?: boolean;
    withDelivery?: boolean;
  } = {}): ResendVerificationDependencies {
    seq += 1;
    const run = seq;
    return {
      tokens: {
        issue() {
          const issued = tokens.issue();
          issuedCode = issued.raw;
          return issued;
        },
      },
      clock: { now: () => Date.now() },
      newChallengeId: () =>
        `evc_r${String(run)}_${String(Date.now() % 100000)}` as VerificationChallengeId,
      verificationTtlMs: TTL,
      commit: operation => database.db.transaction().execute(trx => operation({
        challenges: createVerificationRepository(trx),
        users: createVerifiableUserRepository(trx),
      })),
      ...(overrides.withDelivery === true || overrides.failDelivery === true
        ? {
          scheduleDelivery: () => overrides.failDelivery === true
            ? Promise.reject(new Error("queue down"))
            : Promise.resolve(),
        }
        : {}),
    };
  }

  async function register(email: string): Promise<{ userId: UserId; code: string }> {
    const result = await registerUser({
      email, password: PASSWORD, displayName: "New User", acceptedTerms: true,
    }, registerDeps());
    if (result.outcome !== "registered") throw new Error("fixture failed");
    return { userId: result.userId, code: issuedCode };
  }

  const verifiedAt = async (userId: UserId): Promise<Date | null> => {
    const row = await database.db.selectFrom("users").select("email_verified_at")
      .where("user_id", "=", userId).executeTakeFirstOrThrow();
    return row.email_verified_at;
  };

  // ── Register → verify ────────────────────────────────────────────────────

  it("verifies a freshly registered account and consumes the challenge", async () => {
    const { userId, code } = await register("verify@example.com");
    expect(await verifiedAt(userId)).toBeNull();

    const result = await verifyEmail(code, verifyDeps());
    expect(result).toMatchObject({ outcome: "verified", userId });
    expect(await verifiedAt(userId)).not.toBeNull();

    const challenge = await database.db.selectFrom("email_verification_challenges")
      .selectAll().executeTakeFirstOrThrow();
    expect(challenge.consumed_at).not.toBeNull();
    expect(challenge.superseded_at).toBeNull();
  }, 120_000);

  it("accepts the code however a human retypes it", async () => {
    // Grouping, case and the classic O/0 and I/1 substitutions. Every accepted
    // form maps to ONE canonical value, so the search space is unchanged.
    const { code } = await register("retype@example.com");
    const canonical = canonicalizeVerificationCode(code);
    expect(canonical).not.toBeNull();

    for (const variant of [
      code, code.toLowerCase(), code.replace(/-/g, ""),
      code.replace(/-/g, " "), ` ${code} `,
    ]) {
      expect(canonicalizeVerificationCode(variant)).toBe(canonical);
    }
  }, 120_000);

  it("stores only a DIGEST, never the code", async () => {
    const { code } = await register("digest@example.com");
    const row = await database.db.selectFrom("email_verification_challenges")
      .selectAll().executeTakeFirstOrThrow();

    expect(JSON.stringify(row)).not.toContain(code);
    expect(JSON.stringify(row)).not.toContain(code.replace(/-/g, ""));
    expect(row.token_digest).toMatch(/^[a-f0-9]{64}$/);
  }, 120_000);

  // ── Single use ───────────────────────────────────────────────────────────

  it("REFUSES a second first-time verification, without rewriting the timestamp", async () => {
    const { userId, code } = await register("replay@example.com");
    await verifyEmail(code, verifyDeps());
    const original = await verifiedAt(userId);

    // A user who clicks twice sees a success-equivalent, not a hard failure.
    const second = await verifyEmail(code, verifyDeps());
    expect(second).toMatchObject({ outcome: "already-verified" });
    // The FIRST verification time stays historically true.
    expect((await verifiedAt(userId))?.getTime()).toBe(original?.getTime());
  }, 120_000);

  it("CONCURRENT redemptions of one code produce exactly ONE verification", async () => {
    // The property a read-then-write cannot provide. Eight independent
    // transactions race on one challenge; the conditional UPDATE decides.
    const { userId, code } = await register("race@example.com");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => verifyEmail(code, verifyDeps())));

    const verified = results.filter(r => r.outcome === "verified");
    const already = results.filter(r => r.outcome === "already-verified");
    expect(verified).toHaveLength(1);
    expect(verified.length + already.length).toBe(8);
    expect(await verifiedAt(userId)).not.toBeNull();
  }, 120_000);

  // ── Invalid credentials ──────────────────────────────────────────────────

  it("refuses an unknown or malformed code without touching the account", async () => {
    const { userId } = await register("invalid@example.com");

    // A well-formed code that was never issued.
    expect(await verifyEmail("K7QM-2X9F-P4TB", verifyDeps()))
      .toMatchObject({ outcome: "invalid" });
    // Structurally impossible values are refused before any lookup.
    for (const malformed of ["", "short", "a".repeat(200), "K7QM-2X9F-P4T!"]) {
      expect(await verifyEmail(malformed, verifyDeps()))
        .toMatchObject({ outcome: "invalid" });
    }
    expect(await verifiedAt(userId)).toBeNull();
  }, 120_000);

  it("refuses an EXPIRED code and never reactivates it", async () => {
    const { userId, code } = await register("expired@example.com");
    // Both timestamps move into the past. BACKEND-19's CHECK requires
    // `expires_at > created_at`, so backdating only the expiry is refused by
    // the database - correctly, since that row would be nonsense.
    await database.db.updateTable("email_verification_challenges")
      .set({
        created_at: new Date(Date.now() - 120_000),
        expires_at: new Date(Date.now() - 60_000),
      }).execute();

    expect(await verifyEmail(code, verifyDeps()))
      .toMatchObject({ outcome: "invalid", reason: "expired" });
    expect(await verifiedAt(userId)).toBeNull();
  }, 120_000);

  // ── Resend and supersession ──────────────────────────────────────────────

  it("ROTATES the challenge: the new code works, the old one does not", async () => {
    const { userId } = await register("rotate@example.com");
    const oldCode = issuedCode;

    await resendEmailVerification("rotate@example.com", resendDeps());
    const newCode = issuedCode;
    expect(newCode).not.toBe(oldCode);

    // The superseded code cannot verify.
    expect(await verifyEmail(oldCode, verifyDeps()))
      .toMatchObject({ outcome: "invalid", reason: "superseded" });
    expect(await verifiedAt(userId)).toBeNull();

    // The current one can.
    expect(await verifyEmail(newCode, verifyDeps()))
      .toMatchObject({ outcome: "verified" });
  }, 120_000);

  it("keeps exactly ONE active challenge after repeated resends", async () => {
    const { userId } = await register("many@example.com");
    for (let i = 0; i < 4; i += 1) {
      await resendEmailVerification("many@example.com", resendDeps());
    }

    const active = await database.db.selectFrom("email_verification_challenges")
      .selectAll()
      .where("user_id", "=", userId)
      .where("consumed_at", "is", null)
      .where("superseded_at", "is", null)
      .execute();
    expect(active).toHaveLength(1);
  }, 120_000);

  it("CONCURRENT resends cannot leave two live codes", async () => {
    // The partial unique index is what enforces this: whichever transaction
    // commits second finds the slot taken, not a check it already passed.
    const { userId } = await register("concurrent@example.com");
    const results = await Promise.allSettled(Array.from({ length: 5 }, () =>
      resendEmailVerification("concurrent@example.com", resendDeps())));

    expect(results.some(r => r.status === "fulfilled")).toBe(true);

    const active = await database.db.selectFrom("email_verification_challenges")
      .selectAll()
      .where("user_id", "=", userId)
      .where("consumed_at", "is", null)
      .where("superseded_at", "is", null)
      .execute();
    expect(active).toHaveLength(1);
  }, 120_000);

  it("a FAILED delivery leaves the previous code usable", async () => {
    // The reason delivery scheduling sits inside the transaction. Rotating
    // first and scheduling after would invalidate a working code and then fail
    // to send its replacement, stranding the account.
    const { code: originalCode } = await register("delivery@example.com");

    await expect(resendEmailVerification("delivery@example.com",
      resendDeps({ failDelivery: true }))).rejects.toThrow("queue down");

    // The original still verifies.
    expect(await verifyEmail(originalCode, verifyDeps()))
      .toMatchObject({ outcome: "verified" });
  }, 120_000);

  // ── The repository's own conditions ──────────────────────────────────────
  //
  // These are exercised DIRECTLY because the use case checks the same states
  // before calling them. That redundancy is deliberate defence in depth - but
  // it also means a probe removing the repository's WHERE clauses broke no
  // test, because application logic returned early. A control nothing tests is
  // a control that can be deleted silently.

  it("markEmailVerifiedIfUnverified never moves an existing timestamp", async () => {
    const { userId } = await register("stamp@example.com");
    const users = createVerifiableUserRepository(database.db);

    expect(await users.markEmailVerifiedIfUnverified({ userId, verifiedAt: 1_000 }))
      .toBe(true);
    const first = await verifiedAt(userId);

    // A second call must report "already done" and change nothing.
    expect(await users.markEmailVerifiedIfUnverified({ userId, verifiedAt: 9_999_999 }))
      .toBe(false);
    expect((await verifiedAt(userId))?.getTime()).toBe(first?.getTime());
  }, 120_000);

  it("consumeIfActive refuses a challenge that is already terminal or expired", async () => {
    const { userId } = await register("conditions@example.com");
    const challenges = createVerificationRepository(database.db);
    const row = await database.db.selectFrom("email_verification_challenges")
      .selectAll().where("user_id", "=", userId).executeTakeFirstOrThrow();
    const challengeId = row.challenge_id as VerificationChallengeId;

    // Active: consumed once.
    expect(await challenges.consumeIfActive({ challengeId, now: Date.now() })).toBe(true);
    // Already consumed: refused, and the original timestamp stands.
    const consumedAt = (await database.db.selectFrom("email_verification_challenges")
      .select("consumed_at").where("challenge_id", "=", challengeId)
      .executeTakeFirstOrThrow()).consumed_at;
    expect(await challenges.consumeIfActive({ challengeId, now: Date.now() + 5_000 }))
      .toBe(false);
    expect((await database.db.selectFrom("email_verification_challenges")
      .select("consumed_at").where("challenge_id", "=", challengeId)
      .executeTakeFirstOrThrow()).consumed_at?.getTime())
      .toBe(consumedAt?.getTime());

    // Expired: refused even when otherwise active.
    const { userId: other } = await register("conditions2@example.com");
    await database.db.updateTable("email_verification_challenges")
      .set({
        created_at: new Date(Date.now() - 120_000),
        expires_at: new Date(Date.now() - 60_000),
      })
      .where("user_id", "=", other).execute();
    const expiredRow = await database.db.selectFrom("email_verification_challenges")
      .selectAll().where("user_id", "=", other).executeTakeFirstOrThrow();
    expect(await challenges.consumeIfActive({
      challengeId: expiredRow.challenge_id as VerificationChallengeId, now: Date.now(),
    })).toBe(false);
  }, 120_000);

  it("DOMAIN-SEPARATES the digest from a bare hash of the code", async () => {
    // Without the prefix, a verification code and a session token that happened
    // to be the same string would digest identically - and a credential minted
    // to prove mailbox ownership could be presented as another kind.
    const { createHash } = await import("node:crypto");
    const canonical = "K7QM2X9FP4TB";
    const bare = createHash("sha256").update(canonical).digest("hex");
    const domained = digestSubmittedCode("K7QM-2X9F-P4TB");

    expect(domained).not.toBe(bare);
    expect(domained).toBe(
      createHash("sha256").update(`lagda.email-verify:${canonical}`).digest("hex"));
  });

  // ── Anti-enumeration ─────────────────────────────────────────────────────

  it("creates nothing for an unknown or already-verified address", async () => {
    // Unknown address.
    const unknown = await resendEmailVerification("nobody@example.com", resendDeps());
    expect(unknown).toMatchObject({ outcome: "accepted" });
    expect(await database.db.selectFrom("email_verification_challenges")
      .selectAll().execute()).toHaveLength(0);

    // Already-verified account.
    const { userId, code } = await register("done@example.com");
    await verifyEmail(code, verifyDeps());
    const before = await database.db.selectFrom("email_verification_challenges")
      .selectAll().where("user_id", "=", userId).execute();

    const verified = await resendEmailVerification("done@example.com", resendDeps());
    expect(verified).toMatchObject({ outcome: "accepted" });
    const after = await database.db.selectFrom("email_verification_challenges")
      .selectAll().where("user_id", "=", userId).execute();
    // No new challenge for a verified account.
    expect(after).toHaveLength(before.length);
  }, 120_000);

  it("resolves an address through the canonical normalizer", async () => {
    await register("Case.Resend@Example.com");
    const before = await database.db.selectFrom("email_verification_challenges")
      .selectAll().execute();

    await resendEmailVerification("CASE.RESEND@EXAMPLE.COM", resendDeps());
    const after = await database.db.selectFrom("email_verification_challenges")
      .selectAll().execute();
    // A rotation happened, so the differently-cased address found the account.
    expect(after.length).toBeGreaterThan(before.length);
  }, 120_000);

  // ── Login interaction ────────────────────────────────────────────────────

  it("register → login BLOCKED → verify → login SUCCEEDS", async () => {
    // The cross-feature property the whole verification flow exists to unlock.
    const { code } = await register("gate@example.com");

    const loginDeps = (): LoginDependencies => ({
      users: createUserRepository(database.db),
      hasher,
      sessions: { issue: userId => sessions.issue(userId) },
      clock: { now: () => Date.now() },
      dummyPasswordHash: dummyHash,
    });

    const before = await loginUser(
      { email: "gate@example.com", password: PASSWORD }, loginDeps());
    expect(before).toMatchObject({ failure: { kind: "email-not-verified" } });

    expect(await verifyEmail(code, verifyDeps())).toMatchObject({ outcome: "verified" });

    const after = await loginUser(
      { email: "gate@example.com", password: PASSWORD }, loginDeps());
    expect(after.outcome).toBe("authenticated");
  }, 180_000);

  it("verification issues NO session of its own", async () => {
    // Possession of a code proves mailbox access, not an intent to sign in.
    const { code } = await register("nosession@example.com");
    await verifyEmail(code, verifyDeps());
    expect(await database.db.selectFrom("user_sessions").selectAll().execute())
      .toHaveLength(0);
  }, 120_000);

  // ── Links ────────────────────────────────────────────────────────────────

  it("builds a link from CONFIGURATION, never a Host header", () => {
    const url = buildVerificationUrl("https://app.lagda.example/", "K7QM-2X9F-P4TB");
    expect(url.startsWith("https://app.lagda.example/verify-email?code=")).toBe(true);
    expect(url).toContain(encodeURIComponent("K7QM-2X9F-P4TB"));
  });

  it("issues unpredictable, well-formed codes", () => {
    const issued = Array.from({ length: 50 }, () => tokens.issue());
    expect(new Set(issued.map(t => t.raw)).size).toBe(50);
    expect(new Set(issued.map(t => t.digest)).size).toBe(50);
    for (const { raw } of issued) {
      expect(raw).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
  });

  it("REFUSES a database state that is both consumed and superseded", async () => {
    // A CHECK constraint, so "was this code used?" can never have two
    // contradictory answers.
    const { userId } = await register("terminal@example.com");
    await expect(database.db.updateTable("email_verification_challenges")
      .set({ consumed_at: new Date(), superseded_at: new Date() })
      .where("user_id", "=", userId).execute()).rejects.toThrow();
  }, 120_000);
});
