// 059 — a workflow template may carry its own document.
//
// ── Reversing what 058 said, and saying so ─────────────────────────────────
//
// Migration 058's header states: "It is NOT a document, and it holds no
// file." That was true and deliberate at the time — Steps 1–6 shipped the
// routing SHAPE alone, and attaching a document was explicitly out of scope.
//
// It cost real, felt value: a template saved the routing shape and nothing
// else, so a three-role contract sent weekly still meant uploading the same
// PDF by hand on every use. This migration closes that gap. The rest of 058's
// header — snapshot not reference, no FK pointing back at this table from a
// document/preparation/request — is UNCHANGED and still enforced; only "holds
// no file" is revised.
//
// ── Reference, not a copy ──────────────────────────────────────────────────
//
// A template's document is stored the ordinary way: as a row in `documents`
// and an artifact in `document_artifacts`, exactly like any document uploaded
// through the existing prepare flow. This table adds two nullable columns
// naming that document and that exact artifact — never a second copy of the
// bytes, never a new upload or storage mechanism.
//
// `document_id` is the business relationship ("this template is ABOUT this
// document"); `source_artifact_id` is the exact bytes ("these are the bytes
// as they stood when attached") — the same two-column pattern
// `signing_requests` already uses for the same reason: a document can be
// re-uploaded, and the artifact id pins which version this template pointed
// at without requiring a new one every time.
//
// Both or neither: a template with a document id but no artifact (or the
// reverse) is a half-attached state nothing should be able to produce, so a
// CHECK constraint refuses it structurally rather than trusting every write
// path to keep the two in step.
//
// ── Why this is additive, not a rewrite of 058's columns ───────────────────
//
// Every template created before this migration has neither column set. That
// is not a migration to backfill; it is simply "no document attached yet",
// the same state a template can be left in deliberately (the routing shape
// alone remains a complete, useful template).
//
// ── ON DELETE RESTRICT, matching the document's own posture ────────────────
//
// Documents are never deleted today (traced: no DELETE route exists on
// `/workspaces/{id}/documents/{id}`), so RESTRICT here costs nothing in
// practice — it exists to fail loudly rather than silently if that ever
// changes. `document_artifacts` grants `lagda_app` only SELECT and INSERT
// (003's grant, restated there and unchanged since), so DELETING the
// TEMPLATE can never cascade into or block on the artifact table at all —
// deleting a template simply stops referencing its document; the document
// and its artifact are untouched and outlive it, exactly as a document
// outlives a deleted signing request today.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("workspace_workflow_templates")
    .addColumn("document_id", "varchar(64)")
    .addColumn("source_artifact_id", "varchar(64)")
    .execute();

  await sql`
    alter table workspace_workflow_templates
      add constraint workflow_templates_document_fk
        foreign key (workspace_id, document_id)
        references documents (workspace_id, document_id) on delete restrict
  `.execute(db);

  await sql`
    alter table workspace_workflow_templates
      add constraint workflow_templates_source_artifact_fk
        foreign key (workspace_id, source_artifact_id)
        references document_artifacts (workspace_id, artifact_id) on delete restrict
  `.execute(db);

  // Both set or both null. A template pointing at a document but no exact
  // artifact (or the reverse) cannot arise through this schema.
  await sql`
    alter table workspace_workflow_templates
      add constraint workflow_templates_document_pair_check
        check ((document_id is null) = (source_artifact_id is null))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table workspace_workflow_templates
      drop constraint if exists workflow_templates_document_pair_check
  `.execute(db);
  await sql`
    alter table workspace_workflow_templates
      drop constraint if exists workflow_templates_source_artifact_fk
  `.execute(db);
  await sql`
    alter table workspace_workflow_templates
      drop constraint if exists workflow_templates_document_fk
  `.execute(db);
  await db.schema
    .alterTable("workspace_workflow_templates")
    .dropColumn("source_artifact_id")
    .dropColumn("document_id")
    .execute();
}
