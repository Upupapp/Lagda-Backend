// Contact requests (086): something a workspace user asks of a CONTACT.
//
// Three kinds:
//
//   signed-document  provide a signed copy of a document (answered by upload)
//   upload           upload a document                  (answered by upload)
//   preparation      prepare a document for signing     (members only)
//
// ── Delivery is decided once, at creation ─────────────────────────────────
//
// A contact whose address matches a CURRENT member of the workspace gets the
// request in-app (`delivery: "in-app"`, `recipientUserId` set) and no email.
// Anyone else gets an email (`delivery: "email"`, `recipientUserId` null).
// The decision is frozen on the row: a contact who joins later does not
// silently re-route a request that was already emailed.
//
// ── Who may act ────────────────────────────────────────────────────────────
//
// An in-app request is completed or declined by its RECIPIENT only. An
// emailed request has nobody in the workspace who received it, so its
// requester records the outcome (completes it with the document they were
// sent, or cancels it). Either way the requester may cancel while pending.

import type { WorkspaceId, UserId, DocumentId, ContactId } from "@lagda/contracts";

export type ContactRequestId = string & { readonly __brand: "ContactRequestId" };

export interface ContactRequestIdGenerator {
  nextContactRequestId(): ContactRequestId;
}

export const CONTACT_REQUEST_KINDS = ["signed-document", "upload", "preparation"] as const;
export type ContactRequestKind = (typeof CONTACT_REQUEST_KINDS)[number];

export const CONTACT_REQUEST_STATUSES = ["pending", "completed", "declined", "cancelled"] as const;
export type ContactRequestStatus = (typeof CONTACT_REQUEST_STATUSES)[number];

export const CONTACT_REQUEST_DELIVERIES = ["in-app", "email"] as const;
export type ContactRequestDelivery = (typeof CONTACT_REQUEST_DELIVERIES)[number];

export interface ContactRequestRecord {
  readonly requestId: ContactRequestId;
  readonly workspaceId: WorkspaceId;
  readonly kind: ContactRequestKind;
  /** 092: null once the contact was deleted; the snapshots below remain. */
  readonly contactId: ContactId | null;
  /** Snapshots of the contact at creation; an edit to the contact later does
   *  not rewrite whom a request was sent to. */
  readonly recipientName: string;
  readonly recipientEmail: string;
  readonly delivery: ContactRequestDelivery;
  /** Set exactly when `delivery` is `in-app`. */
  readonly recipientUserId: UserId | null;
  readonly title: string;
  readonly message: string | null;
  /** The document the request is ABOUT (preparation, signed-document). */
  readonly documentId: DocumentId | null;
  readonly dueAt: number | null;
  readonly status: ContactRequestStatus;
  /** The document that ANSWERED it (upload kinds), set on completion. */
  readonly responseDocumentId: DocumentId | null;
  readonly declineReason: string | null;
  readonly requestedByUserId: UserId;
  readonly completedByUserId: UserId | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
  readonly declinedAt: number | null;
  readonly cancelledAt: number | null;
}

export interface ContactRequestInsert {
  readonly requestId: ContactRequestId;
  readonly workspaceId: WorkspaceId;
  readonly kind: ContactRequestKind;
  readonly contactId: ContactId;
  readonly recipientName: string;
  readonly recipientEmail: string;
  readonly delivery: ContactRequestDelivery;
  readonly recipientUserId: UserId | null;
  readonly title: string;
  readonly message: string | null;
  readonly documentId: DocumentId | null;
  readonly dueAt: number | null;
  readonly requestedByUserId: UserId;
  readonly createdAt: number;
}

export interface ContactRequestFilter {
  readonly recipientUserId?: UserId;
  readonly requestedByUserId?: UserId;
  readonly contactId?: ContactId;
  readonly status?: ContactRequestStatus;
}

export interface ScopedContactRequestRepository {
  insert(input: ContactRequestInsert): Promise<void>;
  find(requestId: string): Promise<ContactRequestRecord | null>;
  /** Newest first. */
  list(filter: ContactRequestFilter): Promise<readonly ContactRequestRecord[]>;
  /**
   * The three transitions leave `pending` only; each returns false when the
   * row is gone or already left `pending`, so two concurrent answers cannot
   * both win.
   */
  markCompleted(requestId: string, input: {
    readonly byUserId: UserId;
    readonly responseDocumentId: DocumentId | null;
    readonly at: number;
  }): Promise<boolean>;
  markDeclined(requestId: string, input: {
    readonly reason: string | null;
    readonly at: number;
  }): Promise<boolean>;
  markCancelled(requestId: string, input: { readonly at: number }): Promise<boolean>;
}
