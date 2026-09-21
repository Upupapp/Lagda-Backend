// Signing request persistence.
//
// Write-once. `createSnapshot` is the only mutation in this file, and the
// runtime role holds no UPDATE grant on either snapshot table — so a method
// that tried to change a recipient or a field would fail at the database, not
// merely be absent from an interface.

import { sql, type Selectable, type Transaction } from "kysely";
import type {
  DocumentId, PreparationFieldType, RecipientType, SigningRequestState,
  UserId, WorkspaceId,
} from "@lagda/contracts";
import {
  PREPARATION_FIELD_TYPES, RECIPIENT_TYPES, SIGNING_REQUEST_STATES,
} from "@lagda/contracts";
import type {
  ScopedSigningRequestRepository, NewSigningRequestSnapshot, SigningRequestSummary,
  SigningRequestRecord, SigningRequestRecipientRecord, SigningRequestFieldRecord,
  SigningRequestId, SigningRequestRecipientId, SigningRequestFieldId,
  ArtifactId, PreparationId, PreparationFieldId, RecipientId,
  SigningRequestExpiryIndexRepository,
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

/**
 * The states a send may start from.
 *
 * Mirrors `@lagda/core`'s `isEditableForSend`. Written as a constant rather
 * than inline so the predicate has a name a reader can go and check.
 */
const SENDABLE_STATES = ["draft", "ready-to-send"] as const;

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
    completedAt: row.completed_at === null ? null : row.completed_at.getTime(),
    expiresAt: row.expires_at === null ? null : row.expires_at.getTime(),
    completionReadyAt:
      row.completion_ready_at === null ? null : row.completion_ready_at.getTime(),
    terminatedAt: row.terminated_at === null ? null : row.terminated_at.getTime(),
    // Validated rather than cast, like every other persisted vocabulary here.
    terminationReason: row.termination_reason === null ? null : oneOf(
      ["declined", "cancelled"] as const,
      "signing_requests", "termination_reason", row.termination_reason),
    cancellationNote: row.cancellation_note,
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
    /**
     * The workspace's requests, latest first, with recipient counts.
     *
     * ONE query, not one per row. The counts are correlated subqueries rather
     * than joins: joining both recipients and their activation rows would
     * multiply the result set and need a second grouping to undo.
     *
     * Recipient state lives on the ACTIVATION row, not the recipient. A
     * recipient exists from the moment the request is created and only becomes
     * `signed` once activated, so counting recipient rows would report every
     * participant as complete.
     */
    async listForWorkspace(query) {
      const rows = await sql<{
        signing_request_id: string;
        document_id: string;
        state: string;
        document_title: string;
        created_at: Date;
        sent_at: Date | null;
        completed_at: Date | null;
        expires_at: Date | null;
        participant_count: string;
        completed_participant_count: string;
        initiator_name: string | null;
        initiator_email: string | null;
      }>`
        select
          sr.signing_request_id, sr.document_id, sr.state, sr.document_title,
          sr.created_at, sr.sent_at, sr.completed_at, sr.expires_at,
          -- Who sent it. A LEFT join, because created_by_user_id has no
          -- foreign key to users and a deleted account must not make the
          -- request itself disappear from the list: the request is the
          -- workspace record, not the sender one.
          u.display_name as initiator_name,
          u.email        as initiator_email,
          (select count(*) from signing_request_recipients r
             where r.signing_request_id = sr.signing_request_id)
            as participant_count,
          (select count(*) from signing_request_recipient_activation a
             where a.signing_request_id = sr.signing_request_id
               and a.recipient_state = 'signed')
            as completed_participant_count
        from signing_requests sr
        left join users u on u.user_id = sr.created_by_user_id
        where sr.workspace_id = ${scope}
        order by sr.created_at desc, sr.signing_request_id desc
        limit ${query.limit} offset ${query.offset}
      `.execute(trx);

      const counted = await trx.selectFrom("signing_requests")
        .select(eb => eb.fn.countAll<string>().as("total"))
        .where("workspace_id", "=", scope)
        .executeTakeFirstOrThrow();

      return {
        items: rows.rows.map(row => ({
          signingRequestId: row.signing_request_id as SigningRequestId,
          documentId: row.document_id as DocumentId,
          state: row.state as SigningRequestSummary["state"],
          documentTitle: row.document_title,
          participantCount: Number(row.participant_count),
          completedParticipantCount: Number(row.completed_participant_count),
          // Null when the account has gone. The row stays; the attribution
          // degrades rather than the record vanishing.
          initiator: row.initiator_name === null && row.initiator_email === null
            ? null
            : { name: row.initiator_name ?? "", email: row.initiator_email ?? "" },
          createdAt: row.created_at.getTime(),
          sentAt: row.sent_at === null ? null : row.sent_at.getTime(),
          completedAt: row.completed_at === null ? null : row.completed_at.getTime(),
          expiresAt: row.expires_at === null ? null : row.expires_at.getTime(),
        })),
        total: Number(counted.total),
      };
    },

    /**
     * One GROUP BY, scoped by the same predicate as the list.
     *
     * Started from a zero for every state the contract knows, then
     * overwritten by whatever the database reports: a state with no rows is
     * absent from a grouped result, and the caller must not have to know
     * that to sum the answer.
     */
    async countByState() {
      const rows = await sql<{ state: string; count: string }>`
        select sr.state, count(*) as count
        from signing_requests sr
        where sr.workspace_id = ${scope}
        group by sr.state
      `.execute(trx);

      const counts = Object.fromEntries(
        SIGNING_REQUEST_STATES.map(state => [state, 0]),
      ) as Record<SigningRequestState, number>;
      for (const row of rows.rows) {
        if ((SIGNING_REQUEST_STATES as readonly string[]).includes(row.state)) {
          counts[row.state as SigningRequestState] = Number(row.count);
        }
      }
      return counts;
    },

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

    async markSentIfSendable(input) {
      try {
        const claimed = await trx.updateTable("signing_requests")
          .set({ state: "sent", sent_at: new Date(input.sentAt),
                 updated_at: new Date(input.sentAt) })
          .where("workspace_id", "=", scope)
          .where("signing_request_id", "=", input.signingRequestId)
          // The whole concurrency control, in one predicate. A second send
          // matches zero rows rather than sending twice.
          //
          // BOTH sendable states, which is core's `isEditableForSend` and not
          // a widening invented here: the review state is optional, so a draft
          // still sends directly.
          .where("state", "in", SENDABLE_STATES)
          .executeTakeFirst();
        return Number(claimed.numUpdatedRows) === 1;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async markReadyToSendIfDraft(input) {
      try {
        const applied = await trx.updateTable("signing_requests")
          .set({ state: "ready-to-send", updated_at: new Date(input.now) })
          .where("workspace_id", "=", scope)
          .where("signing_request_id", "=", input.signingRequestId)
          .where("state", "=", "draft")
          .executeTakeFirst();
        return Number(applied.numUpdatedRows) === 1;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async returnToDraftIfReady(input) {
      try {
        const applied = await trx.updateTable("signing_requests")
          .set({ state: "draft", updated_at: new Date(input.now) })
          .where("workspace_id", "=", scope)
          .where("signing_request_id", "=", input.signingRequestId)
          // Only from the review state. A SENT request is not retractable this
          // way; `cancel` is the operation for that, and it tells recipients.
          .where("state", "=", "ready-to-send")
          .executeTakeFirst();
        return Number(applied.numUpdatedRows) === 1;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async setExpiry(input) {
      try {
        // The index is NOT written here. A trigger maintains it, so this
        // statement cannot be the one that forgets, and there is one writer
        // for one fact.
        const applied = await trx.updateTable("signing_requests")
          .set({
            expires_at: input.expiresAt === null ? null : new Date(input.expiresAt),
            updated_at: new Date(input.now),
          })
          .where("workspace_id", "=", scope)
          .where("signing_request_id", "=", input.signingRequestId)
          .executeTakeFirst();
        return Number(applied.numUpdatedRows) === 1;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async expireIfDue(input) {
      try {
        const applied = await trx.updateTable("signing_requests")
          .set({ state: "expired", updated_at: new Date(input.now) })
          .where("workspace_id", "=", scope)
          .where("signing_request_id", "=", input.signingRequestId)
          // BOTH conditions are in the statement, not read beforehand. The
          // sweep found this id OUTSIDE this transaction; since then the
          // request may have been signed, cancelled, or had its deadline
          // extended, and a sweep that trusted its own stale read would expire
          // a request somebody had just rescued.
          .where("state", "in", ["sent", "partially-completed"])
          .where("expires_at", "<=", new Date(input.now))
          .executeTakeFirst();
        return Number(applied.numUpdatedRows) === 1;
      } catch (error) {
        throw translatePersistenceError(error);
      }
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

/**
 * The expiry index, read WITHOUT a tenant.
 *
 * `signing_requests` cannot be scanned here: `tenant_isolation` is
 * `workspace_id = lagda_current_workspace()` and a global transaction sets no
 * such context, so the scan would return nothing. This reads the unpoliced
 * index instead -- three columns, maintained by a trigger -- and the caller
 * enters each workspace properly to do the work.
 */
export function createSigningRequestExpiryIndexRepository(
  trx: Transaction<Database>,
): SigningRequestExpiryIndexRepository {
  return {
    async listDue(input) {
      const rows = await trx.selectFrom("signing_request_expiry_index")
        .select(["signing_request_id", "workspace_id", "expires_at"])
        .where("expires_at", "<=", new Date(input.now))
        // Longest overdue first. An arbitrary order could starve one request
        // indefinitely while the batch size held.
        .orderBy("expires_at", "asc")
        .limit(input.limit)
        .execute();
      return rows.map(row => ({
        signingRequestId: row.signing_request_id as SigningRequestId,
        workspaceId: row.workspace_id as WorkspaceId,
        expiresAt: row.expires_at.getTime(),
      }));
    },
  };
}
