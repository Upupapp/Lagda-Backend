// Asking a colleague to supply a document (067).
//
// The inverse of the signing flow: everywhere else the workspace already HAS
// the file and needs signatures on it; here it does not have the file and is
// asking a member to provide one.
//
// ── Why the assignee is a user id and the contact is only provenance ───────
//
// Fulfilling a request writes a document into the workspace, and workspace
// writes are authorized by membership. So the party who may act is a USER.
// `assigneeContactId` records which address-book entry the requester picked
// and is never consulted when deciding whether somebody may fulfil anything —
// see migration 067's header for the full reasoning.

import type { WorkspaceId, UserId, DocumentId } from "@lagda/contracts";

export type UploadRequestId = string & { readonly __brand: "UploadRequestId" };

export interface UploadRequestIdGenerator {
  nextUploadRequestId(): UploadRequestId;
}

/**
 * Where a request is.
 *
 * Three states and no "expired": nothing sweeps these yet, and a status the
 * product cannot reach is dead vocabulary a future reader would assume is
 * live. A due date and its expiry belong to the same later piece of work.
 */
export const UPLOAD_REQUEST_STATUSES = ["pending", "fulfilled", "cancelled"] as const;
export type UploadRequestStatus = (typeof UPLOAD_REQUEST_STATUSES)[number];

export interface UploadRequestRecord {
  readonly requestId: UploadRequestId;
  readonly workspaceId: WorkspaceId;
  /** What the REQUESTER asked for, in their words. Not a document title —
   *  the document does not exist yet. */
  readonly title: string;
  readonly note: string | null;
  readonly requestedByUserId: UserId;
  readonly assigneeUserId: UserId;
  readonly assigneeContactId: string | null;
  readonly status: UploadRequestStatus;
  /** The document that answered this request. Set exactly when fulfilled. */
  readonly documentId: DocumentId | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly fulfilledAt: number | null;
  readonly cancelledAt: number | null;
}

export interface UploadRequestInsert {
  readonly requestId: UploadRequestId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly note: string | null;
  readonly requestedByUserId: UserId;
  readonly assigneeUserId: UserId;
  readonly assigneeContactId: string | null;
  readonly createdAt: number;
}

/** Narrowing for the two listings the product actually shows: "what this
 *  workspace has asked for" and "what is being asked of ME". */
export interface UploadRequestFilter {
  readonly assigneeUserId?: UserId;
  readonly status?: UploadRequestStatus;
}

export interface ScopedUploadRequestRepository {
  insert(input: UploadRequestInsert): Promise<void>;
  find(requestId: string): Promise<UploadRequestRecord | null>;
  list(filter?: UploadRequestFilter): Promise<readonly UploadRequestRecord[]>;
  /**
   * Both transitions return `false` rather than throwing when they change
   * nothing — the row is gone, or it had already left `pending`. The caller
   * turns that into the right refusal, which differs between the two (a
   * second fulfilment is a conflict; cancelling a cancelled request is not
   * worth an error).
   */
  markFulfilled(
    requestId: string, input: { documentId: DocumentId; at: number },
  ): Promise<boolean>;
  markCancelled(requestId: string, input: { at: number }): Promise<boolean>;
}
