// Recipient signing access and sessions (BACKEND-34).
//
// ── Two realms, and this is the second one ─────────────────────────────────
//
//   Workspace actor    user session + membership + capability
//   Signing recipient  recipient session + SigningRequestRecipientId
//
// They never merge. A recipient session confers no workspace capability, and a
// user session does not authenticate a recipient — even when the emails match.
//
// ── Why a separate credential unit of work ─────────────────────────────────
//
// A recipient has no workspace context to bind a transaction to. The credential
// establishes it: digest → the one grant that matches → its workspace. That is
// the shape BACKEND-26 built for invitations, and the security argument is the
// same one.

import type { WorkspaceId } from "@lagda/contracts";
import type { SigningRequestState } from "@lagda/contracts";
import type { RecipientCeremonyUnitOfWork } from "./signing-ceremony.js";
import type {
  SigningRequestId, SigningRequestRecipientId,
} from "./signing-requests.js";
import type {
  SigningAccessDigest, SigningAccessGrantId, RecipientActivationState,
} from "./signing-access.js";

/** SHA-256 of a recipient session token, domain-separated. Its own brand. */
export type RecipientSessionDigest =
  string & { readonly __brand: "RecipientSessionDigest" };

/** SHA-256 of a recipient CSRF token. A DIFFERENT brand from the session's. */
export type RecipientCsrfDigest =
  string & { readonly __brand: "RecipientCsrfDigest" };

export type RecipientSigningSessionId =
  string & { readonly __brand: "RecipientSigningSessionId" };

/**
 * How a recipient proved they may act.
 *
 * `link-only` is implemented and is the product's default. `email-otp` is
 * declared so a session can SAY which ceremony authenticated it — the day a
 * second method arrives, existing rows must still describe themselves
 * correctly. Declaring it does not make it work.
 */
export const RECIPIENT_AUTHENTICATION_METHODS = ["link-only", "email-otp"] as const;
export type RecipientAuthenticationMethod =
  (typeof RECIPIENT_AUTHENTICATION_METHODS)[number];

export const RECIPIENT_SESSION_REVOCATION_REASONS = [
  "expired", "superseded", "request-terminal", "grant-revoked", "security-action",
] as const;
export type RecipientSessionRevocationReason =
  (typeof RECIPIENT_SESSION_REVOCATION_REASONS)[number];

// ── What a credential resolves to ────────────────────────────────────────────

/**
 * Everything the bootstrap path needs, resolved from ONE credential.
 *
 * Assembled by the lookup repository in one query group. Note what is here and
 * what is not: enough to decide whether this recipient may proceed, and nothing
 * about any other recipient of the request.
 */
export interface ResolvedSigningAccess {
  readonly grantId: SigningAccessGrantId;
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: SigningRequestId;
  readonly recipientId: SigningRequestRecipientId;
  readonly grantExpiresAt: number;
  readonly grantRevokedAt: number | null;
  readonly requestState: SigningRequestState;
  /** The snapshotted title. What a landing page shows. */
  readonly documentTitle: string;
  /** The recipient's own snapshot. Never a contact, never a live lookup. */
  readonly recipientName: string;
  readonly recipientEmail: string;
  /** NULL when send never wrote an activation row — treated as ineligible. */
  readonly activationState: RecipientActivationState | null;
}

/**
 * The narrow public credential lookup.
 *
 * ── What it deliberately cannot do ─────────────────────────────────────────
 *
 * There is no `list`, no `findByRequest`, no `findByRecipient`, no `count`. One
 * method, taking a digest, returning at most one row — because the RLS policy
 * behind it matches equality on a UNIQUE column and can therefore answer no
 * other question.
 *
 * It cannot write. Every mutation still requires the tenant transition, which
 * happens only after the credential has resolved the workspace.
 */
export interface SigningAccessLookupRepository {
  findByCredentialDigest(
    digest: SigningAccessDigest,
  ): Promise<ResolvedSigningAccess | null>;
}

/** The same shape, for an established session's cookie. */
export interface ResolvedRecipientSession {
  readonly signingSessionId: RecipientSigningSessionId;
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: SigningRequestId;
  readonly recipientId: SigningRequestRecipientId;
  readonly sourceGrantId: SigningAccessGrantId;
  readonly csrfTokenDigest: RecipientCsrfDigest;
  readonly authenticationMethod: RecipientAuthenticationMethod;
  readonly authenticatedAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}

export interface RecipientSessionLookupRepository {
  findByTokenDigest(
    digest: RecipientSessionDigest,
  ): Promise<ResolvedRecipientSession | null>;
}

// ── Writing ──────────────────────────────────────────────────────────────────

export interface NewRecipientSigningSession {
  readonly signingSessionId: RecipientSigningSessionId;
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: SigningRequestId;
  readonly recipientId: SigningRequestRecipientId;
  readonly sourceGrantId: SigningAccessGrantId;
  /** Digests only. The raw values reach the browser and nothing else. */
  readonly tokenDigest: RecipientSessionDigest;
  readonly csrfTokenDigest: RecipientCsrfDigest;
  readonly authenticationMethod: RecipientAuthenticationMethod;
  readonly authenticatedAt: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * Recipient session persistence, inside a workspace-scoped transaction.
 *
 * Writing needs tenant context, which the credential established. Reading a
 * session by its cookie does NOT — that is the lookup repository above, on its
 * own narrow path.
 */
export interface ScopedRecipientSessionRepository {
  /** @throws if the record's workspace differs from the bound scope. */
  insert(session: NewRecipientSigningSession): Promise<void>;
  /**
   * Revokes a session. Returns whether it applied.
   *
   * Unused by BACKEND-34 — nothing revokes yet. Declared because the column,
   * the reason vocabulary and the index all exist, and BACKEND-46 will need
   * exactly this when a request expires.
   */
  revoke(input: {
    readonly signingSessionId: RecipientSigningSessionId;
    readonly reason: RecipientSessionRevocationReason;
    readonly now: number;
  }): Promise<boolean>;
}

// ── The credential unit of work ──────────────────────────────────────────────

/**
 * A transaction bound to a signing CREDENTIAL rather than a workspace.
 *
 * Mirrors `InvitationCredentialUnitOfWork` exactly, for the same reason: the
 * caller has no tenant context until the credential supplies one.
 *
 * `enterWorkspace` performs the transition on the SAME transaction. Two
 * transactions would leave a window in which a session exists and the grant it
 * came from has been revoked — or the reverse.
 */
export interface SigningCredentialUnitOfWork {
  readonly access: SigningAccessLookupRepository;
  enterWorkspace<T>(
    workspaceId: WorkspaceId,
    operation: (uow: RecipientWorkspaceUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

/**
 * The narrow slice of workspace state a recipient ceremony may write.
 *
 * NOT the full `WorkspaceUnitOfWork`. A recipient has no business reaching
 * contacts, documents, memberships or preparations, and the way to guarantee
 * that is to hand them a unit of work that does not have them.
 */
export interface RecipientWorkspaceUnitOfWork {
  readonly workspaceId: WorkspaceId;
  readonly recipientSessions: ScopedRecipientSessionRepository;
}

/**
 * A transaction bound to an established recipient SESSION credential.
 *
 * `enterWorkspace` mirrors `SigningCredentialUnitOfWork` exactly, and for the
 * same reason: the caller holds a cookie, not a tenant. The session resolves
 * the workspace, the request and the recipient, and the ceremony repository is
 * bound to all three before it exists.
 *
 * Same transaction, deliberately. Two would leave a window in which the
 * session is valid and the request it names has moved on.
 */
export interface RecipientSessionUnitOfWork {
  readonly session: RecipientSessionLookupRepository;
  enterWorkspace<T>(
    scope: {
      readonly workspaceId: WorkspaceId;
      readonly signingRequestId: SigningRequestId;
      readonly recipientId: SigningRequestRecipientId;
    },
    operation: (uow: RecipientCeremonyUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export interface RecipientSigningSessionIdGenerator {
  nextRecipientSigningSessionId(): RecipientSigningSessionId;
}

/**
 * Issues and digests recipient session credentials.
 *
 * Two credentials per session, from one call: the cookie and the CSRF token.
 * Issued together so they cannot be accidentally derived from one another —
 * a CSRF token that is a function of the session token protects nothing.
 */
export interface RecipientSessionTokenFactory {
  readonly issue: () => {
    readonly rawToken: string;
    readonly tokenDigest: RecipientSessionDigest;
    readonly rawCsrfToken: string;
    readonly csrfDigest: RecipientCsrfDigest;
  };
  /** Null for anything that cannot be a token — wrong length or alphabet. */
  readonly digestToken: (submitted: string) => RecipientSessionDigest | null;
  readonly digestCsrf: (submitted: string) => RecipientCsrfDigest | null;
}
