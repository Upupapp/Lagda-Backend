// 087. Sharing a completed document, and asking its owner for access.
//
// ── Who owns a completed document ─────────────────────────────────────────
//
// The member who SENT its signing request. They share it and decide requests
// for it; so may anyone holding `document.share.manage` (workspace owners and
// administrators). Everyone else in the workspace sees nothing here.
//
// ── The access list ───────────────────────────────────────────────────────
//
//   participants (automatic) ∪ ACCEPTED shares ∪ APPROVED access requests
//
// Everyone on it can open the completed document: signed in with no code, or
// on the public page with an emailed code. Nothing here widens who may SEND,
// prepare or change the document.
//
// ── Shares ────────────────────────────────────────────────────────────────
//
// A share names an EMAIL, not an account: it is matched to accounts by the
// account's VERIFIED normalized address, and waits — invisible to everyone but
// the owner — until such an account exists. Nothing is emailed.
//
// ── Recipients reach rows in someone else's workspace ─────────────────────
//
// Through `TransactionManager.runForSharingRecipient`: a narrow read realm
// keyed on the account's verified address (shares) and its user id (its own
// requests), with every write made only after entering the RESOLVED row's
// workspace. See migration 087.

import type { WorkspaceId, UserId, DocumentId, VerificationId } from "@lagda/contracts";
import type {
  VerificationDetailsProjection, VerificationGrantDocumentRef,
} from "./verification-access.js";
import type { WorkspaceUnitOfWork } from "./index.js";

export type DocumentShareId = string & { readonly __brand: "DocumentShareId" };
export type DocumentAccessRequestId = string & { readonly __brand: "DocumentAccessRequestId" };

export interface DocumentSharingIdGenerator {
  nextDocumentShareId(): DocumentShareId;
  nextDocumentAccessRequestId(): DocumentAccessRequestId;
}

export const DOCUMENT_SHARE_STATUSES = ["pending", "accepted", "rejected", "removed"] as const;
export type DocumentShareStatus = (typeof DOCUMENT_SHARE_STATUSES)[number];

export const DOCUMENT_ACCESS_REQUEST_STATUSES = ["pending", "approved", "rejected", "removed"] as const;
export type DocumentAccessRequestStatus = (typeof DOCUMENT_ACCESS_REQUEST_STATUSES)[number];

/** Who ended a share: its owner, its recipient, or an edit of its address. */
export type DocumentShareRemovedBy = "owner" | "recipient" | "email-changed";

export const DOCUMENT_SHARE_NAME_MAX_LENGTH = 200;
export const DOCUMENT_ACCESS_REQUEST_NOTE_MAX_LENGTH = 500;

/** A document whose signing request completed and was sealed and recorded. */
export interface CompletedDocumentRecord {
  readonly workspaceId: WorkspaceId;
  readonly documentId: DocumentId;
  readonly signingRequestId: string;
  readonly verificationId: VerificationId;
  readonly documentTitle: string;
  readonly completedAt: number;
  /** The member who sent the signing request. */
  readonly ownerUserId: UserId;
  readonly participantCount: number;
}

export interface DocumentShareRecord {
  readonly shareId: DocumentShareId;
  readonly workspaceId: WorkspaceId;
  readonly documentId: DocumentId;
  readonly signingRequestId: string;
  readonly verificationId: VerificationId;
  /** As the owner typed it (trimmed). */
  readonly email: string;
  readonly normalizedEmail: string;
  readonly fullName: string | null;
  readonly status: DocumentShareStatus;
  readonly sharedByUserId: UserId;
  /** The account that answered, once one has. */
  readonly recipientUserId: UserId | null;
  readonly replacesShareId: DocumentShareId | null;
  readonly removedBy: DocumentShareRemovedBy | null;
  readonly removedByUserId: UserId | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly respondedAt: number | null;
  readonly removedAt: number | null;
  /** A rejected share its recipient deleted from their own list. */
  readonly recipientDeletedAt: number | null;
}

export interface DocumentShareInsert {
  readonly shareId: DocumentShareId;
  readonly workspaceId: WorkspaceId;
  readonly documentId: DocumentId;
  readonly signingRequestId: string;
  readonly verificationId: VerificationId;
  readonly email: string;
  readonly normalizedEmail: string;
  readonly fullName: string | null;
  readonly sharedByUserId: UserId;
  readonly replacesShareId: DocumentShareId | null;
  readonly createdAt: number;
}

/** The mutable columns. Absent keys are left alone. */
export interface DocumentSharePatch {
  readonly status?: DocumentShareStatus;
  readonly fullName?: string | null;
  readonly recipientUserId?: UserId | null;
  readonly respondedAt?: number | null;
  readonly removedAt?: number | null;
  readonly removedBy?: DocumentShareRemovedBy | null;
  readonly removedByUserId?: UserId | null;
  readonly recipientDeletedAt?: number | null;
  readonly updatedAt: number;
}

export interface DocumentAccessRequestRecord {
  readonly requestId: DocumentAccessRequestId;
  readonly workspaceId: WorkspaceId;
  readonly documentId: DocumentId;
  readonly signingRequestId: string;
  readonly verificationId: VerificationId;
  readonly requesterUserId: UserId;
  /** The VERIFIED normalized address at request time. */
  readonly requesterEmail: string;
  readonly requesterName: string;
  readonly note: string | null;
  readonly status: DocumentAccessRequestStatus;
  readonly decidedByUserId: UserId | null;
  readonly decidedAt: number | null;
  readonly removedByUserId: UserId | null;
  readonly removedAt: number | null;
  /** A rejected request the owner deleted from the workspace's list. */
  readonly deletedByUserId: UserId | null;
  readonly deletedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DocumentAccessRequestInsert {
  readonly requestId: DocumentAccessRequestId;
  readonly workspaceId: WorkspaceId;
  readonly documentId: DocumentId;
  readonly signingRequestId: string;
  readonly verificationId: VerificationId;
  readonly requesterUserId: UserId;
  readonly requesterEmail: string;
  readonly requesterName: string;
  readonly note: string | null;
  readonly createdAt: number;
}

export interface DocumentAccessRequestPatch {
  readonly status?: DocumentAccessRequestStatus;
  readonly decidedByUserId?: UserId | null;
  readonly decidedAt?: number | null;
  readonly removedByUserId?: UserId | null;
  readonly removedAt?: number | null;
  readonly deletedByUserId?: UserId | null;
  readonly deletedAt?: number | null;
  readonly updatedAt: number;
}

/** The two answers to "may this row move": the statuses it must be in now. */
export interface TransitionGuard<S extends string> {
  readonly from: readonly S[];
  /** Also require the row not to be deleted (recipient- or owner-side). */
  readonly notDeleted?: boolean;
}

/** One workspace's sharing records, on the unit of work's transaction. */
/** One participant of a completed document, as its signing request snapshotted them. */
export interface DocumentParticipantRecord {
  readonly name: string;
  readonly email: string;
  readonly organization: string | null;
  /** The signing request's recipient type, e.g. SIGNER, APPROVER, CC. */
  readonly role: string;
}

export interface ScopedDocumentSharingRepository {
  /** The document's latest completed signing request, or null. */
  findCompletedDocument(documentId: DocumentId): Promise<CompletedDocumentRecord | null>;
  findCompletedByVerification(verificationId: VerificationId): Promise<CompletedDocumentRecord | null>;
  /** Participants and evidence, as 083's details summary is computed from. */
  detailsProjection(document: CompletedDocumentRecord): Promise<VerificationDetailsProjection | null>;
  /** The sealed PDF's storage reference. */
  sealedDocumentRef(document: CompletedDocumentRecord): Promise<VerificationGrantDocumentRef | null>;
  /** Whether this normalized address is a participant of the request. */
  isParticipant(document: CompletedDocumentRecord, normalizedEmail: string): Promise<boolean>;
  /** The request's participants as they were snapshotted, in signing order. */
  listParticipants(document: CompletedDocumentRecord): Promise<readonly DocumentParticipantRecord[]>;

  insertShare(input: DocumentShareInsert): Promise<void>;
  findShare(shareId: string): Promise<DocumentShareRecord | null>;
  /** Newest first. */
  listShares(filter: {
    readonly documentId?: DocumentId;
    readonly verificationId?: VerificationId;
    readonly normalizedEmail?: string;
    readonly statuses?: readonly DocumentShareStatus[];
  }): Promise<readonly DocumentShareRecord[]>;
  /** Compare-and-set: false when the row is gone or not in a `from` status. */
  updateShare(
    shareId: string, guard: TransitionGuard<DocumentShareStatus>, patch: DocumentSharePatch,
  ): Promise<boolean>;

  insertAccessRequest(input: DocumentAccessRequestInsert): Promise<void>;
  findAccessRequest(requestId: string): Promise<DocumentAccessRequestRecord | null>;
  /** Newest first. */
  listAccessRequests(filter: {
    readonly verificationId?: VerificationId;
    readonly requesterUserId?: UserId;
    readonly statuses?: readonly DocumentAccessRequestStatus[];
    readonly includeDeleted?: boolean;
  }): Promise<readonly DocumentAccessRequestRecord[]>;
  updateAccessRequest(
    requestId: string, guard: TransitionGuard<DocumentAccessRequestStatus>, patch: DocumentAccessRequestPatch,
  ): Promise<boolean>;

  /**
   * The account whose VERIFIED address is this one, if any: who a share is
   * shown to and notified. Id and display name only.
   */
  verifiedAccountByEmail(normalizedEmail: string): Promise<{
    readonly userId: UserId;
    readonly displayName: string;
  } | null>;
}

// ── The recipient realm ─────────────────────────────────────────────────────

/** Who the recipient realm is opened for — from the SESSION's account. */
export interface SharingRecipient {
  readonly userId: UserId;
  /** The account's normalized address when VERIFIED; null otherwise (no shares). */
  readonly verifiedEmail: string | null;
}

export interface SharingRecipientUnitOfWork {
  readonly recipient: SharingRecipient;
  /** Every share addressed to the verified address, in any workspace. */
  listShares(): Promise<readonly DocumentShareRecord[]>;
  findShare(shareId: string): Promise<DocumentShareRecord | null>;
  /** Every access request this account made, in any workspace. */
  listAccessRequests(): Promise<readonly DocumentAccessRequestRecord[]>;
  findAccessRequest(requestId: string): Promise<DocumentAccessRequestRecord | null>;
  /**
   * The tenant transition, on the SAME transaction. The workspace must come
   * from a row this realm resolved — never from a request.
   */
  enterWorkspace<R>(
    workspaceId: WorkspaceId,
    inner: (uow: WorkspaceUnitOfWork) => Promise<R>,
  ): Promise<R>;
}
