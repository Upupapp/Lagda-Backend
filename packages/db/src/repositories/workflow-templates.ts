// Migration 058 — reusable workflow templates.
//
// Every statement filters on the bound workspace, and migration 058's
// row-level security filters again in the database. The second one is what
// makes the isolation a guarantee rather than a convention: a query that
// forgot its `where` would still return nothing from another tenant.
//
// The two JSONB columns are handed out RAW. This repository will not assert a
// shape PostgreSQL never checked — parsing and validation belong to the use
// case, which owns the error a caller sees.

import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type {
  WorkspaceId, UserId, DocumentId, WorkflowTemplateVariable,
} from "@lagda/contracts";
import type {
  ScopedWorkflowTemplateRepository, NewWorkflowTemplate,
  WorkflowTemplateUpdate, RawWorkflowTemplateRow, ArtifactId,
} from "@lagda/application";
import type { Database } from "../schema/index.js";
import { WorkspaceScopeMismatchError, translatePersistenceError } from "../errors.js";

interface Row {
  workflow_template_id: string;
  workspace_id: string;
  name: string;
  routing_mode: string;
  role_slots: unknown;
  completion_notification_settings: unknown;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  document_id: string | null;
  source_artifact_id: string | null;
}

/**
 * Variables are ROWS since 064, not a JSONB column on the template.
 *
 * They are still handed to the use case as a plain array on
 * `RawWorkflowTemplateRow.variables`, so `validateVariables()` and every
 * caller above this layer see exactly the shape they saw before. What changed
 * is only where the array comes from — and that a field can now hold a real
 * foreign key to one of these rows, which a JSONB array could never offer.
 */
interface VariableRow {
  variable_id: string;
  workflow_template_id: string;
  variable_key: string;
  label: string;
  variable_type: string;
  required: boolean;
  ordinal: number;
}

const toVariable = (row: VariableRow): WorkflowTemplateVariable => ({
  key: row.variable_key,
  label: row.label,
  type: row.variable_type as WorkflowTemplateVariable["type"],
  required: row.required,
});

/**
 * JSONB comes back parsed from `pg` already, but a driver or a column written
 * by hand can still hand over a string. Parsed once here so the use case sees
 * one shape; anything unparseable stays `unknown` and fails validation there
 * rather than throwing from inside a repository.
 */
function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

const toRaw = (
  row: Row,
  variables: readonly WorkflowTemplateVariable[],
): RawWorkflowTemplateRow => ({
  workflowTemplateId: row.workflow_template_id,
  workspaceId: row.workspace_id as WorkspaceId,
  name: row.name,
  routingMode: row.routing_mode,
  roleSlots: jsonValue(row.role_slots),
  completionSettings: jsonValue(row.completion_notification_settings),
  variables,
  createdBy: row.created_by as UserId,
  createdAt: row.created_at.getTime(),
  updatedAt: row.updated_at.getTime(),
  documentId: row.document_id as DocumentId | null,
  sourceArtifactId: row.source_artifact_id as ArtifactId | null,
});

export function createScopedWorkflowTemplateRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): ScopedWorkflowTemplateRepository {
  const scoped = () => trx
    .selectFrom("workspace_workflow_templates")
    .where("workspace_id", "=", scope);

  async function readVariables(
    templateIds: readonly string[],
  ): Promise<Map<string, WorkflowTemplateVariable[]>> {
    const rows = await trx
      .selectFrom("workflow_template_variables")
      .select([
        "variable_id", "workflow_template_id", "variable_key",
        "label", "variable_type", "required", "ordinal",
      ])
      .where("workspace_id", "=", scope)
      .where("workflow_template_id", "in", templateIds)
      .orderBy("ordinal", "asc")
      .orderBy("variable_id", "asc")
      .execute();

    const byTemplate = new Map<string, WorkflowTemplateVariable[]>();
    for (const row of rows) {
      const list = byTemplate.get(row.workflow_template_id) ?? [];
      list.push(toVariable(row));
      byTemplate.set(row.workflow_template_id, list);
    }
    return byTemplate;
  }

  /**
   * Reconciles a template's variables against the list it should now hold.
   *
   * Matched BY KEY, not by position, and emphatically not by delete-all-then-
   * reinsert. The key is the identity a field binds to: `contract_date` is
   * still `contract_date` after its label is corrected or another variable is
   * inserted above it, and a field bound to it must keep pointing at the same
   * row. Deleting and reinserting would mint a new `variable_id` on every
   * save, and the ON DELETE RESTRICT foreign key would — correctly — refuse.
   *
   * Order is load-bearing: inserts and updates first, deletions last. A field
   * that is being unbound in the same transaction has already released its
   * reference by the time the variable it pointed at is removed.
   */
  async function writeVariables(
    workflowTemplateId: string,
    variables: readonly WorkflowTemplateVariable[],
    at: Date,
  ): Promise<void> {
    const existing = await trx
      .selectFrom("workflow_template_variables")
      .select(["variable_id", "variable_key"])
      .where("workspace_id", "=", scope)
      .where("workflow_template_id", "=", workflowTemplateId)
      .execute();
    const idByKey = new Map(existing.map(r => [r.variable_key, r.variable_id]));

    const keep = new Set<string>();
    for (const [ordinal, variable] of variables.entries()) {
      keep.add(variable.key);
      const existingId = idByKey.get(variable.key);
      if (existingId === undefined) {
        await trx.insertInto("workflow_template_variables").values({
          variable_id: `wfv_${randomUUID().replace(/-/g, "")}`,
          workspace_id: scope,
          workflow_template_id: workflowTemplateId,
          variable_key: variable.key,
          label: variable.label,
          variable_type: variable.type,
          required: variable.required,
          ordinal,
          created_at: at,
          updated_at: at,
        }).execute();
        continue;
      }
      await trx.updateTable("workflow_template_variables")
        .set({
          label: variable.label,
          variable_type: variable.type,
          required: variable.required,
          ordinal,
          updated_at: at,
        })
        .where("workspace_id", "=", scope)
        .where("variable_id", "=", existingId)
        .execute();
    }

    const removed = existing.filter(r => !keep.has(r.variable_key));
    if (removed.length === 0) return;
    // Last. A bound field still pointing here makes this raise
    // `workflow_template_fields_variable_fk`, which translatePersistenceError
    // turns into a named domain error — the backstop behind the application's
    // own friendlier check.
    await trx.deleteFrom("workflow_template_variables")
      .where("workspace_id", "=", scope)
      .where("variable_id", "in", removed.map(r => r.variable_id))
      .execute();
  }

  return {
    async insert(template: NewWorkflowTemplate): Promise<void> {
      if (template.workspaceId !== scope) {
        throw new WorkspaceScopeMismatchError(
          "WorkflowTemplate", scope, template.workspaceId);
      }
      try {
        await trx.insertInto("workspace_workflow_templates").values({
          workflow_template_id: template.workflowTemplateId,
          workspace_id: template.workspaceId,
          name: template.name,
          routing_mode: template.routingMode,
          role_slots: JSON.stringify(template.roleSlots),
          completion_notification_settings: JSON.stringify(template.completionSettings),
          created_by: template.createdBy,
          created_at: new Date(template.createdAt),
          // Equal to `created_at` on insert, never null — the same position
          // contacts takes, and for the same reason: "never edited" and
          // "edited at T" are both answered by one column, and the default
          // sort has no undefined case.
          updated_at: new Date(template.createdAt),
        }).execute();
        await writeVariables(
          template.workflowTemplateId, template.variables, new Date(template.createdAt));
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async find(workflowTemplateId) {
      const row = await scoped()
        .selectAll()
        .where("workflow_template_id", "=", workflowTemplateId)
        .executeTakeFirst();
      if (row === undefined) return null;
      const byTemplate = await readVariables([workflowTemplateId]);
      return toRaw(row, byTemplate.get(workflowTemplateId) ?? []);
    },

    async list() {
      const rows = await scoped()
        .selectAll()
        // Most recently changed first, matching the index this leads with.
        .orderBy("updated_at", "desc")
        .orderBy("workflow_template_id", "desc")
        .execute();
      if (rows.length === 0) return [];
      // ONE query for every template's variables, not one per template. A
      // workspace with 200 templates would otherwise issue 201 queries to
      // render a list that shows no variables at all.
      const byTemplate = await readVariables(rows.map(r => r.workflow_template_id));
      return rows.map(row => toRaw(row, byTemplate.get(row.workflow_template_id) ?? []));
    },

    async update(workflowTemplateId, update: WorkflowTemplateUpdate) {
      try {
        const result = await trx.updateTable("workspace_workflow_templates")
          .set({
            name: update.name,
            routing_mode: update.routingMode,
            role_slots: JSON.stringify(update.roleSlots),
            completion_notification_settings: JSON.stringify(update.completionSettings),
            updated_at: new Date(update.updatedAt),
          })
          .where("workspace_id", "=", scope)
          .where("workflow_template_id", "=", workflowTemplateId)
          .executeTakeFirst();
        if (Number(result.numUpdatedRows) === 0) return false;
        await writeVariables(workflowTemplateId, update.variables, new Date(update.updatedAt));
        return true;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async remove(workflowTemplateId) {
      const result = await trx.deleteFrom("workspace_workflow_templates")
        .where("workspace_id", "=", scope)
        .where("workflow_template_id", "=", workflowTemplateId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },

    async nameExists(name, exceptId) {
      // Same normalization as the unique index: trimmed and lowercased. The
      // index is still the guarantee; this exists so a duplicate is a named
      // conflict rather than a constraint violation surfacing as a 500.
      let query = scoped()
        .select("workflow_template_id")
        .where(sql<boolean>`lower(btrim(name)) = lower(btrim(${name}))`);
      if (exceptId !== null) {
        query = query.where("workflow_template_id", "!=", exceptId);
      }
      const row = await query.executeTakeFirst();
      return row !== undefined;
    },

    async attachDocument(workflowTemplateId, document) {
      try {
        const result = await trx.updateTable("workspace_workflow_templates")
          .set({
            document_id: document.documentId,
            source_artifact_id: document.artifactId,
            updated_at: new Date(document.updatedAt),
          })
          .where("workspace_id", "=", scope)
          .where("workflow_template_id", "=", workflowTemplateId)
          .executeTakeFirst();
        return Number(result.numUpdatedRows) > 0;
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async detachDocument(workflowTemplateId, updatedAt) {
      const result = await trx.updateTable("workspace_workflow_templates")
        .set({
          document_id: null, source_artifact_id: null,
          updated_at: new Date(updatedAt),
        })
        .where("workspace_id", "=", scope)
        .where("workflow_template_id", "=", workflowTemplateId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
  };
}
