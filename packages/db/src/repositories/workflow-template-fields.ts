// Workflow-template field-placement persistence (060).
//
// Mirrors `preparation.ts`'s `listFields`/`replaceLayout` pair, minus the
// revision claim — see `ScopedWorkflowTemplateFieldRepository`'s header for
// why a template's field layout needs no concurrency control.

import type { Selectable, Transaction } from "kysely";
import type { PreparationFieldType, WorkspaceId } from "@lagda/contracts";
import { PREPARATION_FIELD_TYPES } from "@lagda/contracts";
import type {
  ScopedWorkflowTemplateFieldRepository, WorkflowTemplateFieldRecord,
  WorkflowTemplateFieldId,
} from "@lagda/application";
import type { Database, WorkflowTemplateFieldsTable } from "../schema/index.js";
import { PersistenceMappingError } from "../mapping/index.js";
import { translatePersistenceError } from "../errors.js";

type FieldRow = Selectable<WorkflowTemplateFieldsTable>;

/** Validated rather than cast, exactly like `preparation.ts`'s `toFieldType` —
 *  the CHECK constraint makes an unrecognised value unlikely, this makes it
 *  impossible to pass silently if that constraint is ever dropped. */
function toFieldType(value: string): PreparationFieldType {
  const type = PREPARATION_FIELD_TYPES.find(candidate => candidate === value);
  if (type === undefined) {
    throw new PersistenceMappingError(
      "workflow_template_fields", "field_type", `"${value}" is not a preparation field type.`);
  }
  return type;
}

function toField(row: FieldRow): WorkflowTemplateFieldRecord {
  return {
    fieldId: row.field_id as WorkflowTemplateFieldId,
    slotId: row.slot_id,
    type: toFieldType(row.field_type),
    pageNumber: row.page_number,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    required: row.required,
    label: row.label,
    layer: row.layer,
  };
}

export function createScopedWorkflowTemplateFieldRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): ScopedWorkflowTemplateFieldRepository {
  return {
    async list(workflowTemplateId: string) {
      const rows = await trx.selectFrom("workflow_template_fields")
        .selectAll()
        .where("workspace_id", "=", scope)
        .where("workflow_template_id", "=", workflowTemplateId)
        // Matches `workflow_template_fields_order_idx`: page, then z-order,
        // then id, so two fields at the same layer never swap between reads.
        .orderBy("page_number", "asc")
        .orderBy("layer", "asc")
        .orderBy("field_id", "asc")
        .execute();
      return rows.map(toField);
    },

    async replaceAll(workflowTemplateId, fields, now) {
      try {
        // Delete then insert, in the caller's transaction — the same
        // atomic-replace pattern `preparation.ts`'s `replaceLayout` uses,
        // minus the revision claim: nothing else needs to be true first.
        await trx.deleteFrom("workflow_template_fields")
          .where("workspace_id", "=", scope)
          .where("workflow_template_id", "=", workflowTemplateId)
          .execute();

        // Skipped for an empty layout — Kysely rejects a zero-row insert,
        // and "clear all fields" is a legitimate save.
        if (fields.length > 0) {
          const at = new Date(now);
          await trx.insertInto("workflow_template_fields").values(
            fields.map(field => ({
              field_id: field.fieldId,
              workspace_id: scope,
              workflow_template_id: workflowTemplateId,
              slot_id: field.slotId,
              field_type: field.type,
              page_number: field.pageNumber,
              x: field.x,
              y: field.y,
              width: field.width,
              height: field.height,
              created_at: at,
              updated_at: at,
              required: field.required,
              label: field.label,
              layer: field.layer,
            })),
          ).execute();
        }
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },
  };
}
