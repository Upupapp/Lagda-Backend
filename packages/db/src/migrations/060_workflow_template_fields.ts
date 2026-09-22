// 060 — field-position templating: geometry per role slot.
//
// ── What this closes ────────────────────────────────────────────────────────
//
// 058 gave a template named role slots and a routing mode. 059 let it point at
// a document. Neither lets an admin say WHERE on that document each role
// signs — every use of the template still meant opening the real document and
// placing fields from scratch, exactly the manual step 059 removed for the
// upload itself. This migration adds that: a field belongs to a SLOT (a role),
// not a person, the same relationship `role_slots` already has to a real
// template's eventual recipients.
//
// ── Slots need a STABLE id first ────────────────────────────────────────────
//
// `role_slots` (058) is a JSONB array with no id — a slot was addressed only
// by its position, which is fine for "the whole list" (the only thing 058/059
// ever read or wrote) but cannot be a foreign key for a field to point at: a
// slot's array index changes the moment an earlier slot is removed or
// reordered, and a field that silently followed a DIFFERENT role after such an
// edit is a signature landing on the wrong party.
//
// So every stored slot needs a `slotId` before any field can reference one.
// Application code (see workflow-templates.ts's `validateSlot`) starts
// requiring and preserving it going forward; this migration backfills the ids
// existing rows do not have, so a template created before 060 does not become
// unreadable the moment that validation starts running. The backfill is data
// only — no column is added to `workspace_workflow_templates` for it, because
// `slotId` lives INSIDE each JSONB slot object, exactly where `label` and
// `role` already do.
//
// ── The new table ────────────────────────────────────────────────────────────
//
// `workflow_template_fields` mirrors `preparation_fields` (017) deliberately:
// the same field-type vocabulary, the same normalized-rectangle geometry, the
// same CHECK constraints, because a template field and a real preparation
// field describe the same nine renderable things in the same coordinate
// space — see `@lagda/core/preparation`'s `validateRect`/`isValidPageNumber`,
// reused unchanged by the application layer that writes this table. The one
// structural difference is `slot_id` where `preparation_fields` has
// `recipient_id`: a template field is FOR A ROLE, and no recipient exists
// yet for it to name.
//
// `slot_id` has no foreign key. It cannot: slots live in JSONB, not a table
// row, so there is nothing at the database level to reference. The
// application validates it against the template's CURRENT `role_slots` on
// every write, the same way it validates every other part of a slot's shape.
//
// ── ON DELETE CASCADE, matching `preparation_fields`' own posture ──────────
//
// A field has no meaning without its template and no independent history —
// it is authoring state, not evidence, the same reasoning 017's header gives
// for `preparation_fields`. Nothing references this table, and nothing may: a
// signing request snapshots field values at send time (BACKEND-32, not yet
// built for templates), it does not point back at them.

import { type Kysely, sql } from "kysely";
import { randomUUID } from "node:crypto";

const FIELD_TYPES = [
  "signature", "initials", "date-signed", "text", "checkbox",
  "full-name", "email", "title", "company",
] as const;

function inList(values: readonly string[]): ReturnType<typeof sql.join> {
  return sql.join(values.map(value => sql.lit(value)));
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── Backfill: every stored slot gets a stable id ──────────────────────────
  const rows = await db
    .selectFrom("workspace_workflow_templates" as never)
    .select(["workflow_template_id" as never, "role_slots" as never])
    .execute() as { workflow_template_id: string; role_slots: unknown }[];

  for (const row of rows) {
    if (!Array.isArray(row.role_slots)) continue; // malformed row; left for application-layer validation to catch
    let changed = false;
    const withIds: unknown[] = row.role_slots.map((slot: unknown): unknown => {
      if (slot !== null && typeof slot === "object" && typeof (slot as Record<string, unknown>)["slotId"] === "string") {
        return slot;
      }
      changed = true;
      return { ...(slot as Record<string, unknown>), slotId: `wfs_${randomUUID().replace(/-/g, "")}` };
    });
    if (!changed) continue;
    await db
      .updateTable("workspace_workflow_templates" as never)
      .set({ role_slots: JSON.stringify(withIds) } as never)
      .where("workflow_template_id" as never, "=", row.workflow_template_id as never)
      .execute();
  }

  // ── The missing unique key `workflow_template_fields`'s FK needs ─────────
  //
  // `workspace_workflow_templates` has only a single-column primary key
  // (`workflow_template_id`) — 058 never needed a composite one, since 059's
  // own FKs point OUT of this table (at `documents`/`document_artifacts`),
  // never INTO it. This is the first migration that needs an FK targeting
  // this table, and every tenant-safe FK elsewhere in this schema targets a
  // `(workspace_id, id)` pair, not a bare id — so that pair needs a unique
  // constraint to be a valid FK target before it can be one.
  await sql`
    alter table workspace_workflow_templates
      add constraint workflow_templates_workspace_key
        unique (workspace_id, workflow_template_id)
  `.execute(db);

  // ── workflow_template_fields ──────────────────────────────────────────────
  await sql`
    create table workflow_template_fields (
      field_id             varchar(64)  primary key,
      workspace_id         varchar(64)  not null,
      workflow_template_id varchar(64)  not null,

      -- One of the template's OWN role_slots[].slotId values, at write time.
      -- No FK (slots are JSONB, not rows) — the application validates this.
      slot_id              varchar(64)  not null,

      field_type           varchar(32)  not null,

      -- 1-BASED, against the template's attached document (059). Ceiling
      -- enforced by the application, which has the artifact's page count.
      page_number           integer      not null,

      -- NORMALIZED 0-1, top-left origin, matching preparation_fields exactly
      -- (PREPARATION_COORDINATES.md) — the same coordinate model, because
      -- these values are copied verbatim onto a real preparation at apply
      -- time and must mean the same thing there that they meant here.
      x                     double precision not null,
      y                     double precision not null,
      width                 double precision not null,
      height                double precision not null,

      required              boolean      not null,
      label                 varchar(200) not null,
      layer                 integer      not null,

      created_at            timestamptz  not null default now(),
      updated_at            timestamptz  not null default now(),

      constraint workflow_template_fields_workspace_key unique (workspace_id, field_id),

      constraint workflow_template_fields_type_check
        check (field_type in (${inList(FIELD_TYPES)})),
      constraint workflow_template_fields_page_check check (page_number >= 1),
      constraint workflow_template_fields_size_check check (width > 0 and height > 0),
      constraint workflow_template_fields_bounds_check check (
        x >= 0 and y >= 0 and x + width <= 1 and y + height <= 1
      ),
      constraint workflow_template_fields_layer_check check (layer >= 0),

      constraint workflow_template_fields_template_fk
        foreign key (workspace_id, workflow_template_id)
        references workspace_workflow_templates (workspace_id, workflow_template_id)
        on delete cascade
    )
  `.execute(db);

  // Deterministic listing order, matching the application's ORDER BY and
  // preparation_fields' own index for the same reason.
  await sql`
    create index workflow_template_fields_order_idx
      on workflow_template_fields (workspace_id, workflow_template_id, page_number, layer, field_id)
  `.execute(db);

  await sql`
    grant select, insert, update, delete on table workflow_template_fields to lagda_app
  `.execute(db);
  await sql`alter table workflow_template_fields enable row level security`.execute(db);
  await sql`alter table workflow_template_fields force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on workflow_template_fields
    using (workspace_id = lagda_current_workspace())
    with check (workspace_id = lagda_current_workspace())
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists tenant_isolation on workflow_template_fields`.execute(db);
  await sql`drop table if exists workflow_template_fields`.execute(db);
  await sql`
    alter table workspace_workflow_templates
      drop constraint if exists workflow_templates_workspace_key
  `.execute(db);

  // The slotId backfill is NOT reversed. Leaving it is harmless — every
  // reader before this migration ignored unknown JSONB keys, the same as
  // every additive change in this schema — and stripping it back out would
  // require distinguishing "backfilled by this migration" from "written by
  // application code that has since started requiring it", which the data
  // alone cannot tell apart once any template has been saved again.
}
