// Password recovery against REAL PostgreSQL.
//
// Single-use, one-active-challenge, and both races are properties of the
// DATABASE — a conditional UPDATE and a partial unique index are what enforce
// them. A fake repository can be made to agree with any claim; it cannot show
// what two transactions do when they touch the same row at the same time.
//
// The scenario that matters most is §70: two requests holding one token, each
// carrying a different password. If both commit, the account's password is
// whichever request lost the race — a value the user never chose.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import {
  registerUser, loginUser, requestPasswordReset, resetPassword,
  type LoginDependencies, type RegisterUserDependencies,
  type RequestPasswordResetDependencies, type ResetPasswordDependencies,
  type PasswordHash, type UserId, type VerificationChallengeId,
  type PasswordResetChallengeId, type ResetTokenDigest,
  createSessionService,
} from "@lagda/application";
import {
  createTestDatabase, hasIntegrationDatabase, createUserRepository,
  createVerificationChallengeRepository, createPasswordResetRepository,
  createPasswordResettableUserRepository, createSessionRepository,
  type LagdaDatabase,
} from "@lagda/db";
import {
  createArgon2PasswordHasher, createVerificationTokenFactory,
  createResetTokenFactory, createSecurityTokenGenerator,
  createSecurityTokenDigester, digestSubmittedResetToken, digestResetToken,
  isWellFormedResetToken, buildPasswordResetUrl, digestVerificationCode,
} from "@lagda/api";
import { truncateAccounts } from "@lagda/db";

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a completely different passphrase";
const RESET_TTL = 60 * 60 * 1000;
const VERIFY_TTL = 24 * 60 * 60 * 1000;

describe.skipIf(!hasIntegrationDatabase())("password recovery", () => {
  let database: LagdaDatabase;
  const hasher = createArgon2PasswordHasher();
  const verificationTokens = createVerificationTokenFactory();
  const resetTokens = createResetTokenFactory();
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
    await truncateAccounts(database);
  });

  let seq = 0;
  let issuedToken = "";

  function registerDeps(): RegisterUserDependencies {
    seq += 1;
    const run = seq;
    return {
      users: createUserRepository(database.db),
      challenges: createVerificationChallengeRepository(database.db),
      hasher,
      tokens: verificationTokens,
      clock: { now: () => Date.now() },
      newUserId: () => `usr_${String(run)}_${String(Date.now() % 100000)}` as UserId,
      newChallengeId: () =>
        `evc_${String(run)}_${String(Date.now() % 100000)}` as VerificationChallengeId,
      commit: operation => database.db.transaction().execute(trx => operation({
        users: createUserRepository(trx),
        challenges: createVerificationChallengeRepository(trx),
      })),
      termsVersion: "2026-01-01",
      verificationTtlMs: VERIFY_TTL,
    };
  }

  function requestDeps(overrides: {
    failDelivery?: boolean;
    withDelivery?: boolean;
  } = {}): RequestPasswordResetDependencies {
    seq += 1;
    const run = seq;
    return {
      tokens: {
        issue() {
          const issued = resetTokens.issue();
          issuedToken = issued.raw;
          return issued;
        },
      },
      clock: { now: () => Date.now() },
      newChallengeId: () =>
        `prc_${String(run)}_${String(Date.now() % 100000)}` as PasswordResetChallengeId,
      resetTtlMs: RESET_TTL,
      commit: operation => database.db.transaction().execute(trx => operation({
        challenges: createPasswordResetRepository(trx),
        users: createPasswordResettableUserRepository(trx),
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

  const resetDeps = (): ResetPasswordDependencies => ({
    digestSubmitted: digestSubmittedResetToken,
    hasher,
    clock: { now: () => Date.now() },
    peek: digest =>
      createPasswordResetRepository(database.db).findByTokenDigest(digest),
    commit: operation => database.db.transaction().execute(trx => operation({
      challenges: createPasswordResetRepository(trx),
      users: createPasswordResettableUserRepository(trx),
      sessions: createSessionRepository(trx),
    })),
  });

  const loginDeps = (): LoginDependencies => ({
    users: createUserRepository(database.db),
    hasher,
    sessions: { issue: userId => sessions.issue(userId) },
    clock: { now: () => Date.now() },
    dummyPasswordHash: dummyHash,
  });

  async function register(email: string): Promise<UserId> {
    const result = await registerUser({
      email, password: PASSWORD, displayName: "New User", acceptedTerms: true,
    }, registerDeps());
    if (result.outcome !== "registered") throw new Error("fixture failed");
    return result.userId;
  }

  /** Registers and then verifies, so login is not blocked by BACKEND-21. */
  async function registerVerified(email: string): Promise<UserId> {
    const userId = await register(email);
    await database.db.updateTable("users")
      .set({ email_verified_at: new Date() })
      .where("user_id", "=", userId).execute();
    return userId;
  }

  async function requestReset(email: string): Promise<string> {
    await requestPasswordReset(email, requestDeps());
    return issuedToken;
  }

  const challengeRows = (userId: UserId) =>
    database.db.selectFrom("password_reset_challenges").selectAll()
      .where("user_id", "=", userId).orderBy("created_at", "asc").execute();

  const passwordHashOf = async (userId: UserId): Promise<string> => {
    const row = await database.db.selectFrom("users").select("password_hash")
      .where("user_id", "=", userId).executeTakeFirstOrThrow();
    return row.password_hash;
  };

  // ── Request ──────────────────────────────────────────────────────────────

  it("creates a challenge for a known account and finds it by digest", async () => {
    const userId = await registerVerified("known@example.com");
    const token = await requestReset("known@example.com");

    const rows = await challengeRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.consumed_at).toBeNull();
    expect(rows[0]?.superseded_at).toBeNull();

    // The lookup path the reset endpoint uses.
    const found = await createPasswordResetRepository(database.db)
      .findByTokenDigest(digestResetToken(token));
    expect(found?.userId).toBe(userId);
  });

  it("creates NO challenge for an unknown address, and no account", async () => {
    const result = await requestPasswordReset("nobody@example.com", requestDeps());

    expect(result.outcome).toBe("accepted");
    expect(result.telemetryReason).toBe("unknown-account");
    const rows = await database.db.selectFrom("password_reset_challenges")
      .selectAll().execute();
    expect(rows).toHaveLength(0);
    // §35: forgot-password never creates a user.
    const users = await database.db.selectFrom("users").selectAll().execute();
    expect(users).toHaveLength(0);
  });

  it("returns the SAME public outcome for known and unknown addresses", async () => {
    await registerVerified("real@example.com");

    const known = await requestPasswordReset("real@example.com", requestDeps());
    const unknown = await requestPasswordReset("ghost@example.com", requestDeps());

    // The only differing field is `telemetryReason`, which the route discards.
    expect(known.outcome).toBe(unknown.outcome);
    expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort());
  });

  it("allows an UNVERIFIED account to reset (§33 option A)", async () => {
    const userId = await register("unverified@example.com");
    const token = await requestReset("unverified@example.com");

    const result = await resetPassword(
      { token, newPassword: NEW_PASSWORD }, resetDeps());
    expect(result.outcome).toBe("reset");

    // And it is STILL unverified — reset proves the mailbox, but the two
    // account facts stay separate (§34, §96).
    const row = await database.db.selectFrom("users").select("email_verified_at")
      .where("user_id", "=", userId).executeTakeFirstOrThrow();
    expect(row.email_verified_at).toBeNull();
  });

  it("normalizes the address, so casing and spacing find one account", async () => {
    const userId = await registerVerified("Case.User@Example.com");
    await requestReset("  CASE.USER@EXAMPLE.COM  ");

    const rows = await challengeRows(userId);
    expect(rows).toHaveLength(1);
  });

  it("raw tokens are never persisted — no column holds one", async () => {
    const userId = await registerVerified("raw@example.com");
    const token = await requestReset("raw@example.com");

    const rows = await challengeRows(userId);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(token);
    // The digest IS stored, and is not the token.
    expect(rows[0]?.token_digest).toBe(digestResetToken(token));
    expect(rows[0]?.token_digest).not.toBe(token);
  });

  // ── Rotation and supersession ────────────────────────────────────────────

  it("a second request supersedes the first, and the first token dies", async () => {
    const userId = await registerVerified("rotate@example.com");
    const first = await requestReset("rotate@example.com");
    const second = await requestReset("rotate@example.com");
    expect(second).not.toBe(first);

    const rows = await challengeRows(userId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.superseded_at).not.toBeNull();
    expect(rows[1]?.superseded_at).toBeNull();

    const stale = await resetPassword(
      { token: first, newPassword: NEW_PASSWORD }, resetDeps());
    expect(stale.outcome).toBe("invalid-token");

    const fresh = await resetPassword(
      { token: second, newPassword: NEW_PASSWORD }, resetDeps());
    expect(fresh.outcome).toBe("reset");
  });

  it("CONCURRENT requests leave exactly one active challenge", async () => {
    const userId = await registerVerified("concurrent@example.com");

    // Five at once. The partial unique index is the arbiter; some transactions
    // may lose and that is correct — what must never happen is two live links.
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        requestPasswordReset("concurrent@example.com", requestDeps())),
    );
    expect(settled.some(r => r.status === "fulfilled")).toBe(true);

    const rows = await challengeRows(userId);
    const active = rows.filter(r =>
      r.consumed_at === null && r.superseded_at === null);
    expect(active).toHaveLength(1);
  });

  it("a delivery failure ROLLS BACK and leaves the old token usable", async () => {
    const userId = await registerVerified("rollback@example.com");
    const original = await requestReset("rollback@example.com");

    await expect(
      requestPasswordReset("rollback@example.com", requestDeps({ failDelivery: true })),
    ).rejects.toThrow("queue down");

    // The rotation did not happen: still one challenge, still active.
    const rows = await challengeRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.superseded_at).toBeNull();

    // And the link the user already has still works. Without the transaction,
    // this account would be unrecoverable: old link dead, new link never sent.
    const result = await resetPassword(
      { token: original, newPassword: NEW_PASSWORD }, resetDeps());
    expect(result.outcome).toBe("reset");
  });

  // ── Reset ────────────────────────────────────────────────────────────────

  it("replaces the password, consumes the challenge and revokes sessions", async () => {
    const userId = await registerVerified("full@example.com");
    const before = await passwordHashOf(userId);

    // Three live sessions, as if signed in on three devices.
    await sessions.issue(userId);
    await sessions.issue(userId);
    await sessions.issue(userId);

    const token = await requestReset("full@example.com");
    const result = await resetPassword(
      { token, newPassword: NEW_PASSWORD }, resetDeps());

    expect(result.outcome).toBe("reset");
    if (result.outcome !== "reset") return;
    expect(result.revokedSessionCount).toBe(3);

    expect(await passwordHashOf(userId)).not.toBe(before);
    const rows = await challengeRows(userId);
    expect(rows[0]?.consumed_at).not.toBeNull();

    const live = await database.db.selectFrom("user_sessions").selectAll()
      .where("user_id", "=", userId).where("revoked_at", "is", null).execute();
    expect(live).toHaveLength(0);
  });

  it("records the revocation reason as password-change", async () => {
    const userId = await registerVerified("reason@example.com");
    await sessions.issue(userId);
    const token = await requestReset("reason@example.com");
    await resetPassword({ token, newPassword: NEW_PASSWORD }, resetDeps());

    const rows = await database.db.selectFrom("user_sessions")
      .select("revocation_reason").where("user_id", "=", userId).execute();
    expect(rows[0]?.revocation_reason).toBe("password-change");
  });

  it("rejects a malformed token without touching the database", async () => {
    await registerVerified("malformed@example.com");
    for (const bad of ["", "short", "has spaces in it", "!!!", "x".repeat(200)]) {
      const result = await resetPassword(
        { token: bad, newPassword: NEW_PASSWORD }, resetDeps());
      expect(result.outcome).toBe("invalid-token");
      if (result.outcome !== "invalid-token") return;
      expect(result.reason).toBe("malformed");
    }
  });

  it("rejects a well-formed but unknown token", async () => {
    const unknown = resetTokens.issue().raw;
    expect(isWellFormedResetToken(unknown)).toBe(true);

    const result = await resetPassword(
      { token: unknown, newPassword: NEW_PASSWORD }, resetDeps());
    expect(result.outcome).toBe("invalid-token");
    if (result.outcome !== "invalid-token") return;
    expect(result.reason).toBe("not-found");
  });

  it("rejects an EXPIRED token and leaves the password alone", async () => {
    const userId = await registerVerified("expired@example.com");
    const token = await requestReset("expired@example.com");
    const before = await passwordHashOf(userId);

    // Backdate BOTH timestamps: the CHECK requires expires_at > created_at, so
    // moving only the expiry is rejected by the database.
    const past = new Date(Date.now() - 2 * RESET_TTL);
    await database.db.updateTable("password_reset_challenges")
      .set({ created_at: new Date(past.getTime() - 1000), expires_at: past })
      .where("user_id", "=", userId).execute();

    const result = await resetPassword(
      { token, newPassword: NEW_PASSWORD }, resetDeps());
    expect(result.outcome).toBe("invalid-token");
    expect(await passwordHashOf(userId)).toBe(before);
  });

  it("rejects a CONSUMED token — no second password change", async () => {
    const userId = await registerVerified("replay@example.com");
    const token = await requestReset("replay@example.com");

    const first = await resetPassword(
      { token, newPassword: NEW_PASSWORD }, resetDeps());
    expect(first.outcome).toBe("reset");
    const afterFirst = await passwordHashOf(userId);

    // The lost-response replay (§123, §192).
    const second = await resetPassword(
      { token, newPassword: "yet another different password" }, resetDeps());
    expect(second.outcome).toBe("invalid-token");
    expect(await passwordHashOf(userId)).toBe(afterFirst);
  });

  it("leaves NO active challenge for the user after a successful reset", async () => {
    const userId = await registerVerified("others@example.com");
    const token = await requestReset("others@example.com");

    // §72 asks that a successful reset invalidate every OTHER live reset link.
    // The `supersedeActiveForUser` sweep in the use case is written for that —
    // and it can never actually match a row, because `password_reset_one_active`
    // already makes a second active challenge impossible to insert. An attempt
    // to force one for this test was rejected by the index, which is the
    // stronger guarantee working.
    //
    // So the sweep is unreachable defence in depth, and what is asserted here is
    // the PROPERTY §72 wants rather than the mechanism: after a reset, nothing
    // active remains. If the index is ever relaxed, the sweep is what keeps this
    // true, and this test is what notices.
    await resetPassword({ token, newPassword: NEW_PASSWORD }, resetDeps());

    const rows = await challengeRows(userId);
    const active = rows.filter(r =>
      r.consumed_at === null && r.superseded_at === null);
    expect(active).toHaveLength(0);
  });

  it("CONCURRENT resets with one token: exactly one password wins", async () => {
    const userId = await registerVerified("race@example.com");
    const token = await requestReset("race@example.com");

    const candidates = [
      "first candidate password", "second candidate password",
      "third candidate password", "fourth candidate password",
    ];
    const results = await Promise.all(candidates.map(newPassword =>
      resetPassword({ token, newPassword }, resetDeps())));

    const winners = results.filter(r => r.outcome === "reset");
    expect(winners).toHaveLength(1);

    // And the surviving password is the WINNER's — not whichever request
    // happened to write last. A losing request that still overwrote the hash
    // would leave the account holding a password its owner never chose (§70).
    const finalHash = await passwordHashOf(userId) as PasswordHash;
    const matches = await Promise.all(
      candidates.map(p => hasher.verify(p, finalHash)));
    expect(matches.filter(Boolean)).toHaveLength(1);
  });

  it("a reset and a fresh request racing cannot both take effect", async () => {
    const userId = await registerVerified("crossrace@example.com");
    const token = await requestReset("crossrace@example.com");

    const [resetResult] = await Promise.all([
      resetPassword({ token, newPassword: NEW_PASSWORD }, resetDeps()),
      requestPasswordReset("crossrace@example.com", requestDeps()),
    ]);

    const rows = await challengeRows(userId);
    const consumed = rows.filter(r => r.consumed_at !== null);
    // Either the reset won (one consumed row) or the request superseded it
    // first (none consumed). Never both, and never two consumed (§71).
    expect(consumed.length).toBeLessThanOrEqual(1);
    expect(["reset", "invalid-token"]).toContain(resetResult.outcome);
  });

  // ── Password policy ──────────────────────────────────────────────────────

  it("applies the REGISTRATION password policy, before any hashing", async () => {
    await registerVerified("policy@example.com");
    const token = await requestReset("policy@example.com");

    const short = await resetPassword(
      { token, newPassword: "1234567" }, resetDeps());
    expect(short.outcome).toBe("invalid-password");
    if (short.outcome !== "invalid-password") return;
    expect(short.reason).toBe("too-short");

    const long = await resetPassword(
      { token, newPassword: "x".repeat(1025) }, resetDeps());
    expect(long.outcome).toBe("invalid-password");

    // Exactly at the minimum is ACCEPTED — the boundary is inclusive, matching
    // the frontend's `pw.length >= 8`.
    const atMinimum = await resetPassword(
      { token, newPassword: "12345678" }, resetDeps());
    expect(atMinimum.outcome).toBe("reset");
  });

  it("a policy rejection does NOT consume the challenge", async () => {
    const userId = await registerVerified("nopeconsume@example.com");
    const token = await requestReset("nopeconsume@example.com");

    await resetPassword({ token, newPassword: "short" }, resetDeps());

    const rows = await challengeRows(userId);
    expect(rows[0]?.consumed_at).toBeNull();
    // And the token still works afterwards.
    const retry = await resetPassword(
      { token, newPassword: NEW_PASSWORD }, resetDeps());
    expect(retry.outcome).toBe("reset");
  });

  it("stores an Argon2id hash, and never the plaintext", async () => {
    const userId = await registerVerified("argon@example.com");
    const token = await requestReset("argon@example.com");
    await resetPassword({ token, newPassword: NEW_PASSWORD }, resetDeps());

    const stored = await passwordHashOf(userId);
    expect(stored.startsWith("$argon2id$")).toBe(true);
    expect(stored).not.toContain(NEW_PASSWORD);
    expect(await hasher.verify(NEW_PASSWORD, stored as PasswordHash)).toBe(true);
  });

  // ── Cross-feature ────────────────────────────────────────────────────────

  it("old password FAILS and new password SUCCEEDS after reset", async () => {
    await registerVerified("login@example.com");
    const token = await requestReset("login@example.com");
    await resetPassword({ token, newPassword: NEW_PASSWORD }, resetDeps());

    const old = await loginUser(
      { email: "login@example.com", password: PASSWORD }, loginDeps());
    expect(old.outcome).toBe("rejected");

    const fresh = await loginUser(
      { email: "login@example.com", password: NEW_PASSWORD }, loginDeps());
    expect(fresh.outcome).toBe("authenticated");
  });

  it("a session issued BEFORE the reset no longer resolves", async () => {
    const userId = await registerVerified("staleSession@example.com");
    const issued = await sessions.issue(userId);
    // Assert the OUTCOME, not merely that something came back. `resolve` always
    // returns a result object, so `not.toBeNull()` would pass for a revoked
    // session just as happily as for a live one.
    expect((await sessions.resolve(issued.sessionToken)).outcome)
      .toBe("authenticated");

    const token = await requestReset("staleSession@example.com");
    await resetPassword({ token, newPassword: NEW_PASSWORD }, resetDeps());

    // The exact attack this defends against: an intruder holding a stolen
    // session is the reason the user is resetting at all (§131).
    const after = await sessions.resolve(issued.sessionToken);
    expect(after.outcome).toBe("rejected");
    if (after.outcome !== "rejected") return;
    expect(after.reason).toBe("revoked");
  });

  it("a session issued AFTER the reset is unaffected", async () => {
    const userId = await registerVerified("newSession@example.com");
    const token = await requestReset("newSession@example.com");
    await resetPassword({ token, newPassword: NEW_PASSWORD }, resetDeps());

    const issued = await sessions.issue(userId);
    expect((await sessions.resolve(issued.sessionToken)).outcome)
      .toBe("authenticated");
  });

  it("reset does not touch verification state of a VERIFIED account", async () => {
    const userId = await registerVerified("keepverified@example.com");
    const before = await database.db.selectFrom("users").select("email_verified_at")
      .where("user_id", "=", userId).executeTakeFirstOrThrow();

    const token = await requestReset("keepverified@example.com");
    await resetPassword({ token, newPassword: NEW_PASSWORD }, resetDeps());

    const after = await database.db.selectFrom("users").select("email_verified_at")
      .where("user_id", "=", userId).executeTakeFirstOrThrow();
    expect(after.email_verified_at?.getTime())
      .toBe(before.email_verified_at?.getTime());
  });

  it("a new request AFTER a successful reset creates a fresh challenge", async () => {
    const userId = await registerVerified("again@example.com");
    const first = await requestReset("again@example.com");
    await resetPassword({ token: first, newPassword: NEW_PASSWORD }, resetDeps());

    const second = await requestReset("again@example.com");
    expect(second).not.toBe(first);

    const rows = await challengeRows(userId);
    const active = rows.filter(r =>
      r.consumed_at === null && r.superseded_at === null);
    expect(active).toHaveLength(1);
  });

  // ── Credential domain separation ─────────────────────────────────────────

  it("the digest is DOMAIN-SEPARATED from every other credential", () => {
    // The property, asserted directly rather than through a lookup that would
    // pass for unrelated reasons. An earlier version of this test compared the
    // digest function to itself and then checked that a garbage value found no
    // row — it passed happily with the domain prefix deleted.
    const shared = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

    // A bare SHA-256 is NOT what is stored. Without the prefix these match, and
    // any system that digests the same string the obvious way would produce
    // lookup keys into LAGDA's reset table.
    const bare = createHash("sha256").update(shared).digest("hex");
    expect(digestResetToken(shared)).not.toBe(bare);

    // And the reset domain differs from the verification domain. If these
    // collided, a code issued to prove someone owns a mailbox would resolve a
    // password-reset challenge — proof of address becoming authority to take
    // the account (§8, INV-278).
    expect(digestResetToken(shared)).not.toBe(digestVerificationCode(shared));

    // Same input, same output — the digest is deterministic, which is what
    // makes a stored digest usable as a lookup key at all.
    expect(digestResetToken(shared)).toBe(digestResetToken(shared));
  });

  it("a digest from another domain resolves no reset challenge", async () => {
    await registerVerified("domains@example.com");
    const token = await requestReset("domains@example.com");

    const repository = createPasswordResetRepository(database.db);
    // The SAME raw token, digested for email verification. It must not find the
    // row that the reset digest of that token does find.
    const found = await repository.findByTokenDigest(
      digestVerificationCode(token) as unknown as ResetTokenDigest);
    expect(found).toBeNull();
    expect(await repository.findByTokenDigest(digestResetToken(token))).not.toBeNull();
  });

  // ── Link construction ────────────────────────────────────────────────────

  it("builds the link from CONFIGURED base URLs only", () => {
    const token = resetTokens.issue().raw;
    expect(buildPasswordResetUrl("https://app.lagda.ph", token))
      .toBe(`https://app.lagda.ph/reset-password?token=${encodeURIComponent(token)}`);
    // Trailing slashes collapse rather than producing a double slash.
    expect(buildPasswordResetUrl("https://app.lagda.ph///", token))
      .toBe(`https://app.lagda.ph/reset-password?token=${encodeURIComponent(token)}`);
    // No email in the URL (§44, §88).
    expect(buildPasswordResetUrl("https://app.lagda.ph", token))
      .not.toContain("@");
  });

  // ── Repository conditions, tested DIRECTLY ───────────────────────────────
  //
  // The use case checks these too, and that redundancy is deliberate defence in
  // depth. But a control whose only test goes through a redundant caller is a
  // control that can be deleted without any test noticing.

  it("consumeIfActive refuses an already-consumed challenge", async () => {
    const userId = await registerVerified("direct1@example.com");
    const token = await requestReset("direct1@example.com");
    const repository = createPasswordResetRepository(database.db);
    const challenge = await repository.findByTokenDigest(digestResetToken(token));
    if (challenge === null) throw new Error("fixture failed");

    expect(await repository.consumeIfActive({
      challengeId: challenge.challengeId, now: Date.now(),
    })).toBe(true);
    expect(await repository.consumeIfActive({
      challengeId: challenge.challengeId, now: Date.now(),
    })).toBe(false);
    expect(userId).toBeTruthy();
  });

  it("consumeIfActive refuses a superseded or expired challenge", async () => {
    const userId = await registerVerified("direct2@example.com");
    const token = await requestReset("direct2@example.com");
    const repository = createPasswordResetRepository(database.db);
    const challenge = await repository.findByTokenDigest(digestResetToken(token));
    if (challenge === null) throw new Error("fixture failed");

    await repository.supersedeActiveForUser({ userId, now: Date.now() });
    expect(await repository.consumeIfActive({
      challengeId: challenge.challengeId, now: Date.now(),
    })).toBe(false);

    // And expiry, on a fresh challenge.
    const second = await requestReset("direct2@example.com");
    const other = await repository.findByTokenDigest(digestResetToken(second));
    if (other === null) throw new Error("fixture failed");
    expect(await repository.consumeIfActive({
      challengeId: other.challengeId, now: other.expiresAt + 1,
    })).toBe(false);
  });

  it("replacePasswordHash reports false for an account that is gone", async () => {
    const repository = createPasswordResettableUserRepository(database.db);
    expect(await repository.replacePasswordHash({
      userId: "usr_does_not_exist" as UserId,
      passwordHash: dummyHash,
    })).toBe(false);
  });

  // ── Database constraints ─────────────────────────────────────────────────

  it("the database refuses a challenge that is consumed AND superseded", async () => {
    const userId = await registerVerified("terminal@example.com");
    await requestReset("terminal@example.com");

    await expect(
      database.db.updateTable("password_reset_challenges")
        .set({ consumed_at: new Date(), superseded_at: new Date() })
        .where("user_id", "=", userId).execute(),
    ).rejects.toThrow(/password_reset_single_terminal/);
  });

  it("the database refuses a second ACTIVE challenge for one user", async () => {
    const userId = await registerVerified("oneactive@example.com");
    await requestReset("oneactive@example.com");

    await expect(
      database.db.insertInto("password_reset_challenges").values({
        challenge_id: "prc_dupe",
        user_id: userId,
        token_digest: digestResetToken(resetTokens.issue().raw),
        created_at: new Date(),
        expires_at: new Date(Date.now() + RESET_TTL),
        consumed_at: null,
        superseded_at: null,
      }).execute(),
    ).rejects.toThrow(/password_reset_one_active/);
  });
});
