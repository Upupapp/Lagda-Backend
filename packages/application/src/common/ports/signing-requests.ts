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
//   listForWorkspace      no product surface needs it yet

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

  /** Ordered by `orderIndex`, then id. Ordered in SQL. */
  listRecipients(
    signingRequestId: SigningRequestId,
  ): Promise<readonly SigningRequestRecipientRecord[]>;

  /** Ordered by page, then layer, then id. Ordered in SQL. */
  listFields(
    signingRequestId: SigningRequestId,
  ): Promise<readonly SigningRequestFieldRecord[]>;

  /**
   * Marks a DRAFT request sent, conditionally.
   *
   * The condition is IN the statement, not before it: two sends racing on one
   * request would otherwise both read `draft` and both proceed, and the second
   * would mint a second set of bearer credentials for the same people.
   *
   * Returns whether it applied. False means the request was not `draft` -
   * already sent, or absent, or another tenant's - and the caller reports only
   * what it needs to.
   *
   * `sentAt` is set in the same UPDATE. A CHECK constraint refuses the two
   * columns disagreeing, so a transition that forgot the timestamp fails.
   */
  markSentIfDraft(input: {
    readonly signingRequestId: SigningRequestId;
    readonly sentAt: number;
  }): Promise<boolean>;
}

export interface SigningRequestIdGenerator {
  nextSigningRequestId(): SigningRequestId;
  nextSigningRequestRecipientId(): SigningRequestRecipientId;
  nextSigningRequestFieldId(): SigningRequestFieldId;
}
