// 070 — authored content becomes a FLOWING document, not a fixed canvas.
//
// ── What 066 got wrong ──────────────────────────────────────────────────────
//
// `content_blocks` modelled authoring as `workflow_template_fields`' own
// canvas: one plain-text string in one fixed 0-1 rectangle on one declared
// page. It worked as a layout tool. It was not a document editor — nothing
// knew a paragraph came after another one, lengthening a sentence did not
// push anything down, and the generator REFUSED the save outright if the
// wrapped text didn't fit the box the admin had drawn. An admin wanting "type
// a contract, the way Word lets you" had no such thing.
//
// ── What this adds ───────────────────────────────────────────────────────────
//
// `content`: a FLOWING document — an ordered tree of blocks (paragraphs,
// headings, nested ordered lists for numbered clauses, page breaks), each
// carrying runs of styled inline text plus two new inline atoms:
//
//   variable   — a reference to `variables[].key`, dropped in from the
//                authoring ribbon rather than typed as literal `{{...}}`
//   fieldAnchor — a signature/initials/date/role placement, typed INLINE in
//                the sentence it belongs to ("Signed: ___") instead of
//                dragged onto a separate canvas afterward
//
// Where a `fieldAnchor` actually LANDS — its page and rectangle — is computed
// by the layout engine at generate time and written through the EXISTING
// `workflow_template_fields` table (060/064) via the ordinary `PUT .../fields`
// endpoint. That table does not change at all: a field placed via an inline
// anchor is indistinguishable from one dragged the old way.
//
// ── Why a new column, not a rewritten `content_blocks` ──────────────────────
//
// The two shapes describe different things — one string per fixed box versus
// a tree of flowing blocks — so there is no lossless reinterpretation of the
// old column as the new one; ADDING is the honest move, matching 066's own
// "additive, not a replacement" posture toward 059's upload path. `content_
// blocks`/`content_page_count` are left in place rather than dropped: nothing
// in application code writes them after this ships (the flow generator
// replaces 066's box generator entirely), but a column that still holds real
// authored history is not deleted in the same migration that stops writing
// it. A later migration can drop it once nothing reads it either.
//
// ── The data migration ───────────────────────────────────────────────────────
//
// Every existing row's `content_blocks` — as of this writing, one real
// template in production — is converted into an equivalent flowing document:
// blocks are read in the order a person would have designed them (page, then
// top-to-bottom), each becomes its own paragraph carrying its original bold/
// size/alignment as marks, and a `pageBreak` is inserted wherever the source
// page number changed. This is a best-effort RECREATION, not a byte-for-byte
// preservation — a fixed canvas has no paragraph-order concept to preserve
// exactly — but it is a documented, reviewable conversion rather than
// silently discarding an admin's authored work.

import { type Kysely, sql } from "kysely";

interface LegacyBlock {
  readonly pageNumber: number;
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly text: string;
  readonly fontSize?: number;
  readonly bold?: boolean;
  readonly align?: "left" | "center" | "right";
}

type FlowMark =
  | { readonly kind: "bold" }
  | { readonly kind: "fontSize"; readonly size: number };

interface FlowParagraph {
  readonly kind: "paragraph";
  readonly align?: "left" | "center" | "right" | "justify";
  readonly content: readonly { readonly kind: "text"; readonly text: string; readonly marks?: readonly FlowMark[] }[];
}

type FlowBlock = FlowParagraph | { readonly kind: "pageBreak" };

/** Converts 066's fixed-box blocks into an equivalent flowing document, in
 *  reading order, with a page break wherever the source page changed. */
function toFlowDocument(blocks: readonly LegacyBlock[]): { kind: "flowDocument"; content: readonly FlowBlock[] } {
  const sorted = [...blocks].sort((a, b) => a.pageNumber - b.pageNumber || a.rect.y - b.rect.y);
  const content: FlowBlock[] = [];
  let currentPage: number | null = null;

  for (const block of sorted) {
    if (currentPage !== null && block.pageNumber !== currentPage) {
      content.push({ kind: "pageBreak" });
    }
    currentPage = block.pageNumber;

    const marks: FlowMark[] = [];
    if (block.bold === true) marks.push({ kind: "bold" });
    if (typeof block.fontSize === "number") marks.push({ kind: "fontSize", size: block.fontSize });

    content.push({
      kind: "paragraph",
      ...(block.align === undefined ? {} : { align: block.align }),
      content: [{ kind: "text", text: block.text, ...(marks.length > 0 ? { marks } : {}) }],
    });
  }

  return { kind: "flowDocument", content };
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("workspace_workflow_templates")
    .addColumn("content", "jsonb", col =>
      col.notNull().defaultTo(sql`'{"kind":"flowDocument","content":[]}'::jsonb`))
    .execute();

  await sql`
    alter table workspace_workflow_templates
      add constraint workflow_templates_content_is_object
      check (jsonb_typeof(content) = 'object')
  `.execute(db);

  // ── Convert every existing authored template ────────────────────────────
  const rows = await db
    .selectFrom("workspace_workflow_templates" as never)
    .select(["workflow_template_id" as never, "content_blocks" as never])
    .execute() as { workflow_template_id: string; content_blocks: unknown }[];

  for (const row of rows) {
    if (!Array.isArray(row.content_blocks) || row.content_blocks.length === 0) continue;
    const flow = toFlowDocument(row.content_blocks as LegacyBlock[]);
    await db
      .updateTable("workspace_workflow_templates" as never)
      .set({ content: JSON.stringify(flow) } as never)
      .where("workflow_template_id" as never, "=", row.workflow_template_id as never)
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table workspace_workflow_templates
      drop constraint if exists workflow_templates_content_is_object
  `.execute(db);
  await db.schema
    .alterTable("workspace_workflow_templates")
    .dropColumn("content")
    .execute();
}
