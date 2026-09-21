// Signing request ports (BACKEND-32).
//
// ── One write, and why ─────────────────────────────────────────────────────
//
// `createSnapshot` writes the request, its recipients and its fields in one
// call. Not three, and not a generic `insert` per table.
//
// A signing request is only ever created whole. Splitting it into three
// repository calls would make a partially-written request representable — a
// request with recipients and no fields is not a lesser request, it is a
// corrupt one — and would put the ordering constraint (recipients before the
// fields that reference them) in the caller's hands.
//
// ── Methods that are deliberately absent ───────────────────────────────────
//
//   updateRecipient / updateField / patch...
//                         a snapshot is immutable. The runtime role holds no
//                         UPDATE grant on either snapshot table, so this is
//                         not merely a missing method
//   transitionState       BACKEND-33's, when there is a second state to move to
//   delete                the product has no abandon-unsent-request control
//   findById(id)          no unscoped lookup
//
// `listForWorkspace` and `countByState` were once listed here too. The
// dashboard (BACKEND-49) is the product surface that needs them.

import type { DocumentId, WorkspaceId, UserId } from "@lagda/contracts";
import type {
  RecipientType, PreparationFieldType, SigningRequestState,
} from "@lagda/contracts";
import type { ArtifactId } from "./evidence.js";
import type { PreparationId, PreparationFieldId } from "./preparation.js";
import type { RecipientId } from "./recipients.js";

/**
 * Opaque, server-generated.
 *
 * Distinct from `DocumentId`, `PreparationId` and `ArtifactId` as a TYPE, not
 * just by convention: a function that takes one will not accept another.
 */
export type SigningRequestId = string & { readonly __brand: "SigningRequestId" };

/**
 * A recipient's identity WITHIN one signing request.
 *
 * Distinct from `RecipientId`, which identifies a mutable preparation
 * recipient. The distinction is the point of BACKEND-32: a preparation
 * recipient can be edited, deleted or reused by a second request, and a signing
 * workflow cannot have its participants change underneath it.
 *
 * BACKEND-34 issues access credentials against THIS id. BACKEND-37 tracks
 * ceremony state against it. BACKEND-43 cites it as evidence.
 */
export type SigningRequestRecipientId =
  string & { readonly __brand: "SigningRequestRecipientId" };

/** A field's identity within one signing request. Distinct from `PreparationFieldId`. */
export type SigningRequestFieldId =
  string & { readonly __brand: "SigningRequestFieldId" };

// ── Records ──────────────────────────────────────────────────────────────────

export interface SigningRequestRecipientRecord {
  readonly recipientId: SigningRequestRecipientId;
  /** PROVENANCE only, and null once the preparation recipient is deleted. */
  readonly sourcePreparationRecipientId: RecipientId | null;
  readonly name: string;
  /** The delivery address as it was. Unverified, and not rewritten. */
  readonly email: string;
  /** Internal. Never projected to a client. */
  readonly normalizedEmail: string;
  readonly organization: string | null;
  readonly type: RecipientType;
  readonly isRequired: boolean;
  readonly orderIndex: number;
  readonly routingOrder: number;
}

export interface SigningRequestFieldRecord {
  readonly fieldId: SigningRequestFieldId;
  /** PROVENANCE only, and null once the preparation field is deleted. */
  readonly sourcePreparationFieldId: PreparationFieldId | null;
  readonly type: PreparationFieldType;
  /** 1-based, the canonical model. */
  readonly pageNumber: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly required: boolean;
  readonly label: string;
  readonly layer: number;
  /**
   * A recipient of THIS request. Never null.
   *
   * Preparation permits an unassigned field while authoring. A workflow cannot:
   * nobody could complete it. Readiness refuses to snapshot one.
   */
  readonly recipientId: SigningRequestRecipientId;
}

export interface SigningRequestRecord {
  readonly signingRequestId: SigningRequestId;
  readonly workspaceId: WorkspaceId;
  readonly documentId: DocumentId;
  /** The EXACT bytes the geometry applies to. */
  readonly sourceArtifactId: ArtifactId;
  /** Provenance. Nothing reads these to reconstruct the request. */
  readonly sourcePreparationId: PreparationId;
  readonly sourcePreparationRevision: number;
  readonly state: SigningRequestState;
  /**
   * When the workflow closed to further signing (BACKEND-37).
   *
   * The backend transition time, NOT the last signature's `acceptedAt`. And
   * not `completedAt` — the signed document does not exist yet.
   */
  readonly completionReadyAt: number | null;
  /**
   * When this request stops accepting signatures, or null for no deadline.
   *
   * Null is NO DEADLINE, not "unknown" and not "already passed". Opt-in, and an
   * absolute instant rather than a period, matching the product's
   * `ExpirationSettings`.
   */
  readonly expiresAt: number | null;
  /**
   * BACKEND-41's finalization time. Non-null exactly when `state` is
   * `completed`, asserted by a database CHECK in both directions.
   *
   * NOT any recipient's signing time — those live on their submissions and are
   * always earlier.
   */
  readonly completedAt: number | null;
  /** When it ended without completing. */
  readonly terminatedAt: number | null;
  /** `declined` or `cancelled`. Always equal to `state` when set. */
  readonly terminationReason: "declined" | "cancelled" | null;
  /** The sender's cancellation reason. Workspace content; never logged. */
  readonly cancellationNote: string | null;
  /** The title as it WAS. Not the document's current title. */
  readonly documentTitle: string;
  readonly createdByUserId: UserId;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Everything one request is, written in one statement group. */
/**
 * One request as a LIST row: enough to render it, nothing that belongs to
 * opening it.
 *
 * No recipient names, no emails, no field geometry. A list is read by anyone
 * with document.view, and a participant list is not theirs to see in aggregate.
 */
export interface SigningRequestSummary {
  readonly signingRequestId: SigningRequestId;
  readonly documentId: DocumentId;
  readonly state: SigningRequestState;
  readonly documentTitle: string;
  readonly participantCount: number;
  readonly completedParticipantCount: number;
  /**
   * Who started this request — a WORKSPACE member, not a recipient.
   *
   * Distinct from the privacy rule above, which withholds participants: those
   * are outside parties whose involvement is not the list's to broadcast. The
   * initiator is a colleague, already visible in the member directory to
   * anyone who can read this list, and "who sent this" is the first question
   * asked of any document in an admin view.
   *
   * Null when the account has been removed. The request survives its sender.
   */
  readonly initiator: { readonly name: string; readonly email: string } | null;
  readonly createdAt: number;
  readonly sentAt: number | null;
  readonly completedAt: number | null;
  /** When it stops accepting signatures, or null for no deadline. */
  readonly expiresAt: number | null;
}

export interface SigningRequestListPage {
  readonly items: readonly SigningRequestSummary[];
  /** Counted in the same transaction as the page, so the two cannot disagree. */
  readonly total: number;
}

/**
 * Every state, with a count — zeros included.
 *
 * A partial record would make "no requests in this state" and "the
 * repository did not report this state" the same shape, and a dashboard
 * summing the values would silently be summing a subset.
 */
export type SigningRequestStateCounts = Readonly<Record<SigningRequestState, number>>;

export interface NewSigningRequestSnapshot {
  readonly request: SigningRequestRecord;
  readonly recipients: readonly SigningRequestRecipientRecord[];
  readonly fields: readonly SigningRequestFieldRecord[];
}

/**
 * Signing request persistence, bound to ONE workspace and ONE transaction.
 *
 * No method takes a workspace argument.
 */
export interface ScopedSigningRequestRepository {
  /**
   * Writes a whole request: the row, its recipients, then its fields.
   *
   * @throws if any record's workspace differs from the bound scope.
   */
  createSnapshot(snapshot: NewSigningRequestSnapshot): Promise<void>;

  /** One request of this workspace, or null. */
  find(signingRequestId: SigningRequestId): Promise<SigningRequestRecord | null>;

  /**
   * Every signing request in the workspace, latest first.
   *
   * ── Why this exists now, having been deferred ──────────────────────────
   *
   * `listSigningRequests` was deferred with "no product surface needs it".
   * One does: the document list shows a status chip per row and groups by
   * Draft / Sent / Completed, and a DOCUMENT has no status of its own --
   * lifecycle belongs to the request. Without a list, a client can read a
   * request only by an id it does not have, so it cannot discover which of
   * its documents were sent.
   *
   * Returned from the SIGNING domain rather than added to the document read
   * model, because the document domain references nothing about signing and
   * an architecture test enforces that. The client joins on `documentId`.
   *
   * Counts are included because the alternative is one round trip per row.
   */
  listForWorkspace(query: {
    readonly limit: number;
    readonly offset: number;
  }): Promise<SigningRequestListPage>;

  /**
   * How many requests are in each state, for the bound workspace.
   *
   * One grouped query, not a walk over the list. The list is paged at 100
   * and a client bucketing a page was counting a page; this is the count the
   * page could not give. Every state is present in the result, zero or not.
   */
  countByState(): Promise<SigningRequestStateCounts>;

  /** Ordered by `orderIndex`, then id. Ordered in SQL. */
  listRecipients(
    signingRequestId: SigningRequestId,
  ): Promise<readonly SigningRequestRecipientRecord[]>;

  /** Ordered by page, then layer, then id. Ordered in SQL. */
  listFields(
    signingRequestId: SigningRequestId,
  ): Promise<readonly SigningRequestFieldRecord[]>;

  /**
   * Marks a SENDABLE request sent, conditionally.
   *
   * Sendable is `draft` OR `ready-to-send`, which is core's rule
   * (`isEditableForSend`) rather than this port's: the review state is
   * OPTIONAL, so send still works straight from a draft.
   *
   * Renamed from `markSentIfDraft` in BACKEND-47. The old name described the
   * only sendable state there was, and would have become a lie the moment a
   * second one existed -- the kind that reads as documentation.
   *
   * The condition is IN the statement, not before it: two sends racing on one
   * request would otherwise both read a sendable state and both proceed, and
   * the second would mint a second set of bearer credentials for the same
   * people.
   *
   * Returns whether it applied. False means the request was not sendable -
   * already sent, or absent, or another tenant's - and the caller reports only
   * what it needs to.
   *
   * `sentAt` is set in the same UPDATE. A CHECK constraint refuses the two
   * columns disagreeing, so a transition that forgot the timestamp fails.
   */
  markSentIfSendable(input: {
    readonly signingRequestId: SigningRequestId;
    readonly sentAt: number;
  }): Promise<boolean>;

  /**
   * Marks a DRAFT ready to send, conditionally.
   *
   * The condition is in the statement for the same reason every transition
   * here carries its own: the caller read the state in a different breath.
   *
   * Returns whether it applied. False means it was not `draft` -- already
   * marked, already sent, absent, or another tenant's.
   */
  markReadyToSendIfDraft(input: {
    readonly signingRequestId: SigningRequestId;
    readonly now: number;
  }): Promise<boolean>;

  /**
   * Returns a READY-TO-SEND request to draft, conditionally.
   *
   * The reverse of the edge above, and the reason the review state is safe to
   * enter: marking a request ready commits nobody to anything, because it can
   * be taken back. Only from `ready-to-send` -- a sent request is not
   * retractable this way, and `cancel` is the operation for that.
   */
  returnToDraftIfReady(input: {
    readonly signingRequestId: SigningRequestId;
    readonly now: number;
  }): Promise<boolean>;

  /**
   * Sets or clears the deadline. NULL clears it.
   *
   * Does NOT touch the index: a database trigger maintains it, so no caller can
   * be the one that forgets. Writing it here as well would be a second writer
   * for one fact.
   *
   * Returns whether it applied. Zero rows means absent or another tenant.
   */
  setExpiry(input: {
    readonly signingRequestId: SigningRequestId;
    readonly expiresAt: number | null;
    readonly now: number;
  }): Promise<boolean>;

  /**
   * Expires a request, conditionally on it still being expirable AND due.
   *
   * BOTH conditions are IN the statement. The sweep reads the index outside the
   * workspace transaction, so between the read and this write the request may
   * have been signed, cancelled, or had its deadline extended -- and a sweep
   * that trusted its own stale read would expire a request somebody had just
   * rescued.
   *
   * Returns whether it applied. False means the request moved on, which is an
   * ordinary outcome and not an error.
   */
  expireIfDue(input: {
    readonly signingRequestId: SigningRequestId;
    readonly now: number;
  }): Promise<boolean>;
}

/**
 * One request whose deadline has passed, and the workspace to enter for it.
 *
 * IDENTIFIERS AND AN INSTANT. Nothing here can name a document, a person or a
 * field value, because none of those is in the index table -- the column list
 * is the control that a row policy would otherwise be.
 */
export interface DueExpiryRef {
  readonly signingRequestId: SigningRequestId;
  readonly workspaceId: WorkspaceId;
  readonly expiresAt: number;
}

/**
 * Finding expired requests without a tenant.
 *
 * The THIRD exception to "global mode is not a route to workspace data", and
 * built to the same shape as the other two rather than a new one: a deadline
 * passes with nobody watching, and `signing_requests` cannot be scanned across
 * tenants because `tenant_isolation` matches nothing without a workspace
 * context. That is the design working, not a gap -- so the sweep reads
 * identifiers from an unpoliced index and enters each workspace properly.
 */
export interface SigningRequestExpiryIndexRepository {
  /**
   * The oldest overdue requests, bounded.
   *
   * Ordered by deadline so the longest-overdue request is handled first; a
   * sweep that ordered arbitrarily could starve one request indefinitely while
   * the batch size held.
   */
  listDue(input: {
    readonly now: number;
    readonly limit: number;
  }): Promise<readonly DueExpiryRef[]>;
}

export interface SigningRequestIdGenerator {
  nextSigningRequestId(): SigningRequestId;
  nextSigningRequestRecipientId(): SigningRequestRecipientId;
  nextSigningRequestFieldId(): SigningRequestFieldId;
}
