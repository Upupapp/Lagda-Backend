// Email identity, password policy, and the registration use case.

import { describe, it, expect } from "vitest";
import {
  normalizeEmail, assertNormalized, MAX_EMAIL_LENGTH,
  checkPassword, registerUser, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH,
  EmailAlreadyRegisteredError,
  type PasswordHash, type RegisterUserDependencies,
  type UserId, type UserRecord, type VerificationChallengeId,
  type NewUser, type NewVerificationChallenge, type VerificationTokenDigest,
} from "../index.js";

// ── Email identity ───────────────────────────────────────────────────────────

describe("email normalization", () => {
  it("trims and lowercases, keeping the display form", () => {
    const result = normalizeEmail("  User@Example.COM  ");
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.normalized).toBe("user@example.com");
    // The display form keeps the user's casing; only the lookup key is folded.
    expect(result.display).toBe("User@Example.COM");
  });

  it("maps case variants to ONE account identity", () => {
    // The property login depends on: a user who typed their address differently
    // at signup must still resolve to the same account.
    const forms = ["user@example.com", "User@Example.com", "USER@EXAMPLE.COM"];
    const keys = forms.map(f => {
      const r = normalizeEmail(f);
      return r.outcome === "ok" ? r.normalized : "";
    });
    expect(new Set(keys).size).toBe(1);
  });

  it("does NOT apply provider-specific alias rewrites", () => {
    // Gmail treats dots as insignificant; most servers do not. Rewriting here
    // would merge two genuinely different mailboxes into one account, which in
    // an auth system is an account takeover primitive.
    const dotted = normalizeEmail("john.smith@gmail.com");
    const plain = normalizeEmail("johnsmith@gmail.com");
    expect(dotted.outcome === "ok" && plain.outcome === "ok"
      && dotted.normalized !== plain.normalized).toBe(true);

    // Plus-addressing is a legitimate way to keep separate accounts.
    const tagged = normalizeEmail("user+one@example.com");
    const bare = normalizeEmail("user@example.com");
    expect(tagged.outcome === "ok" && bare.outcome === "ok"
      && tagged.normalized !== bare.normalized).toBe(true);

    // googlemail.com is not rewritten to gmail.com either.
    const alt = normalizeEmail("user@googlemail.com");
    expect(alt.outcome === "ok" && alt.normalized).toBe("user@googlemail.com");
  });

  it("lowercases independently of the ambient locale", () => {
    // `toLowerCase()` folds a dotted capital I differently under a Turkish
    // locale. An account key that changes with the server's locale is a key
    // that changes when the server does.
    const result = normalizeEmail("USER@EXAMPLE.COM");
    expect(result.outcome === "ok" && result.normalized).toBe("user@example.com");
  });

  it("rejects empty, overlong and malformed addresses", () => {
    expect(normalizeEmail("   ")).toMatchObject({ reason: "empty" });
    expect(normalizeEmail(`${"a".repeat(MAX_EMAIL_LENGTH)}@x.com`))
      .toMatchObject({ reason: "too-long" });
    for (const bad of ["no-at-sign", "no@domain", "sp ace@x.com", "@x.com", "a@b"]) {
      expect(normalizeEmail(bad)).toMatchObject({ reason: "malformed" });
    }
  });

  it("refuses a non-normalized value at a repository boundary", () => {
    // A repository must receive a canonical key, never normalize one itself —
    // a second normalization rule would drift from the first.
    expect(() => assertNormalized("User@Example.com")).toThrow(TypeError);
    expect(assertNormalized("user@example.com")).toBe("user@example.com");
  });

  it("preserves unicode local parts rather than mangling them", () => {
    // Whatever the behaviour is, it is examined rather than assumed. LAGDA does
    // no Unicode normalization: two visually identical addresses with different
    // code points stay distinct, which is conservative and predictable.
    const result = normalizeEmail("josé@example.com");
    expect(result.outcome === "ok" && result.normalized).toBe("josé@example.com");
  });
});

// ── Password policy ──────────────────────────────────────────────────────────

describe("password policy", () => {
  it("enforces the boundaries exactly", () => {
    expect(checkPassword("a".repeat(PASSWORD_MIN_LENGTH - 1))).toBe("too-short");
    expect(checkPassword("a".repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(checkPassword("a".repeat(PASSWORD_MAX_LENGTH))).toBeNull();
    expect(checkPassword("a".repeat(PASSWORD_MAX_LENGTH + 1))).toBe("too-long");
  });

  it("accepts passphrases, unicode and spaces without composition rules", () => {
    // No forced uppercase/digit/symbol: those push users toward `Password1!`,
    // which is both predictable and shorter than a passphrase.
    for (const password of [
      "correct horse battery staple",
      "日本語のパスワードです",
      "  leading and trailing  ",
      "🔐🔐🔐🔐🔐🔐🔐🔐",
    ]) {
      expect(checkPassword(password)).toBeNull();
    }
  });

  it("does not alter the password it is given", () => {
    // Trimming would mean the password a user typed is not the password LAGDA
    // stored, and two different inputs would authenticate one account.
    const padded = "  spaces matter  ";
    expect(checkPassword(padded)).toBeNull();
    expect(padded).toBe("  spaces matter  ");
  });
});

// ── Registration ─────────────────────────────────────────────────────────────

const VALID = {
  email: "New.User@Example.com",
  password: "correct horse battery staple",
  displayName: "New User",
  organization: "Mabini Legal",
  intendedUse: "legal-professional",
  acceptedTerms: true,
};

interface Harness {
  readonly deps: RegisterUserDependencies;
  readonly created: NewUser[];
  readonly challenges: NewVerificationChallenge[];
  readonly order: string[];
  readonly hashCalls: string[];
}

function harness(overrides: {
  existing?: UserRecord | null;
  failCommit?: boolean;
  duplicateOnInsert?: boolean;
} = {}): Harness {
  const created: NewUser[] = [];
  const challenges: NewVerificationChallenge[] = [];
  const order: string[] = [];
  const hashCalls: string[] = [];

  const users = {
    create(user: NewUser) {
      order.push("insert-user");
      if (overrides.duplicateOnInsert === true) {
        return Promise.reject(new EmailAlreadyRegisteredError());
      }
      created.push(user);
      return Promise.resolve();
    },
    findByNormalizedEmail() {
      order.push("lookup");
      return Promise.resolve(overrides.existing ?? null);
    },
    findAuthByNormalizedEmail: () => Promise.resolve(null),
  };

  const challengeRepo = {
    create(challenge: NewVerificationChallenge) {
      order.push("insert-challenge");
      challenges.push(challenge);
      return Promise.resolve();
    },
  };

  const deps: RegisterUserDependencies = {
    users,
    challenges: challengeRepo,
    hasher: {
      hash(plaintext: string) {
        order.push("hash");
        hashCalls.push(plaintext);
        return Promise.resolve(`$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$${plaintext.length}` as PasswordHash);
      },
      verify: () => Promise.resolve(false),
      needsRehash: () => false,
    },
    tokens: {
      issue: () => ({
        raw: "raw-verification-token-value",
        digest: "a".repeat(64) as VerificationTokenDigest,
      }),
    },
    clock: { now: () => 1_700_000_000_000 },
    newUserId: () => "usr_1" as UserId,
    newChallengeId: () => "evc_1" as VerificationChallengeId,
    commit(operation) {
      order.push("begin");
      if (overrides.failCommit === true) return Promise.reject(new Error("db down"));
      return operation({ users, challenges: challengeRepo });
    },
    termsVersion: "2026-01-01",
    verificationTtlMs: 24 * 60 * 60 * 1000,
  };

  return { deps, created, challenges, order, hashCalls };
}

describe("registerUser", () => {
  it("creates an UNVERIFIED account with a verification challenge", async () => {
    const h = harness();
    const result = await registerUser(VALID, h.deps);

    expect(result.outcome).toBe("registered");
    if (result.outcome !== "registered") return;
    // Never derived from "registration succeeded".
    expect(result.emailVerified).toBe(false);
    expect(h.created[0]?.normalizedEmail).toBe("new.user@example.com");
    // The display form keeps the user's casing.
    expect(h.created[0]?.email).toBe("New.User@Example.com");
    expect(h.challenges).toHaveLength(1);
  });

  it("HASHES only after every cheap check, and outside the transaction", async () => {
    // Both orderings matter: hashing a password that fails a length rule is
    // free work for an attacker, and hashing inside a transaction holds a
    // connection for the length of a deliberately slow operation.
    const h = harness();
    await registerUser(VALID, h.deps);

    expect(h.order.indexOf("lookup")).toBeLessThan(h.order.indexOf("hash"));
    expect(h.order.indexOf("hash")).toBeLessThan(h.order.indexOf("begin"));
    expect(h.order.indexOf("begin")).toBeLessThan(h.order.indexOf("insert-user"));
  });

  it("does NOT hash when the password fails policy", async () => {
    const h = harness();
    const result = await registerUser({ ...VALID, password: "short" }, h.deps);

    expect(result).toMatchObject({ outcome: "rejected" });
    expect(h.order).not.toContain("hash");
  });

  it("does NOT hash when the email is malformed", async () => {
    const h = harness();
    await registerUser({ ...VALID, email: "not-an-email" }, h.deps);
    expect(h.order).not.toContain("hash");
  });

  it("does NOT hash when the email is already registered", async () => {
    const h = harness({
      existing: {
        userId: "usr_existing" as UserId, email: "x@y.com", displayName: "X",
        emailVerifiedAt: null, createdAt: 0,
      },
    });
    const result = await registerUser(VALID, h.deps);

    expect(result).toMatchObject({
      outcome: "rejected", failure: { kind: "email-already-registered" },
    });
    expect(h.order).not.toContain("hash");
    expect(h.created).toHaveLength(0);
  });

  it("NEVER overwrites an existing account", async () => {
    // Account takeover: a public registration that updated an existing user's
    // password would let anyone reset any unverified account.
    const h = harness({
      existing: {
        userId: "usr_existing" as UserId, email: "victim@example.com",
        displayName: "Victim", emailVerifiedAt: null, createdAt: 0,
      },
    });
    await registerUser({ ...VALID, email: "victim@example.com" }, h.deps);

    // No insert, and — because the repository has no update method at all — no
    // possible path to modifying the existing row.
    expect(h.created).toHaveLength(0);
    expect(h.order).not.toContain("insert-user");
  });

  it("treats a unique-constraint race as a duplicate, not an error", async () => {
    // The window the pre-check cannot close: another registration commits
    // between the lookup and the insert.
    const h = harness({ duplicateOnInsert: true });
    const result = await registerUser(VALID, h.deps);

    expect(result).toMatchObject({
      outcome: "rejected", failure: { kind: "email-already-registered" },
    });
  });

  it("requires terms acceptance", async () => {
    const h = harness();
    const result = await registerUser({ ...VALID, acceptedTerms: false }, h.deps);
    expect(result).toMatchObject({ failure: { kind: "terms-not-accepted" } });
    expect(h.order).not.toContain("hash");
  });

  it("records WHICH terms version was accepted, and when", async () => {
    const h = harness();
    await registerUser(VALID, h.deps);
    expect(h.created[0]?.termsVersion).toBe("2026-01-01");
    expect(h.created[0]?.termsAcceptedAt).toBe(1_700_000_000_000);
  });

  it("writes the challenge DIGEST and returns the raw token separately", async () => {
    const h = harness();
    const result = await registerUser(VALID, h.deps);

    expect(h.challenges[0]?.tokenDigest).toBe("a".repeat(64));
    // The raw token appears in NOTHING that was persisted.
    const persisted = JSON.stringify({ users: h.created, challenges: h.challenges });
    expect(persisted).not.toContain("raw-verification-token-value");
    // It is returned to the caller, for delivery only.
    expect(result.outcome === "registered" && result.verificationToken)
      .toBe("raw-verification-token-value");
  });

  it("NEVER persists or returns the plaintext password", async () => {
    const marker = "DO_NOT_LOG_REGISTRATION_PASSWORD";
    const h = harness();
    const result = await registerUser({ ...VALID, password: marker }, h.deps);

    const everything = JSON.stringify({
      result, users: h.created, challenges: h.challenges,
    });
    expect(everything).not.toContain(marker);
    // It reached the hasher and nowhere else.
    expect(h.hashCalls).toEqual([marker]);
  });

  it("hands the hasher the password EXACTLY as given", async () => {
    // Trimming or normalizing anywhere in the pipeline would mean two different
    // inputs authenticate one account. `checkPassword` not mutating was already
    // tested; that a trim added elsewhere would be caught was not, and a probe
    // that trimmed inside the use case broke nothing.
    const padded = "  spaces really do matter  ";
    const h = harness();
    await registerUser({ ...VALID, password: padded }, h.deps);
    expect(h.hashCalls).toEqual([padded]);
  });

  it("propagates a commit failure rather than reporting success", async () => {
    const h = harness({ failCommit: true });
    await expect(registerUser(VALID, h.deps)).rejects.toThrow("db down");
    expect(h.created).toHaveLength(0);
  });

  it("normalizes empty optional fields to null rather than empty strings", async () => {
    const h = harness();
    await registerUser({ ...VALID, organization: "   ", intendedUse: "" }, h.deps);
    expect(h.created[0]?.organization).toBeNull();
    expect(h.created[0]?.intendedUse).toBeNull();
  });

  it("gives a caller no way to preset verification or privilege state", async () => {
    // The input type has no field for verification, role or id, so extra
    // properties on an object literal cannot reach persistence. Asserted
    // against what was ACTUALLY written rather than through a spy on a
    // repository the transaction does not use.
    const h = harness();
    await registerUser({
      ...VALID,
      ...({ emailVerified: true, role: "admin", userId: "usr_attacker" } as object),
    }, h.deps);

    const written = h.created[0];
    expect(written).toBeDefined();
    const keys = Object.keys(written as object);
    expect(keys).not.toContain("emailVerified");
    expect(keys).not.toContain("role");
    // The id is server-generated, never the one supplied.
    expect(written?.userId).toBe("usr_1");
  });
});
