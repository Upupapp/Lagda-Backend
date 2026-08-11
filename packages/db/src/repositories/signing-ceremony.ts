// Signing ceremony reads and writes (BACKEND-35).
//
// Bound at construction to one workspace, one request and one recipient — all
// three out of the trusted session. No method takes an identifying argument,
// so there is no call site that could pass the wrong one.
//
// Every predicate here is written even though migration 022's restrictive
// policies enforce the same scope. Belt and braces, deliberately: the policies
// stop a bug from LEAKING, and the predicates stop the query from being wrong
// in the first place. Neither is a reason to omit the other.

import type { Transaction } from "kysely";
import type { WorkspaceId } from "@lagda/contracts";
import { RECIPIENT_WORKFLOW_STATES } from "@lagda/contracts";
import type {
  RecipientCeremonyRepository, CeremonyArtifactRecord, CeremonyProgressRecord,
  CeremonyConsentRecord, NewCeremonyConsent, RecipientActivationState,
  SigningRequestRecord, SigningRequestRecipientRecord, SigningRequestFieldRecord,
  SigningRequestId, SigningRequestRecipientId, ArtifactId, StorageObjectKey,
} from "@lagda/application";
import type {
  DocumentId, PreparationFieldType, RecipientType, SigningRequestState,
} from "@lagda/contracts";
import type { Database } from "../schema/index.js";
import { PersistenceMappingError } from "../mapping/index.js";
import type {
  PreparationId, UserId, SigningRequestFieldId,
} from "@lagda/application";

export interface CeremonyScope {
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: SigningRequestId;
  readonly recipientId: SigningRequestRecipientId;
}

export function createRecipientCeremonyRepository(
  trx: Transaction<Database>,
  scope: CeremonyScope,
): RecipientCeremonyRepository {
  const { workspaceId, signingRequestId, recipientId } = scope;

  return {
    async getRequest(): Promise<SigningRequestRecord | null> {
      const row = await trx
        .selectFrom("signing_requests")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("signing_request_id", "=", signingRequestId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        signingRequestId: row.signing_request_id as SigningRequestId,
        workspaceId: row.workspace_id as WorkspaceId,
        documentId: row.document_id as DocumentId,
        sourceArtifactId: row.source_artifact_id as ArtifactId,
        sourcePreparationId: row.source_preparation_id as PreparationId,
        sourcePreparationRevision: row.source_preparation_revision,
        state: row.state as SigningRequestState,
        completedAt:
          row.completed_at === null ? null : row.completed_at.getTime(),
        completionReadyAt:
          row.completion_ready_at === null ? null : row.completion_ready_at.getTime(),
        terminatedAt: row.terminated_at === null ? null : row.terminated_at.getTime(),
        terminationReason: row.termination_reason as "declined" | "cancelled" | null,
        // NOT projected onward. The ceremony DTO carries no cancellation note -
        // it is the sender's words about their own document, and a recipient is
        // told that the request was cancelled, not what the sender wrote.
        cancellationNote: row.cancellation_note,
        documentTitle: row.document_title,
        createdByUserId: row.created_by_user_id as UserId,
        createdAt: row.created_at.getTime(),
        updatedAt: row.updated_at.getTime(),
      };
    },

    async getRecipient(): Promise<SigningRequestRecipientRecord | null> {
      const row = await trx
        .selectFrom("signing_request_recipients")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("signing_request_id", "=", signingRequestId)
        .where("request_recipient_id", "=", recipientId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        recipientId: row.request_recipient_id as SigningRequestRecipientId,
        sourcePreparationRecipientId: null,
        name: row.name,
        email: row.email,
        normalizedEmail: row.normalized_email,
        organization: row.organization,
        type: row.recipient_type as RecipientType,
        isRequired: row.is_required,
        orderIndex: row.order_index,
        routingOrder: row.routing_order,
      };
    },

    async getActivationState(): Promise<RecipientActivationState | null> {
      const row = await trx
        .selectFrom("signing_request_recipient_activation")
        .select("recipient_state")
        .where("workspace_id", "=", workspaceId)
        .where("signing_request_id", "=", signingRequestId)
        .where("request_recipient_id", "=", recipientId)
        .executeTakeFirst();
      if (row === undefined) return null;
      // Validated, not cast. BACKEND-37 widened this vocabulary from two values
      // to four, and a blind cast would have carried whatever the column holds
      // straight into the decision about whether somebody may sign (§187).
      const state = RECIPIENT_WORKFLOW_STATES.find(
        candidate => candidate === row.recipient_state);
      if (state === undefined) {
        throw new PersistenceMappingError(
          "signing_request_recipient_activation", "recipient_state",
          `"${row.recipient_state}" is not a recipient state.`);
      }
      return state;
    },

    async listAssignedFields(): Promise<readonly SigningRequestFieldRecord[]> {
      const rows = await trx
        .selectFrom("signing_request_fields")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("signing_request_id", "=", signingRequestId)
        // The filter that matters. `request_recipient_id` is NOT NULL on every
        // field, so this partitions the request's fields completely.
        .where("request_recipient_id", "=", recipientId)
        .execute();
      return rows.map(row => ({
        fieldId: row.request_field_id as SigningRequestFieldId,
        sourcePreparationFieldId: null,
        type: row.field_type as PreparationFieldType,
        pageNumber: row.page_number,
        x: row.x,
        y: row.y,
        width: row.width,
        height: row.height,
        required: row.required,
        label: row.label,
        layer: row.layer,
        recipientId: row.request_recipient_id as SigningRequestRecipientId,
      }));
    },

    /**
     * Joined FROM the request, never looked up by an id a caller supplied.
     *
     * `signing_requests.source_artifact_id` is the join key, so this cannot
     * return the document's current artifact even if one exists and is newer.
     * That is §19 and §104 expressed as a query rather than as a rule.
     */
    async getSourceArtifact(): Promise<CeremonyArtifactRecord | null> {
      const row = await trx
        .selectFrom("signing_requests as r")
        .innerJoin("document_artifacts as a", join => join
          .onRef("a.artifact_id", "=", "r.source_artifact_id")
          .onRef("a.workspace_id", "=", "r.workspace_id"))
        .select([
          "a.artifact_id", "a.media_type", "a.size_bytes", "a.digest",
          "a.page_count", "a.storage_reference",
        ])
        .where("r.workspace_id", "=", workspaceId)
        .where("r.signing_request_id", "=", signingRequestId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        artifactId: row.artifact_id as ArtifactId,
        mediaType: row.media_type,
        // `bigint`, read as a string to avoid silent precision loss.
        sizeBytes: Number(row.size_bytes),
        digest: row.digest,
        pageCount: row.page_count,
        storageReference: row.storage_reference as StorageObjectKey,
      };
    },

    async getProgress(): Promise<CeremonyProgressRecord | null> {
      const row = await trx
        .selectFrom("signing_recipient_progress")
        .select("first_entered_at")
        .where("workspace_id", "=", workspaceId)
        .where("signing_request_id", "=", signingRequestId)
        .where("request_recipient_id", "=", recipientId)
        .executeTakeFirst();
      return row === undefined
        ? null
        : { firstEnteredAt: row.first_entered_at.getTime() };
    },

    async listConsents(): Promise<readonly CeremonyConsentRecord[]> {
      const rows = await trx
        .selectFrom("signing_recipient_consents")
        .select(["consent_type", "consent_version", "accepted_at"])
        .where("workspace_id", "=", workspaceId)
        .where("signing_request_id", "=", signingRequestId)
        .where("request_recipient_id", "=", recipientId)
        .execute();
      return rows.map(row => ({
        consentType: row.consent_type,
        consentVersion: row.consent_version,
        acceptedAt: row.accepted_at.getTime(),
      }));
    },

    /**
     * `on conflict do nothing`, so the FIRST entry is the one that stands.
     *
     * No read-then-write, therefore no window in which two concurrent entries
     * both decide they are first. The return value says whether this call
     * inserted, which the caller uses only to know it should read the
     * authoritative timestamp back.
     */
    async recordFirstEntry(input: {
      readonly firstEnteredAt: number;
      readonly createdAt: number;
    }): Promise<boolean> {
      const result = await trx
        .insertInto("signing_recipient_progress")
        .values({
          workspace_id: workspaceId,
          signing_request_id: signingRequestId,
          request_recipient_id: recipientId,
          first_entered_at: new Date(input.firstEnteredAt),
          created_at: new Date(input.createdAt),
        })
        .onConflict(oc => oc.columns([
          "workspace_id", "signing_request_id", "request_recipient_id",
        ]).doNothing())
        .executeTakeFirst();
      return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
    },

    /**
     * Append-only. The unique constraint makes a repeat acceptance converge on
     * the row that already exists rather than adding a second one.
     */
    async insertConsent(consent: NewCeremonyConsent): Promise<boolean> {
      const result = await trx
        .insertInto("signing_recipient_consents")
        .values({
          consent_id: consent.consentId,
          workspace_id: workspaceId,
          signing_request_id: signingRequestId,
          request_recipient_id: recipientId,
          consent_type: consent.consentType,
          consent_version: consent.consentVersion,
          accepted_at: new Date(consent.acceptedAt),
          signing_session_id: consent.signingSessionId,
          authentication_method: consent.authenticationMethod,
          created_at: new Date(consent.createdAt),
        })
        .onConflict(oc => oc.columns([
          "workspace_id", "signing_request_id", "request_recipient_id",
          "consent_type", "consent_version",
        ]).doNothing())
        .executeTakeFirst();
      return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
    },
  };
}
