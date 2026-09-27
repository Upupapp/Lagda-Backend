// 087. Document shares and access requests, on PostgreSQL.
//
// Two shapes of access, one row format:
//
//   createScopedDocumentSharingRepository  inside ONE workspace's tenant
//       context — every statement names the bound workspace and 087's FORCE
//       `tenant_isolation` filters again.
//   createSharingRecipientLookup           the recipient realm: the shares
//       whose `recipient_email_digest` equals `lagda.document_share_recipient`
//       and the requests whose requester equals `lagda.document_access_requester`,
//       across workspaces, READ ONLY (087's two FOR SELECT policies).
//
// The recipient digest is computed in SQL — a domain-separated SHA-256 of the
// normalized address — both when a share is written and when the realm is
// opened, so the two can never disagree.
//
// Every transition is a compare-and-set on the current status (067's rule):
// two concurrent answers cannot both win.

import { sql, type Transaction, type RawBuilder, type Selectable } from "kysely";
import type { WorkspaceId, UserId, DocumentId, VerificationId } from "@lagda/contracts";
import {
  ResourceConflictError,
  type ScopedDocumentSharingRepository, type CompletedDocumentRecord,
  type DocumentShareRecord, type DocumentShareId, type DocumentShareStatus, type DocumentShareRemovedBy,
  type DocumentAccessRequestRecord, type DocumentAccessRequestId, type DocumentAccessRequestStatus,
  type DocumentSharePatch, type DocumentAccessRequestPatch, type TransitionGuard,
  type VerificationDetailsProjection, type VerificationGrantDocumentRef,
} from "@lagda/application";
import type { Database, DocumentSharesTable, DocumentAccessRequestsTable } from "../schema/index.js";
import { WorkspaceScopeMismatchError, translatePersistenceError, UniqueConstraintViolation } from "../errors.js";

type Trx = Transaction<Database>;

/** The domain prefix of a share recipient digest. Never reused elsewhere. */
const RECIPIENT_DIGEST_DOMAIN = "lagda.document-share-recipient:";

/** SQL for the recipient digest of a normalized address. */
export function shareRecipientDigestSql(normalizedEmail: string): RawBuilder<string> {
  return sql<string>`encode(sha256(convert_to(${RECIPIENT_DIGEST_DOMAIN + normalizedEmail}, 'UTF8')), 'hex')`;
}

const ms = (value: Date | null): number | null => (value === null ? null : value.getTime());
const date = (value: number | null): Date | null => (value === null ? null : new Date(value));

type ShareRow = Selectable<DocumentSharesTable>;
type RequestRow = Selectable<DocumentAccessRequestsTable>;

/** The enumerations are CHECK-constrained by 087; the casts restate them. */
export const toShareRecord = (row: ShareRow): DocumentShareRecord => ({
  shareId: row.share_id as DocumentShareId,
  workspaceId: row.workspace_id as WorkspaceId,
  documentId: row.document_id as DocumentId,
  signingRequestId: row.signing_request_id,
  verificationId: row.verification_id as VerificationId,
  email: row.email,
  normalizedEmail: row.normalized_email,
  fullName: row.full_name,
  status: row.status as DocumentShareStatus,
  sharedByUserId: row.shared_by_user_id as UserId,
  recipientUserId: row.recipient_user_id as UserId | null,
  replacesShareId: row.replaces_share_id as DocumentShareId | null,
  removedBy: row.removed_by as DocumentShareRemovedBy | null,
  removedByUserId: row.removed_by_user_id as UserId | null,
  createdAt: row.created_at.getTime(),
  updatedAt: row.updated_at.getTime(),
  respondedAt: ms(row.responded_at),
  removedAt: ms(row.removed_at),
  recipientDeletedAt: ms(row.recipient_deleted_at),
});

export const toRequestRecord = (row: RequestRow): DocumentAccessRequestRecord => ({
  requestId: row.request_id as DocumentAccessRequestId,
  workspaceId: row.workspace_id as WorkspaceId,
  documentId: row.document_id as DocumentId,
  signingRequestId: row.signing_request_id,
  verificationId: row.verification_id as VerificationId,
  requesterUserId: row.requester_user_id as UserId,
  requesterEmail: row.requester_email,
  requesterName: row.requester_name,
  note: row.note,
  status: row.status as DocumentAccessRequestStatus,
  decidedByUserId: row.decided_by_user_id as UserId | null,
  decidedAt: ms(row.decided_at),
  removedByUserId: row.removed_by_user_id as UserId | null,
  removedAt: ms(row.removed_at),
  deletedByUserId: row.deleted_by_user_id as UserId | null,
  deletedAt: ms(row.deleted_at),
  createdAt: row.created_at.getTime(),
  updatedAt: row.updated_at.getTime(),
});

function shareColumns(patch: DocumentSharePatch): Record<string, unknown> {
  const set: Record<string, unknown> = { updated_at: new Date(patch.updatedAt) };
  if (patch.status !== undefined) set["status"] = patch.status;
  if (patch.fullName !== undefined) set["full_name"] = patch.fullName;
  if (patch.recipientUserId !== undefined) set["recipient_user_id"] = patch.recipientUserId;
  if (patch.respondedAt !== undefined) set["responded_at"] = date(patch.respondedAt);
  if (patch.removedAt !== undefined) set["removed_at"] = date(patch.removedAt);
  if (patch.removedBy !== undefined) set["removed_by"] = patch.removedBy;
  if (patch.removedByUserId !== undefined) set["removed_by_user_id"] = patch.removedByUserId;
  if (patch.recipientDeletedAt !== undefined) set["recipient_deleted_at"] = date(patch.recipientDeletedAt);
  return set;
}

function requestColumns(patch: DocumentAccessRequestPatch): Record<string, unknown> {
  const set: Record<string, unknown> = { updated_at: new Date(patch.updatedAt) };
  if (patch.status !== undefined) set["status"] = patch.status;
  if (patch.decidedByUserId !== undefined) set["decided_by_user_id"] = patch.decidedByUserId;
  if (patch.decidedAt !== undefined) set["decided_at"] = date(patch.decidedAt);
  if (patch.removedByUserId !== undefined) set["removed_by_user_id"] = patch.removedByUserId;
  if (patch.removedAt !== undefined) set["removed_at"] = date(patch.removedAt);
  if (patch.deletedByUserId !== undefined) set["deleted_by_user_id"] = patch.deletedByUserId;
  if (patch.deletedAt !== undefined) set["deleted_at"] = date(patch.deletedAt);
  return set;
}

/** The race the application's check lost: the live-row index answered first. */
function translate(error: unknown, liveIndex: string, message: string): unknown {
  const translated = translatePersistenceError(error);
  if (translated instanceof UniqueConstraintViolation
    && (translated.constraint === undefined || translated.constraint === liveIndex)) {
    return new ResourceConflictError(message, error);
  }
  return translated;
}

export function createScopedDocumentSharingRepository(
  trx: Trx, scope: WorkspaceId,
): ScopedDocumentSharingRepository {
  /** A completed, sealed and recorded signing request, by one key. */
  const completed = async (
    key: { documentId: string } | { verificationId: string },
  ): Promise<CompletedDocumentRecord | null> => {
    let query = trx.selectFrom("verification_records")
      .innerJoin("signing_requests", join => join
        .onRef("signing_requests.signing_request_id", "=", "verification_records.signing_request_id")
        .onRef("signing_requests.workspace_id", "=", "verification_records.workspace_id"))
      .innerJoin("signing_request_completions", join => join
        .onRef("signing_request_completions.signing_request_id", "=", "verification_records.signing_request_id")
        .onRef("signing_request_completions.workspace_id", "=", "verification_records.workspace_id"))
      .where("verification_records.workspace_id", "=", scope)
      .where("signing_requests.state", "=", "completed")
      .select([
        "verification_records.verification_id", "verification_records.signing_request_id",
        "verification_records.document_id", "verification_records.completed_at",
        "verification_records.participant_count",
        "signing_requests.document_title", "signing_requests.created_by_user_id",
      ]);
    query = "documentId" in key
      ? query.where("verification_records.document_id", "=", key.documentId)
      : query.where("verification_records.verification_id", "=", key.verificationId);
    const row = await query
      .orderBy("verification_records.completed_at", "desc")
      .orderBy("verification_records.verification_id", "desc")
      .executeTakeFirst();
    if (!row) return null;
    return {
      workspaceId: scope,
      documentId: row.document_id as DocumentId,
      signingRequestId: row.signing_request_id,
      verificationId: row.verification_id as VerificationId,
      documentTitle: row.document_title,
      completedAt: row.completed_at.getTime(),
      ownerUserId: row.created_by_user_id as UserId,
      participantCount: row.participant_count,
    };
  };

  return {
    findCompletedDocument: documentId => completed({ documentId }),
    findCompletedByVerification: verificationId => completed({ verificationId }),

    async detailsProjection(document): Promise<VerificationDetailsProjection | null> {
      const seal = await trx.selectFrom("verification_records")
        .innerJoin("document_seals", join => join
          .onRef("document_seals.seal_id", "=", "verification_records.seal_id")
          .onRef("document_seals.workspace_id", "=", "verification_records.workspace_id"))
        .where("verification_records.workspace_id", "=", scope)
        .where("verification_records.verification_id", "=", document.verificationId)
        .select(["document_seals.signed_document_hash"])
        .executeTakeFirst();
      if (!seal) return null;
      const participants = await trx.selectFrom("signing_request_recipients")
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", document.signingRequestId)
        .select(["request_recipient_id", "name", "email", "recipient_type", "routing_order", "order_index"])
        .orderBy("routing_order").orderBy("order_index")
        .execute();
      const events = await trx.selectFrom("evidence_events")
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", document.signingRequestId)
        .select(["event_type", "recipient_id", "occurred_at"])
        .orderBy("occurred_at").orderBy("evidence_event_id")
        .execute();
      return {
        documentTitle: document.documentTitle,
        completedAt: document.completedAt,
        sealedDigest: seal.signed_document_hash,
        participants: participants.map(row => ({
          requestRecipientId: row.request_recipient_id,
          name: row.name,
          email: row.email,
          recipientType: row.recipient_type,
          routingOrder: row.routing_order,
          orderIndex: row.order_index,
        })),
        events: events.map(row => ({
          eventType: row.event_type,
          recipientId: row.recipient_id,
          occurredAt: row.occurred_at.getTime(),
        })),
      };
    },

    async sealedDocumentRef(document): Promise<VerificationGrantDocumentRef | null> {
      const row = await trx.selectFrom("verification_records")
        .innerJoin("document_seals", join => join
          .onRef("document_seals.seal_id", "=", "verification_records.seal_id")
          .onRef("document_seals.workspace_id", "=", "verification_records.workspace_id"))
        .innerJoin("document_artifacts", join => join
          .onRef("document_artifacts.artifact_id", "=", "document_seals.sealed_artifact_id")
          .onRef("document_artifacts.workspace_id", "=", "document_seals.workspace_id"))
        .where("verification_records.workspace_id", "=", scope)
        .where("verification_records.verification_id", "=", document.verificationId)
        .select([
          "document_artifacts.storage_reference", "document_artifacts.media_type",
          "document_artifacts.size_bytes",
        ])
        .executeTakeFirst();
      if (!row) return null;
      return {
        storageReference: row.storage_reference,
        mediaType: row.media_type,
        sizeBytes: Number(row.size_bytes),
      };
    },

    async isParticipant(document, normalizedEmail) {
      const row = await trx.selectFrom("signing_request_recipients")
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", document.signingRequestId)
        .where("normalized_email", "=", normalizedEmail)
        .select("request_recipient_id")
        .executeTakeFirst();
      return row !== undefined;
    },

    async insertShare(input) {
      if (input.workspaceId !== scope) {
        throw new WorkspaceScopeMismatchError("DocumentShare", scope, input.workspaceId);
      }
      try {
        await trx.insertInto("document_shares").values({
          share_id: input.shareId,
          workspace_id: input.workspaceId,
          document_id: input.documentId,
          signing_request_id: input.signingRequestId,
          verification_id: input.verificationId,
          email: input.email,
          normalized_email: input.normalizedEmail,
          recipient_email_digest: shareRecipientDigestSql(input.normalizedEmail),
          full_name: input.fullName,
          status: "pending",
          shared_by_user_id: input.sharedByUserId,
          recipient_user_id: null,
          replaces_share_id: input.replacesShareId,
          removed_by: null,
          removed_by_user_id: null,
          created_at: new Date(input.createdAt),
          updated_at: new Date(input.createdAt),
          responded_at: null,
          removed_at: null,
          recipient_deleted_at: null,
        }).execute();
      } catch (error) {
        throw translate(error, "document_shares_one_live",
          "This document is already shared with that email address.");
      }
    },

    async findShare(shareId) {
      const row = await trx.selectFrom("document_shares").selectAll()
        .where("workspace_id", "=", scope)
        .where("share_id", "=", shareId)
        .executeTakeFirst();
      return row === undefined ? null : toShareRecord(row);
    },

    async listShares(filter) {
      let query = trx.selectFrom("document_shares").selectAll().where("workspace_id", "=", scope);
      if (filter.documentId !== undefined) query = query.where("document_id", "=", filter.documentId);
      if (filter.verificationId !== undefined) query = query.where("verification_id", "=", filter.verificationId);
      if (filter.normalizedEmail !== undefined) query = query.where("normalized_email", "=", filter.normalizedEmail);
      if (filter.statuses !== undefined) {
        if (filter.statuses.length === 0) return [];
        query = query.where("status", "in", [...filter.statuses]);
      }
      const rows = await query.orderBy("created_at", "desc").orderBy("share_id", "desc").execute();
      return rows.map(toShareRecord);
    },

    async updateShare(shareId, guard: TransitionGuard<DocumentShareStatus>, patch) {
      if (guard.from.length === 0) return false;
      try {
        let query = trx.updateTable("document_shares")
          .set(shareColumns(patch) as never)
          .where("workspace_id", "=", scope)
          .where("share_id", "=", shareId)
          .where("status", "in", [...guard.from]);
        if (guard.notDeleted === true) query = query.where("recipient_deleted_at", "is", null);
        const result = await query.executeTakeFirst();
        return (result.numUpdatedRows ?? 0n) > 0n;
      } catch (error) {
        throw translate(error, "document_shares_one_live",
          "That email address already has another share of this document.");
      }
    },

    async insertAccessRequest(input) {
      if (input.workspaceId !== scope) {
        throw new WorkspaceScopeMismatchError("DocumentAccessRequest", scope, input.workspaceId);
      }
      try {
        await trx.insertInto("document_access_requests").values({
          request_id: input.requestId,
          workspace_id: input.workspaceId,
          document_id: input.documentId,
          signing_request_id: input.signingRequestId,
          verification_id: input.verificationId,
          requester_user_id: input.requesterUserId,
          requester_email: input.requesterEmail,
          requester_name: input.requesterName,
          note: input.note,
          status: "pending",
          decided_by_user_id: null,
          decided_at: null,
          removed_by_user_id: null,
          removed_at: null,
          deleted_by_user_id: null,
          deleted_at: null,
          created_at: new Date(input.createdAt),
          updated_at: new Date(input.createdAt),
        }).execute();
      } catch (error) {
        throw translate(error, "document_access_requests_one_live",
          "You already asked for access to this document.");
      }
    },

    async findAccessRequest(requestId) {
      const row = await trx.selectFrom("document_access_requests").selectAll()
        .where("workspace_id", "=", scope)
        .where("request_id", "=", requestId)
        .executeTakeFirst();
      return row === undefined ? null : toRequestRecord(row);
    },

    async listAccessRequests(filter) {
      let query = trx.selectFrom("document_access_requests").selectAll().where("workspace_id", "=", scope);
      if (filter.verificationId !== undefined) query = query.where("verification_id", "=", filter.verificationId);
      if (filter.requesterUserId !== undefined) query = query.where("requester_user_id", "=", filter.requesterUserId);
      if (filter.statuses !== undefined) {
        if (filter.statuses.length === 0) return [];
        query = query.where("status", "in", [...filter.statuses]);
      }
      if (filter.includeDeleted !== true) query = query.where("deleted_at", "is", null);
      const rows = await query.orderBy("created_at", "desc").orderBy("request_id", "desc").execute();
      return rows.map(toRequestRecord);
    },

    async updateAccessRequest(requestId, guard: TransitionGuard<DocumentAccessRequestStatus>, patch) {
      if (guard.from.length === 0) return false;
      try {
        let query = trx.updateTable("document_access_requests")
          .set(requestColumns(patch) as never)
          .where("workspace_id", "=", scope)
          .where("request_id", "=", requestId)
          .where("status", "in", [...guard.from]);
        if (guard.notDeleted === true) query = query.where("deleted_at", "is", null);
        const result = await query.executeTakeFirst();
        return (result.numUpdatedRows ?? 0n) > 0n;
      } catch (error) {
        throw translate(error, "document_access_requests_one_live",
          "This account already has another request for this document.");
      }
    },

    async verifiedAccountByEmail(normalizedEmail) {
      const row = await trx.selectFrom("users")
        .where("normalized_email", "=", normalizedEmail)
        .where("email_verified_at", "is not", null)
        .select(["user_id", "display_name"])
        .executeTakeFirst();
      return row === undefined ? null : { userId: row.user_id as UserId, displayName: row.display_name };
    },
  };
}

/**
 * The recipient realm's reads. Only what 087's two FOR SELECT policies show
 * for the settings the transaction manager set — each query ALSO names the
 * recipient, so the filter is stated twice.
 */
export function createSharingRecipientLookup(
  trx: Trx, recipient: { readonly userId: string; readonly verifiedEmail: string | null },
) {
  return {
    listShares: async (): Promise<readonly DocumentShareRecord[]> => {
      if (recipient.verifiedEmail === null) return [];
      const rows = await trx.selectFrom("document_shares").selectAll()
        .where("normalized_email", "=", recipient.verifiedEmail)
        .where(sql<boolean>`recipient_email_digest = lagda_current_document_share_recipient()`)
        .orderBy("created_at", "desc").orderBy("share_id", "desc")
        .execute();
      return rows.map(toShareRecord);
    },
    findShare: async (shareId: string): Promise<DocumentShareRecord | null> => {
      if (recipient.verifiedEmail === null) return null;
      const row = await trx.selectFrom("document_shares").selectAll()
        .where("share_id", "=", shareId)
        .where("normalized_email", "=", recipient.verifiedEmail)
        .where(sql<boolean>`recipient_email_digest = lagda_current_document_share_recipient()`)
        .executeTakeFirst();
      return row === undefined ? null : toShareRecord(row);
    },
    listAccessRequests: async (): Promise<readonly DocumentAccessRequestRecord[]> => {
      const rows = await trx.selectFrom("document_access_requests").selectAll()
        .where("requester_user_id", "=", recipient.userId)
        .orderBy("created_at", "desc").orderBy("request_id", "desc")
        .execute();
      return rows.map(toRequestRecord);
    },
    findAccessRequest: async (requestId: string): Promise<DocumentAccessRequestRecord | null> => {
      const row = await trx.selectFrom("document_access_requests").selectAll()
        .where("request_id", "=", requestId)
        .where("requester_user_id", "=", recipient.userId)
        .executeTakeFirst();
      return row === undefined ? null : toRequestRecord(row);
    },
  };
}
