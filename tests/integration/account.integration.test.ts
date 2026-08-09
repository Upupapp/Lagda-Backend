// Account and profile against REAL PostgreSQL.
//
// The property under test is a boundary, not an algorithm: profile editing must
// be unable to reach identity or credentials. That is worth proving against a
// real database because the columns share one table — `users` holds the display
// name and the password hash side by side, and the only thing separating them
// is which columns the repository names.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  registerUser, loginUser, getCurrentUser, updateCurrentUserProfile,
  updateCurrentUserPreferences, changeCurrentPassword, listOwnSessions,
  revokeOwnSession, revokeOtherSessions, createSessionService,
  type RegisterUserDependencies, type LoginDependencies,
  type GetCurrentUserDependencies, type UpdateProfileDependencies,
  type UpdatePreferencesDependencies, type ChangePasswordDependencies,
  type PasswordHash, type UserId,
  type VerificationChallengeId,
} from "@lagda/application";
import {
  createTestDatabase, hasIntegrationDatabase, createUserRepository,
  createVerificationChallengeRepository, createSessionRepository,
  createAccountProfileRepository, createAccountCredentialRepository,
  createAccountSessionRepository, createPendingAuthenticationRepository,
  type LagdaDatabase,
} from "@lagda/db";
import {
  createArgon2PasswordHasher, createVerificationTokenFactory,
  createSecurityTokenGenerator, createSecurityTokenDigester,
} from "@lagda/api";
import { truncateAccounts } from "@lagda/db";

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "an entirely different passphrase";

describe.skipIf(!hasIntegrationDatabase())("account and profile", () => {
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
    await truncateAccounts(database);
  });

  let seq = 0;
  const nextId = (prefix: string): string => {
    seq += 1;
    return `${prefix}_${String(seq)}_${String(Date.now() % 100000)}`;
  };

  const registerDeps = (): RegisterUserDependencies => ({
    users: createUserRepository(database.db),
    challenges: createVerificationChallengeRepository(database.db),
    hasher,
    tokens,
    clock: { now: () => Date.now() },
    newUserId: () => nextId("usr") as UserId,
    newChallengeId: () => nextId("evc") as VerificationChallengeId,
    commit: operation => database.db.transaction().execute(trx => operation({
      users: createUserRepository(trx),
      challenges: createVerificationChallengeRepository(trx),
    })),
    termsVersion: "2026-01-01",
    verificationTtlMs: 86_400_000,
  });

  const currentUserDeps = (): GetCurrentUserDependencies => ({
    accounts: createAccountProfileRepository(database.db),
  });

  const profileDeps = (): UpdateProfileDependencies => ({
    clock: { now: () => Date.now() },
    commit: operation => database.db.transaction().execute(trx => operation({
      accounts: createAccountProfileRepository(trx),
    })),
  });

  const preferenceDeps = (): UpdatePreferencesDependencies => ({
    clock: { now: () => Date.now() },
    isKnownTimezone: value => {
      try {
        // Validated against the RUNTIME's real zone data, not a hard-coded
        // list that would be wrong the next time the tz database changes.
        new Intl.DateTimeFormat("en-US", { timeZone: value });
        return true;
      } catch { return false; }
    },
    commit: operation => database.db.transaction().execute(trx => operation({
      accounts: createAccountProfileRepository(trx),
    })),
  });

  const passwordDeps = (): ChangePasswordDependencies => ({
    clock: { now: () => Date.now() },
    hasher,
    credentials: createAccountCredentialRepository(database.db),
    commit: operation => database.db.transaction().execute(trx => operation({
      credentials: createAccountCredentialRepository(trx),
      sessions: createAccountSessionRepository(trx),
      pendingAuth: createPendingAuthenticationRepository(trx),
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
      email, password: PASSWORD, displayName: "Real User", acceptedTerms: true,
    }, registerDeps());
    if (result.outcome !== "registered") throw new Error("fixture failed");
    await database.db.updateTable("users")
      .set({ email_verified_at: new Date() })
      .where("user_id", "=", result.userId).execute();
    return result.userId;
  }

  const userRow = (userId: UserId) =>
    database.db.selectFrom("users").selectAll()
      .where("user_id", "=", userId).executeTakeFirstOrThrow();

  // ── Current user ─────────────────────────────────────────────────────────

  it("returns a safe projection with no security internals", async () => {
    // MIXED CASE deliberately: the display address and the canonical one then
    // differ, so "the normalized identity is absent" is a real assertion rather
    // than one satisfied by the display address happening to equal it.
    const userId = await register("Me.User@Example.com");
    const user = await getCurrentUser(userId, currentUserDeps());

    expect(user?.email).toBe("Me.User@Example.com");
    expect(user?.emailVerified).toBe(true);

    // The exhaustive check: whatever is serialized must not contain the
    // account's hash, its canonical identity, or any digest.
    const row = await userRow(userId);
    const serialized = JSON.stringify(user);
    expect(serialized).not.toContain(row.password_hash);
    expect(serialized).not.toContain(row.normalized_email);
    expect(serialized).not.toMatch(/passwordHash|normalizedEmail|tokenDigest/);
    // `emailVerifiedAt` itself is not exposed — only the derived boolean.
    expect(serialized).not.toContain("emailVerifiedAt");
  });

  it("reports MFA as a summary only", async () => {
    const userId = await register("mfa@example.com");
    await database.db.insertInto("mfa_factors").values({
      factor_id: "mfa_1", user_id: userId, factor_type: "TOTP",
      secret_ciphertext: "v1.AAAA.BBBB.CCCC", secret_key_version: "v1",
      created_at: new Date(), verified_at: new Date(), disabled_at: null,
      last_used_time_step: null,
    }).execute();

    const user = await getCurrentUser(userId, currentUserDeps());
    expect(user?.security.mfaEnabled).toBe(true);
    expect(user?.security.mfaFactor).toBe("TOTP");
    // The ciphertext, key version and watermark stay in the database.
    expect(JSON.stringify(user)).not.toContain("v1.AAAA.BBBB.CCCC");
    expect(JSON.stringify(user)).not.toMatch(/secret|ciphertext|keyVersion/i);
  });

  it("an UNVERIFIED factor does not count as MFA enabled", async () => {
    const userId = await register("pendingmfa@example.com");
    await database.db.insertInto("mfa_factors").values({
      factor_id: "mfa_2", user_id: userId, factor_type: "TOTP",
      secret_ciphertext: "v1.A.B.C", secret_key_version: "v1",
      created_at: new Date(), verified_at: null, disabled_at: null,
      last_used_time_step: null,
    }).execute();

    const user = await getCurrentUser(userId, currentUserDeps());
    expect(user?.security.mfaEnabled).toBe(false);
  });

  it("returns null for an account that no longer exists", async () => {
    expect(await getCurrentUser("usr_gone" as UserId, currentUserDeps()))
      .toBeNull();
  });

  // ── Profile ──────────────────────────────────────────────────────────────

  it("updates the five profile fields and nothing else", async () => {
    const userId = await register("profile@example.com");
    const before = await userRow(userId);

    const result = await updateCurrentUserProfile(userId, {
      fullName: "Maria de los Reyes",
      displayName: "Maria",
      jobTitle: "Notary",
      department: "Legal",
      preferredSenderName: "Maria R.",
    }, profileDeps());

    expect(result.outcome).toBe("updated");
    const after = await userRow(userId);
    expect(after.full_name).toBe("Maria de los Reyes");
    expect(after.job_title).toBe("Notary");

    // The boundary. These share a table with the columns just written, and the
    // repository has no method that names them.
    expect(after.email).toBe(before.email);
    expect(after.normalized_email).toBe(before.normalized_email);
    expect(after.password_hash).toBe(before.password_hash);
    expect(after.email_verified_at?.getTime())
      .toBe(before.email_verified_at?.getTime());
  });

  it("accepts names with Unicode, apostrophes and hyphens", async () => {
    const userId = await register("names@example.com");
    // Real names. An ASCII allowlist would reject most of these, and a large
    // share of this product's own users along with them.
    for (const name of [
      "José Rizal", "Ng", "D'Souza", "Jean-Luc Picard",
      "María José de la Cruz-Santos", "李小龍", "Ólafur Þórðarson",
    ]) {
      const result = await updateCurrentUserProfile(userId, {
        fullName: name, displayName: null, jobTitle: null,
        department: null, preferredSenderName: null,
      }, profileDeps());
      expect(result.outcome).toBe("updated");
      expect((await userRow(userId)).full_name).toBe(name);
    }
  });

  it("rejects control characters", async () => {
    const userId = await register("control@example.com");
    const result = await updateCurrentUserProfile(userId, {
      fullName: ["Maria", "Reyes"].join(String.fromCharCode(0)),
      displayName: null, jobTitle: null, department: null,
      preferredSenderName: null,
    }, profileDeps());
    expect(result.outcome).toBe("invalid");
    if (result.outcome !== "invalid") return;
    expect(result.reason).toBe("control-characters");
  });

  it("rejects a full name below the product's minimum", async () => {
    const userId = await register("short@example.com");
    const result = await updateCurrentUserProfile(userId, {
      fullName: "A", displayName: null, jobTitle: null,
      department: null, preferredSenderName: null,
    }, profileDeps());
    expect(result.outcome).toBe("invalid");
    if (result.outcome !== "invalid") return;
    expect(result.reason).toBe("full-name-too-short");
  });

  it("trims whitespace and maps blank optional fields to null", async () => {
    const userId = await register("blank@example.com");
    await updateCurrentUserProfile(userId, {
      fullName: "  Maria Reyes  ", displayName: null,
      jobTitle: "   ", department: "", preferredSenderName: null,
    }, profileDeps());

    const row = await userRow(userId);
    expect(row.full_name).toBe("Maria Reyes");
    // Whitespace-only was never intended as content — the product's own form
    // does `form.jobTitle?.trim()`.
    expect(row.job_title).toBeNull();
    expect(row.department).toBeNull();
  });

  it("falls back to the full name for display and sender name", async () => {
    const userId = await register("fallback@example.com");
    await updateCurrentUserProfile(userId, {
      fullName: "Maria Reyes", displayName: null, jobTitle: null,
      department: null, preferredSenderName: null,
    }, profileDeps());

    const row = await userRow(userId);
    expect(row.display_name).toBe("Maria Reyes");
    expect(row.preferred_sender_name).toBe("Maria Reyes");
  });

  it("refuses to leave the account with no display name", async () => {
    const userId = await register("nodisplay@example.com");
    const result = await updateCurrentUserProfile(userId, {
      fullName: null, displayName: null, jobTitle: null,
      department: null, preferredSenderName: null,
    }, profileDeps());
    // `display_name` is NOT NULL, so this is a validation failure rather than a
    // constraint violation surfacing as a 500.
    expect(result.outcome).toBe("invalid");
    if (result.outcome !== "invalid") return;
    expect(result.reason).toBe("display-name-required");
  });

  it("does not disable MFA or alter sessions", async () => {
    const userId = await register("boundary@example.com");
    await database.db.insertInto("mfa_factors").values({
      factor_id: "mfa_3", user_id: userId, factor_type: "TOTP",
      secret_ciphertext: "v1.A.B.C", secret_key_version: "v1",
      created_at: new Date(), verified_at: new Date(), disabled_at: null,
      last_used_time_step: null,
    }).execute();
    const issued = await sessions.issue(userId);

    await updateCurrentUserProfile(userId, {
      fullName: "Maria Reyes", displayName: null, jobTitle: null,
      department: null, preferredSenderName: null,
    }, profileDeps());

    const factor = await database.db.selectFrom("mfa_factors").selectAll()
      .where("user_id", "=", userId).executeTakeFirstOrThrow();
    expect(factor.disabled_at).toBeNull();
    expect(factor.verified_at).not.toBeNull();
    expect((await sessions.resolve(issued.sessionToken)).outcome)
      .toBe("authenticated");
  });

  // ── Preferences ──────────────────────────────────────────────────────────

  it("stores an IANA timezone and refuses an offset", async () => {
    const userId = await register("tz@example.com");

    const ok = await updateCurrentUserPreferences(
      userId, { timezone: "Asia/Manila" }, preferenceDeps());
    expect(ok.outcome).toBe("updated");
    expect((await userRow(userId)).timezone).toBe("Asia/Manila");

    // An offset is wrong twice a year wherever daylight saving applies, and
    // cannot be corrected without knowing the zone it came from.
    // `+08:00` is the one that matters: `Intl.DateTimeFormat` ACCEPTS it, so a
    // runtime-only check would have stored a raw offset here.
    for (const bad of ["+08:00", "-05:00", "GMT+8", "PHT", "Not/AZone"]) {
      const result = await updateCurrentUserPreferences(
        userId, { timezone: bad }, preferenceDeps());
      expect(result.outcome).toBe("invalid");
    }
    // And the good value survived every rejection.
    expect((await userRow(userId)).timezone).toBe("Asia/Manila");
  });

  it("leaves unmentioned preferences alone", async () => {
    const userId = await register("partial@example.com");
    await updateCurrentUserPreferences(userId, {
      timezone: "Asia/Manila", appearance: "dark", dateFormat: "DD/MM/YYYY",
    }, preferenceDeps());

    // A partial submission must not silently blank what it did not mention.
    await updateCurrentUserPreferences(
      userId, { appearance: "light" }, preferenceDeps());

    const row = await userRow(userId);
    expect(row.appearance).toBe("light");
    expect(row.timezone).toBe("Asia/Manila");
    expect(row.date_format).toBe("DD/MM/YYYY");
  });

  it("an explicit null CLEARS a preference", async () => {
    const userId = await register("clear@example.com");
    await updateCurrentUserPreferences(
      userId, { timezone: "Asia/Manila" }, preferenceDeps());
    await updateCurrentUserPreferences(
      userId, { timezone: null }, preferenceDeps());
    expect((await userRow(userId)).timezone).toBeNull();
  });

  it("the database refuses a preference outside the vocabulary", async () => {
    const userId = await register("badpref@example.com");
    await expect(
      database.db.updateTable("users").set({ appearance: "neon" })
        .where("user_id", "=", userId).execute(),
    ).rejects.toThrow(/user_appearance_known/);
  });

  // ── Password change ──────────────────────────────────────────────────────

  it("changes the password, keeps this session, revokes the others", async () => {
    const userId = await register("pwd@example.com");
    const current = await sessions.issue(userId);
    const other1 = await sessions.issue(userId);
    const other2 = await sessions.issue(userId);
    const before = (await userRow(userId)).password_hash;

    const result = await changeCurrentPassword(userId, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      currentSessionId: current.sessionId,
    }, passwordDeps());

    expect(result.outcome).toBe("changed");
    if (result.outcome !== "changed") return;
    expect(result.revokedSessionCount).toBe(2);

    expect((await userRow(userId)).password_hash).not.toBe(before);
    // The browser being used SURVIVES. Signing someone out of the session they
    // used to change their password teaches them the security action breaks
    // things.
    expect((await sessions.resolve(current.sessionToken)).outcome)
      .toBe("authenticated");
    for (const stale of [other1, other2]) {
      expect((await sessions.resolve(stale.sessionToken)).outcome)
        .toBe("rejected");
    }
  });

  it("refuses a wrong current password and changes nothing", async () => {
    const userId = await register("wrongpwd@example.com");
    const current = await sessions.issue(userId);
    const other = await sessions.issue(userId);
    const before = (await userRow(userId)).password_hash;

    const result = await changeCurrentPassword(userId, {
      currentPassword: "not the password",
      newPassword: NEW_PASSWORD,
      currentSessionId: current.sessionId,
    }, passwordDeps());

    expect(result.outcome).toBe("invalid-current-password");
    expect((await userRow(userId)).password_hash).toBe(before);
    // And no session was touched — a failed attempt must not be a way to sign
    // someone else's devices out.
    expect((await sessions.resolve(other.sessionToken)).outcome)
      .toBe("authenticated");
  });

  it("applies the REGISTRATION password policy", async () => {
    const userId = await register("policy@example.com");
    const current = await sessions.issue(userId);

    for (const bad of ["1234567", "x".repeat(1025)]) {
      const result = await changeCurrentPassword(userId, {
        currentPassword: PASSWORD, newPassword: bad,
        currentSessionId: current.sessionId,
      }, passwordDeps());
      expect(result.outcome).toBe("invalid-new-password");
    }
  });

  it("old password fails and new password works after the change", async () => {
    const userId = await register("login@example.com");
    const current = await sessions.issue(userId);
    await changeCurrentPassword(userId, {
      currentPassword: PASSWORD, newPassword: NEW_PASSWORD,
      currentSessionId: current.sessionId,
    }, passwordDeps());

    expect((await loginUser(
      { email: "login@example.com", password: PASSWORD }, loginDeps())).outcome)
      .toBe("rejected");
    expect((await loginUser(
      { email: "login@example.com", password: NEW_PASSWORD }, loginDeps())).outcome)
      .toBe("authenticated");
  });

  it("stores an Argon2id hash and never the plaintext", async () => {
    const userId = await register("argon@example.com");
    const current = await sessions.issue(userId);
    await changeCurrentPassword(userId, {
      currentPassword: PASSWORD, newPassword: NEW_PASSWORD,
      currentSessionId: current.sessionId,
    }, passwordDeps());

    const stored = (await userRow(userId)).password_hash;
    expect(stored.startsWith("$argon2id$")).toBe(true);
    expect(stored).not.toContain(NEW_PASSWORD);
    expect(await hasher.verify(NEW_PASSWORD, stored as PasswordHash)).toBe(true);
  });

  it("revokes in-flight MFA ceremonies", async () => {
    const userId = await register("ceremony@example.com");
    const current = await sessions.issue(userId);
    await createPendingAuthenticationRepository(database.db).create({
      pendingId: "pnd_1" as never,
      userId,
      credentialDigest: "a".repeat(64) as never,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
      maxAttempts: 5,
      authenticationMethod: "PASSWORD",
    });

    await changeCurrentPassword(userId, {
      currentPassword: PASSWORD, newPassword: NEW_PASSWORD,
      currentSessionId: current.sessionId,
    }, passwordDeps());

    // A ceremony is a proof of the OLD password.
    const pending = await database.db.selectFrom("pending_authentications")
      .selectAll().where("user_id", "=", userId).executeTakeFirstOrThrow();
    expect(pending.revoked_at).not.toBeNull();
  });

  it("does not change email verification state", async () => {
    const userId = await register("verified@example.com");
    const current = await sessions.issue(userId);
    const before = (await userRow(userId)).email_verified_at;

    await changeCurrentPassword(userId, {
      currentPassword: PASSWORD, newPassword: NEW_PASSWORD,
      currentSessionId: current.sessionId,
    }, passwordDeps());

    expect((await userRow(userId)).email_verified_at?.getTime())
      .toBe(before?.getTime());
  });

  // ── Sessions ─────────────────────────────────────────────────────────────

  it("lists only the caller's own sessions, with no credentials", async () => {
    const alice = await register("alice@example.com");
    const bob = await register("bob@example.com");
    const aliceSession = await sessions.issue(alice);
    await sessions.issue(alice);
    await sessions.issue(bob);

    const listed = await listOwnSessions(alice, aliceSession.sessionId, {
      sessions: createAccountSessionRepository(database.db),
    });

    expect(listed).toHaveLength(2);
    expect(listed.filter(s => s.isCurrent)).toHaveLength(1);
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain(aliceSession.sessionToken);
    expect(serialized).not.toContain(aliceSession.csrfToken);
    expect(serialized).not.toMatch(/tokenHash|token_hash|csrf/i);
  });

  it("cannot revoke another user's session", async () => {
    const alice = await register("ralice@example.com");
    const bob = await register("rbob@example.com");
    const aliceSession = await sessions.issue(alice);
    const bobSession = await sessions.issue(bob);

    const result = await revokeOwnSession(alice, {
      sessionId: bobSession.sessionId,
      currentSessionId: aliceSession.sessionId,
    }, {
      clock: { now: () => Date.now() },
      sessions: createAccountSessionRepository(database.db),
    });

    expect(result.outcome).toBe("not-found");
    // Bob is untouched. A revoke keyed on the session alone would have worked.
    expect((await sessions.resolve(bobSession.sessionToken)).outcome)
      .toBe("authenticated");
  });

  it("revokes one own session and leaves the current one", async () => {
    const userId = await register("revokeone@example.com");
    const current = await sessions.issue(userId);
    const other = await sessions.issue(userId);

    const result = await revokeOwnSession(userId, {
      sessionId: other.sessionId, currentSessionId: current.sessionId,
    }, {
      clock: { now: () => Date.now() },
      sessions: createAccountSessionRepository(database.db),
    });

    expect(result.outcome).toBe("revoked");
    if (result.outcome !== "revoked") return;
    expect(result.wasCurrent).toBe(false);
    expect((await sessions.resolve(other.sessionToken)).outcome).toBe("rejected");
    expect((await sessions.resolve(current.sessionToken)).outcome)
      .toBe("authenticated");
  });

  it("reports when the caller revoked their OWN current session", async () => {
    const userId = await register("selfrevoke@example.com");
    const current = await sessions.issue(userId);

    const result = await revokeOwnSession(userId, {
      sessionId: current.sessionId, currentSessionId: current.sessionId,
    }, {
      clock: { now: () => Date.now() },
      sessions: createAccountSessionRepository(database.db),
    });

    expect(result.outcome).toBe("revoked");
    if (result.outcome !== "revoked") return;
    // The route uses this to clear cookies — otherwise the browser keeps
    // presenting a dead credential.
    expect(result.wasCurrent).toBe(true);
  });

  it("revokes every other session", async () => {
    const userId = await register("revokeothers@example.com");
    const current = await sessions.issue(userId);
    const a = await sessions.issue(userId);
    const b = await sessions.issue(userId);

    const revoked = await revokeOtherSessions(userId, current.sessionId, {
      clock: { now: () => Date.now() },
      sessions: createAccountSessionRepository(database.db),
    });

    expect(revoked).toBe(2);
    expect((await sessions.resolve(current.sessionToken)).outcome)
      .toBe("authenticated");
    for (const stale of [a, b]) {
      expect((await sessions.resolve(stale.sessionToken)).outcome)
        .toBe("rejected");
    }
  });

  it("a second revoke-all is a no-op rather than an error", async () => {
    const userId = await register("idempotent@example.com");
    const current = await sessions.issue(userId);
    await sessions.issue(userId);

    const deps = {
      clock: { now: () => Date.now() },
      sessions: createAccountSessionRepository(database.db),
    };
    expect(await revokeOtherSessions(userId, current.sessionId, deps)).toBe(1);
    expect(await revokeOtherSessions(userId, current.sessionId, deps)).toBe(0);
  });

  // ── The repository boundary, tested DIRECTLY ─────────────────────────────

  it("the profile repository exposes NO method that writes identity", () => {
    const repository = createAccountProfileRepository(database.db);
    // The mass-assignment defence is an absence of capability, not a filter.
    // If a generic patch is ever added, this fails.
    expect(Object.keys(repository).sort())
      .toEqual(["findCurrentUser", "updatePreferences", "updateProfile"]);
  });

  it("updateProfile cannot touch identity even when asked repeatedly", async () => {
    const userId = await register("repeat@example.com");
    const before = await userRow(userId);

    for (let n = 0; n < 3; n += 1) {
      await createAccountProfileRepository(database.db).updateProfile({
        userId,
        profile: {
          fullName: `Name ${String(n)}`, displayName: `D${String(n)}`,
          jobTitle: null, department: null, preferredSenderName: null,
        },
        updatedAt: Date.now(),
      });
    }

    const after = await userRow(userId);
    expect(after.email).toBe(before.email);
    expect(after.normalized_email).toBe(before.normalized_email);
    expect(after.password_hash).toBe(before.password_hash);
    expect(after.terms_version).toBe(before.terms_version);
  });
});
