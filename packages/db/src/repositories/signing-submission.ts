// Signature submission persistence (BACKEND-36).
//
// Bound to one workspace, one request and one recipient from the trusted
// session, exactly as the ceremony repository is. Two methods, and neither of
// them can change an accepted value: there is no update and no delete, at this
// layer or in the runtime role's privileges.

import type { Transaction } from "kysely";
import type { WorkspaceId } from "@lagda/contracts";
import type {
  RecipientSubmissionRepository, AcceptedSubmissionRecord,
  NewRecipientSubmission, RecipientSubmissionId,
  SigningRequestId, SigningRequestRecipientId,
} from "@lagda/application";
import type { Database } from "../schema/index.js";

export interface SubmissionScope {
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: SigningRequestId;
  readonly recipientId: SigningRequestRecipientId;
}

export function createRecipientSubmissionRepository(
  trx: Transaction<Database>,
  scope: SubmissionScope,
): RecipientSubmissionRepository {
  const { workspaceId, signingRequestId, recipientId } = scope;

  return {
    async findAccepted(): Promise<AcceptedSubmissionRecord | null> {
      const row = await trx
        .selectFrom("recipient_submissions as s")
        .select(eb => [
          "s.submission_id", "s.accepted_at",
          eb.selectFrom("signing_field_values as v")
            .whereRef("v.submission_id", "=", "s.submission_id")
            .select(eb2 => eb2.fn.countAll<string>().as("n"))
            .as("value_count"),
        ])
        .where("s.workspace_id", "=", workspaceId)
        .where("s.signing_request_id", "=", signingRequestId)
        .where("s.request_recipient_id", "=", recipientId)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        submissionId: row.submission_id as RecipientSubmissionId,
        acceptedAt: row.accepted_at.getTime(),
        acceptedFieldCount: Number(row.value_count ?? "0"),
      };
    },

    /**
     * One statement group, one transaction.
     *
     * Representations before values, because a value references a
     * representation. Everything commits together or nothing does — §135, and
     * a failure on the last value rolls back the first (§136).
     */
    async create(submission: NewRecipientSubmission): Promise<void> {
      await trx
        .insertInto("recipient_submissions")
        .values({
          submission_id: submission.submissionId,
          workspace_id: workspaceId,
          signing_request_id: signingRequestId,
          request_recipient_id: recipientId,
          accepted_at: new Date(submission.acceptedAt),
          signing_session_id: submission.signingSessionId,
          authentication_method: submission.authenticationMethod,
          consent_id: submission.consentId,
        })
        .execute();

      if (submission.representations.length > 0) {
        await trx
          .insertInto("signing_representations")
          .values(submission.representations.map(rep => ({
            representation_id: rep.representationId,
            workspace_id: workspaceId,
            signing_request_id: signingRequestId,
            request_recipient_id: recipientId,
            submission_id: submission.submissionId,
            purpose: rep.purpose,
            representation_type: rep.representationType,
            typed_text: rep.typedText,
            typed_style_index: rep.typedStyleIndex,
            raster_bytes: rep.rasterBytes,
            raster_media_type: rep.rasterMediaType,
            raster_width: rep.rasterWidth,
            raster_height: rep.rasterHeight,
            digest: rep.digest,
          })))
          .execute();
      }

      if (submission.values.length > 0) {
        await trx
          .insertInto("signing_field_values")
          .values(submission.values.map(value => ({
            value_id: value.valueId,
            workspace_id: workspaceId,
            signing_request_id: signingRequestId,
            request_recipient_id: recipientId,
            submission_id: submission.submissionId,
            request_field_id: value.fieldId,
            field_type: value.fieldType,
            value_kind: value.valueKind,
            value_source: value.valueSource,
            text_value: value.textValue,
            boolean_value: value.booleanValue,
            instant_value: value.instantValue === null
              ? null : new Date(value.instantValue),
            representation_id: value.representationId,
          })))
          .execute();
      }
    },
  };
}
