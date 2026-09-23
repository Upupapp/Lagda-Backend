// 063 — a template may declare VARIABLES: named values a sender fills in once,
// at apply time, that the document should carry without pretending some
// recipient typed them.
//
// ── Why this is separate from 062 ───────────────────────────────────────────
//
// 062 built the DESTINATION for a static value (`preparation_fields.
// static_value` / `signing_request_fields.static_value`) but nothing that
// PRODUCES one. This is the definition side: a template's own `variables`
// column, the same JSONB-array-of-objects shape `role_slots` (058) already
// uses, for the same reason — a variable's shape (key, label, type,
// required) has no query this schema needs to run against it, only
// validation the application already owns for every other JSONB column here.
//
// ── What this migration does NOT do ─────────────────────────────────────────
//
// It does not connect a variable to a field, a signing request, or a
// rendered document. `workflow_template_fields` still targets a role slot
// only; wiring a field to a variable, and substituting a sender's typed
// value into a real preparation's `static_value` at apply time, is
// deliberately out of scope here — see the application layer's own comment
// on `WorkflowTemplateVariable` for exactly what is and is not connected yet.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("workspace_workflow_templates")
    .addColumn("variables", "jsonb", col => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .execute();

  // The one thing SQL can honestly say about it: it is an array. Unlike
  // `role_slots`, an EMPTY array is the ordinary case — most templates today
  // declare no variables — so there is no "non-empty" half of this check.
  await sql`
    alter table workspace_workflow_templates
      add constraint workflow_templates_variables_are_array
      check (jsonb_typeof(variables) = 'array')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table workspace_workflow_templates
      drop constraint if exists workflow_templates_variables_are_array
  `.execute(db);
  await db.schema
    .alterTable("workspace_workflow_templates")
    .dropColumn("variables")
    .execute();
}
