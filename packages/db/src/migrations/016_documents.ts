// 016 — the document aggregate.
//
// ── What this migration is really doing ────────────────────────────────────
//
// Creating `documents` is the small half. The consequential half is the two
// constraints it lets us add to `document_artifacts`, a table that has carried
// `document_id NOT NULL` since migration 003 with **no foreign key**, because
// there was nothing to point at:
//
//   1. (workspace_id, document_id) -> documents (workspace_id, document_id)
//   2. one ORIGINAL artifact per document
//
// Until now `document_id` on an artifact was a client-supplied string naming
// nothing. BACKEND-18's upload route says so in as many words: "Supplied by the
// caller because DOCUMENTS DO NOT EXIST YET". After this migration it is a real
// reference, and a tenant-safe one.
//
// ── Document-first, and why ────────────────────────────────────────────────
//
// The storage key is {workspaceId}/{documentId}/{artifactId} and
// `document_artifacts.document_id` is NOT NULL, so the document identity has to
// exist BEFORE the bytes are promoted. The alternative — artifact first, then
// create a document from it — would mean changing the key strategy
// (BACKEND-17) and the artifact schema (BACKEND-10) so that accepted bytes
// could be filed under a placeholder path, permanently, to make an ordering
// preference work. See DOCUMENT_ARTIFACT_MODEL.md.
//
// The consequence is real and is treated as a state rather than an anomaly: a
// document can exist with no original artifact, for the window between its
// creation and a successful upload.
//
// ── What is deliberately NOT here ──────────────────────────────────────────
//
// No `status`, no `archived_at`, no `deleted_at`. The product has no
// document-level lifecycle at all — every status it displays is a
// TransactionStatus, and archive/restore are transaction actions. Adding a
// document status column now is precisely what §33 forbids, and it is the
// column a later command would have to reconcile with the signing-request
// state it duplicates.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table documents (
      document_id        varchar(64)  primary key,
      workspace_id       varchar(64)  not null
        references workspaces (workspace_id) on delete restrict,

      -- MUTABLE display metadata. Never a storage key, never an identity, and
      -- never derived from the PDF's embedded metadata (which is attacker-
      -- controlled text inside an untrusted file).
      title              varchar(300) not null,

      -- What the file arrived as. Display only, and SEPARATE from the title:
      -- the product's own TransactionFile carries both \`displayTitle\` and
      -- \`fileName\`, so a rename to "Office Lease" leaves "lease-v4-final.pdf"
      -- intact. Nullable because a multipart part legitimately has no filename,
      -- and because a document exists before its upload.
      original_filename  varchar(255),

      -- Audit metadata, NOT authorization. Documents are owned by the
      -- workspace; who created one does not decide who may read it (§105).
      created_by_user_id varchar(64)  not null,

      created_at         timestamptz  not null,
      updated_at         timestamptz  not null,

      -- The compound-key target. Redundant against the primary key and present
      -- so \`document_artifacts\` can reference it tenant-safely below.
      constraint documents_workspace_key unique (workspace_id, document_id),

      -- Reinforces the application rule rather than restating it: the domain
      -- trims, counts code points and rejects control characters; this refuses
      -- a blank title from any writer that skipped it.
      constraint documents_title_present check (length(btrim(title)) > 0)
    )
  `.execute(db);

  // The document list order the product would use: newest first, tenant-first.
  // The id is part of the index because it is the tie-breaker in the ORDER BY,
  // and an index that stops at the timestamp leaves the sort to do the rest.
  await sql`
    create index documents_workspace_created_idx
      on documents (workspace_id, created_at desc, document_id desc)
  `.execute(db);

  // ── Page count, which BACKEND-18 inspects and then throws away ───────────
  //
  // `InspectionOk.pageCount` is computed from the accepted bytes during upload
  // and persisted NOWHERE — not on the upload row, not on the artifact. The
  // product shows it (`TransactionFile.pageCount`), so without this the only
  // ways to satisfy the UI are to re-parse the PDF on every read, or to trust a
  // client-supplied number. §22 rules out the first and §12 the second.
  //
  // It belongs on the ARTIFACT, not on the document: page count is a fact about
  // one exact sequence of bytes. A sealed artifact may legitimately have a
  // different count from the original it derives from, and a column on
  // `documents` could only ever describe one of them.
  //
  // Nullable, because artifacts written before this migration have no inspected
  // count and a backfill would have to invent one — and because a future
  // non-paginated artifact type has no meaningful value here.
  await sql`alter table document_artifacts add column page_count integer`.execute(db);
  await sql`
    alter table document_artifacts
      add constraint document_artifacts_page_count_check
      check (page_count is null or page_count > 0)
  `.execute(db);

  // ── The two constraints this migration exists for ────────────────────────
  //
  // 1. TENANT-SAFE ARTIFACT LINKAGE.
  //
  // Compound, not `document_id` alone. A single-column reference would let a
  // Workspace A artifact name a Workspace B document, with nothing but
  // application code to stop it — and §113 requires the database itself to
  // refuse that. With this, "create a document from another tenant's artifact"
  // is not a bug that can reach production; it is a constraint violation.
  //
  // RESTRICT, matching every other reference in this schema. An artifact is
  // immutable evidence of bytes that exist; a cascade from a document delete
  // would silently orphan the object and destroy the only record of it.
  await sql`
    alter table document_artifacts
      add constraint document_artifacts_document_fk
      foreign key (workspace_id, document_id)
      references documents (workspace_id, document_id) on delete restrict
  `.execute(db);

  // 2. ONE ORIGINAL PER DOCUMENT.
  //
  // A partial unique index, because the rule applies to exactly one artifact
  // type. `sealed` and `completion-certificate` are deliberately unconstrained:
  // there is no reason yet to promise a document has at most one of either, and
  // a constraint promising something nobody has decided is a constraint that
  // gets dropped later — which is how historical rows stop being validated.
  //
  // What this prevents concretely: a second successful upload against a
  // document that already has its original. Without it, a retried upload after
  // a partially-observed failure produces two `original` rows for one document
  // and nothing can choose between them. The retry path that matters still
  // works — a commit that failed wrote no row, so the retry finds none.
  await sql`
    create unique index document_artifacts_one_original_idx
      on document_artifacts (workspace_id, document_id)
      where artifact_type = 'original'
  `.execute(db);

  // ── RLS ───────────────────────────────────────────────────────────────────
  //
  // The ordinary tenant pattern. Documents have no public path and no
  // credential lookup — BACKEND-42's public verification reads verification
  // records, not documents, and building a bypass here in anticipation of it
  // is what §116 forbids.
  await sql`grant select, insert, update on table documents to lagda_app`.execute(db);

  // No DELETE grant. The product has no delete at either level, and a document
  // is referenced by immutable artifacts and — from BACKEND-32 — by signing
  // evidence. DOCUMENT_DELETION_POLICY.md records the choice.

  await sql`alter table documents enable row level security`.execute(db);
  await sql`alter table documents force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on documents
    using (workspace_id = lagda_current_workspace())
    with check (workspace_id = lagda_current_workspace())
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists document_artifacts_one_original_idx`.execute(db);
  await sql`
    alter table document_artifacts
      drop constraint if exists document_artifacts_document_fk
  `.execute(db);
  await sql`
    alter table document_artifacts
      drop constraint if exists document_artifacts_page_count_check
  `.execute(db);
  await sql`alter table document_artifacts drop column if exists page_count`.execute(db);
  await sql`drop policy if exists tenant_isolation on documents`.execute(db);
  await db.schema.dropTable("documents").ifExists().execute();
}
