// Signing request persistence.
//
// Write-once. `createSnapshot` is the only mutation in this file, and the
// runtime role holds no UPDATE grant on either snapshot table — so a method
// that tried to change a recipient or a field would fail at the database, not
// merely be absent from an interface.

import type { Selectable, Transaction } from "kysely";
import type {
  DocumentId, PreparationFieldType, RecipientType, SigningRequestState,
  UserId, WorkspaceId,
} from "@lagda/contracts";
import {
  PREPARATION_FIELD_TYPES, RECIPIENT_TYPES, SIGNING_REQUEST_STATES,
} from "@lagda/contracts";
import type {
  ScopedSigningRequestRepository, NewSigningRequestSnapshot,
  SigningRequestRecord, SigningRequestRecipientRecord, SigningRequestFieldRecord,
  SigningRequestId, SigningRequestRecipientId, SigningRequestFieldId,
  ArtifactId, PreparationId, PreparationFieldId, RecipientId,
} from "@lagda/application";
import type {
  Database, SigningRequestsTable, SigningRequestRecipientsTable,
  SigningRequestFieldsTable,
} from "../schema/index.js";
import { PersistenceMappingError } from "../mapping/index.js";
import { WorkspaceScopeMismatchError, translatePersistenceError } from "../errors.js";

type RequestRow = Selectable<SigningRequestsTable>;
type RecipientRow = Selectable<SigningRequestRecipientsTable>;
type FieldRow = Selectable<SigningRequestFieldsTable>;

/**
 * Validated rather than cast.
 *
 * Persisted state is untrusted input. `row.state as SigningRequestState` would
 * accept whatever the column holds, and a snapshot is the historical authority
 * for a legal transaction — the one place a silent mis-map is least acceptable.
 */
function oneOf<T extends string>(
  allowed: readonly T[], table: string, column: string, value: string,
): T {
  const found = allowed.find(candidate => candidate === value);
  if (found === undefined) {
    throw new PersistenceMappingError(table, column, `"${value}" is not permitted here.`);
  }
  return found;
}

function toRequest(row: RequestRow): SigningRequestRecord {
  return {
    signingRequestId: row.signing_request_id as SigningRequestId,
    workspaceId: row.workspace_id as WorkspaceId,
    documentId: row.document_id as DocumentId,
    sourceArtifactId: row.source_artifact_id as ArtifactId,
    sourcePreparationId: row.source_preparation_id as PreparationId,
    sourcePreparationRevision: row.source_preparation_revision,
    state: oneOf<SigningRequestState>(
      SIGNING_REQUEST_STATES, "signing_requests", "state", row.state),
    documentTitle: row.document_title,
    createdByUserId: row.created_by_user_id as UserId,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
}

function toRecipient(row: RecipientRow): SigningRequestRecipientRecord {
  return {
    recipientId: row.request_recipient_id as SigningRequestRecipientId,
    sourcePreparationRecipientId:
      row.source_preparation_recipient_id as RecipientId | null,
    name: row.name,
    email: row.email,
    normalizedEmail: row.normalized_email,
    organization: row.organization,
    type: oneOf<RecipientType>(
      RECIPIENT_TYPES, "signing_request_recipients", "recipient_type", row.recipient_type),
    isRequired: row.is_required,
    orderIndex: row.order_index,
    routingOrder: row.routing_order,
  };
}

function toField(row: FieldRow): SigningRequestFieldRecord {
  return {
    fieldId: row.request_field_id as SigningRequestFieldId,
    sourcePreparationFieldId:
      row.source_preparation_field_id as PreparationFieldId | null,
    type: oneOf<PreparationFieldType>(
      PREPARATION_FIELD_TYPES, "signing_request_fields", "field_type", row.field_type),
    pageNumber: row.page_number,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    required: row.required,
    label: row.label,
    layer: row.layer,
    recipientId: row.request_recipient_id as SigningRequestRecipientId,
  };
}

export function createScopedSigningRequestRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): ScopedSigningRequestRepository {
  return {
    async createSnapshot(snapshot: NewSigningRequestSnapshot): Promise<void> {
      const { request, recipients, fields } = snapshot;
      if (request.workspaceId !== scope) {
        throw new WorkspaceScopeMismatchError(
          "SigningRequest", scope, request.workspaceId);
      }

      try {
        await trx.insertInto("signing_requests").values({
          signing_request_id: request.signingRequestId,
          workspace_id: request.workspaceId,
          document_id: request.documentId,
          source_artifact_id: request.sourceArtifactId,
          source_preparation_id: request.sourcePreparationId,
          source_preparation_revision: request.sourcePreparationRevision,
          state: request.state,
          document_title: request.documentTitle,
          created_by_user_id: request.createdByUserId,
          created_at: new Date(request.createdAt),
          updated_at: new Date(request.createdAt),
        }).execute();

        // Recipients BEFORE fields. The field FK names a recipient of this
        // request, so the reverse order fails on a constraint that is doing
        // exactly its job.
        if (recipients.length > 0) {
          await trx.insertInto("signing_request_recipients").values(
            recipients.map(recipient => ({
              request_recipient_id: recipient.recipientId,
              workspace_id: scope,
              signing_request_id: request.signingRequestId,
              source_preparation_recipient_id: recipient.sourcePreparationRecipientId,
              name: recipient.name,
              email: recipient.email,
              normalized_email: recipient.normalizedEmail,
              organization: recipient.organization,
              recipient_type: recipient.type,
              is_required: recipient.isRequired,
              order_index: recipient.orderIndex,
              routing_order: recipient.routingOrder,
              created_at: new Date(request.createdAt),
            })),
          ).execute();
        }

        if (fields.length > 0) {
          await trx.insertInto("signing_request_fields").values(
            fields.map(field => ({
              request_field_id: field.fieldId,
              workspace_id: scope,
              signing_request_id: request.signingRequestId,
              source_preparation_field_id: field.sourcePreparationFieldId,
              field_type: field.type,
              page_number: field.pageNumber,
              x: field.x,
              y: field.y,
              width: field.width,
              height: field.height,
              required: field.required,
              label: field.label,
              layer: field.layer,
              request_recipient_id: field.recipientId,
              created_at: new Date(request.createdAt),
            })),
          ).execute();
        }
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async find(signingRequestId: SigningRequestId) {
      const row = await trx.selectFrom("signing_requests")
        .selectAll()
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", signingRequestId)
        .executeTakeFirst();
      return row === undefined ? null : toRequest(row);
    },

    async listRecipients(signingRequestId: SigningRequestId) {
      const rows = await trx.selectFrom("signing_request_recipients")
        .selectAll()
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", signingRequestId)
        // Display order, with the id as a tie-breaker so two recipients
        // written in one transaction never swap between reads.
        .orderBy("order_index", "asc")
        .orderBy("request_recipient_id", "asc")
        .execute();
      return rows.map(toRecipient);
    },

    async listFields(signingRequestId: SigningRequestId) {
      const rows = await trx.selectFrom("signing_request_fields")
        .selectAll()
        .where("workspace_id", "=", scope)
        .where("signing_request_id", "=", signingRequestId)
        // The same deterministic order as preparation: page, z-order, then id.
        .orderBy("page_number", "asc")
        .orderBy("layer", "asc")
        .orderBy("request_field_id", "asc")
        .execute();
      return rows.map(toField);
    },
  };
}
