// 088 — a template's authored content can be SAVED without being GENERATED.
//
// ── The problem ─────────────────────────────────────────────────────────────
//
// Until now the only writer of 070's `content` was
// `POST .../generate-document`, which also lays the document out, renders a
// PDF, uploads it and attaches it. That is far too heavy to run while an
// admin is typing, so the editor ran it only on an explicit "Generate" — and
// anything typed since was lost on a refresh.
//
// ── What this adds ──────────────────────────────────────────────────────────
//
//   draft_content               the latest AUTOSAVED document, or NULL when the
//       newest content is the one the last generate rendered (`content`). A
//       JSON object when present, like `content`. Reads return
//       `coalesce(draft_content, content)`.
//   content_revision            a monotonically increasing counter, bumped by
//       every autosave AND every generate. An autosave may name the revision
//       it was edited from; a stale one is refused (409) rather than silently
//       overwriting another tab's work.
//   content_saved_at            when the newest content (draft or generated)
//       was written. Backfilled from `updated_at`, and set to `created_at` on
//       insert, so it is never null.
//   content_generated_revision  the revision the last generate produced, or
//       NULL when nothing was ever generated. "The draft matches what was
//       rendered" is exactly `content_generated_revision = content_revision`.
//
// `content` itself keeps meaning what it meant: the document the attached
// PDF was rendered from. Nothing downstream reads it (070's header), and
// keeping it separate from the draft means "what the PDF says" is never
// silently replaced by half-typed text.
//
// ── Backfill ────────────────────────────────────────────────────────────────
//
// Every existing row starts at revision 0 with no draft. A row that has been
// generated before (`content_page_count > 0` — the layout engine always
// produces at least one page) is marked generated at revision 0; any other row
// has never been generated and stays NULL.
//
// ── Privileges ──────────────────────────────────────────────────────────────
//
// New columns on an existing table inherit 058's table-level grants; RLS
// (`tenant_isolation`, FORCEd) is unchanged and covers them. DELETE stays
// granted — templates are really deleted, 058's deliberate choice. TRUNCATE
// was never granted, but a deployment that migrates as `lagda_app` makes it
// the owner, and an owner holds every privilege until one is explicitly
// revoked (080's lesson), so it is revoked here explicitly.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("workspace_workflow_templates")
    .addColumn("draft_content", "jsonb")
    .addColumn("content_revision", "integer", col => col.notNull().defaultTo(0))
    .addColumn("content_saved_at", "timestamptz")
    .addColumn("content_generated_revision", "integer")
    .execute();

  // Production migrates as lagda_app, the table's OWNER, and FORCE RLS
  // applies to the owner too: with no tenant context this backfill would
  // match zero rows and the NOT NULL below would fail (it did, on the first
  // production run). Lift FORCE for the backfill only, as 077 does.
  await sql`alter table workspace_workflow_templates no force row level security`.execute(db);
  await sql`
    update workspace_workflow_templates
       set content_saved_at = updated_at,
           content_generated_revision = case when content_page_count > 0 then 0 else null end
  `.execute(db);
  await sql`alter table workspace_workflow_templates force row level security`.execute(db);

  await sql`
    alter table workspace_workflow_templates
      alter column content_saved_at set not null,
      alter column content_saved_at set default now()
  `.execute(db);

  await sql`
    alter table workspace_workflow_templates
      add constraint workflow_templates_draft_content_is_object
      check (draft_content is null or jsonb_typeof(draft_content) = 'object')
  `.execute(db);

  await sql`
    alter table workspace_workflow_templates
      add constraint workflow_templates_content_revision_check
      check (content_revision >= 0)
  `.execute(db);

  // A generate can only have produced a revision that exists.
  await sql`
    alter table workspace_workflow_templates
      add constraint workflow_templates_content_generated_revision_check
      check (content_generated_revision is null
             or (content_generated_revision >= 0
                 and content_generated_revision <= content_revision))
  `.execute(db);

  await sql`revoke truncate on table workspace_workflow_templates from lagda_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // TRUNCATE is not re-granted: 058 never granted it, so 087's explicit
  // grants are restored exactly.
  await sql`
    alter table workspace_workflow_templates
      drop constraint if exists workflow_templates_content_generated_revision_check
  `.execute(db);
  await sql`
    alter table workspace_workflow_templates
      drop constraint if exists workflow_templates_content_revision_check
  `.execute(db);
  await sql`
    alter table workspace_workflow_templates
      drop constraint if exists workflow_templates_draft_content_is_object
  `.execute(db);
  await db.schema
    .alterTable("workspace_workflow_templates")
    .dropColumn("content_generated_revision")
    .dropColumn("content_saved_at")
    .dropColumn("content_revision")
    .dropColumn("draft_content")
    .execute();
}
