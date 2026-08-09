// The authenticated account: current-user projection, profile editing,
// preferences, password change, and session management.
//
// ── The boundary this file exists to hold ──────────────────────────────────
//
// An account row carries four kinds of state, and only ONE of them is editable
// here:
//
//   ACCOUNT IDENTITY   email, normalized_email, email_verified_at
//   SECURITY STATE     password_hash, MFA factors, sessions, challenges
//   PROFILE            full name, display name, job title, department, sender name
//   PREFERENCES        timezone, locale, formats, appearance
//
// The first two are reachable only through dedicated security use cases. The
// protection is not a filter that could be forgotten — it is that
// `AccountProfileRepository` has NO METHOD that can write them. A profile
// handler cannot set `email_verified_at` because no function exists to call
// (§19, §102, §245).
//
// ── Email change is NOT here ───────────────────────────────────────────────
//
// The product's profile page renders the address read-only: "Contact support to
// change your account email." So there is no self-service email change to build,
// and none is built. The security requirements for a future one are recorded in
// ACCOUNT_SECURITY_BOUNDARIES.md rather than implemented speculatively (§43).

import type { Clock } from "../common/ports/index.js";
import { checkPassword, type PasswordRejection } from "../auth/register-user.js";
import type {
  PasswordHash, PasswordHasher, UserId,
} from "../common/ports/auth.js";
import type { RevocationReason, SessionId } from "../common/ports/session.js";

// ── Vocabularies ─────────────────────────────────────────────────────────────
//
// Closed sets, matching the database CHECKs and the product's own selects. A
// value the UI cannot render should not be storable.

export const DATE_FORMATS = ["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"] as const;
export const TIME_FORMATS = ["12h", "24h"] as const;
export const NUMBER_FORMATS = ["comma-dot", "dot-comma", "space-dot"] as const;
export const APPEARANCES = ["system", "light", "dark"] as const;
export const DENSITIES = ["comfortable", "compact"] as const;
export const DOCUMENT_LIST_VIEWS = ["table", "grid"] as const;

export type DateFormat = (typeof DATE_FORMATS)[number];
export type TimeFormat = (typeof TIME_FORMATS)[number];
export type NumberFormat = (typeof NUMBER_FORMATS)[number];
export type Appearance = (typeof APPEARANCES)[number];
export type Density = (typeof DENSITIES)[number];
export type DocumentListView = (typeof DOCUMENT_LIST_VIEWS)[number];

/**
 * The editable profile. A SINGLE `fullName`, matching the product.
 *
 * Not `firstName` / `lastName`. The product's own form asks for one name, and
 * splitting it would misfit mononyms, patronymics, and the compound surnames
 * that are ordinary in the Philippines — which is not a hypothetical concern for
 * a Philippine legaltech product (§13).
 *
 * Every field is optional-and-nullable rather than defaulting to `""`, so
 * "never filled in" stays distinguishable from "deliberately cleared" (§114).
 */
export interface UserProfileFields {
  readonly fullName: string | null;
  readonly displayName: string;
  readonly jobTitle: string | null;
  readonly department: string | null;
  readonly preferredSenderName: string | null;
}

export interface UserPreferences {
  /** An IANA identifier, e.g. `Asia/Manila`. Never a raw offset (§29). */
  readonly timezone: string | null;
  readonly locale: string | null;
  readonly language: string | null;
  readonly dateFormat: DateFormat | null;
  readonly timeFormat: TimeFormat | null;
  readonly numberFormat: NumberFormat | null;
  readonly appearance: Appearance | null;
  readonly density: Density | null;
  readonly documentListView: DocumentListView | null;
}

/**
 * The current user, as the account surface sees them.
 *
 * Note what is ABSENT and cannot be added by accident: no `passwordHash`, no
 * `normalizedEmail`, no session, no MFA secret, no challenge state. A field
 * that is not on this type cannot be serialized into a response (§7, INV-238).
 *
 * `emailVerified` is DERIVED. The timestamp itself is not exposed — the product
 * shows a badge, not a date (§10).
 */
export interface CurrentUser {
  readonly userId: UserId;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly profile: UserProfileFields;
  readonly preferences: UserPreferences;
  /** A SUMMARY. Never a secret, a provisioning URI, or challenge state (§8). */
  readonly security: {
    readonly mfaEnabled: boolean;
    readonly mfaFactor: "TOTP" | null;
    readonly recoveryCodesRemaining: number | null;
  };
  readonly createdAt: number;
}

// ── Ports ────────────────────────────────────────────────────────────────────

/**
 * The account repository, with a deliberately narrow surface.
 *
 * There is no `update(userId, fields)`. A generic patch is the mechanism by
 * which `password_hash` and `email_verified_at` become reachable from a
 * profile route, and the absence of one is what makes mass assignment
 * structurally impossible rather than merely filtered (§101, §238, §243).
 */
export interface AccountProfileRepository {
  readonly findCurrentUser: (userId: UserId) => Promise<CurrentUser | null>;
  /** Writes PROFILE columns only. Cannot reach identity or credentials. */
  readonly updateProfile: (input: {
    readonly userId: UserId;
    readonly profile: UserProfileFields;
    readonly updatedAt: number;
  }) => Promise<boolean>;
  /** Writes PREFERENCE columns only. */
  readonly updatePreferences: (input: {
    readonly userId: UserId;
    readonly preferences: UserPreferences;
    readonly updatedAt: number;
  }) => Promise<boolean>;
}

/** The credential capability password change needs, and nothing more. */
export interface AccountCredentialRepository {
  readonly findPasswordHash: (userId: UserId) => Promise<PasswordHash | null>;
  readonly replacePasswordHash: (input: {
    readonly userId: UserId;
    readonly passwordHash: PasswordHash;
  }) => Promise<boolean>;
}

/** A session, as its OWNER may see it. */
export interface SessionSummary {
  readonly sessionId: SessionId;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly isCurrent: boolean;
}

export interface AccountSessionRepository {
  /**
   * Lists a user's live sessions.
   *
   * No token, no digest, no IP, no user agent — the product's own sessions page
   * states it shows "no full IP addresses, exact locations, session tokens, or
   * device fingerprints", and the backend records none of them anyway (§89).
   */
  readonly listActiveForUser: (userId: UserId) => Promise<readonly {
    readonly sessionId: SessionId;
    readonly createdAt: number;
    readonly lastSeenAt: number;
    readonly expiresAt: number;
  }[]>;
  /**
   * Revokes one session BELONGING TO a user.
   *
   * Scoped by `userId` AND `sessionId`. A lookup by session id alone would let
   * anyone who guessed or observed an identifier terminate another account's
   * session (§94, §201).
   */
  readonly revokeOwnedByUser: (input: {
    readonly userId: UserId;
    readonly sessionId: SessionId;
    readonly at: number;
    readonly reason: RevocationReason;
  }) => Promise<boolean>;
  readonly revokeAllForUserExcept: (input: {
    readonly userId: UserId;
    readonly keepSessionId: SessionId;
    readonly at: number;
    readonly reason: RevocationReason;
  }) => Promise<number>;
}

/** Revokes in-flight MFA ceremonies. Optional, as in password reset. */
export interface AccountPendingAuthRevoker {
  readonly revokeAllForUser: (input: {
    readonly userId: UserId;
    readonly now: number;
  }) => Promise<number>;
}

// ── Read ─────────────────────────────────────────────────────────────────────

export interface GetCurrentUserDependencies {
  readonly accounts: AccountProfileRepository;
}

/**
 * The current user.
 *
 * Takes a `UserId` that the CALLER obtained from a validated session. There is
 * no email parameter and no lookup by anything a request body could carry —
 * the only way to name an account here is to have already authenticated as it
 * (§4, §20).
 */
export async function getCurrentUser(
  userId: UserId, deps: GetCurrentUserDependencies,
): Promise<CurrentUser | null> {
  return deps.accounts.findCurrentUser(userId);
}

// ── Profile update ───────────────────────────────────────────────────────────

export const NAME_MAX_LENGTH = 200;
export const NAME_MIN_LENGTH = 2;

export type ProfileRejection =
  | "full-name-too-short" | "full-name-too-long" | "display-name-required"
  | "field-too-long" | "control-characters";

/**
 * Rejects control characters, allows everything else printable.
 *
 * NOT an ASCII allowlist. A name may legitimately contain apostrophes, hyphens,
 * spaces, diacritics, and non-Latin scripts — `Ng`, `D'Souza`, `de los Reyes`,
 * `李` are all real names, and a `/^[a-zA-Z ]+$/` would reject a large share of
 * this product's own users.
 *
 * Rejecting punctuation is not an XSS defence either. Profile text is stored as
 * DATA; escaping belongs to whatever renders it (§15, §16).
 */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

function checkText(value: string | null): ProfileRejection | null {
  if (value === null) return null;
  if (value.length > NAME_MAX_LENGTH) return "field-too-long";
  if (CONTROL_CHARACTERS.test(value)) return "control-characters";
  return null;
}

/**
 * Trims surrounding whitespace and maps an empty result to null.
 *
 * `"  "` and `""` both mean "cleared" for an optional field — the product's own
 * form does `form.jobTitle?.trim()`, so a value that is only spaces was never
 * intended as content (§170).
 */
function normalizeOptional(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export interface UpdateProfileInput {
  readonly fullName: string | null;
  readonly displayName: string | null;
  readonly jobTitle: string | null;
  readonly department: string | null;
  readonly preferredSenderName: string | null;
}

export type UpdateProfileResult =
  | { readonly outcome: "updated"; readonly user: CurrentUser }
  | { readonly outcome: "invalid"; readonly reason: ProfileRejection }
  | { readonly outcome: "not-found" };

export interface UpdateProfileDependencies {
  readonly clock: Clock;
  readonly commit: <T>(
    operation: (repositories: {
      readonly accounts: AccountProfileRepository;
    }) => Promise<T>,
  ) => Promise<T>;
}

export async function updateCurrentUserProfile(
  userId: UserId,
  input: UpdateProfileInput,
  deps: UpdateProfileDependencies,
): Promise<UpdateProfileResult> {
  const fullName = normalizeOptional(input.fullName);
  const jobTitle = normalizeOptional(input.jobTitle);
  const department = normalizeOptional(input.department);
  const preferredSenderName = normalizeOptional(input.preferredSenderName);

  if (fullName !== null && fullName.length < NAME_MIN_LENGTH) {
    return { outcome: "invalid", reason: "full-name-too-short" };
  }
  for (const value of [fullName, jobTitle, department, preferredSenderName]) {
    const rejection = checkText(value);
    if (rejection !== null) return { outcome: "invalid", reason: rejection };
  }

  // `displayName` falls back to `fullName`, matching the product's own form:
  // `displayName: form.displayName?.trim() || form.fullName?.trim()`. It is
  // NOT NULL in the schema, so a blank submission with no full name to fall
  // back on is a validation failure rather than a constraint violation.
  const displayName = normalizeOptional(input.displayName) ?? fullName;
  if (displayName === null) {
    return { outcome: "invalid", reason: "display-name-required" };
  }
  const displayRejection = checkText(displayName);
  if (displayRejection !== null) {
    return { outcome: "invalid", reason: displayRejection };
  }

  const now = deps.clock.now();

  return deps.commit(async ({ accounts }) => {
    const updated = await accounts.updateProfile({
      userId,
      profile: {
        fullName, displayName, jobTitle, department,
        // The product defaults this to the full name too.
        preferredSenderName: preferredSenderName ?? fullName,
      },
      updatedAt: now,
    });
    if (!updated) return { outcome: "not-found" };

    // Re-read through the canonical projection rather than echoing the input.
    // Returning the request back would let a response describe state the
    // database never accepted (§27).
    const user = await accounts.findCurrentUser(userId);
    if (user === null) return { outcome: "not-found" };
    return { outcome: "updated", user };
  });
}

// ── Preferences ──────────────────────────────────────────────────────────────

export interface UpdatePreferencesInput {
  readonly timezone?: string | null;
  readonly locale?: string | null;
  readonly language?: string | null;
  readonly dateFormat?: DateFormat | null;
  readonly timeFormat?: TimeFormat | null;
  readonly numberFormat?: NumberFormat | null;
  readonly appearance?: Appearance | null;
  readonly density?: Density | null;
  readonly documentListView?: DocumentListView | null;
}

export type UpdatePreferencesResult =
  | { readonly outcome: "updated"; readonly user: CurrentUser }
  | { readonly outcome: "invalid"; readonly reason: "unknown-timezone" }
  | { readonly outcome: "not-found" };

export interface UpdatePreferencesDependencies {
  readonly clock: Clock;
  /**
   * Whether the runtime recognizes an IANA zone.
   *
   * A port, because the check belongs to the platform's ICU data rather than to
   * the domain — and because a hard-coded list would be wrong the next time the
   * tz database changes, which it does several times a year.
   */
  readonly isKnownTimezone: (value: string) => boolean;
  readonly commit: <T>(
    operation: (repositories: {
      readonly accounts: AccountProfileRepository;
    }) => Promise<T>,
  ) => Promise<T>;
}

/**
 * Whether a value has the SHAPE of an IANA zone identifier.
 *
 * Checked here rather than left to the runtime, because `Intl.DateTimeFormat`
 * accepts `"+08:00"` — measured, not assumed. A port that only asked the
 * platform "do you know this zone?" would happily store a raw offset, which is
 * exactly what §29 exists to prevent: an offset is wrong twice a year wherever
 * daylight saving applies, and cannot be corrected without knowing the zone it
 * came from.
 *
 * IANA identifiers are `Area/Location`, with `UTC` as the documented exception.
 */
function looksLikeIanaZone(value: string): boolean {
  if (value === "UTC") return true;
  if (/^[+-]/.test(value)) return false;
  return /^[A-Za-z][A-Za-z0-9_+-]*\/[A-Za-z0-9_+/-]+$/.test(value);
}

export async function updateCurrentUserPreferences(
  userId: UserId,
  input: UpdatePreferencesInput,
  deps: UpdatePreferencesDependencies,
): Promise<UpdatePreferencesResult> {
  const timezone = normalizeOptional(input.timezone);
  // BOTH checks. The shape rule rejects offsets the runtime would accept; the
  // port rejects well-shaped names the runtime has never heard of.
  if (timezone !== null
    && (!looksLikeIanaZone(timezone) || !deps.isKnownTimezone(timezone))) {
    // Validated against real zone data, so `Asia/Manila` is accepted and
    // `+08:00` is not — an offset is wrong twice a year wherever daylight
    // saving applies, and cannot be corrected without knowing its origin zone.
    return { outcome: "invalid", reason: "unknown-timezone" };
  }

  const now = deps.clock.now();

  return deps.commit(async ({ accounts }) => {
    const current = await accounts.findCurrentUser(userId);
    if (current === null) return { outcome: "not-found" };

    // An absent key LEAVES the stored value alone; an explicit null clears it.
    // The product's preferences form submits the whole set, but a partial
    // submission must not silently blank what it did not mention.
    const merge = <T>(next: T | null | undefined, existing: T | null): T | null =>
      next === undefined ? existing : next;

    await accounts.updatePreferences({
      userId,
      preferences: {
        timezone: input.timezone === undefined
          ? current.preferences.timezone
          : timezone,
        locale: merge(normalizeOptional(input.locale), current.preferences.locale),
        language: merge(
          normalizeOptional(input.language), current.preferences.language),
        dateFormat: merge(input.dateFormat, current.preferences.dateFormat),
        timeFormat: merge(input.timeFormat, current.preferences.timeFormat),
        numberFormat: merge(input.numberFormat, current.preferences.numberFormat),
        appearance: merge(input.appearance, current.preferences.appearance),
        density: merge(input.density, current.preferences.density),
        documentListView: merge(
          input.documentListView, current.preferences.documentListView),
      },
      updatedAt: now,
    });

    const user = await accounts.findCurrentUser(userId);
    if (user === null) return { outcome: "not-found" };
    return { outcome: "updated", user };
  });
}

// ── Password change ──────────────────────────────────────────────────────────

export type ChangePasswordResult =
  | {
    readonly outcome: "changed";
    /** How many OTHER sessions were revoked. A count, never identifiers. */
    readonly revokedSessionCount: number;
  }
  | { readonly outcome: "invalid-current-password" }
  | { readonly outcome: "invalid-new-password"; readonly reason: PasswordRejection }
  | { readonly outcome: "not-found" };

export interface ChangePasswordDependencies {
  readonly clock: Clock;
  readonly hasher: PasswordHasher;
  readonly credentials: Pick<AccountCredentialRepository, "findPasswordHash">;
  readonly commit: <T>(
    operation: (repositories: {
      readonly credentials: AccountCredentialRepository;
      readonly sessions: AccountSessionRepository;
      readonly pendingAuth?: AccountPendingAuthRevoker;
    }) => Promise<T>,
  ) => Promise<T>;
}

/**
 * Changes the password from account settings.
 *
 * Deliberately NOT the password-reset flow. Reset authenticates by possessing a
 * mailed token because the user has lost their password; this authenticates by
 * KNOWING the current one, and the two must not share a path — a settings page
 * that accepted a reset token would let a stolen mailbox change a password
 * without the mailbox owner ever seeing the mail (§35).
 */
export async function changeCurrentPassword(
  userId: UserId,
  input: {
    readonly currentPassword: string;
    readonly newPassword: string;
    readonly currentSessionId: SessionId;
  },
  deps: ChangePasswordDependencies,
): Promise<ChangePasswordResult> {
  // The registration policy, imported. Checked BEFORE the expensive
  // verification, so a hopeless new password costs no Argon2 work (§38).
  const rejection = checkPassword(input.newPassword);
  if (rejection !== null) {
    return { outcome: "invalid-new-password", reason: rejection };
  }

  const currentHash = await deps.credentials.findPasswordHash(userId);
  if (currentHash === null) return { outcome: "not-found" };

  // ── Re-prove the credential (§36) ────────────────────────────────────────
  //
  // A valid session is NOT sufficient. Changing a password from a session
  // someone else stole would lock the real owner out of their own account
  // using nothing but the theft.
  if (!await deps.hasher.verify(input.currentPassword, currentHash)) {
    return { outcome: "invalid-current-password" };
  }

  // Both hashes OUTSIDE the transaction — Argon2 is ~50ms of memory-hard work
  // and must not be holding row locks (§39).
  const newHash = await deps.hasher.hash(input.newPassword);
  const now = deps.clock.now();

  return deps.commit(async ({ credentials, sessions, pendingAuth }) => {
    const replaced = await credentials.replacePasswordHash({
      userId, passwordHash: newHash,
    });
    if (!replaced) return { outcome: "not-found" };

    // ── Session policy: rotate nothing, revoke everything else (§40) ───────
    //
    // The session the user is holding SURVIVES. Logging someone out of the
    // browser they just used to change their password is hostile, and it
    // teaches users that the security action they were told to take breaks
    // things.
    //
    // Every OTHER session dies, because the reason to change a password is
    // usually the suspicion that someone else has one.
    const revokedSessionCount = await sessions.revokeAllForUserExcept({
      userId,
      keepSessionId: input.currentSessionId,
      at: now,
      reason: "password-change",
    });

    // A pending MFA ceremony is a proof of the OLD password (§198).
    if (pendingAuth !== undefined) {
      await pendingAuth.revokeAllForUser({ userId, now });
    }

    return { outcome: "changed", revokedSessionCount };
  });
}

// ── Session management ───────────────────────────────────────────────────────

export interface ListSessionsDependencies {
  readonly sessions: Pick<AccountSessionRepository, "listActiveForUser">;
}

export async function listOwnSessions(
  userId: UserId,
  currentSessionId: SessionId,
  deps: ListSessionsDependencies,
): Promise<readonly SessionSummary[]> {
  const rows = await deps.sessions.listActiveForUser(userId);
  return rows.map(row => ({
    ...row,
    isCurrent: row.sessionId === currentSessionId,
  }));
}

export type RevokeSessionResult =
  | { readonly outcome: "revoked"; readonly wasCurrent: boolean }
  | { readonly outcome: "not-found" };

export interface RevokeSessionDependencies {
  readonly clock: Clock;
  readonly sessions: Pick<AccountSessionRepository, "revokeOwnedByUser">;
}

/**
 * Revokes one of the caller's own sessions.
 *
 * `not-found` covers both "no such session" and "belongs to someone else". They
 * are the same answer on purpose: distinguishing them turns this endpoint into
 * an oracle for which session identifiers exist (§201).
 */
export async function revokeOwnSession(
  userId: UserId,
  input: {
    readonly sessionId: SessionId;
    readonly currentSessionId: SessionId;
  },
  deps: RevokeSessionDependencies,
): Promise<RevokeSessionResult> {
  const revoked = await deps.sessions.revokeOwnedByUser({
    userId,
    sessionId: input.sessionId,
    at: deps.clock.now(),
    reason: "security-action",
  });
  if (!revoked) return { outcome: "not-found" };
  return {
    outcome: "revoked",
    wasCurrent: input.sessionId === input.currentSessionId,
  };
}

export interface RevokeOtherSessionsDependencies {
  readonly clock: Clock;
  readonly sessions: Pick<AccountSessionRepository, "revokeAllForUserExcept">;
}

export async function revokeOtherSessions(
  userId: UserId,
  currentSessionId: SessionId,
  deps: RevokeOtherSessionsDependencies,
): Promise<number> {
  return deps.sessions.revokeAllForUserExcept({
    userId,
    keepSessionId: currentSessionId,
    at: deps.clock.now(),
    reason: "security-action",
  });
}
