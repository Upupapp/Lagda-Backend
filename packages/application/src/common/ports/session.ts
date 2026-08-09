// Browser session security.
//
// Transport-independent by construction: nothing here mentions a cookie, a
// header or a Fastify type. The API adapter extracts the raw credential from
// wherever it arrived and hands it in as a string; this layer decides whether
// it identifies anyone.

import type { UserId } from "@lagda/contracts";

export type SessionId = string & { readonly __brand: "SessionId" };

/**
 * The raw browser credential. **Secret.**
 *
 * A distinct branded type from `SessionId` on purpose. They are easy to confuse
 * and the consequences are asymmetric: a `SessionId` may appear in an internal
 * log line or a future account-security screen, while this must appear in
 * exactly one place — the cookie — and nowhere else, ever.
 */
export type SessionToken = string & { readonly __brand: "SessionToken" };

/** The raw CSRF token. Readable by the frontend by design; still unguessable. */
export type CsrfToken = string & { readonly __brand: "CsrfToken" };

/** Lowercase-hex SHA-256 of a secret. Sensitive, but not a usable credential. */
export type TokenDigest = string & { readonly __brand: "TokenDigest" };

export const REVOCATION_REASONS = [
  "logout", "rotation", "password-change", "security-action", "account-disabled",
] as const;
export type RevocationReason = (typeof REVOCATION_REASONS)[number];

/**
 * Who the caller is. **Nothing about what they may do.**
 *
 * There is no `workspaceId`, no role and no permission list, and that absence is
 * the design. A session answers "which user is this"; whether that user may
 * touch a workspace is membership, resolved per operation (BACKEND-27). Putting
 * a workspace here would let a stale credential carry stale authorization.
 */
export interface AuthenticatedActor {
  readonly actorType: "user";
  readonly userId: UserId;
  readonly sessionId: SessionId;
}

/** A stored session. The raw token is deliberately absent — it is not stored. */
export interface SessionRecord {
  readonly sessionId: SessionId;
  readonly userId: UserId;
  readonly tokenHash: TokenDigest;
  readonly csrfTokenHash: TokenDigest;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly revokedAt?: number;
  readonly revocationReason?: RevocationReason;
}

export interface NewSession {
  readonly sessionId: SessionId;
  readonly userId: UserId;
  readonly tokenHash: TokenDigest;
  readonly csrfTokenHash: TokenDigest;
  readonly createdAt: number;
  readonly expiresAt: number;
}

// ── Ports ────────────────────────────────────────────────────────────────────

/**
 * Session persistence.
 *
 * **Global, not workspace-scoped** — the one deliberate exception to the
 * repository tenancy rule (INV-086). Authentication happens before any
 * workspace is known, so a workspace-scoped session lookup could never run at
 * the moment it is needed. Documented in TENANCY_MODEL.md so a reviewer does
 * not read it as a missed scope.
 *
 * Lookup is by DIGEST. A method taking a raw token would invite a caller to
 * pass one straight to SQL.
 */
export interface SessionRepository {
  findByTokenHash(tokenHash: TokenDigest): Promise<SessionRecord | null>;
  create(session: NewSession): Promise<void>;
  /** Slides the idle window. Throttled by the caller — not every request. */
  touch(sessionId: SessionId, at: number): Promise<void>;
  revoke(sessionId: SessionId, at: number, reason: RevocationReason): Promise<void>;
  /** For password reset and security actions. Returns how many were revoked. */
  revokeAllForUser(userId: UserId, at: number, reason: RevocationReason): Promise<number>;
}

/**
 * Cryptographically secure token generation.
 *
 * Separate methods per token TYPE rather than one `generate(length)`. A single
 * generic generator invites deriving one secret from another, or reusing a
 * session token where a CSRF token belongs — and the type system then has
 * nothing to object to.
 */
export interface SecurityTokenGenerator {
  nextSessionToken(): SessionToken;
  nextCsrfToken(): CsrfToken;
  nextSessionId(): SessionId;
}

/**
 * Digesting for storage and lookup.
 *
 * Two methods, not one, because the digests are DOMAIN-SEPARATED: a session
 * token and a CSRF token that happened to be the same string must not produce
 * the same digest. Without separation, a leaked CSRF token (readable by
 * JavaScript, by design) could be submitted as a session token and would match
 * a stored session hash.
 */
export interface SecurityTokenDigester {
  digestSessionToken(token: SessionToken): TokenDigest;
  digestCsrfToken(token: CsrfToken): TokenDigest;
  /** Timing-safe equality for digests. */
  matches(a: TokenDigest, b: TokenDigest): boolean;
}

// ── Resolution outcome ───────────────────────────────────────────────────────

/**
 * Why a credential did not authenticate.
 *
 * Distinguished INTERNALLY for telemetry. The public response collapses all of
 * them to one `auth_required` — a client that could tell "expired" from
 * "unknown" has an oracle for which tokens exist.
 */
export type SessionRejection = "malformed" | "unknown" | "expired" | "idle-expired" | "revoked";

export type SessionResolution =
  | { readonly outcome: "authenticated"; readonly actor: AuthenticatedActor;
      readonly session: SessionRecord }
  | { readonly outcome: "rejected"; readonly reason: SessionRejection };
