// Multi-factor authentication against REAL PostgreSQL.
//
// The attempt counter is why this file exists. A 6-digit TOTP code is one
// million possibilities, and what stands between an attacker holding a stolen
// password and a working session is that the counter is honest when five
// requests arrive at once. A fake repository can be made to agree with any
// claim about that; only two real transactions touching one row can show it.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TOTP, Secret } from "otpauth";
import {
  registerUser, loginUser, requestPasswordReset, resetPassword,
  completeMfaChallenge, beginMfaEnrolment, confirmMfaEnrolment, disableMfa,
  requiresMfa, MFA_MAX_ATTEMPTS, PENDING_AUTH_TTL_MS,
  type LoginDependencies, type RegisterUserDependencies,
  type RequestPasswordResetDependencies, type ResetPasswordDependencies,
  type CompleteMfaDependencies, type BeginEnrolmentDependencies,
  type ConfirmEnrolmentDependencies, type DisableMfaDependencies,
  type PasswordHash, type UserId, type VerificationChallengeId,
  type PasswordResetChallengeId, type MfaFactorId, type RecoveryCodeId,
  type PendingAuthenticationId, createSessionService,
} from "@lagda/application";
import {
  createTestDatabase, hasIntegrationDatabase, createUserRepository,
  createVerificationChallengeRepository, createPasswordResetRepository,
  createPasswordResettableUserRepository, createSessionRepository,
  createMfaFactorRepository, createRecoveryCodeRepository,
  createPendingAuthenticationRepository, type LagdaDatabase,
} from "@lagda/db";
import {
  createArgon2PasswordHasher, createVerificationTokenFactory,
  createResetTokenFactory, createSecurityTokenGenerator,
  createSecurityTokenDigester, digestSubmittedResetToken,
  createSecretBox, generateSecretBoxKey,
  generateTotpSecret, buildProvisioningUri, verifyTotp, timeStepFor,
  isWellFormedTotpCode, issueRecoveryCodes, digestSubmittedRecoveryCode,
  createPreAuthCredentialFactory, digestPreAuthToken,
} from "@lagda/api";

const PASSWORD = "correct horse battery staple";
const LABEL = "user@example.com";

describe.skipIf(!hasIntegrationDatabase())("multi-factor authentication", () => {
  let database: LagdaDatabase;
  const hasher = createArgon2PasswordHasher();
  const verificationTokens = createVerificationTokenFactory();
  const resetTokens = createResetTokenFactory();
  const preAuth = createPreAuthCredentialFactory();
  const secretBox = createSecretBox({
    keyBase64: generateSecretBoxKey(), keyVersion: "test-v1",
  });
  let dummyHash: PasswordHash;
  let sessions: ReturnType<typeof createSessionService>;

  const totpEngine = {
    generateSecret: () => generateTotpSecret(),
    buildProvisioningUri: (secret: string, label: string) =>
      buildProvisioningUri(secret as never, label),
    verify: (input: {
      secret: string; code: string; nowMs: number; accountLabel: string;
    }) => verifyTotp({
      secret: input.secret as never, code: input.code,
      nowMs: input.nowMs, accountLabel: input.accountLabel,
    }),
    isWellFormedCode: isWellFormedTotpCode,
  };
  const recoveryFactory = {
    issue: issueRecoveryCodes,
    digestSubmitted: digestSubmittedRecoveryCode,
  };

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
    await database.db.deleteFrom("mfa_recovery_codes").execute();
    await database.db.deleteFrom("pending_authentications").execute();
    await database.db.deleteFrom("mfa_factors").execute();
    await database.db.deleteFrom("password_reset_challenges").execute();
    await database.db.deleteFrom("email_verification_challenges").execute();
    await database.db.deleteFrom("user_sessions").execute();
    await database.db.deleteFrom("users").execute();
  });

  let seq = 0;
  const nextId = (prefix: string): string => {
    seq += 1;
    return `${prefix}_${String(seq)}_${String(Date.now() % 100000)}`;
  };

  function registerDeps(): RegisterUserDependencies {
    return {
      users: createUserRepository(database.db),
      challenges: createVerificationChallengeRepository(database.db),
      hasher,
      tokens: verificationTokens,
      clock: { now: () => Date.now() },
      newUserId: () => nextId("usr") as UserId,
      newChallengeId: () => nextId("evc") as VerificationChallengeId,
      commit: operation => database.db.transaction().execute(trx => operation({
        users: createUserRepository(trx),
        challenges: createVerificationChallengeRepository(trx),
      })),
      termsVersion: "2026-01-01",
      verificationTtlMs: 86_400_000,
    };
  }

  const accountLabelFor = async (userId: UserId): Promise<string | null> => {
    const row = await database.db.selectFrom("users").select("email")
      .where("user_id", "=", userId).executeTakeFirst();
    return row?.email ?? null;
  };

  const enrollDeps = (): BeginEnrolmentDependencies => ({
    clock: { now: () => Date.now() },
    totp: totpEngine,
    sealer: secretBox,
    newFactorId: () => nextId("mfa") as MfaFactorId,
    accountLabelFor,
    commit: operation => database.db.transaction().execute(trx => operation({
      factors: createMfaFactorRepository(trx),
    })),
  });

  const confirmDeps = (): ConfirmEnrolmentDependencies => ({
    clock: { now: () => Date.now() },
    totp: totpEngine,
    sealer: secretBox,
    recoveryCodes: recoveryFactory,
    newRecoveryCodeId: () => nextId("rec") as RecoveryCodeId,
    accountLabelFor,
    commit: operation => database.db.transaction().execute(trx => operation({
      factors: createMfaFactorRepository(trx),
      recovery: createRecoveryCodeRepository(trx),
    })),
  });

  const verifyDeps = (): CompleteMfaDependencies => ({
    clock: { now: () => Date.now() },
    totp: totpEngine,
    sealer: secretBox,
    recoveryCodes: recoveryFactory,
    pendingCredentials: preAuth,
    accountLabelFor,
    commit: operation => database.db.transaction().execute(trx => operation({
      pending: createPendingAuthenticationRepository(trx),
      factors: createMfaFactorRepository(trx),
      recovery: createRecoveryCodeRepository(trx),
    })),
  });

  const disableDeps = (): DisableMfaDependencies => ({
    clock: { now: () => Date.now() },
    hasher,
    passwordHashFor: async userId => {
      const row = await database.db.selectFrom("users").select("password_hash")
        .where("user_id", "=", userId).executeTakeFirst();
      return (row?.password_hash ?? null) as PasswordHash | null;
    },
    commit: operation => database.db.transaction().execute(trx => operation({
      factors: createMfaFactorRepository(trx),
      recovery: createRecoveryCodeRepository(trx),
      pending: createPendingAuthenticationRepository(trx),
    })),
  });

  const mfaLoginDependency = {
    isRequired: (userId: UserId) =>
      requiresMfa(userId, createMfaFactorRepository(database.db)),
    beginCeremony: async (userId: UserId) => {
      const issued = preAuth.issue();
      const now = Date.now();
      await createPendingAuthenticationRepository(database.db).create({
        pendingId: nextId("pnd") as PendingAuthenticationId,
        userId,
        credentialDigest: issued.digest,
        createdAt: now,
        expiresAt: now + PENDING_AUTH_TTL_MS,
        maxAttempts: MFA_MAX_ATTEMPTS,
        authenticationMethod: "PASSWORD",
      });
      return { raw: issued.raw, expiresAt: now + PENDING_AUTH_TTL_MS };
    },
  };

  const loginDeps = (withMfa = true): LoginDependencies => ({
    users: createUserRepository(database.db),
    hasher,
    sessions: { issue: userId => sessions.issue(userId) },
    clock: { now: () => Date.now() },
    dummyPasswordHash: dummyHash,
    ...(withMfa ? { mfa: mfaLoginDependency } : {}),
  });

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
      pendingAuth: createPendingAuthenticationRepository(trx),
    })),
  });

  let issuedResetToken = "";
  const requestDeps = (): RequestPasswordResetDependencies => ({
    tokens: {
      issue() {
        const issued = resetTokens.issue();
        issuedResetToken = issued.raw;
        return issued;
      },
    },
    clock: { now: () => Date.now() },
    newChallengeId: () => nextId("prc") as PasswordResetChallengeId,
    resetTtlMs: 3_600_000,
    commit: operation => database.db.transaction().execute(trx => operation({
      challenges: createPasswordResetRepository(trx),
      users: createPasswordResettableUserRepository(trx),
    })),
  });

  // ── Fixtures ─────────────────────────────────────────────────────────────

  async function registerVerified(email: string): Promise<UserId> {
    const result = await registerUser({
      email, password: PASSWORD, displayName: "Real User", acceptedTerms: true,
    }, registerDeps());
    if (result.outcome !== "registered") throw new Error("fixture failed");
    await database.db.updateTable("users")
      .set({ email_verified_at: new Date() })
      .where("user_id", "=", result.userId).execute();
    return result.userId;
  }

  /** Enrols and CONFIRMS, returning the secret so tests can produce codes. */
  async function enableMfa(userId: UserId): Promise<{
    secret: string; recoveryCodes: readonly string[];
  }> {
    const begun = await beginMfaEnrolment(userId, enrollDeps());
    if (begun.outcome !== "started") throw new Error("fixture failed");
    // Confirmed with a code from the PREVIOUS time step, inside the skew
    // window. Enrolment burns the step it uses, so confirming with the CURRENT
    // step would leave every following login in this fixture looking like a
    // replay — which is the watermark working, not a bug. See the dedicated
    // test below.
    const code = codeFor(begun.enrolment.secret, Date.now() - 30_000);
    const confirmed = await confirmMfaEnrolment({ userId, code }, confirmDeps());
    if (confirmed.outcome !== "enabled") throw new Error("fixture failed");
    return { secret: begun.enrolment.secret, recoveryCodes: confirmed.recoveryCodes };
  }

  /** Generates the code an authenticator would show. */
  function codeFor(secret: string, atMs: number): string {
    return new TOTP({
      issuer: "LAGDA", label: LABEL, algorithm: "SHA1", digits: 6, period: 30,
      secret: Secret.fromBase32(secret),
    }).generate({ timestamp: atMs });
  }

  const factorRow = (userId: UserId) =>
    database.db.selectFrom("mfa_factors").selectAll()
      .where("user_id", "=", userId).executeTakeFirst();

  // ── Enrolment ────────────────────────────────────────────────────────────

  it("enrolment stores an ENCRYPTED secret, never plaintext", async () => {
    const userId = await registerVerified("enrol@example.com");
    const begun = await beginMfaEnrolment(userId, enrollDeps());
    if (begun.outcome !== "started") throw new Error("unexpected");

    const row = await factorRow(userId);
    expect(row?.secret_ciphertext).not.toBeNull();
    // The plaintext base32 secret must not appear anywhere in the row.
    expect(JSON.stringify(row)).not.toContain(begun.enrolment.secret);
    // And it round-trips through the box.
    expect(secretBox.open(row?.secret_ciphertext ?? "")).toBe(begun.enrolment.secret);
    expect(row?.secret_key_version).toBe("test-v1");
  });

  it("a begun enrolment is NOT active until confirmed", async () => {
    const userId = await registerVerified("pending@example.com");
    await beginMfaEnrolment(userId, enrollDeps());

    const row = await factorRow(userId);
    expect(row?.verified_at).toBeNull();
    // And login is unaffected — abandoning setup cannot lock anyone out.
    expect(await requiresMfa(userId, createMfaFactorRepository(database.db)))
      .toBe(false);
  });

  it("confirming with a correct code enables MFA and issues recovery codes", async () => {
    const userId = await registerVerified("confirm@example.com");
    const { recoveryCodes } = await enableMfa(userId);

    const row = await factorRow(userId);
    expect(row?.verified_at).not.toBeNull();
    expect(await requiresMfa(userId, createMfaFactorRepository(database.db)))
      .toBe(true);

    expect(recoveryCodes).toHaveLength(10);
    for (const code of recoveryCodes) {
      expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    }
    // Digest-only storage: no displayed code appears in the table.
    const rows = await database.db.selectFrom("mfa_recovery_codes").selectAll()
      .where("user_id", "=", userId).execute();
    expect(rows).toHaveLength(10);
    const serialized = JSON.stringify(rows);
    for (const code of recoveryCodes) {
      expect(serialized).not.toContain(code.replace(/-/g, ""));
    }
  });

  it("confirming with a WRONG code does not enable MFA", async () => {
    const userId = await registerVerified("wrongconfirm@example.com");
    await beginMfaEnrolment(userId, enrollDeps());

    const result = await confirmMfaEnrolment(
      { userId, code: "000000" }, confirmDeps());
    expect(result.outcome).toBe("invalid-code");
    expect((await factorRow(userId))?.verified_at).toBeNull();
  });

  it("re-enrolling an already-enabled account is refused", async () => {
    const userId = await registerVerified("reenrol@example.com");
    await enableMfa(userId);

    const again = await beginMfaEnrolment(userId, enrollDeps());
    // Silently replacing a working factor is an account-takeover primitive for
    // anyone holding a stolen session.
    expect(again.outcome).toBe("already-enabled");
  });

  // ── Login ────────────────────────────────────────────────────────────────

  it("password alone yields NO session for an MFA account", async () => {
    const userId = await registerVerified("login@example.com");
    await enableMfa(userId);

    const result = await loginUser(
      { email: "login@example.com", password: PASSWORD }, loginDeps());

    expect(result.outcome).toBe("mfa-required");
    if (result.outcome !== "mfa-required") return;
    expect(result.factor).toBe("TOTP");
    // The type carries no credentials at all, and no session row was written.
    const live = await database.db.selectFrom("user_sessions").selectAll()
      .where("user_id", "=", userId).execute();
    expect(live).toHaveLength(0);
  });

  it("an account WITHOUT MFA is unchanged — BACKEND-20 behaviour preserved", async () => {
    await registerVerified("nomfa@example.com");
    const result = await loginUser(
      { email: "nomfa@example.com", password: PASSWORD }, loginDeps());
    expect(result.outcome).toBe("authenticated");
  });

  it("a WRONG password reveals nothing about MFA enrolment", async () => {
    const withMfa = await registerVerified("hasmfa@example.com");
    await enableMfa(withMfa);
    await registerVerified("nomfa2@example.com");

    const a = await loginUser(
      { email: "hasmfa@example.com", password: "wrong password entirely" },
      loginDeps());
    const b = await loginUser(
      { email: "nomfa2@example.com", password: "wrong password entirely" },
      loginDeps());
    const c = await loginUser(
      { email: "ghost@example.com", password: "wrong password entirely" },
      loginDeps());

    // All three identical. MFA enrolment is not discoverable without the
    // password (§123, §125, §265).
    for (const result of [a, b, c]) {
      expect(result.outcome).toBe("rejected");
      if (result.outcome !== "rejected") return;
      expect(result.failure.kind).toBe("invalid-credentials");
    }
    // And no ceremony was created for any of them.
    const pending = await database.db.selectFrom("pending_authentications")
      .selectAll().execute();
    expect(pending).toHaveLength(0);
  });

  // ── Completing the second factor ─────────────────────────────────────────

  async function beginLogin(email: string): Promise<string> {
    const result = await loginUser({ email, password: PASSWORD }, loginDeps());
    if (result.outcome !== "mfa-required") throw new Error("expected mfa");
    return result.pendingCredential;
  }

  it("a correct TOTP code completes the ceremony", async () => {
    const userId = await registerVerified("complete@example.com");
    const { secret } = await enableMfa(userId);
    const credential = await beginLogin("complete@example.com");

    const result = await completeMfaChallenge(
      { pendingCredential: credential, code: codeFor(secret, Date.now()) },
      verifyDeps());

    expect(result.outcome).toBe("authenticated");
    if (result.outcome !== "authenticated") return;
    expect(result.method).toBe("PASSWORD_PLUS_TOTP");

    const row = await database.db.selectFrom("pending_authentications")
      .selectAll().where("user_id", "=", userId).executeTakeFirst();
    expect(row?.consumed_at).not.toBeNull();
  });

  it("a wrong code increments the counter and issues nothing", async () => {
    const userId = await registerVerified("wrongcode@example.com");
    await enableMfa(userId);
    const credential = await beginLogin("wrongcode@example.com");

    const result = await completeMfaChallenge(
      { pendingCredential: credential, code: "000000" }, verifyDeps());
    expect(result.outcome).toBe("rejected");

    const row = await database.db.selectFrom("pending_authentications")
      .selectAll().where("user_id", "=", userId).executeTakeFirst();
    expect(row?.failed_attempts).toBe(1);
    expect(row?.consumed_at).toBeNull();
  });

  it("a CORRECT code after exhaustion still fails", async () => {
    const userId = await registerVerified("exhaust@example.com");
    const { secret } = await enableMfa(userId);
    const credential = await beginLogin("exhaust@example.com");

    for (let attempt = 0; attempt < MFA_MAX_ATTEMPTS; attempt += 1) {
      await completeMfaChallenge(
        { pendingCredential: credential, code: "000000" }, verifyDeps());
    }

    // The real code, on a dead ceremony. This is the property §32 asks for:
    // exhaustion is terminal, not merely a pause.
    const result = await completeMfaChallenge(
      { pendingCredential: credential, code: codeFor(secret, Date.now()) },
      verifyDeps());
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.reason).toBe("attempts-exhausted");
  });

  it("CONCURRENT wrong attempts cannot exceed the maximum", async () => {
    const userId = await registerVerified("race@example.com");
    await enableMfa(userId);
    const credential = await beginLogin("race@example.com");

    // Eight at once against a limit of five. A read-then-write counter would
    // let most of these each read the same value and write the same increment,
    // buying an attacker many guesses for the price of one.
    //
    // Eight rather than more because each is its own transaction and the test
    // pool is finite — twelve exhausted it and failed on connection timeout
    // rather than on the property under test.
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      completeMfaChallenge(
        { pendingCredential: credential, code: String(index).padStart(6, "0") },
        verifyDeps())));

    const row = await database.db.selectFrom("pending_authentications")
      .selectAll().where("user_id", "=", userId).executeTakeFirst();
    expect(row?.failed_attempts).toBe(MFA_MAX_ATTEMPTS);
  });

  it("CONCURRENT correct codes complete the ceremony exactly once", async () => {
    const userId = await registerVerified("double@example.com");
    const { secret } = await enableMfa(userId);
    const credential = await beginLogin("double@example.com");
    const code = codeFor(secret, Date.now());

    const results = await Promise.all(Array.from({ length: 4 }, () =>
      completeMfaChallenge(
        { pendingCredential: credential, code }, verifyDeps())));

    // Exactly one authentication. Four would mean four sessions from one
    // ceremony (§37, §163).
    expect(results.filter(r => r.outcome === "authenticated")).toHaveLength(1);
  });

  it("two codes from DIFFERENT steps race to one session", async () => {
    const userId = await registerVerified("steprace@example.com");
    const { secret } = await enableMfa(userId);
    const credential = await beginLogin("steprace@example.com");

    // The skew window makes steps N-1 and N BOTH valid, and they are different
    // codes — so the replay watermark does not serialize them the way two
    // copies of one code would. Each advances the watermark independently, and
    // the only thing left preventing two sessions from one ceremony is the
    // conditional consume.
    //
    // Found by probing: deleting that guard broke nothing, because every
    // existing concurrency test happened to submit the SAME code.
    const results = await Promise.all([
      completeMfaChallenge(
        { pendingCredential: credential, code: codeFor(secret, Date.now()) },
        verifyDeps()),
      completeMfaChallenge(
        {
          pendingCredential: credential,
          code: codeFor(secret, Date.now() - 30_000),
        }, verifyDeps()),
    ]);

    expect(results.filter(r => r.outcome === "authenticated")).toHaveLength(1);
  });

  it("REPLAYING a code that already authenticated fails", async () => {
    const userId = await registerVerified("replay@example.com");
    const { secret } = await enableMfa(userId);
    const code = codeFor(secret, Date.now());

    const first = await completeMfaChallenge(
      { pendingCredential: await beginLogin("replay@example.com"), code },
      verifyDeps());
    expect(first.outcome).toBe("authenticated");

    // A fresh ceremony, the SAME still-valid code. Without the time-step
    // watermark this succeeds for up to 90 seconds (§191).
    const second = await completeMfaChallenge(
      { pendingCredential: await beginLogin("replay@example.com"), code },
      verifyDeps());
    expect(second.outcome).toBe("rejected");

    expect(userId).toBeTruthy();
  });

  it("the enrolment code cannot be REPLAYED as a login code", async () => {
    const userId = await registerVerified("enrolreplay@example.com");
    const begun = await beginMfaEnrolment(userId, enrollDeps());
    if (begun.outcome !== "started") throw new Error("unexpected");

    const code = codeFor(begun.enrolment.secret, Date.now());
    expect((await confirmMfaEnrolment({ userId, code }, confirmDeps())).outcome)
      .toBe("enabled");

    // The SAME code, now against a login. Enrolment and login share one
    // watermark deliberately: someone who observes the confirmation code over a
    // shoulder must not be able to turn it straight into a session.
    //
    // The cost is that a user who enrols and signs in within the same 30-second
    // window waits for the next code. Recorded in MFA_SECURITY.md.
    const result = await completeMfaChallenge(
      { pendingCredential: await beginLogin("enrolreplay@example.com"), code },
      verifyDeps());
    expect(result.outcome).toBe("rejected");
  });

  it("an EXPIRED ceremony cannot be completed with a correct code", async () => {
    const userId = await registerVerified("expired@example.com");
    const { secret } = await enableMfa(userId);
    const credential = await beginLogin("expired@example.com");

    const past = new Date(Date.now() - 2 * PENDING_AUTH_TTL_MS);
    await database.db.updateTable("pending_authentications")
      .set({ created_at: new Date(past.getTime() - 1000), expires_at: past })
      .where("user_id", "=", userId).execute();

    const result = await completeMfaChallenge(
      { pendingCredential: credential, code: codeFor(secret, Date.now()) },
      verifyDeps());
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.reason).toBe("pending-expired");
  });

  it("a ceremony for user A cannot be completed by user B's code", async () => {
    const alice = await registerVerified("alice@example.com");
    await enableMfa(alice);
    const bob = await registerVerified("bob@example.com");
    const bobSecret = (await enableMfa(bob)).secret;

    const aliceCeremony = await beginLogin("alice@example.com");
    const result = await completeMfaChallenge(
      { pendingCredential: aliceCeremony, code: codeFor(bobSecret, Date.now()) },
      verifyDeps());

    // The ceremony resolves the user; the code is checked against THAT user's
    // factor. Bob's authenticator cannot sign Alice in (§221).
    expect(result.outcome).toBe("rejected");
  });

  it("a malformed code still costs an attempt", async () => {
    const userId = await registerVerified("malformed@example.com");
    await enableMfa(userId);
    const credential = await beginLogin("malformed@example.com");

    // Neither a 6-digit code nor a recovery code. If this were free, an
    // attacker would have unlimited guesses simply by varying the length
    // between real attempts (§34).
    await completeMfaChallenge(
      { pendingCredential: credential, code: "12345" }, verifyDeps());

    const row = await database.db.selectFrom("pending_authentications")
      .selectAll().where("user_id", "=", userId).executeTakeFirst();
    expect(row?.failed_attempts).toBe(1);
  });

  it("a leading-zero code is handled exactly", () => {
    // The code is a STRING. `parseInt("004218")` is 4218, which matches
    // nothing — and a codebase that converts would fail for roughly 1 login in
    // 10, intermittently, which is the worst kind of bug to diagnose (§165).
    expect(isWellFormedTotpCode("004218")).toBe(true);
    expect(isWellFormedTotpCode("4218")).toBe(false);

    const secret = generateTotpSecret();
    // Search forward for a timestamp whose code genuinely starts with a zero,
    // so the assertion exercises a real one rather than a hand-written string.
    let found: { at: number; code: string } | null = null;
    for (let step = 0; step < 3000 && found === null; step += 1) {
      const at = Date.now() + step * 30_000;
      const code = codeFor(secret, at);
      if (code.startsWith("0")) found = { at, code };
    }
    expect(found).not.toBeNull();
    if (found === null) return;
    expect(verifyTotp({
      secret, code: found.code, nowMs: found.at, accountLabel: LABEL,
    }).valid).toBe(true);
  });

  // ── Recovery codes ───────────────────────────────────────────────────────

  it("a recovery code completes the ceremony and is single-use", async () => {
    const userId = await registerVerified("recovery@example.com");
    const { recoveryCodes } = await enableMfa(userId);
    const code = recoveryCodes[0] ?? "";

    const first = await completeMfaChallenge(
      { pendingCredential: await beginLogin("recovery@example.com"), code },
      verifyDeps());
    expect(first.outcome).toBe("authenticated");
    if (first.outcome !== "authenticated") return;
    expect(first.method).toBe("PASSWORD_PLUS_RECOVERY_CODE");
    expect(first.recoveryCodesRemaining).toBe(9);

    const second = await completeMfaChallenge(
      { pendingCredential: await beginLogin("recovery@example.com"), code },
      verifyDeps());
    expect(second.outcome).toBe("rejected");
  });

  it("two DIFFERENT recovery codes on one ceremony yield one session", async () => {
    const userId = await registerVerified("recrace@example.com");
    const { recoveryCodes } = await enableMfa(userId);
    const credential = await beginLogin("recrace@example.com");

    // The path the TOTP tests cannot reach: with two different valid codes
    // there is no shared time-step watermark to serialize them, so the only
    // thing preventing two sessions from one ceremony is the conditional
    // consume of the pending authentication itself.
    //
    // Found by probing — deleting that guard broke no test until this existed.
    const results = await Promise.all([
      completeMfaChallenge(
        { pendingCredential: credential, code: recoveryCodes[0] ?? "" },
        verifyDeps()),
      completeMfaChallenge(
        { pendingCredential: credential, code: recoveryCodes[1] ?? "" },
        verifyDeps()),
    ]);

    expect(results.filter(r => r.outcome === "authenticated")).toHaveLength(1);

    const rows = await database.db.selectFrom("pending_authentications")
      .selectAll().where("user_id", "=", userId).execute();
    expect(rows.filter(r => r.consumed_at !== null)).toHaveLength(1);
  });

  it("one user's recovery code cannot sign in another user", async () => {
    const alice = await registerVerified("ralice@example.com");
    await enableMfa(alice);
    const bob = await registerVerified("rbob@example.com");
    const bobCodes = (await enableMfa(bob)).recoveryCodes;

    const result = await completeMfaChallenge(
      {
        pendingCredential: await beginLogin("ralice@example.com"),
        code: bobCodes[0] ?? "",
      }, verifyDeps());
    expect(result.outcome).toBe("rejected");

    // And Bob's code is still unused — a cross-user attempt must not burn it.
    const rows = await database.db.selectFrom("mfa_recovery_codes").selectAll()
      .where("user_id", "=", bob).where("consumed_at", "is", null).execute();
    expect(rows).toHaveLength(10);
  });

  // ── Disable ──────────────────────────────────────────────────────────────

  it("disabling requires the current password", async () => {
    const userId = await registerVerified("disable@example.com");
    await enableMfa(userId);

    const wrong = await disableMfa(
      { userId, password: "not the password" }, disableDeps());
    expect(wrong.outcome).toBe("invalid-password");
    expect(await requiresMfa(userId, createMfaFactorRepository(database.db)))
      .toBe(true);

    const right = await disableMfa({ userId, password: PASSWORD }, disableDeps());
    expect(right.outcome).toBe("disabled");
    expect(await requiresMfa(userId, createMfaFactorRepository(database.db)))
      .toBe(false);
  });

  it("disabling removes recovery codes and revokes ceremonies", async () => {
    const userId = await registerVerified("cleanup@example.com");
    await enableMfa(userId);
    await beginLogin("cleanup@example.com");

    await disableMfa({ userId, password: PASSWORD }, disableDeps());

    const codes = await database.db.selectFrom("mfa_recovery_codes").selectAll()
      .where("user_id", "=", userId).execute();
    expect(codes).toHaveLength(0);

    const pending = await database.db.selectFrom("pending_authentications")
      .selectAll().where("user_id", "=", userId).executeTakeFirstOrThrow();
    expect(pending.revoked_at).not.toBeNull();
  });

  it("after disabling, password alone authenticates again", async () => {
    const userId = await registerVerified("afterdisable@example.com");
    await enableMfa(userId);
    await disableMfa({ userId, password: PASSWORD }, disableDeps());

    const result = await loginUser(
      { email: "afterdisable@example.com", password: PASSWORD }, loginDeps());
    expect(result.outcome).toBe("authenticated");
  });

  // ── Cross-feature ────────────────────────────────────────────────────────

  it("password reset REVOKES a pending MFA ceremony", async () => {
    const userId = await registerVerified("resetmfa@example.com");
    const { secret } = await enableMfa(userId);
    const credential = await beginLogin("resetmfa@example.com");

    await requestPasswordReset("resetmfa@example.com", requestDeps());
    const reset = await resetPassword(
      { token: issuedResetToken, newPassword: "an entirely new passphrase" },
      resetDeps());
    expect(reset.outcome).toBe("reset");

    // The ceremony was a proof of the OLD password. Finishing it now would mean
    // the reset did not actually revoke the attacker's progress (§105, §174).
    const result = await completeMfaChallenge(
      { pendingCredential: credential, code: codeFor(secret, Date.now()) },
      verifyDeps());
    expect(result.outcome).toBe("rejected");
  });

  it("password reset leaves MFA ENABLED", async () => {
    const userId = await registerVerified("keepmfa@example.com");
    await enableMfa(userId);

    await requestPasswordReset("keepmfa@example.com", requestDeps());
    await resetPassword(
      { token: issuedResetToken, newPassword: "an entirely new passphrase" },
      resetDeps());

    // §197 Model A. A password reset must not be a way to strip the second
    // factor — that would make the weaker credential able to remove the
    // stronger one.
    expect(await requiresMfa(userId, createMfaFactorRepository(database.db)))
      .toBe(true);
  });

  it("an email-verification or reset credential cannot satisfy MFA", async () => {
    const userId = await registerVerified("domains@example.com");
    await enableMfa(userId);
    const credential = await beginLogin("domains@example.com");

    // A reset token presented as a second factor. Different domain, different
    // shape, different table — it is not a code and not a recovery code.
    const resetToken = resetTokens.issue().raw;
    const result = await completeMfaChallenge(
      { pendingCredential: credential, code: resetToken.slice(0, 14) },
      verifyDeps());
    expect(result.outcome).toBe("rejected");
    expect(userId).toBeTruthy();
  });

  // ── Pre-auth credential ──────────────────────────────────────────────────

  it("the pre-auth credential is stored as a digest only", async () => {
    const userId = await registerVerified("preauth@example.com");
    await enableMfa(userId);
    const credential = await beginLogin("preauth@example.com");

    const row = await database.db.selectFrom("pending_authentications")
      .selectAll().where("user_id", "=", userId).executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain(credential);
    expect(row.credential_digest).toBe(digestPreAuthToken(credential));
  });

  it("a malformed pre-auth credential is refused without a query", async () => {
    const result = await completeMfaChallenge(
      { pendingCredential: "nonsense", code: "123456" }, verifyDeps());
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.reason).toBe("pending-not-found");
  });

  it("the ceremony's absolute expiry is 10 minutes and is not extended", async () => {
    const userId = await registerVerified("ttl@example.com");
    await enableMfa(userId);
    await beginLogin("ttl@example.com");

    const row = await database.db.selectFrom("pending_authentications")
      .selectAll().where("user_id", "=", userId).executeTakeFirstOrThrow();
    expect(row.expires_at.getTime() - row.created_at.getTime())
      .toBe(PENDING_AUTH_TTL_MS);
    expect(row.max_attempts).toBe(MFA_MAX_ATTEMPTS);
  });

  // ── Repository conditions, tested DIRECTLY ───────────────────────────────
  //
  // The use case checks these too, and that redundancy is deliberate defence in
  // depth. But probing showed the redundant caller MASKS them: deleting the
  // repository's conditions broke no test, because the application check
  // returned first. A control whose only test runs through a redundant caller
  // is a control that can be deleted silently.

  it("consumeIfUsable refuses an EXHAUSTED ceremony", async () => {
    const userId = await registerVerified("directexhaust@example.com");
    await enableMfa(userId);
    await beginLogin("directexhaust@example.com");

    const row = await database.db.selectFrom("pending_authentications")
      .selectAll().where("user_id", "=", userId).executeTakeFirstOrThrow();
    await database.db.updateTable("pending_authentications")
      .set({ failed_attempts: MFA_MAX_ATTEMPTS })
      .where("pending_id", "=", row.pending_id).execute();

    const repository = createPendingAuthenticationRepository(database.db);
    expect(await repository.consumeIfUsable({
      pendingId: row.pending_id as PendingAuthenticationId, now: Date.now(),
    })).toBe(false);
  });

  it("consumeIfUsable refuses an already-consumed or revoked ceremony", async () => {
    const userId = await registerVerified("directconsume@example.com");
    await enableMfa(userId);
    await beginLogin("directconsume@example.com");

    const row = await database.db.selectFrom("pending_authentications")
      .selectAll().where("user_id", "=", userId).executeTakeFirstOrThrow();
    const repository = createPendingAuthenticationRepository(database.db);
    const pendingId = row.pending_id as PendingAuthenticationId;

    // The FIRST consume wins; a second matches nothing. This is what makes
    // "exactly one session per ceremony" true when the replay watermark is not
    // the thing doing the work — a recovery code, for instance, has no
    // watermark at all.
    expect(await repository.consumeIfUsable({ pendingId, now: Date.now() }))
      .toBe(true);
    expect(await repository.consumeIfUsable({ pendingId, now: Date.now() }))
      .toBe(false);
  });

  it("consumeIfUsable refuses an expired ceremony", async () => {
    const userId = await registerVerified("directexpiry@example.com");
    await enableMfa(userId);
    await beginLogin("directexpiry@example.com");

    const row = await database.db.selectFrom("pending_authentications")
      .selectAll().where("user_id", "=", userId).executeTakeFirstOrThrow();
    expect(await createPendingAuthenticationRepository(database.db)
      .consumeIfUsable({
        pendingId: row.pending_id as PendingAuthenticationId,
        now: row.expires_at.getTime() + 1,
      })).toBe(false);
  });

  it("recordFailedAttempt never passes the ceiling", async () => {
    const userId = await registerVerified("directcount@example.com");
    await enableMfa(userId);
    await beginLogin("directcount@example.com");

    const row = await database.db.selectFrom("pending_authentications")
      .selectAll().where("user_id", "=", userId).executeTakeFirstOrThrow();
    const repository = createPendingAuthenticationRepository(database.db);
    const pendingId = row.pending_id as PendingAuthenticationId;

    for (let n = 1; n <= MFA_MAX_ATTEMPTS; n += 1) {
      const result = await repository.recordFailedAttempt({ pendingId });
      expect(result.failedAttempts).toBe(n);
      expect(result.exhausted).toBe(n === MFA_MAX_ATTEMPTS);
    }
    // Past the ceiling the counter STOPS rather than violating the CHECK.
    const beyond = await repository.recordFailedAttempt({ pendingId });
    expect(beyond.exhausted).toBe(true);
    expect(beyond.failedAttempts).toBe(MFA_MAX_ATTEMPTS);
  });

  // ── The skew window ──────────────────────────────────────────────────────

  it("the clock-skew window is NARROW", () => {
    const secret = generateTotpSecret();
    const now = Date.now();

    // One step either way is accepted — real phones drift.
    for (const offset of [-30_000, 0, 30_000]) {
      expect(verifyTotp({
        secret, code: codeFor(secret, now + offset), nowMs: now,
        accountLabel: LABEL,
      }).valid).toBe(true);
    }
    // Beyond that, refused. Every extra step multiplies the number of
    // simultaneously-valid codes, which is how "a code I saw ten minutes ago"
    // stays useful (§190).
    for (const offset of [-120_000, -60_000, 60_000, 120_000, 600_000]) {
      expect(verifyTotp({
        secret, code: codeFor(secret, now + offset), nowMs: now,
        accountLabel: LABEL,
      }).valid).toBe(false);
    }
  });

  // ── Database constraints ─────────────────────────────────────────────────

  it("the database refuses a second ACTIVE factor for one user", async () => {
    const userId = await registerVerified("onefactor@example.com");
    await enableMfa(userId);

    await expect(
      database.db.insertInto("mfa_factors").values({
        factor_id: "mfa_dupe", user_id: userId, factor_type: "TOTP",
        secret_ciphertext: secretBox.seal("JBSWY3DPEHPK3PXP"),
        secret_key_version: "test-v1",
        created_at: new Date(), verified_at: null, disabled_at: null,
        last_used_time_step: null,
      }).execute(),
    ).rejects.toThrow(/mfa_factor_one_active/);
  });

  it("the database refuses an unknown factor type", async () => {
    const userId = await registerVerified("badtype@example.com");
    await expect(
      database.db.insertInto("mfa_factors").values({
        factor_id: "mfa_sms", user_id: userId, factor_type: "SMS",
        secret_ciphertext: null, secret_key_version: null,
        created_at: new Date(), verified_at: null, disabled_at: null,
        last_used_time_step: null,
      }).execute(),
    ).rejects.toThrow(/mfa_factor_type_known/);
  });

  it("the database refuses attempts above the maximum", async () => {
    const userId = await registerVerified("overflow@example.com");
    await enableMfa(userId);
    await beginLogin("overflow@example.com");

    await expect(
      database.db.updateTable("pending_authentications")
        .set({ failed_attempts: MFA_MAX_ATTEMPTS + 1 })
        .where("user_id", "=", userId).execute(),
    ).rejects.toThrow(/pending_auth_attempts_bounded/);
  });

  // ── Secret box ───────────────────────────────────────────────────────────

  it("a tampered ciphertext does not decrypt", () => {
    const sealed = secretBox.seal("JBSWY3DPEHPK3PXP");
    const parts = sealed.split(".");
    // Flip the ciphertext. GCM AUTHENTICATES, so this must not produce an
    // attacker-chosen secret — which would mean choosing which codes work.
    const tampered = [parts[0], parts[1], "AAAAAAAA", parts[3]].join(".");
    expect(() => secretBox.open(tampered)).toThrow();
  });

  it("each seal uses a fresh IV", () => {
    const a = secretBox.seal("JBSWY3DPEHPK3PXP");
    const b = secretBox.seal("JBSWY3DPEHPK3PXP");
    // Same plaintext, different ciphertext. IV reuse under one key is GCM's
    // catastrophic failure mode.
    expect(a).not.toBe(b);
    expect(secretBox.open(a)).toBe(secretBox.open(b));
  });

  it("a wrong key cannot open a sealed secret", () => {
    const sealed = secretBox.seal("JBSWY3DPEHPK3PXP");
    const other = createSecretBox({
      keyBase64: generateSecretBoxKey(), keyVersion: "other",
    });
    expect(() => other.open(sealed)).toThrow();
  });

  it("the time step advances only forwards", () => {
    const now = Date.now();
    expect(timeStepFor(now + 30_000)).toBe(timeStepFor(now) + 1);
  });
});
