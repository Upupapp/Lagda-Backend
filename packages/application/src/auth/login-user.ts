// Password login.
//
// ── Order, and why ─────────────────────────────────────────────────────────
//
//   1. normalize the email          the SAME rule registration used
//   2. (rate limiting already ran at the route, before any of this)
//   3. look the account up
//   4. VERIFY the password          Argon2id — always, even for unknown accounts
//   5. check eligibility            verified email
//   6. issue a FRESH session
//
// ── Anti-enumeration ───────────────────────────────────────────────────────
//
// An unknown email and a wrong password must be indistinguishable from outside.
// Three things together make that true, and all three are needed:
//
//   * ONE public error. No `EMAIL_NOT_FOUND` versus `WRONG_PASSWORD`.
//   * No metadata on failure. No user id, no created-at, no verification state.
//   * The DUMMY HASH. An unknown account still runs a real Argon2id
//     verification against a fixed hash that authenticates nobody, so the
//     request costs roughly what a real one costs. Returning early for unknown
//     accounts would turn response time into an account-existence oracle
//     (INV-250).
//
// The dummy hash is computed ONCE at composition, never per request — computing
// it per request would double the work and defeat the point.

import type { Clock } from "../common/ports/index.js";
import type { SessionId } from "../common/ports/session.js";
import { normalizeEmail } from "./email-identity.js";
import type {
  AuthUserRecord, MfaFactorType, PasswordHash, PasswordHasher, UserId, UserRepository,
} from "../common/ports/auth.js";

/**
 * What a successful login hands back to the HTTP adapter.
 *
 * `sessionToken` and `csrfToken` are RAW CREDENTIALS. They exist for exactly as
 * long as it takes the route to write two cookies. They are never logged, never
 * serialized into JSON, and never persisted in this form (INV-252).
 */
export interface IssuedCredentials {
  readonly sessionId: SessionId;
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly expiresAt: number;
}

/** Issues a session. Narrowed from BACKEND-13's service to what login needs. */
export interface SessionIssuer {
  readonly issue: (userId: UserId) => Promise<IssuedCredentials>;
}

export interface LoginUserInput {
  readonly email: string;
  readonly password: string;
}

export interface LoginDependencies {
  readonly users: Pick<UserRepository, "findAuthByNormalizedEmail">;
  readonly hasher: PasswordHasher;
  readonly sessions: SessionIssuer;
  readonly clock: Clock;
  /**
   * A valid Argon2id hash that authenticates nobody.
   *
   * Computed once at startup from a random secret nobody keeps. It is not a
   * credential — knowing it grants nothing, because no account references it —
   * but it is not logged either, since a fixed value in logs invites confusion
   * with a real hash.
   */
  readonly dummyPasswordHash: PasswordHash;
  /**
   * Upgrades a stored hash whose parameters are below current policy.
   *
   * Optional. Absent means no rehash-on-login, which is a valid configuration;
   * present, it runs only after a SUCCESSFUL verification, and a failure to
   * persist it never fails the login (§23).
   */
  readonly upgradePasswordHash?: (input: {
    readonly userId: UserId;
    readonly currentHash: PasswordHash;
    readonly newHash: PasswordHash;
  }) => Promise<void>;
  /**
   * The second factor, if the deployment has one.
   *
   * Optional so that BACKEND-20's behaviour is EXACTLY preserved when absent —
   * an account with no MFA takes the same path it always did, and the existing
   * login tests continue to describe reality (§250, §264).
   */
  readonly mfa?: {
    /** Server-authoritative. Reads the factor table, never a client claim. */
    readonly isRequired: (userId: UserId) => Promise<boolean>;
    /**
     * Opens a pre-authentication transaction and returns its RAW credential.
     *
     * Called only after the password verified, so no OTP, email or ceremony is
     * ever created for an unauthenticated guess (§149, §150).
     */
    readonly beginCeremony: (userId: UserId) => Promise<{
      readonly raw: string;
      readonly expiresAt: number;
    }>;
  };
}

/**
 * Why a login was refused.
 *
 * `invalid-credentials` deliberately covers BOTH an unknown account and a wrong
 * password. The distinction exists in telemetry, never in a response.
 */
export type LoginFailure =
  | { readonly kind: "invalid-credentials" }
  | { readonly kind: "email-not-verified" };

export type LoginResult =
  | {
    /**
     * The password was correct AND the account requires a second factor.
     *
     * A DISTINCT outcome, not a flag on the authenticated one. `authenticated`
     * carries `credentials`; this carries none, so "a session exists before MFA
     * completed" is not a state the type system can even express (§50, §251).
     *
     * Reached only after the password verifies, which is what keeps MFA
     * enrolment from being discoverable by anyone who knows an address
     * (§123, §125).
     */
    readonly outcome: "mfa-required";
    readonly userId: UserId;
    readonly factor: MfaFactorType;
    /** The RAW pre-auth credential. Goes in a cookie, never a body, never a log. */
    readonly pendingCredential: string;
    readonly pendingExpiresAt: number;
  }
  | {
    readonly outcome: "authenticated";
    readonly userId: UserId;
    readonly email: string;
    readonly displayName: string;
    readonly credentials: IssuedCredentials;
  }
  | {
    readonly outcome: "rejected";
    readonly failure: LoginFailure;
    /**
     * Which internal path produced the rejection.
     *
     * For TELEMETRY ONLY, and it must never reach a response — it is exactly
     * the distinction anti-enumeration exists to hide.
     */
    readonly telemetryReason: "unknown-account" | "wrong-password" | "unverified";
  };

export async function loginUser(
  input: LoginUserInput,
  deps: LoginDependencies,
): Promise<LoginResult> {
  const email = normalizeEmail(input.email);

  // A malformed address cannot match any account. It still runs the dummy
  // verification: returning early here would make "is this even a valid
  // address" measurable, and more importantly it keeps ONE exit path for every
  // credential failure.
  const account: AuthUserRecord | null = email.outcome === "ok"
    ? await deps.users.findAuthByNormalizedEmail(email.normalized)
    : null;

  if (account === null) {
    // The dummy path. Real Argon2id work against a hash that belongs to nobody,
    // so an unknown account costs what a known one costs.
    //
    // The result is deliberately ignored — it is always false, because no
    // password matches a hash derived from a random secret. Ignoring it is the
    // point: nothing about this call can succeed.
    await deps.hasher.verify(input.password, deps.dummyPasswordHash);
    return {
      outcome: "rejected",
      failure: { kind: "invalid-credentials" },
      telemetryReason: "unknown-account",
    };
  }

  const correct = await deps.hasher.verify(input.password, account.passwordHash);
  if (!correct) {
    return {
      outcome: "rejected",
      failure: { kind: "invalid-credentials" },
      telemetryReason: "wrong-password",
    };
  }

  // ── Eligibility ─────────────────────────────────────────────────────────
  //
  // Reached ONLY after the password verified, which is what makes it safe to
  // be specific here: the caller has already demonstrated control of the
  // credential, so telling them the account needs verification reveals nothing
  // they could not already confirm. The same response for a WRONG password
  // would be an enumeration oracle (INV-251).
  if (account.emailVerifiedAt === null) {
    return {
      outcome: "rejected",
      failure: { kind: "email-not-verified" },
      telemetryReason: "unverified",
    };
  }

  // ── Rehash, before the session ──────────────────────────────────────────
  //
  // Only on success, only outside a transaction, and never fatal: a login that
  // failed because a housekeeping upgrade could not be written would be a
  // worse outcome than a hash staying at older parameters for one more login.
  if (deps.upgradePasswordHash !== undefined && deps.hasher.needsRehash(account.passwordHash)) {
    try {
      const newHash = await deps.hasher.hash(input.password);
      await deps.upgradePasswordHash({
        userId: account.userId, currentHash: account.passwordHash, newHash,
      });
    } catch {
      // Deliberately swallowed. The user is authenticated either way.
    }
  }

  // ── Second factor? ──────────────────────────────────────────────────────
  //
  // Server-derived, after the password. Nothing the client sent participates,
  // and an attacker who does not know the password never reaches this line —
  // so login cannot be used to discover who has MFA enabled (§87, §150, §213).
  if (deps.mfa !== undefined && await deps.mfa.isRequired(account.userId)) {
    const pending = await deps.mfa.beginCeremony(account.userId);
    // NO session, NO credentials. The ceremony is incomplete, and the return
    // type has no place to put one (§41).
    return {
      outcome: "mfa-required",
      userId: account.userId,
      factor: "TOTP",
      pendingCredential: pending.raw,
      pendingExpiresAt: pending.expiresAt,
    };
  }

  // ── A FRESH session ─────────────────────────────────────────────────────
  //
  // Always newly issued, never derived from a cookie the client sent. A login
  // that adopted an incoming credential would let an attacker fix a session
  // and then have the victim authenticate it (INV-253).
  const credentials = await deps.sessions.issue(account.userId);

  return {
    outcome: "authenticated",
    userId: account.userId,
    email: account.email,
    displayName: account.displayName,
    credentials,
  };
}
