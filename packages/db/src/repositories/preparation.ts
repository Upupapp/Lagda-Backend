// Document preparation persistence.
//
// Geometry and metadata. This repository never opens a PDF, never resolves a
// storage key and never writes an artifact.

import type { Selectable, Transaction } from "kysely";
import type {
  DocumentId, PreparationFieldType, WorkspaceId,
} from "@lagda/contracts";
import { PREPARATION_FIELD_TYPES } from "@lagda/contracts";
import type {
  ScopedPreparationRepository, PreparationRecord, NewPreparation,
  PreparationFieldRecord, PreparationId, PreparationFieldId,
} from "@lagda/application";
import type {
  Database, DocumentPreparationsTable, PreparationFieldsTable,
} from "../schema/index.js";
import { PersistenceMappingError } from "../mapping/index.js";
import { WorkspaceScopeMismatchError, translatePersistenceError } from "../errors.js";

type PreparationRow = Selectable<DocumentPreparationsTable>;
type FieldRow = Selectable<PreparationFieldsTable>;

function toPreparation(row: PreparationRow): PreparationRecord {
  return {
    preparationId: row.preparation_id as PreparationId,
    workspaceId: row.workspace_id as WorkspaceId,
    documentId: row.document_id as DocumentId,
    sourceArtifactId: row.source_artifact_id,
    revision: row.revision,
    lockedAt: row.locked_at === null ? null : row.locked_at.getTime(),
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
}

/**
 * Validated rather than cast.
 *
 * `row.field_type as PreparationFieldType` would accept whatever the column
 * holds. The CHECK constraint makes that unlikely; this makes it impossible to
 * pass silently if the constraint is ever dropped or predates a new value.
 */
function toFieldType(value: string): PreparationFieldType {
  const type = PREPARATION_FIELD_TYPES.find(candidate => candidate === value);
  if (type === undefined) {
    throw new PersistenceMappingError(
      "preparation_fields", "field_type", `"${value}" is not a preparation field type.`);
  }
  return type;
}

function toField(row: FieldRow): PreparationFieldRecord {
  return {
    fieldId: row.field_id as PreparationFieldId,
    type: toFieldType(row.field_type),
    pageNumber: row.page_number,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    required: row.required,
    label: row.label,
    layer: row.layer,
    recipientId: row.recipient_id as never,
  };
}

export function createScopedPreparationRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): ScopedPreparationRepository {
  return {
    async insert(preparation: NewPreparation): Promise<void> {
      if (preparation.workspaceId !== scope) {
        throw new WorkspaceScopeMismatchError(
          "DocumentPreparation", scope, preparation.workspaceId);
      }
      try {
        await trx.insertInto("document_preparations").values({
          preparation_id: preparation.preparationId,
          workspace_id: preparation.workspaceId,
          document_id: preparation.documentId,
          source_artifact_id: preparation.sourceArtifactId,
          revision: 1,
          locked_at: null,
          created_at: new Date(preparation.createdAt),
          updated_at: new Date(preparation.createdAt),
        }).execute();
      } catch (error) {
        // A unique violation here means a concurrent request created the
        // preparation first. The use case converges on that one rather than
        // failing — see `ensurePreparation`.
        throw translatePersistenceError(error);
      }
    },

    async findByDocument(documentId: DocumentId) {
      const row = await trx.selectFrom("document_preparations")
        .selectAll()
        .where("workspace_id", "=", scope)
        .where("document_id", "=", documentId)
        .executeTakeFirst();
      return row === undefined ? null : toPreparation(row);
    },

    async listFields(preparationId: PreparationId) {
      const rows = await trx.selectFrom("preparation_fields")
        .selectAll()
        .where("workspace_id", "=", scope)
        .where("preparation_id", "=", preparationId)
        // The deterministic order, matching `preparation_fields_order_idx`.
        // Page first (how a reader moves through the document), then z-order,
        // then the id so two fields at the same layer never swap between reads.
        .orderBy("page_number", "asc")
        .orderBy("layer", "asc")
        .orderBy("field_id", "asc")
        .execute();
      return rows.map(toField);
    },

    async replaceLayout(input) {
      // ── One transaction, three statements, all conditional ────────────────
      //
      // The caller's transaction, so a validation failure anywhere leaves the
      // previous layout entirely untouched (§247).
      try {
        // 1. Claim the revision. This is the concurrency control AND the
        //    editability check, in one statement — a freeze that commits
        //    between a separate check and this write would otherwise slip
        //    through (§158).
        const claimed = await trx.updateTable("document_preparations")
          .set({ revision: input.expectedRevision + 1, updated_at: new Date(input.now) })
          .where("workspace_id", "=", scope)
          .where("preparation_id", "=", input.preparationId)
          .where("revision", "=", input.expectedRevision)
          .where("locked_at", "is", null)
          .executeTakeFirst();

        if (Number(claimed.numUpdatedRows) !== 1) return null;

        // 2. Clear the old field set. Safe only because the row above is now
        //    claimed at a new revision: a concurrent save is already refused.
        await trx.deleteFrom("preparation_fields")
          .where("workspace_id", "=", scope)
          .where("preparation_id", "=", input.preparationId)
          .execute();

        // 3. Insert the new one. Skipped entirely for an empty layout —
        //    Kysely rejects a zero-row insert, and "clear all fields" is a
        //    legitimate save.
        if (input.fields.length > 0) {
          await trx.insertInto("preparation_fields").values(
            input.fields.map(field => ({
              field_id: field.fieldId,
              workspace_id: scope,
              preparation_id: input.preparationId,
              field_type: field.type,
              page_number: field.pageNumber,
              x: field.x,
              y: field.y,
              width: field.width,
              height: field.height,
              required: field.required,
              label: field.label,
              layer: field.layer,
              recipient_id: field.recipientId,
            })),
          ).execute();
        }

        return input.expectedRevision + 1;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },
  };
}
