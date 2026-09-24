// Migration 067 — documents this workspace has asked a member to supply.
//
// Every statement filters on the bound workspace, and migration 067's
// row-level security filters again in the database. The second one is what
// makes the isolation a guarantee rather than a convention: a query that
// forgot its `where` would still return nothing from another tenant.
//
// ── Why both transitions carry `status = 'pending'` in their WHERE ────────
//
// `markFulfilled` and `markCancelled` are not "set these columns" — they are
// state transitions, and the only legal source state is `pending`. Putting
// that in the WHERE rather than in a read-then-write makes it atomic: two
// concurrent fulfilments cannot both succeed, because the second one matches
// zero rows and returns `false`. A read-check-write would let both through
// between the read and the write, and the second would silently overwrite the
// first request's document.

import { type Transaction } from "kysely";
import type { WorkspaceId, UserId, DocumentId } from "@lagda/contracts";
import type {
  ScopedUploadRequestRepository, UploadRequestInsert, UploadRequestRecord,
  UploadRequestFilter, UploadRequestId, UploadRequestStatus,
} from "@lagda/application";
import type { Database } from "../schema/index.js";
import { WorkspaceScopeMismatchError, translatePersistenceError } from "../errors.js";

interface Row {
  request_id: string;
  workspace_id: string;
  title: string;
  note: string | null;
  requested_by_user_id: string;
  assignee_user_id: string;
  assignee_contact_id: string | null;
  status: string;
  document_id: string | null;
  created_at: Date;
  updated_at: Date;
  fulfilled_at: Date | null;
  cancelled_at: Date | null;
}

/**
 * `status` is handed out as the union without re-checking it.
 *
 * Not a blind cast: migration 067's `upload_requests_status_check` is the
 * authority, and it permits exactly the three values the union names. A
 * runtime re-check here would be asserting something PostgreSQL has already
 * refused to store.
 */
const toRecord = (row: Row): UploadRequestRecord => ({
  requestId: row.request_id as UploadRequestId,
  workspaceId: row.workspace_id as WorkspaceId,
  title: row.title,
  note: row.note,
  requestedByUserId: row.requested_by_user_id as UserId,
  assigneeUserId: row.assignee_user_id as UserId,
  assigneeContactId: row.assignee_contact_id,
  status: row.status as UploadRequestStatus,
  documentId: row.document_id as DocumentId | null,
  createdAt: row.created_at.getTime(),
  updatedAt: row.updated_at.getTime(),
  fulfilledAt: row.fulfilled_at === null ? null : row.fulfilled_at.getTime(),
  cancelledAt: row.cancelled_at === null ? null : row.cancelled_at.getTime(),
});

export function createScopedUploadRequestRepository(
  trx: Transaction<Database>, scope: WorkspaceId,
): ScopedUploadRequestRepository {
  return {
    async insert(input: UploadRequestInsert): Promise<void> {
      if (input.workspaceId !== scope) {
        throw new WorkspaceScopeMismatchError(
          "UploadRequest", scope, input.workspaceId);
      }
      try {
        await trx.insertInto("workspace_document_upload_requests").values({
          request_id: input.requestId,
          workspace_id: input.workspaceId,
          title: input.title,
          note: input.note,
          requested_by_user_id: input.requestedByUserId,
          assignee_user_id: input.assigneeUserId,
          assignee_contact_id: input.assigneeContactId,
          // A new request is always pending and always answers nothing yet —
          // the two CHECK biconditionals in 067 refuse any other combination.
          status: "pending",
          document_id: null,
          created_at: new Date(input.createdAt),
          updated_at: new Date(input.createdAt),
          fulfilled_at: null,
          cancelled_at: null,
        }).execute();
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async find(requestId: string): Promise<UploadRequestRecord | null> {
      const row = await trx
        .selectFrom("workspace_document_upload_requests")
        .selectAll()
        .where("request_id", "=", requestId)
        .where("workspace_id", "=", scope)
        .executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },

    async list(filter?: UploadRequestFilter): Promise<readonly UploadRequestRecord[]> {
      let query = trx
        .selectFrom("workspace_document_upload_requests")
        .selectAll()
        .where("workspace_id", "=", scope);
      if (filter?.assigneeUserId !== undefined) {
        query = query.where("assignee_user_id", "=", filter.assigneeUserId);
      }
      if (filter?.status !== undefined) {
        query = query.where("status", "=", filter.status);
      }
      // Newest first, matching `idx_upload_requests_workspace_created`.
      const rows = await query.orderBy("created_at", "desc").execute();
      return rows.map(row => toRecord(row));
    },

    async markFulfilled(
      requestId: string, input: { documentId: DocumentId; at: number },
    ): Promise<boolean> {
      try {
        const result = await trx
          .updateTable("workspace_document_upload_requests")
          .set({
            status: "fulfilled",
            document_id: input.documentId,
            fulfilled_at: new Date(input.at),
            updated_at: new Date(input.at),
          })
          .where("request_id", "=", requestId)
          .where("workspace_id", "=", scope)
          // The transition, not just the row — see this file's header.
          .where("status", "=", "pending")
          .executeTakeFirst();
        return (result.numUpdatedRows ?? 0n) > 0n;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async markCancelled(requestId: string, input: { at: number }): Promise<boolean> {
      try {
        const result = await trx
          .updateTable("workspace_document_upload_requests")
          .set({
            status: "cancelled",
            cancelled_at: new Date(input.at),
            updated_at: new Date(input.at),
          })
          .where("request_id", "=", requestId)
          .where("workspace_id", "=", scope)
          .where("status", "=", "pending")
          .executeTakeFirst();
        return (result.numUpdatedRows ?? 0n) > 0n;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },
  };
}
