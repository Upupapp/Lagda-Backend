// Workspace invitation ports (BACKEND-26).
//
// ── Two access paths, and they are deliberately different types ────────────
//
//   ScopedInvitationRepository   management. Bound to one workspace and one
//                                transaction, like every tenant repository.
//   InvitationCredentialLookup   acceptance. Resolves ONE invitation from its
//                                token digest, with no workspace context,
//                                because the recipient is not a member yet.
//
// The second is a genuine security exception and is shaped so it cannot become
// anything else: one method, one row, read-only. It has no `list`, no
// `findByWorkspace`, and no write of any kind.

import type {
  UserId, WorkspaceId, WorkspaceInvitationId, WorkspaceRole,
  InvitableWorkspaceRole,
} from "@lagda/contracts";
import type { NormalizedEmail } from "../../auth/email-identity.js";

/**
 * A digest of an invitation token.
 *
 * A DISTINCT brand from every other digest in the system. Six 64-hex digest
 * types now exist — verification, reset, session, CSRF, recovery code,
 * pre-auth — and without separate brands any of them could be passed where
 * another is expected. That is precisely the credential-purpose confusion the
 * digest domain prefixes prevent at runtime; the brand prevents it at compile
 * time.
 */
export type InvitationTokenDigest = string & {
  readonly __brand: "InvitationTokenDigest";
};

/**
 * Issues and digests invitation credentials.
 *
 * `issue()` returns the raw token EXACTLY ONCE. It is handed to delivery and
 * then discarded; nothing persists it.
 *
 * `digest()` returns null for anything that cannot be a token — wrong length,
 * wrong alphabet, control characters — so a malformed submission is refused by
 * SHAPE before it becomes a database round trip, and never has to be echoed
 * back to explain why.
 */
export interface InvitationTokenFactory {
  readonly issue: () => { readonly raw: string; readonly digest: InvitationTokenDigest };
  readonly digest: (submitted: string) => InvitationTokenDigest | null;
}

/**
 * Builds the URL an invitee follows.
 *
 * Takes the raw token and returns an absolute URL built from CONFIGURED
 * application origin. It has no access to a request, which is what makes
 * host-header injection unexpressible rather than merely unperformed: there is
 * no `Host` in scope to read (§48, §226).
 */
export interface InvitationLinkBuilder {
  readonly build: (rawToken: string) => string;
}

/** A persisted invitation. Never the raw credential. */
export interface WorkspaceInvitationRecord {
  readonly invitationId: WorkspaceInvitationId;
  readonly workspaceId: WorkspaceId;
  /** What the inviter typed. For rendering only. */
  readonly inviteeEmail: string;
  /** The identity key. What acceptance compares against. */
  readonly inviteeNormalizedEmail: NormalizedEmail;
  readonly requestedRole: InvitableWorkspaceRole;
  readonly invitedByUserId: UserId;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly acceptedAt: number | null;
  readonly acceptedByUserId: UserId | null;
  readonly revokedAt: number | null;
  readonly declinedAt: number | null;
  readonly supersededAt: number | null;
}

export interface NewWorkspaceInvitation {
  readonly invitationId: WorkspaceInvitationId;
  readonly workspaceId: WorkspaceId;
  readonly inviteeEmail: string;
  readonly inviteeNormalizedEmail: NormalizedEmail;
  readonly requestedRole: InvitableWorkspaceRole;
  readonly invitedByUserId: UserId;
  readonly tokenDigest: InvitationTokenDigest;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * Invitation management, bound to ONE workspace and ONE transaction.
 *
 * No method takes a workspace argument. The scope is not a parameter, so
 * "operate on another tenant's invitation" is not a call that can be written.
 */
export interface ScopedInvitationRepository {
  /** @throws if the record's workspace differs from the bound scope. */
  insert(invitation: NewWorkspaceInvitation): Promise<void>;

  findById(invitationId: WorkspaceInvitationId): Promise<WorkspaceInvitationRecord | null>;

  /**
   * The one invitation occupying the active slot for this email, if any.
   *
   * "Active" means none of the four terminal timestamps is set — the same
   * predicate as the partial unique index, so this cannot disagree with the
   * constraint. It deliberately includes logically EXPIRED rows, because the
   * index cannot filter on the clock: they still hold the slot until something
   * supersedes them.
   */
  findActiveByNormalizedEmail(
    email: NormalizedEmail,
  ): Promise<WorkspaceInvitationRecord | null>;

  /** Newest first. Ordered in SQL — PostgreSQL guarantees nothing otherwise. */
  list(): Promise<readonly WorkspaceInvitationRecord[]>;

  /**
   * Frees the active slot for an email, in one statement.
   *
   * Returns how many rows it retired. Called before every insert, so the
   * partial unique index is satisfied by an explicit act rather than by hoping
   * nothing is there.
   */
  supersedeActiveForEmail(input: {
    readonly email: NormalizedEmail;
    readonly now: number;
  }): Promise<number>;

  /**
   * Rotates the credential of an existing invitation.
   *
   * Conditional on the invitation still being live. Read-then-write would let
   * two concurrent resends both observe a pending invitation and both rotate,
   * leaving one recipient holding a token the database no longer knows.
   *
   * Returns whether the rotation applied. Zero rows is deliberately ambiguous —
   * absent, already accepted, already revoked, or rotated concurrently — and
   * the caller reports "could not apply", never which.
   */
  rotateCredentialIfLive(input: {
    readonly invitationId: WorkspaceInvitationId;
    readonly tokenDigest: InvitationTokenDigest;
    readonly expiresAt: number;
    readonly now: number;
  }): Promise<boolean>;

  /** Conditional on being live. Returns whether it applied. */
  revokeIfLive(input: {
    readonly invitationId: WorkspaceInvitationId;
    readonly now: number;
  }): Promise<boolean>;

  /**
   * Consumes the invitation, conditionally on it still being live.
   *
   * The single-use guarantee, and it is a conditional UPDATE rather than a
   * read followed by a write: two concurrent acceptances both see a pending
   * row, and exactly one of them matches here.
   */
  acceptIfLive(input: {
    readonly invitationId: WorkspaceInvitationId;
    readonly acceptedByUserId: UserId;
    readonly now: number;
  }): Promise<boolean>;

  /** Conditional on being live. Returns whether it applied. */
  declineIfLive(input: {
    readonly invitationId: WorkspaceInvitationId;
    readonly now: number;
  }): Promise<boolean>;
}

/**
 * Resolves ONE invitation from its credential, with no workspace context.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * An invitee is not a member. They have no tenant context and cannot be given
 * one before the invitation says which tenant. Under `tenant_isolation` alone
 * they can see nothing at all, so acceptance would be impossible.
 *
 * ── Why it is not a bypass ─────────────────────────────────────────────────
 *
 * The RLS policy behind it is `FOR SELECT` and matches on equality against a
 * UNIQUE column. Equality on a unique column matches at most one row, so this
 * cannot enumerate, cannot scan a workspace, and cannot answer any question
 * other than "the invitation whose credential I already hold". Holding the
 * setting IS holding the credential.
 *
 * One method, returning one row. There is nothing else it can be used for.
 */
export interface InvitationCredentialLookup {
  find(): Promise<WorkspaceInvitationRecord | null>;
}

/**
 * A transaction that begins with a credential and may then enter its tenant.
 *
 * ── Why the escalation is a callback and not a second transaction ──────────
 *
 * Acceptance must validate the invitation and create the membership atomically
 * (§72, §182). Two transactions would leave a window in which the invitation is
 * consumed and the membership is not, or the reverse. `enterWorkspace` runs on
 * the SAME transaction and simply adds tenant context to it, so the whole
 * ceremony commits or rolls back together.
 *
 * The workspace it enters comes from the RESOLVED invitation, never from the
 * client. There is no parameter a request could reach.
 */
export interface InvitationCredentialUnitOfWork {
  readonly invitation: InvitationCredentialLookup;
  /**
   * Establishes tenant context for the resolved workspace and yields the full
   * workspace unit of work, on the same transaction.
   */
  enterWorkspace<T>(
    workspaceId: WorkspaceId,
    operation: (uow: WorkspaceUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

/**
 * Persists the intent to deliver an invitation, INSIDE the transaction.
 *
 * The placement is the entire guarantee (§33, §129). If delivery cannot be
 * durably scheduled, the invitation creation — or the credential rotation —
 * rolls back, and the invitee keeps whatever valid link they already had.
 * Scheduling after commit would produce the worst available outcome on a
 * resend: the previous link invalidated and the replacement never sent.
 *
 * OPTIONAL, exactly as it is for email verification and password reset, and for
 * the same reason: there is no notification infrastructure (OD-003, BACKEND-44/
 * 45). Where it is absent the invitation is still created correctly and the raw
 * token is discarded — see INVITATION_ARCHITECTURE.md, which reports delivery
 * as BLOCKED rather than implying an email is sent.
 */
export type InvitationDeliveryScheduler = (input: {
  readonly invitationId: WorkspaceInvitationId;
  readonly workspaceId: WorkspaceId;
  readonly inviteeEmail: string;
  readonly requestedRole: WorkspaceRole;
  /** Handed over ONCE. Never persisted by the caller, never logged. */
  readonly invitationUrl: string;
  readonly expiresAt: number;
}) => Promise<void>;

export interface WorkspaceInvitationIdGenerator {
  nextWorkspaceInvitationId(): WorkspaceInvitationId;
}

import type { WorkspaceUnitOfWork } from "./index.js";
