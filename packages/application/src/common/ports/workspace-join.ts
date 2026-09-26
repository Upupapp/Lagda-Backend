// Ports for joining a workspace by a single-use join link (078).
//
// A TICKET is one link meant for one person: Draft (no live link), Sent (a
// live link) or Withdrawn (link dead, ticket kept and re-sendable). The first
// request submitted through a sent link uses it. Every join — through a
// ticket or an emailed invitation — is a pending REQUEST an owner or
// administrator approves or declines. See migration 078.

import type { UserId, WorkspaceId, WorkspaceRole } from "@lagda/contracts";
import type { WorkspaceUnitOfWork } from "./index.js";

export type JoinTicketDigest = string & { readonly __brand: "JoinTicketDigest" };
export type JoinTicketId = string & { readonly __brand: "JoinTicketId" };
export type JoinRequestId = string & { readonly __brand: "JoinRequestId" };

export const JOIN_TICKET_STATES = ["draft", "sent", "withdrawn"] as const;
export type JoinTicketState = (typeof JOIN_TICKET_STATES)[number];

export const JOIN_REQUEST_STATES = ["pending", "approved", "declined"] as const;
export type JoinRequestState = (typeof JOIN_REQUEST_STATES)[number];

export const JOIN_TICKET_LABEL_MAX_LENGTH = 120;
export const JOIN_REQUEST_REASON_MAX_LENGTH = 500;
export const MEMBER_ROLE_TITLE_MAX_LENGTH = 120;

export interface JoinTicketRecord {
  readonly ticketId: JoinTicketId;
  readonly workspaceId: WorkspaceId;
  readonly label: string;
  readonly recipientEmail: string | null;
  readonly state: JoinTicketState;
  readonly tokenDigest: JoinTicketDigest | null;
  /** The live link's token, sealed; only while Sent. Never projected raw to a non-admin. */
  readonly sealedToken: string | null;
  readonly sealedKeyVersion: string | null;
  readonly workspaceName: string | null;
  readonly sentByName: string | null;
  readonly sentByUserId: UserId | null;
  readonly sentAt: number | null;
  readonly withdrawnAt: number | null;
  readonly usedAt: number | null;
  readonly usedByUserId: UserId | null;
  readonly createdByUserId: UserId;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface JoinRequestRecord {
  readonly requestId: JoinRequestId;
  readonly workspaceId: WorkspaceId;
  readonly sourceKind: "ticket" | "invitation";
  readonly ticketId: JoinTicketId | null;
  readonly invitationId: string | null;
  readonly userId: UserId;
  readonly fullName: string;
  readonly email: string;
  readonly reason: string | null;
  readonly requestedRole: WorkspaceRole;
  readonly state: JoinRequestState;
  readonly decidedByUserId: UserId | null;
  readonly decidedAt: number | null;
  readonly createdAt: number;
}

export interface ScopedJoinTicketRepository {
  insert(record: JoinTicketRecord): Promise<void>;
  find(ticketId: JoinTicketId): Promise<JoinTicketRecord | null>;
  list(): Promise<readonly JoinTicketRecord[]>;
  /** Draft only. */
  updateDraft(input: {
    readonly ticketId: JoinTicketId; readonly label: string;
    readonly recipientEmail: string | null; readonly now: number;
  }): Promise<boolean>;
  /**
   * Draft or Withdrawn → Sent, with a brand-new link. Clears any earlier use,
   * because the link that was used is gone.
   */
  markSent(input: {
    readonly ticketId: JoinTicketId; readonly tokenDigest: JoinTicketDigest;
    readonly sealedToken: string; readonly sealedKeyVersion: string;
    readonly workspaceName: string; readonly sentByName: string;
    readonly sentByUserId: UserId; readonly now: number;
  }): Promise<boolean>;
  /** Draft or Sent → Withdrawn; the live link, if any, dies. */
  withdraw(input: { readonly ticketId: JoinTicketId; readonly now: number }): Promise<boolean>;
  /** The single-use gate: true for exactly one caller of a Sent, unused ticket. */
  markUsedIfUnused(input: {
    readonly ticketId: JoinTicketId; readonly userId: UserId; readonly now: number;
  }): Promise<boolean>;
}

export interface ScopedJoinRequestRepository {
  insert(record: JoinRequestRecord): Promise<void>;
  find(requestId: JoinRequestId): Promise<JoinRequestRecord | null>;
  list(state: JoinRequestState | null): Promise<readonly JoinRequestRecord[]>;
  findPendingForUser(userId: UserId): Promise<JoinRequestRecord | null>;
  /** Pending → approved/declined, for exactly one decider. */
  decideIfPending(input: {
    readonly requestId: JoinRequestId; readonly state: "approved" | "declined";
    readonly decidedByUserId: UserId; readonly now: number;
  }): Promise<boolean>;
}

/** The one ticket whose digest this transaction holds (078's credential realm). */
export interface JoinTicketCredentialLookup {
  find(): Promise<JoinTicketRecord | null>;
}

export interface JoinTicketCredentialUnitOfWork {
  readonly ticket: JoinTicketCredentialLookup;
  /** Tenant context for the RESOLVED ticket's workspace, on the same transaction. */
  enterWorkspace<T>(
    workspaceId: WorkspaceId,
    operation: (uow: WorkspaceUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export interface JoinTicketTokenFactory {
  readonly issue: () => { readonly raw: string; readonly digest: JoinTicketDigest };
  /** Null for anything that cannot be a join link. */
  readonly digest: (submitted: string) => JoinTicketDigest | null;
}

/** Seals a live link for the admin's Copy/QR, and opens it again for them. */
export interface JoinTicketSecrets {
  readonly keyVersion: string;
  readonly seal: (raw: string) => string;
  /** Null when the key rotated or the value is not ours. */
  readonly open: (sealed: string) => string | null;
}

export interface JoinIdGenerator {
  nextJoinTicketId(): JoinTicketId;
  nextJoinRequestId(): JoinRequestId;
  /** One per admin told about a request — the notification's own source id. */
  nextJoinNoticeId(): string;
}
