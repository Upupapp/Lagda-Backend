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

import { sql, type Transaction } from "kysely";
import type { WorkspaceId, UserId } from "@lagda/contracts";
import type {
  ScopedWorkflowTemplateRepository, NewWorkflowTemplate,
  WorkflowTemplateUpdate, RawWorkflowTemplateRow,
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
}

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

const toRaw = (row: Row): RawWorkflowTemplateRow => ({
  workflowTemplateId: row.workflow_template_id,
  workspaceId: row.workspace_id as WorkspaceId,
  name: row.name,
  routingMode: row.routing_mode,
  roleSlots: jsonValue(row.role_slots),
  completionSettings: jsonValue(row.completion_notification_settings),
  createdBy: row.created_by as UserId,
  createdAt: row.created_at.getTime(),
  updatedAt: row.updated_at.getTime(),
});

export function createScopedWorkflowTemplateRepository(
  trx: Transaction<Database>,
  scope: WorkspaceId,
): ScopedWorkflowTemplateRepository {
  const scoped = () => trx
    .selectFrom("workspace_workflow_templates")
    .where("workspace_id", "=", scope);

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
      } catch (error) {
        throw translatePersistenceError(error);
      }
    },

    async find(workflowTemplateId) {
      const row = await scoped()
        .selectAll()
        .where("workflow_template_id", "=", workflowTemplateId)
        .executeTakeFirst();
      return row === undefined ? null : toRaw(row);
    },

    async list() {
      const rows = await scoped()
        .selectAll()
        // Most recently changed first, matching the index this leads with.
        .orderBy("updated_at", "desc")
        .orderBy("workflow_template_id", "desc")
        .execute();
      return rows.map(row => toRaw(row));
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
        return Number(result.numUpdatedRows) > 0;
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
  };
}
