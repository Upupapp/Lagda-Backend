// 066 — a template's document does not have to be an upload.
//
// ── What this adds ───────────────────────────────────────────────────────
//
// `content_blocks`: authored text, laid out on blank pages with the SAME
// normalized 0-1, top-left rectangle every field placement already uses. Not
// a rich-text document — a fixed canvas, exactly like `workflow_template_
// fields` already is, so the SAME editor that places fields places text.
//
// `content_page_count`: how many blank pages the last generate produced. 0
// before the first one. Stored rather than derived from
// `max(blocks[].pageNumber)`, because a trailing blank page (no blocks on it
// yet, or ever) is a legitimate authoring state and must not silently vanish
// on the next save.
//
// ── Why a template can hold BOTH kinds of source ───────────────────────────
//
// This is additive, not a replacement for 059's upload path. `document_id`
// and `source_artifact_id` still mean exactly what they meant: a real
// document and its original artifact, attached through the ordinary path
// (an upload) or a new one (`POST .../generate-document`, which uploads
// bytes it produced itself through that SAME path). Nothing downstream —
// field placement, apply, completion — can tell the two apart, and nothing
// needs to: `content_blocks` is authoring state for the ADMIN's canvas, not
// something the signing pipeline ever reads.
//
// ── Same JSONB-array convention as 063 ─────────────────────────────────────
//
// An empty array is the ordinary case — a template with an uploaded document
// has none — so there is no "non-empty" half of this check, matching
// `workflow_templates_variables_are_array`.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("workspace_workflow_templates")
    .addColumn("content_blocks", "jsonb", col => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("content_page_count", "integer", col => col.notNull().defaultTo(0))
    .execute();

  await sql`
    alter table workspace_workflow_templates
      add constraint workflow_templates_content_blocks_are_array
      check (jsonb_typeof(content_blocks) = 'array')
  `.execute(db);

  await sql`
    alter table workspace_workflow_templates
      add constraint workflow_templates_content_page_count_check
      check (content_page_count >= 0)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table workspace_workflow_templates
      drop constraint if exists workflow_templates_content_page_count_check
  `.execute(db);
  await sql`
    alter table workspace_workflow_templates
      drop constraint if exists workflow_templates_content_blocks_are_array
  `.execute(db);
  await db.schema
    .alterTable("workspace_workflow_templates")
    .dropColumn("content_page_count")
    .dropColumn("content_blocks")
    .execute();
}
