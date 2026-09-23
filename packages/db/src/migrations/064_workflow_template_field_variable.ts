// 064 — a template field may be filled from a VARIABLE instead of a role slot.
//
// ── The gap this closes ─────────────────────────────────────────────────────
//
// 062 built the DESTINATION for a value nobody types during signing
// (`preparation_fields.static_value`), and 063 let a template DECLARE named
// variables. Neither connected them, and 063's own header says so: "It does
// not connect a variable to a field, a signing request, or a rendered
// document."
//
// So a sender could declare `contract_date`, place a field, and there was no
// way to say the second is filled by the first. The values collected in the
// apply wizard were shown on a review screen and discarded — the UI told the
// user as much.
//
// This is the join: a field targets EITHER a role slot (a person signs it) or
// a variable (the sender types it once, at apply time).
//
// ── Why `variable_key` and not a foreign key ───────────────────────────────
//
// `slot_id` has no foreign key either, and 060 explains why: "It cannot: slots
// live in JSONB, not a table row, so there is nothing at the database level to
// reference. The application validates it against the template's CURRENT
// `role_slots` on every write."
//
// Variables live in the same JSONB shape (063), so they get the same treatment
// and the same guarantee — `saveWorkflowTemplateFields` validates every
// `variableKey` against the template's own `variables` in the same
// transaction that writes the row, exactly as it already does for `slotId`.
//
// A stronger design promotes variables to their own table so this can be a
// real composite FK. That is worth doing, and it is deliberately NOT this
// migration: it needs a contract change and a column drop before the feature
// does anything a user can see. Tracked, not forgotten.
//
// ── Exactly one target, enforced by the database ───────────────────────────
//
// `slot_id` becomes NULLABLE and a CHECK makes the two mutually exclusive —
// the same shape 062 used for `static_value` vs `request_recipient_id`, and
// for the same reason: a field with both targets, or neither, has no
// defensible rendering. The check is the backstop; the application produces
// the readable error.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table workflow_template_fields
      alter column slot_id drop not null
  `.execute(db);

  await sql`
    alter table workflow_template_fields
      add column variable_key varchar(64) null
  `.execute(db);

  // Mirrors the application's VARIABLE_KEY_PATTERN exactly. The application
  // owns the readable message; this refuses anything that slipped past it.
  await sql`
    alter table workflow_template_fields
      add constraint workflow_template_fields_variable_key_check
      check (variable_key is null or variable_key ~ '^[a-z][a-z0-9_]*$')
  `.execute(db);

  // One target, never both, never neither.
  await sql`
    alter table workflow_template_fields
      add constraint workflow_template_fields_target_check
      check (
        (slot_id is not null and variable_key is null)
        or (slot_id is null and variable_key is not null)
      )
  `.execute(db);

  // Finding every field bound to a variable whose declaration is being removed
  // is the one query the application runs that this column exists for.
  await sql`
    create index workflow_template_fields_variable_idx
      on workflow_template_fields (workspace_id, workflow_template_id, variable_key)
      where variable_key is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists workflow_template_fields_variable_idx`.execute(db);
  await sql`
    alter table workflow_template_fields
      drop constraint if exists workflow_template_fields_target_check
  `.execute(db);
  await sql`
    alter table workflow_template_fields
      drop constraint if exists workflow_template_fields_variable_key_check
  `.execute(db);

  // Variable-bound rows cannot survive the column going away, and they cannot
  // become slot-bound either — there is no slot to guess. They are DELETED
  // rather than silently rewritten, which is the honest reversal: the feature
  // they belong to no longer exists at this schema version.
  await sql`
    delete from workflow_template_fields where variable_key is not null
  `.execute(db);

  await sql`
    alter table workflow_template_fields drop column if exists variable_key
  `.execute(db);
  await sql`
    alter table workflow_template_fields
      alter column slot_id set not null
  `.execute(db);
}
