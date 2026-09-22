// 062 — a field may carry a KNOWN value instead of an assigned recipient.
//
// ── The gap this closes ─────────────────────────────────────────────────────
//
// Every field, on both `preparation_fields` and `signing_request_fields`, has
// always meant "something a RECIPIENT will supply". There has never been a way
// to say "the sender already knows this value — print it, ask nobody." A
// template's variable (BACKEND-30's Phase 4) is exactly that: a sender types a
// value once, before sending, and the document should carry it without
// pretending some recipient typed it during a ceremony.
//
// ── Why `signing_request_fields.request_recipient_id` becomes nullable ──────
//
// Migration 019's own comment is explicit about why the column was NOT NULL:
// "An unassigned field is a legitimate AUTHORING state ... and an impossible
// WORKFLOW state: nobody could ever complete it." That reasoning is still
// correct for a field with NEITHER a recipient NOR a value — it is still
// impossible to complete. It stops being correct for a field that carries a
// static value: nobody needs to complete it, because it is already complete
// the moment the request is created. The CHECK constraint below states the
// real rule precisely — "assigned to someone, or already answered" — rather
// than weakening the column to allow states neither side intended.
//
// `preparation_fields.recipient_id` was already nullable (018) for the
// authoring-in-progress case, so it needs no column change — only the new
// value column, with no CHECK at all: authoring permits any combination
// (§247's "validate before any write" happens in the application, not here),
// exactly as `recipient_id` itself is unconstrained at this layer today.
//
// ── Why `text`, not something typed ─────────────────────────────────────────
//
// A static value renders as drawn text regardless of the field's declared
// type (`field-merge.ts`'s `RenderableValue` already has a `{kind: "text"}`
// case for exactly this). Scoping what field TYPES may carry one is an
// application-layer rule (§ preparation.ts), not a storage rule — storage only
// needs somewhere to put the string.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── preparation_fields: authoring state, no constraint needed ────────────
  await db.schema
    .alterTable("preparation_fields")
    .addColumn("static_value", "text")
    .execute();

  // ── signing_request_fields: the immutable workflow snapshot ──────────────
  await db.schema
    .alterTable("signing_request_fields")
    .addColumn("static_value", "text")
    .execute();

  await sql`
    alter table signing_request_fields
      alter column request_recipient_id drop not null
  `.execute(db);

  // Exactly one of "assigned to a recipient" or "already has a value" — never
  // both (that would be ambiguous about who supplies it) and never neither
  // (that field could never be completed, migration 019's own rule, restated
  // for the new third state rather than silently dropped).
  await sql`
    alter table signing_request_fields
      add constraint signing_request_fields_completeness_check
      check (
        (request_recipient_id is not null and static_value is null)
        or (request_recipient_id is null and static_value is not null)
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table signing_request_fields
      drop constraint if exists signing_request_fields_completeness_check
  `.execute(db);
  await sql`
    alter table signing_request_fields
      alter column request_recipient_id set not null
  `.execute(db);
  await db.schema
    .alterTable("signing_request_fields")
    .dropColumn("static_value")
    .execute();

  await db.schema
    .alterTable("preparation_fields")
    .dropColumn("static_value")
    .execute();
}
