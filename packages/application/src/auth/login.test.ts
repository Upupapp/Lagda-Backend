// Password login.
//
// The properties under test are mostly about what does NOT differ: an unknown
// account and a wrong password must be indistinguishable from outside, and the
// only way to assert that is to drive both and compare.

import { describe, it, expect, vi } from "vitest";
import {
  loginUser,
  type AuthUserRecord, type IssuedCredentials, type LoginDependencies,
  type NormalizedEmail, type PasswordHash, type SessionId, type UserId,
} from "../index.js";

const DUMMY = "$argon2id$v=19$m=19456,p=1,t=2$ZHVtbXlzYWx0$ZHVtbXloYXNo" as PasswordHash;
const REAL = "$argon2id$v=19$m=19456,p=1,t=2$cmVhbHNhbHQ$cmVhbGhhc2g" as PasswordHash;
const PASSWORD = "correct horse battery staple";

function account(overrides: Partial<AuthUserRecord> = {}): AuthUserRecord {
  return {
    userId: "usr_1" as UserId,
    email: "User@Example.com",
    displayName: "Real User",
    emailVerifiedAt: 1_700_000_000_000,
    createdAt: 0,
    normalizedEmail: "user@example.com" as NormalizedEmail,
    passwordHash: REAL,
    ...overrides,
  };
}

interface Harness {
  readonly deps: LoginDependencies;
  readonly verifyCalls: { password: string; hash: string }[];
  readonly issued: string[];
  readonly upgrades: { userId: string }[];
}

function harness(overrides: {
  found?: AuthUserRecord | null;
  passwordCorrect?: boolean;
  needsRehash?: boolean;
  withUpgrade?: boolean;
  failUpgrade?: boolean;
} = {}): Harness {
  const verifyCalls: { password: string; hash: string }[] = [];
  const issued: string[] = [];
  const upgrades: { userId: string }[] = [];

  const deps: LoginDependencies = {
    users: {
      findAuthByNormalizedEmail: () =>
        Promise.resolve(overrides.found === undefined ? account() : overrides.found),
    },
    hasher: {
      hash: () => Promise.resolve("$argon2id$v=19$m=65536,p=1,t=3$bmV3$bmV3" as PasswordHash),
      verify(password: string, hash: PasswordHash) {
        verifyCalls.push({ password, hash });
        // The dummy hash NEVER authenticates, whatever the password.
        if (hash === DUMMY) return Promise.resolve(false);
        return Promise.resolve(overrides.passwordCorrect ?? true);
      },
      needsRehash: () => overrides.needsRehash ?? false,
    },
    sessions: {
      issue(userId: UserId): Promise<IssuedCredentials> {
        issued.push(userId);
        return Promise.resolve({
          sessionId: `ses_${String(issued.length)}` as SessionId,
          sessionToken: `raw-session-token-${String(issued.length)}`,
          csrfToken: `raw-csrf-token-${String(issued.length)}`,
          expiresAt: 1_700_000_000_000 + 8 * 3_600_000,
        });
      },
    },
    clock: { now: () => 1_700_000_000_000 },
    dummyPasswordHash: DUMMY,
    ...(overrides.withUpgrade === true
      ? {
        upgradePasswordHash: (input) => {
          if (overrides.failUpgrade === true) return Promise.reject(new Error("db down"));
          upgrades.push({ userId: input.userId });
          return Promise.resolve();
        },
      }
      : {}),
  };

  return { deps, verifyCalls, issued, upgrades };
}

const login = (h: Harness, email = "user@example.com", password = PASSWORD) =>
  loginUser({ email, password }, h.deps);

describe("login", () => {
  it("authenticates a verified account and issues a FRESH session", async () => {
    const h = harness();
    const result = await login(h);

    expect(result.outcome).toBe("authenticated");
    if (result.outcome !== "authenticated") return;
    expect(result.userId).toBe("usr_1");
    expect(h.issued).toEqual(["usr_1"]);
    expect(result.credentials.sessionToken).toBe("raw-session-token-1");
  });

  it("uses the SAME email normalization as registration", async () => {
    // A login that normalized differently would fail to find accounts that
    // registration created.
    for (const form of ["User@Example.com", "  USER@EXAMPLE.COM  ", "user@example.com"]) {
      const h = harness();
      expect((await login(h, form)).outcome).toBe("authenticated");
    }
  });

  it("does NOT normalize the password", async () => {
    // Passwords are case-sensitive and space-significant.
    const h = harness();
    await login(h, "user@example.com", "  Mixed Case Password  ");
    expect(h.verifyCalls[0]?.password).toBe("  Mixed Case Password  ");
  });

  // ── Anti-enumeration ─────────────────────────────────────────────────────

  it("gives an UNKNOWN account and a WRONG password identical public results", async () => {
    // The decisive property. Any difference here — status, code, shape — is an
    // account-existence oracle.
    const unknown = await login(harness({ found: null }));
    const wrong = await login(harness({ passwordCorrect: false }));

    expect(unknown.outcome).toBe("rejected");
    expect(wrong.outcome).toBe("rejected");
    if (unknown.outcome !== "rejected" || wrong.outcome !== "rejected") return;
    expect(unknown.failure).toEqual(wrong.failure);
    expect(unknown.failure).toEqual({ kind: "invalid-credentials" });
  });

  it("runs a REAL Argon2 verification for an unknown account", async () => {
    // Without this, an unknown account returns before any expensive work and
    // response time becomes an existence oracle.
    const h = harness({ found: null });
    await login(h);

    expect(h.verifyCalls).toHaveLength(1);
    expect(h.verifyCalls[0]?.hash).toBe(DUMMY);
    expect(h.verifyCalls[0]?.password).toBe(PASSWORD);
  });

  it("runs the dummy verification for a MALFORMED email too", async () => {
    // Returning early on a malformed address would make "is this a valid
    // shape" measurable, and would create a second exit path for a credential
    // failure.
    const h = harness({ found: null });
    const result = await login(h, "not-an-email");

    expect(result).toMatchObject({ failure: { kind: "invalid-credentials" } });
    expect(h.verifyCalls[0]?.hash).toBe(DUMMY);
  });

  it("NEVER authenticates against the dummy hash", async () => {
    // Even if a caller somehow submitted a password matching it.
    const h = harness({ found: null, passwordCorrect: true });
    const result = await login(h);
    expect(result.outcome).toBe("rejected");
    expect(h.issued).toHaveLength(0);
  });

  it("leaks no account metadata on failure", async () => {
    const h = harness({ passwordCorrect: false });
    const result = await login(h);

    const serialized = JSON.stringify(result);
    for (const leak of ["usr_1", "Real User", "User@Example.com", REAL, "emailVerifiedAt"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("distinguishes the cause in TELEMETRY only", async () => {
    // Operators need to know whether they are seeing credential stuffing
    // against real accounts or spray against random ones. The distinction lives
    // here and must not reach a response.
    const unknown = await login(harness({ found: null }));
    const wrong = await login(harness({ passwordCorrect: false }));
    expect(unknown).toMatchObject({ telemetryReason: "unknown-account" });
    expect(wrong).toMatchObject({ telemetryReason: "wrong-password" });
  });

  it("creates NO session on any failure", async () => {
    for (const h of [
      harness({ found: null }),
      harness({ passwordCorrect: false }),
      harness({ found: account({ emailVerifiedAt: null }) }),
    ]) {
      await login(h);
      expect(h.issued).toHaveLength(0);
    }
  });

  // ── Verification policy ──────────────────────────────────────────────────

  it("REFUSES an unverified account after a correct password", async () => {
    // MEASURED from SignIn.tsx: the unverified path routes to /verify-email and
    // never calls platform.signIn, so no authenticated session is created.
    const h = harness({ found: account({ emailVerifiedAt: null }) });
    const result = await login(h);

    expect(result).toMatchObject({ failure: { kind: "email-not-verified" } });
    expect(h.issued).toHaveLength(0);
  });

  it("does NOT reveal unverified state for a WRONG password", async () => {
    // The specific response is safe only because the caller proved control of
    // the credential. For a wrong password it would be an enumeration oracle.
    const h = harness({
      found: account({ emailVerifiedAt: null }), passwordCorrect: false,
    });
    expect(await login(h)).toMatchObject({ failure: { kind: "invalid-credentials" } });
  });

  it("checks verification AFTER the password, not before", async () => {
    // Checking first would let an attacker learn verification state without
    // knowing the password.
    const h = harness({ found: account({ emailVerifiedAt: null }) });
    await login(h);
    expect(h.verifyCalls).toHaveLength(1);
  });

  // ── Rehash ───────────────────────────────────────────────────────────────

  it("upgrades a weak hash only after a SUCCESSFUL login", async () => {
    const h = harness({ needsRehash: true, withUpgrade: true });
    await login(h);
    expect(h.upgrades).toEqual([{ userId: "usr_1" }]);
  });

  it("never rehashes on a failed login", async () => {
    const h = harness({ needsRehash: true, withUpgrade: true, passwordCorrect: false });
    await login(h);
    expect(h.upgrades).toHaveLength(0);
  });

  it("still authenticates when the rehash cannot be persisted", async () => {
    // A login that failed because housekeeping failed would be a worse outcome
    // than a hash staying at older parameters for one more login.
    const h = harness({ needsRehash: true, withUpgrade: true, failUpgrade: true });
    const result = await login(h);
    expect(result.outcome).toBe("authenticated");
    expect(h.issued).toEqual(["usr_1"]);
  });

  it("does not rehash when the stored hash is current", async () => {
    const h = harness({ needsRehash: false, withUpgrade: true });
    await login(h);
    expect(h.upgrades).toHaveLength(0);
  });

  // ── Session issuance ─────────────────────────────────────────────────────

  it("issues a DIFFERENT credential for each login", async () => {
    // Two logins must not share a raw token, and no login may echo one that
    // was handed in.
    const h = harness();
    const first = await login(h);
    const second = await login(h);
    if (first.outcome !== "authenticated" || second.outcome !== "authenticated") return;

    expect(first.credentials.sessionToken).not.toBe(second.credentials.sessionToken);
    expect(first.credentials.csrfToken).not.toBe(second.credentials.csrfToken);
    expect(first.credentials.sessionId).not.toBe(second.credentials.sessionId);
  });

  it("issues the session only after everything else passed", async () => {
    const issue = vi.fn(() => Promise.resolve({
      sessionId: "ses_1" as SessionId, sessionToken: "t", csrfToken: "c", expiresAt: 0,
    }));
    const h = harness({ passwordCorrect: false });
    await loginUser({ email: "user@example.com", password: PASSWORD },
      { ...h.deps, sessions: { issue } });
    expect(issue).not.toHaveBeenCalled();
  });
});
