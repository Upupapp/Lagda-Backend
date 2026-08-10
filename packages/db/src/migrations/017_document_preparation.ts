// 017 — document preparation.
//
// ── Two tables, and what they are not ──────────────────────────────────────
//
// `document_preparations` is AUTHORING state: where a sender says what will be
// asked for and where. It is not the document (BACKEND-29) and it is not a
// signing request (BACKEND-32). There is no `sent_at`, no `expires_at`, no
// signing status, and no recipient authentication anywhere in this migration.
//
// `preparation_fields` holds the placements. Coordinates are NORMALIZED 0–1
// against the page, top-left origin — the model BACKEND-09 established and
// documented, reused rather than reinvented.
//
// ── Rotation, and the column that refuses work ─────────────────────────────
//
// `rotated_page_count` lands on `document_artifacts` because it is a fact about
// those exact bytes. Nothing in LAGDA knew a page could be rotated before this:
// `page.getSize()` returns the UNROTATED mediabox while a viewer renders the
// rotated page, so on a 90° page every normalized coordinate the editor
// produces would be placed into the wrong space with no error.
//
// Preparation refuses rotated documents rather than misplacing fields on them.
// The column is what makes that refusal possible.

import { type Kysely, sql } from "kysely";

/**
 * The nine field types preparation persists.
 *
 * Five are renderable by the sealer today (`signature`, `initials`, `text`,
 * `date`, `checkbox`). Four more — `full-name`, `email`, `title`, `company` —
 * are semantically distinct requests that all RENDER as text; the mapping lives
 * in `@lagda/core/preparation` and PREPARATION_FIELD_MODEL.md records it.
 *
 * Deliberately absent, each with a reason in PREPARATION_PRODUCT_INVENTORY.md:
 * `radio-group` (needs option sets and a renderer, and is plan-gated),
 * `multiline-text` (no multiline renderer), `acknowledgment` (no renderer),
 * `sender-text` (sender-filled content carries separate authority semantics).
 */
const FIELD_TYPES = [
  "signature", "initials", "date-signed", "text", "checkbox",
  "full-name", "email", "title", "company",
] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── Rotation, on the artifact ─────────────────────────────────────────────
  await sql`
    alter table document_artifacts add column rotated_page_count integer
  `.execute(db);
  await sql`
    alter table document_artifacts
      add constraint document_artifacts_rotated_pages_check
      check (rotated_page_count is null or rotated_page_count >= 0)
  `.execute(db);

  // ── document_preparations ─────────────────────────────────────────────────
  await sql`
    create table document_preparations (
      preparation_id     varchar(64)  primary key,
      workspace_id       varchar(64)  not null,
      document_id        varchar(64)  not null,

      -- The EXACT artifact these coordinates were authored against.
      --
      -- Not "the document's current PDF". If a source artifact is ever replaced
      -- (OD-115), coordinates authored for artifact A may be meaningless for
      -- artifact B even though both belong to one document. Naming the artifact
      -- is what lets a later command detect that rather than silently reuse
      -- geometry against different bytes.
      source_artifact_id varchar(64)  not null,

      -- Concurrency, not authorization.
      --
      -- The editor autosaves and two tabs can edit one layout. A whole-layout
      -- save without this would let a stale tab silently erase the other's
      -- work. The client sends the revision it read; the server commits
      -- revision + 1 or refuses.
      revision           integer      not null default 1,

      -- NULL means EDITABLE. Nothing in BACKEND-30 sets it: the freeze belongs
      -- to signing-request creation (BACKEND-32), and inventing the transition
      -- here would mean inventing the state that triggers it.
      --
      -- The column exists now so every mutation conditions on it from the
      -- start. Retrofitting that discipline later means auditing every write
      -- instead of adding one transition.
      locked_at          timestamptz,

      created_at         timestamptz  not null,
      updated_at         timestamptz  not null,

      -- ONE preparation per document. The product has one editor per document
      -- and no version history; multiple live preparations would immediately
      -- raise "which one is current?" with no product answer.
      constraint document_preparations_document_key unique (workspace_id, document_id),
      -- The compound-key target for \`preparation_fields\`.
      constraint document_preparations_workspace_key unique (workspace_id, preparation_id),

      constraint document_preparations_revision_check check (revision >= 1),

      -- Tenant-safe on BOTH references. A single-column FK would let a
      -- preparation in one workspace target another's document or bytes.
      constraint document_preparations_document_fk
        foreign key (workspace_id, document_id)
        references documents (workspace_id, document_id) on delete restrict,
      constraint document_preparations_artifact_fk
        foreign key (workspace_id, source_artifact_id)
        references document_artifacts (workspace_id, artifact_id) on delete restrict
    )
  `.execute(db);

  // ── preparation_fields ────────────────────────────────────────────────────
  await sql`
    create table preparation_fields (
      field_id       varchar(64)  primary key,
      workspace_id   varchar(64)  not null,
      preparation_id varchar(64)  not null,

      field_type     varchar(32)  not null,

      -- 1-BASED, matching \`SealableField.pageNumber\` and the product. Page 0 is
      -- rejected rather than treated as page 1: a zero means the caller is on a
      -- different convention, and accepting it would put the field on the wrong
      -- page every time.
      page_number    integer      not null,

      -- NORMALIZED 0–1, top-left origin, \`y\` to the field's TOP edge.
      -- \`double precision\` rather than numeric: these are display geometry, not
      -- money, and the renderer multiplies them by page dimensions anyway.
      -- PREPARATION_COORDINATES.md records the precision policy.
      x              double precision not null,
      y              double precision not null,
      width          double precision not null,
      height         double precision not null,

      required       boolean      not null,
      -- Shown in the editor and to the signer. Bounded, and treated as
      -- potentially sensitive in logs — "Landlord signature" names a party.
      label          varchar(200) not null,
      -- z-order. The editor's \`layer\`; higher draws on top.
      layer          integer      not null,

      -- The editor's participant slot, and NOT an identity.
      --
      -- The product's \`FieldDefinition.participantId\` is an editor-local label
      -- ("P1", "P2"). It is NOT a UserId, NOT a ContactId, NOT a
      -- WorkspaceMemberId and NOT a RecipientId — there is no recipient table
      -- yet. Deliberately no foreign key, because there is nothing to point at.
      --
      -- BACKEND-31 must migrate this to a real RecipientId. Until then it is an
      -- opaque bounded string, and nothing dereferences it.
      -- PREPARATION_RECIPIENT_HANDOFF.md.
      participant_slot varchar(64),

      constraint preparation_fields_workspace_key unique (workspace_id, field_id),

      constraint preparation_fields_type_check
        check (field_type in (${inList(FIELD_TYPES)})),
      -- 1-based, so the floor is 1. The CEILING is the artifact's page count and
      -- lives in the application, which has the artifact to compare against.
      constraint preparation_fields_page_check check (page_number >= 1),

      -- Geometry, at the database. These reject the pathological cases without
      -- restating the application's page-relative rules:
      --   * positive size — a zero-area field is invisible and unfillable;
      --   * within the page — possible here ONLY because coordinates are
      --     normalized, so the bound is 1 rather than a page dimension.
      -- NaN and Infinity fail these comparisons, so they are rejected too.
      constraint preparation_fields_size_check check (width > 0 and height > 0),
      constraint preparation_fields_bounds_check check (
        x >= 0 and y >= 0 and x + width <= 1 and y + height <= 1
      ),
      constraint preparation_fields_layer_check check (layer >= 0),

      constraint preparation_fields_preparation_fk
        foreign key (workspace_id, preparation_id)
        references document_preparations (workspace_id, preparation_id)
        -- CASCADE, and the only one in this schema.
        --
        -- Justified because a field has no meaning without its preparation and
        -- no independent history: it is authoring state, not evidence. Every
        -- other RESTRICT in LAGDA protects a record something else references;
        -- nothing references a preparation field, and nothing may — a signing
        -- request will snapshot these values, not point at them.
        on delete cascade
    )
  `.execute(db);

  // Deterministic listing: page, then z-order, then id as the tie-breaker.
  // Matches the application's ORDER BY exactly, so the index serves the query
  // rather than merely existing.
  await sql`
    create index preparation_fields_order_idx
      on preparation_fields (workspace_id, preparation_id, page_number, layer, field_id)
  `.execute(db);

  // ── RLS ───────────────────────────────────────────────────────────────────
  //
  // The ordinary tenant pattern on both tables. No credential path, no new
  // transaction scope: every caller is an authenticated workspace member.
  for (const table of ["document_preparations", "preparation_fields"] as const) {
    await sql`
      grant select, insert, update, delete on table ${sql.raw(table)} to lagda_app
    `.execute(db);
    await sql`alter table ${sql.raw(table)} enable row level security`.execute(db);
    await sql`alter table ${sql.raw(table)} force row level security`.execute(db);
    await sql`
      create policy tenant_isolation on ${sql.raw(table)}
      using (workspace_id = lagda_current_workspace())
      with check (workspace_id = lagda_current_workspace())
    `.execute(db);
  }

  // DELETE is granted here, unlike every other table in this schema.
  //
  // Deliberate: a whole-layout save replaces the field set, and removing a field
  // the sender deleted is the operation. Authoring metadata is not evidence —
  // there is no history to destroy, and a soft-deleted field would have to be
  // filtered out of every read and every future snapshot.
  //
  // The grant is on `preparation_fields` and `document_preparations` ONLY.
  // `documents` and `document_artifacts` still have none.
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists tenant_isolation on preparation_fields`.execute(db);
  await sql`drop policy if exists tenant_isolation on document_preparations`.execute(db);
  await db.schema.dropTable("preparation_fields").ifExists().execute();
  await db.schema.dropTable("document_preparations").ifExists().execute();
  await sql`
    alter table document_artifacts
      drop constraint if exists document_artifacts_rotated_pages_check
  `.execute(db);
  await sql`
    alter table document_artifacts drop column if exists rotated_page_count
  `.execute(db);
}
