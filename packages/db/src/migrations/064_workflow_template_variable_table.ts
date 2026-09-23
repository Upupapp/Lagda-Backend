// 064 — variables become ROWS, and a field may be bound to one.
//
// ── Why the JSONB column from 063 is not enough ─────────────────────────────
//
// 063 stored a template's variables as a JSONB array, reasoning that "a
// variable's shape has no query this schema needs to run against it". That
// reasoning held only while nothing pointed AT a variable. It no longer does:
// a template field must be able to say "this rectangle is filled from the
// variable `contract_date`", and that is a foreign key.
//
// This is the same lesson 060 learned about `role_slots`. There, a slot needed
// a stable `slotId` before a field could reference one, and 060's header spells
// out why an array index cannot be a reference: "a slot's array index changes
// the moment an earlier slot is removed or reordered, and a field that
// silently followed a DIFFERENT role after such an edit is a signature landing
// on the wrong party." A field silently following a different VARIABLE is the
// same failure with a different payload — a date, a case number or an amount
// rendered into a document that will be signed and sealed.
//
// 060 solved it by backfilling an id INTO the JSONB. That was the cheaper move
// at the time and it left `slot_id` with no foreign key at all, which 060 is
// candid about: "It cannot: slots live in JSONB, not a table row, so there is
// nothing at the database level to reference. The application validates it."
// We are not repeating that trade here. A variable binding gets a real FK, so
// the database — not only the application — refuses a field that points at a
// variable which does not exist, belongs to another template, or belongs to
// another tenant.
//
// ── One source of truth, not two ────────────────────────────────────────────
//
// The JSONB column is DROPPED in this same migration, after the backfill and
// after a row-count assertion. Keeping both would mean two places to write, two
// places to read, and an inevitable divergence that no constraint could catch.
//
// ── The FK is tenant-first, and enforces same-template structurally ─────────
//
// `workflow_template_fields` already carries both `workspace_id` and
// `workflow_template_id`, and 060 established the house rule that "every
// tenant-safe FK elsewhere in this schema targets a `(workspace_id, id)` pair,
// not a bare id". This migration goes one column further and references
// `(workspace_id, workflow_template_id, variable_id)`, so THREE things are
// true by construction rather than by application diligence:
//
//   - the variable exists,
//   - it belongs to the same template as the field,
//   - it belongs to the same workspace as the field.
//
// The nullable `variable_id` is safe under the default MATCH SIMPLE semantics:
// when it is NULL the constraint is not checked at all, which is exactly right
// for a field that is bound to a role slot instead.
//
// ── ON DELETE RESTRICT, not CASCADE ────────────────────────────────────────
//
// 060 gave fields `on delete cascade` from their template, because a field has
// no meaning without its template. The opposite applies here. Deleting a
// variable that fields still point at must FAIL, not quietly blank out the
// places a sender's value was going to be rendered. The application produces a
// friendly error before it ever reaches this constraint; the constraint is the
// backstop for every path that forgets to.
//
// ── Ordering, because RESTRICT makes write order load-bearing ──────────────
//
// Within the single transaction that saves a template: variables are written
// BEFORE fields (so a newly-bound field has something to point at), and
// removed variables are deleted AFTER fields (so a field that is going away in
// the same save has already released its reference). The repository layer owns
// that order; this header records why it is not arbitrary.

import { type Kysely, sql } from "kysely";
import { randomUUID } from "node:crypto";

const VARIABLE_TYPES = [
  "short-text", "multiline-text", "date", "number", "yes-no",
] as const;

function inList(values: readonly string[]): ReturnType<typeof sql.join> {
  return sql.join(values.map(value => sql.lit(value)));
}

interface StoredVariable {
  key: string;
  label: string;
  type: string;
  required: boolean;
}

/**
 * Refuses to run under row-level security.
 *
 * `workspace_workflow_templates` has `force row level security`, which binds
 * the table OWNER too — see 002's comment, "FORCE applies policies to the table
 * OWNER too. Without it, anything connecting as the owner … sees everything."
 * The policy compares `workspace_id = lagda_current_workspace()`, and in a
 * migration no workspace is set, so the function returns NULL and the
 * comparison is NULL — every row invisible.
 *
 * That is catastrophic for THIS migration specifically. A backfill that reads
 * zero rows would insert zero variables, the row-count assertion would compare
 * 0 against 0 and pass, and the column would then be dropped — silently
 * destroying every variable in the database.
 *
 * `row_security = off` is the guard: for a superuser or a BYPASSRLS role it is
 * a no-op, and for a role that IS subject to policies Postgres raises an error
 * rather than filtering. So this migration either sees all the data or stops.
 */
async function requireUnfilteredReads(db: Kysely<unknown>): Promise<void> {
  await sql`set local row_security = off`.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await requireUnfilteredReads(db);

  // ── The table ─────────────────────────────────────────────────────────────
  //
  // `varchar(64)` opaque prefixed ids (`wfv_`), matching `wft_`/`wfs_`/`wff_`
  // — this schema uses no native uuid columns.
  await sql`
    create table workflow_template_variables (
      variable_id          varchar(64)  primary key,
      workspace_id         varchar(64)  not null,
      workflow_template_id varchar(64)  not null,

      -- The token name a field binds to. Lowercase ASCII, starts with a
      -- letter. The application's validateVariables() owns the readable error;
      -- this CHECK is the backstop, and is written to match that regex exactly.
      variable_key         varchar(64)  not null,
      label                varchar(200) not null,
      variable_type        varchar(32)  not null,
      required             boolean      not null,

      -- Declaration order. Variables are an ordered list to the person editing
      -- them, and a JSONB array preserved that for free; rows do not, so the
      -- order is stored rather than left to the planner.
      ordinal              integer      not null,

      created_at           timestamptz  not null default now(),
      updated_at           timestamptz  not null default now(),

      -- The tenant-safe FK target every other table in this schema expects.
      constraint workflow_template_variables_workspace_key
        unique (workspace_id, variable_id),

      -- What workflow_template_fields' three-column FK references. This is the
      -- constraint that makes "same template AND same tenant" structural.
      constraint workflow_template_variables_template_key
        unique (workspace_id, workflow_template_id, variable_id),

      -- Unique per template, mirroring validateVariables()'s own dedupe.
      constraint workflow_template_variables_key_unique
        unique (workflow_template_id, variable_key),

      constraint workflow_template_variables_key_check
        check (variable_key ~ '^[a-z][a-z0-9_]*$'),
      constraint workflow_template_variables_label_check
        check (length(btrim(label)) > 0),
      constraint workflow_template_variables_type_check
        check (variable_type in (${inList(VARIABLE_TYPES)})),
      constraint workflow_template_variables_ordinal_check
        check (ordinal >= 0),

      constraint workflow_template_variables_template_fk
        foreign key (workspace_id, workflow_template_id)
        references workspace_workflow_templates (workspace_id, workflow_template_id)
        on delete cascade
    )
  `.execute(db);

  // Listing order, matching the application's ORDER BY.
  await sql`
    create index workflow_template_variables_order_idx
      on workflow_template_variables (workspace_id, workflow_template_id, ordinal, variable_id)
  `.execute(db);

  // ── Backfill ──────────────────────────────────────────────────────────────
  const templates = await db
    .selectFrom("workspace_workflow_templates" as never)
    .select([
      "workflow_template_id" as never,
      "workspace_id" as never,
      "variables" as never,
    ])
    .execute() as { workflow_template_id: string; workspace_id: string; variables: unknown }[];

  let expected = 0;
  for (const template of templates) {
    if (!Array.isArray(template.variables)) continue; // malformed; 063's CHECK made this near-impossible
    let ordinal = 0;
    for (const raw of template.variables as StoredVariable[]) {
      if (raw === null || typeof raw !== "object") continue;
      await db
        .insertInto("workflow_template_variables" as never)
        .values({
          variable_id: `wfv_${randomUUID().replace(/-/g, "")}`,
          workspace_id: template.workspace_id,
          workflow_template_id: template.workflow_template_id,
          variable_key: raw.key,
          label: raw.label,
          variable_type: raw.type,
          required: raw.required,
          ordinal,
        } as never)
        .execute();
      ordinal += 1;
      expected += 1;
    }
  }

  // The assertion D1 asked for. It cannot pass vacuously: a filtered read would
  // already have failed at `set local row_security = off` above.
  const counted = await sql<{ count: string }>`
    select count(*)::text as count from workflow_template_variables
  `.execute(db);
  const inserted = Number(counted.rows[0]?.count ?? "-1");

  if (inserted !== expected) {
    throw new Error(
      `064 backfill lost rows: ${String(expected)} variables were read from JSONB `
      + `but ${String(inserted)} rows exist. The variables column has NOT been dropped.`,
    );
  }

  await sql`
    grant select, insert, update, delete on table workflow_template_variables to lagda_app
  `.execute(db);
  await sql`alter table workflow_template_variables enable row level security`.execute(db);
  await sql`alter table workflow_template_variables force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on workflow_template_variables
    using (workspace_id = lagda_current_workspace())
    with check (workspace_id = lagda_current_workspace())
  `.execute(db);

  // ── The binding on a field ────────────────────────────────────────────────
  await sql`
    alter table workflow_template_fields
      add column variable_id varchar(64) null
  `.execute(db);

  await sql`
    alter table workflow_template_fields
      add constraint workflow_template_fields_variable_fk
        foreign key (workspace_id, workflow_template_id, variable_id)
        references workflow_template_variables
          (workspace_id, workflow_template_id, variable_id)
        on delete restrict
  `.execute(db);

  // RESTRICT is checked on the REFERENCING side when a variable is deleted, so
  // deleting a variable scans this table. Without this index that is a
  // sequential scan of every field in the workspace on every variable removal.
  await sql`
    create index workflow_template_fields_variable_idx
      on workflow_template_fields (workspace_id, workflow_template_id, variable_id)
      where variable_id is not null
  `.execute(db);

  // ── Drop the old column — one source of truth from here ──────────────────
  await sql`
    alter table workspace_workflow_templates
      drop constraint if exists workflow_templates_variables_are_array
  `.execute(db);
  await db.schema
    .alterTable("workspace_workflow_templates")
    .dropColumn("variables")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // ── A DELIBERATE DEPARTURE FROM HOUSE STYLE ───────────────────────────────
  //
  // Every other down() in this schema reverses structure only and refuses to
  // restore data — 060 says so explicitly about its slotId backfill, and the
  // runner's own comment says "a migration that drops a column cannot restore
  // the data — so production rollback is a restore-from-backup question."
  //
  // That convention is right when down() drops something up() ADDED. It is
  // wrong here, because up() drops the column that HELD the data. A
  // structural-only reversal would recreate `variables` as an empty array on
  // every template and destroy every variable in the database — the precise
  // outcome the convention exists to avoid. So this down() rebuilds the JSONB
  // faithfully from the rows, in declaration order, before dropping them.
  await requireUnfilteredReads(db);

  await db.schema
    .alterTable("workspace_workflow_templates")
    .addColumn("variables", "jsonb", col => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .execute();

  // Reassembles 063's exact shape: an array of {key, label, type, required}
  // ordered by `ordinal`. Templates with no variables keep the '[]' default,
  // which is what they held before.
  await sql`
    update workspace_workflow_templates t
    set variables = coalesce(v.payload, '[]'::jsonb)
    from (
      select
        workflow_template_id,
        jsonb_agg(
          jsonb_build_object(
            'key',      variable_key,
            'label',    label,
            'type',     variable_type,
            'required', required
          )
          order by ordinal, variable_id
        ) as payload
      from workflow_template_variables
      group by workflow_template_id
    ) v
    where v.workflow_template_id = t.workflow_template_id
  `.execute(db);

  await sql`
    alter table workspace_workflow_templates
      add constraint workflow_templates_variables_are_array
      check (jsonb_typeof(variables) = 'array')
  `.execute(db);

  await sql`drop index if exists workflow_template_fields_variable_idx`.execute(db);
  await sql`
    alter table workflow_template_fields
      drop constraint if exists workflow_template_fields_variable_fk
  `.execute(db);
  await sql`
    alter table workflow_template_fields
      drop column if exists variable_id
  `.execute(db);

  await sql`drop policy if exists tenant_isolation on workflow_template_variables`.execute(db);
  await sql`drop table if exists workflow_template_variables`.execute(db);
}
