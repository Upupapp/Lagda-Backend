// Upload processing records, in PostgreSQL.
//
// Tenant-scoped like every other workspace repository: the workspace is BOUND
// at construction, never passed per call, so a method cannot be invoked with
// the wrong one. Reads and writes go through the transaction handed in, because
// RLS context lives on that connection.

import type { Selectable, Transaction, Kysely } from "kysely";
import type { WorkspaceId, Sha256Digest } from "@lagda/contracts";
import type {
  ScopedUploadRepository, QuarantineCleanupLookup, UploadRecord, UploadId,
  UploadStatus, UploadRejectionReason, MalwareScanOutcome,
} from "@lagda/application";
import type { Database, DocumentUploadsTable } from "../schema/index.js";

function toRecord(row: Selectable<DocumentUploadsTable>): UploadRecord {
  return {
    uploadId: row.upload_id as UploadId,
    workspaceId: row.workspace_id,
    uploaderUserId: row.uploader_user_id,
    quarantineReference: row.quarantine_reference,
    originalFilename: row.original_filename,
    clientMediaType: row.client_media_type,
    detectedMediaType: row.detected_media_type,
    // `bigint` arrives as a STRING from the pg driver, like every other
    // timestamp and 64-bit column in this codebase. `Number(...)` is explicit
    // rather than relying on arithmetic coercion later.
    byteSize: Number(row.byte_size),
    digest: row.digest === null ? null : (row.digest as Sha256Digest),
    status: row.status as UploadStatus,
    rejectionReason: row.rejection_reason as UploadRejectionReason | null,
    acceptedArtifactId: row.accepted_artifact_id,
    scanOutcome: row.scan_outcome as MalwareScanOutcome | null,
    scannedAt: row.scanned_at === null ? null : row.scanned_at.getTime(),
    createdAt: row.created_at.getTime(),
    completedAt: row.completed_at === null ? null : row.completed_at.getTime(),
  };
}

export function createUploadRepository(
  trx: Transaction<Database>,
  workspaceId: WorkspaceId,
): ScopedUploadRepository {
  return {
    async insert(record: UploadRecord): Promise<void> {
      await trx.insertInto("document_uploads").values({
        upload_id: record.uploadId,
        // The BOUND workspace, not the record's. If a caller ever handed in a
        // record built for another tenant, this writes the scoped one and RLS
        // rejects the mismatch rather than quietly storing it.
        workspace_id: workspaceId,
        uploader_user_id: record.uploaderUserId,
        quarantine_reference: record.quarantineReference,
        quarantine_cleared_at: null,
        original_filename: record.originalFilename,
        client_media_type: record.clientMediaType,
        detected_media_type: record.detectedMediaType,
        byte_size: record.byteSize,
        digest_algorithm: "sha-256",
        digest: record.digest,
        status: record.status,
        rejection_reason: record.rejectionReason,
        accepted_artifact_id: record.acceptedArtifactId,
        scan_outcome: record.scanOutcome,
        scanned_at: record.scannedAt === null ? null : new Date(record.scannedAt),
        created_at: new Date(record.createdAt),
        completed_at: record.completedAt === null ? null : new Date(record.completedAt),
      }).execute();
    },

    async find(uploadId: UploadId): Promise<UploadRecord | null> {
      const row = await trx.selectFrom("document_uploads").selectAll()
        .where("upload_id", "=", uploadId)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },

    async complete(input: Parameters<ScopedUploadRepository["complete"]>[0]): Promise<void> {
      await trx.updateTable("document_uploads")
        .set({
          status: input.status,
          ...(input.detectedMediaType === undefined
            ? {} : { detected_media_type: input.detectedMediaType }),
          ...(input.digest === undefined ? {} : { digest: input.digest }),
          ...(input.rejectionReason === undefined
            ? {} : { rejection_reason: input.rejectionReason }),
          ...(input.acceptedArtifactId === undefined
            ? {} : { accepted_artifact_id: input.acceptedArtifactId }),
          ...(input.scanOutcome === undefined ? {} : { scan_outcome: input.scanOutcome }),
          ...(input.scannedAt === undefined
            ? {} : { scanned_at: new Date(input.scannedAt) }),
          completed_at: new Date(input.completedAt),
        })
        .where("upload_id", "=", input.uploadId)
        .where("workspace_id", "=", workspaceId)
        // Only a row still in flight may be completed. Without this, a retry or
        // a duplicated call could move an ACCEPTED upload to rejected and
        // strand an artifact that genuinely exists.
        .where("status", "=", "quarantined")
        .execute();
    },
  };
}

/**
 * Quarantine cleanup, GLOBAL rather than tenant-scoped.
 *
 * Cleanup is a system job with no workspace context. It reads the DATABASE to
 * decide what to delete — never a bucket listing, which is how a cleanup job
 * removes an object nobody asked it to touch (§82).
 *
 * Built on the pool rather than inside a tenant transaction, so it must never
 * be handed to a request path.
 */
export function createQuarantineCleanupLookup(
  db: Kysely<Database>,
): QuarantineCleanupLookup {
  return {
    async listCleanable(input: Parameters<QuarantineCleanupLookup["listCleanable"]>[0]) {
      const rows = await db.selectFrom("document_uploads")
        .select(["upload_id", "quarantine_reference"])
        // Still holding bytes...
        .where("quarantine_cleared_at", "is", null)
        // ...and old enough that no request is still working on it. A row being
        // processed right now must not have its quarantine object deleted
        // underneath it, which is why this is a horizon and not "all pending".
        .where("created_at", "<", new Date(input.before))
        .orderBy("created_at", "asc")
        .limit(input.limit)
        .execute();

      return rows.map(row => ({
        uploadId: row.upload_id as UploadId,
        quarantineReference: row.quarantine_reference,
      }));
    },

    async markQuarantineCleared(uploadId: UploadId): Promise<void> {
      // Idempotent by construction: setting an already-set timestamp again
      // changes nothing, and a second cleanup pass simply finds no rows (§155).
      await db.updateTable("document_uploads")
        .set({ quarantine_cleared_at: new Date() })
        .where("upload_id", "=", uploadId)
        .execute();
    },
  };
}
