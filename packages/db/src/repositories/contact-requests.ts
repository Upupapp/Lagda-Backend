// 086. Contact requests, scoped by construction AND by row-level security.
//
// Every statement names the bound workspace; 086's FORCE `tenant_isolation`
// filters again. The three transitions carry `status = 'pending'` in their
// WHERE, so two concurrent answers cannot both win (067's rule).

import { type Transaction } from "kysely";
import type { WorkspaceId, UserId, DocumentId, ContactId } from "@lagda/contracts";
import type {
  ScopedContactRequestRepository, ContactRequestInsert, ContactRequestRecord,
  ContactRequestFilter, ContactRequestId, ContactRequestKind, ContactRequestStatus,
  ContactRequestDelivery,
} from "@lagda/application";
import type { Database } from "../schema/index.js";
import { WorkspaceScopeMismatchError, translatePersistenceError } from "../errors.js";

type Trx = Transaction<Database>;

interface Row {
  request_id: string;
  workspace_id: string;
  kind: string;
  contact_id: string;
  recipient_name: string;
  recipient_email: string;
  delivery: string;
  recipient_user_id: string | null;
  title: string;
  message: string | null;
  document_id: string | null;
  due_at: Date | null;
  status: string;
  response_document_id: string | null;
  decline_reason: string | null;
  requested_by_user_id: string;
  completed_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  declined_at: Date | null;
  cancelled_at: Date | null;
}

const ms = (value: Date | null): number | null => (value === null ? null : value.getTime());

/** The enumerations are CHECK-constrained by 086; the casts restate them. */
const toRecord = (row: Row): ContactRequestRecord => ({
  requestId: row.request_id as ContactRequestId,
  workspaceId: row.workspace_id as WorkspaceId,
  kind: row.kind as ContactRequestKind,
  contactId: row.contact_id as ContactId,
  recipientName: row.recipient_name,
  recipientEmail: row.recipient_email,
  delivery: row.delivery as ContactRequestDelivery,
  recipientUserId: row.recipient_user_id as UserId | null,
  title: row.title,
  message: row.message,
  documentId: row.document_id as DocumentId | null,
  dueAt: ms(row.due_at),
  status: row.status as ContactRequestStatus,
  responseDocumentId: row.response_document_id as DocumentId | null,
  declineReason: row.decline_reason,
  requestedByUserId: row.requested_by_user_id as UserId,
  completedByUserId: row.completed_by_user_id as UserId | null,
  createdAt: row.created_at.getTime(),
  updatedAt: row.updated_at.getTime(),
  completedAt: ms(row.completed_at),
  declinedAt: ms(row.declined_at),
  cancelledAt: ms(row.cancelled_at),
});

export function createScopedContactRequestRepository(
  trx: Trx, scope: WorkspaceId,
): ScopedContactRequestRepository {
  const transition = async (
    requestId: string, set: Record<string, unknown>,
  ): Promise<boolean> => {
    try {
      const result = await trx.updateTable("contact_requests")
        .set(set as never)
        .where("request_id", "=", requestId)
        .where("workspace_id", "=", scope)
        .where("status", "=", "pending")
        .executeTakeFirst();
      return (result.numUpdatedRows ?? 0n) > 0n;
    } catch (error) {
      throw translatePersistenceError(error);
    }
  };

  return {
    async insert(input: ContactRequestInsert): Promise<void> {
      if (input.workspaceId !== scope) {
        throw new WorkspaceScopeMismatchError("ContactRequest", scope, input.workspaceId);
      }
      try {
        await trx.insertInto("contact_requests").values({
          request_id: input.requestId,
          workspace_id: input.workspaceId,
          kind: input.kind,
          contact_id: input.contactId,
          recipient_name: input.recipientName,
          recipient_email: input.recipientEmail,
          delivery: input.delivery,
          recipient_user_id: input.recipientUserId,
          title: input.title,
          message: input.message,
          document_id: input.documentId,
          due_at: input.dueAt === null ? null : new Date(input.dueAt),
          status: "pending",
          response_document_id: null,
          decline_reason: null,
          requested_by_user_id: input.requestedByUserId,
          completed_by_user_id: null,
          created_at: new Date(input.createdAt),
          updated_at: new Date(input.createdAt),
          completed_at: null,
          declined_at: null,
          cancelled_at: null,
        }).execute();
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async find(requestId: string): Promise<ContactRequestRecord | null> {
      const row = await trx.selectFrom("contact_requests")
        .selectAll()
        .where("request_id", "=", requestId)
        .where("workspace_id", "=", scope)
        .executeTakeFirst();
      return row === undefined ? null : toRecord(row);
    },

    async list(filter: ContactRequestFilter): Promise<readonly ContactRequestRecord[]> {
      let query = trx.selectFrom("contact_requests")
        .selectAll()
        .where("workspace_id", "=", scope);
      if (filter.recipientUserId !== undefined) {
        query = query.where("recipient_user_id", "=", filter.recipientUserId);
      }
      if (filter.requestedByUserId !== undefined) {
        query = query.where("requested_by_user_id", "=", filter.requestedByUserId);
      }
      if (filter.contactId !== undefined) query = query.where("contact_id", "=", filter.contactId);
      if (filter.status !== undefined) query = query.where("status", "=", filter.status);
      const rows = await query.orderBy("created_at", "desc").orderBy("request_id").execute();
      return rows.map(toRecord);
    },

    markCompleted(requestId, input) {
      return transition(requestId, {
        status: "completed",
        completed_by_user_id: input.byUserId,
        response_document_id: input.responseDocumentId,
        completed_at: new Date(input.at),
        updated_at: new Date(input.at),
      });
    },

    markDeclined(requestId, input) {
      return transition(requestId, {
        status: "declined",
        decline_reason: input.reason,
        declined_at: new Date(input.at),
        updated_at: new Date(input.at),
      });
    },

    markCancelled(requestId, input) {
      return transition(requestId, {
        status: "cancelled",
        cancelled_at: new Date(input.at),
        updated_at: new Date(input.at),
      });
    },
  };
}
