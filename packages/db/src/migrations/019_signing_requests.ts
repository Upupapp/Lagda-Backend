// 019 — signing requests: the authoring/workflow boundary.
//
// ── What changes here ──────────────────────────────────────────────────────
//
// Everything before this migration is MUTABLE authoring state. A sender edits a
// preparation, moves fields, renames recipients, renames the document. That is
// correct while nothing has been sent.
//
// A signing request is the other side of that line: an IMMUTABLE snapshot of
// one coherent preparation state, taken at one instant, which nothing later can
// change. It is what BACKEND-33 will send, what BACKEND-38 will complete
// against, and what BACKEND-43 will cite as evidence.
//
//   Document + DocumentPreparation revision N
//        |  snapshot
//        v
//   SigningRequest + SigningRequestRecipient[] + SigningRequestField[]
//
// Preparation then moves to revision N+1 and the request does not notice.
//
// ── Why NEW ids for recipients and fields ──────────────────────────────────
//
// A preparation recipient can be edited, deleted, reordered, or reused by a
// second request. If a request pointed at `preparation_recipients.recipient_id`
// as its historical identity, deleting that row would orphan a signing
// workflow, and reusing it would make two requests share a participant.
//
// So each snapshot row gets its own id. The `source_*` columns are PROVENANCE:
// nullable, never read to resolve a value, ON DELETE SET NULL so the mutable
// side stays freely editable.
//
// ── What is deliberately NOT here ──────────────────────────────────────────
//
// No `sent_at`, `delivered_at`, `viewed_at`, `signed_at`, `declined_at`,
// `completed_at`, `expires_at`, `cancelled_at`. No `subject`, no `message`, no
// reminder configuration. No `access_token`, no `otp`, no `authenticated_at`.
//
// Each belongs to the command that owns the behaviour which writes it — 33 for
// send, 34 for access, 37 for ceremony state, 46 for reminders and expiry. A
// nullable column added now would be a semantic nothing can fill and a reader
// would reasonably believe.

import { type Kysely, sql } from "kysely";

/**
 * The states a signing request can be in TODAY.
 *
 * Exactly one. Not a state machine — a starting point.
 *
 * `sent`, `completed`, `declined`, `expired`, `voided` and `cancelled` all
 * exist in the product's `TransactionStatus`, and every one is a claim about
 * something that happened. BACKEND-32 makes none of them true, so listing them
 * in a CHECK would let a bug write one.
 *
 * Widening a CHECK is a one-line migration. Explaining why a request says
 * `sent` when nothing was sent is not.
 */
const REQUEST_STATES = ["draft"] as const;

/**
 * The nine preparation field types, copied verbatim from migration 017.
 *
 * Re-listed rather than imported. A migration is a record of what the schema
 * was at a point in time; a shared constant would silently rewrite this one the
 * day a tenth type is added.
 */
const FIELD_TYPES = [
  "signature", "initials", "date-signed", "text", "checkbox",
  "full-name", "email", "title", "company",
] as const;

/** The six participant roles, copied verbatim from migration 018, same reason. */
const RECIPIENT_TYPES = [
  "signer", "approver", "reviewer",
  "acknowledgment-recipient", "viewer", "carbon-copy",
] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── signing_requests ────────────────────────────────────────────────────────
  await sql`
    create table signing_requests (
      signing_request_id  varchar(64)  primary key,
      workspace_id        varchar(64)  not null,

      -- The business relationship. A request is ABOUT a document, and the
      -- document outlives it.
      document_id         varchar(64)  not null,

      -- The exact bytes the geometry applies to. NOT "the document's current
      -- original": if a source artifact is ever replaced, this request still
      -- names the one its coordinates were authored against.
      source_artifact_id  varchar(64)  not null,

      -- Provenance, not authority. Which preparation, at which revision, this
      -- snapshot came from. Nothing reads them to reconstruct the request; they
      -- exist so an operator can answer "where did this come from".
      --
      -- NOT NULL and RESTRICT, unlike a contact reference: the product has no
      -- control that deletes a preparation and BACKEND-30 granted no DELETE.
      source_preparation_id        varchar(64) not null,
      source_preparation_revision  integer     not null,

      state               varchar(32)  not null,

      -- ── The document title as it was ───────────────────────────────────────
      --
      -- Snapshotted because the title is MUTABLE (BACKEND-29 renameDocument)
      -- and because the SIGNER sees it: the product's RecipientRequest carries
      -- transactionTitle.
      --
      -- Without this, renaming a document in October would retroactively rename
      -- the transaction someone signed in March, on their own copy of it.
      document_title      varchar(300) not null,

      -- From AuthenticatedActor.userId, never from input. Audit provenance: the
      -- request is workspace-owned, so losing membership does not remove it.
      created_by_user_id  varchar(64)  not null,

      created_at          timestamptz  not null,
      -- Present from the start because the row's STATE will change when
      -- BACKEND-33 sends it, even though its snapshot columns never will.
      updated_at          timestamptz  not null,

      -- The compound-key target for recipient and field rows.
      constraint signing_requests_workspace_key
        unique (workspace_id, signing_request_id),

      constraint signing_requests_state_check
        check (state in (${inList(REQUEST_STATES)})),
      constraint signing_requests_revision_check
        check (source_preparation_revision >= 1),
      constraint signing_requests_title_present
        check (length(btrim(document_title)) > 0),

      -- RESTRICT on all three. A signing workflow is the record that a document
      -- was put in front of people; nothing upstream may delete it out from
      -- under itself.
      constraint signing_requests_document_fk
        foreign key (workspace_id, document_id)
        references documents (workspace_id, document_id) on delete restrict,

      constraint signing_requests_artifact_fk
        foreign key (workspace_id, source_artifact_id)
        references document_artifacts (workspace_id, artifact_id) on delete restrict,

      constraint signing_requests_preparation_fk
        foreign key (workspace_id, source_preparation_id)
        references document_preparations (workspace_id, preparation_id) on delete restrict
    )
  `.execute(db);

  // Deliberately NOT unique on document_id. The product's evidence for one
  // request per document is a fixture display shape and a rule about a
  // DIFFERENT aggregate (SigningWorkflow). Forbidding a second request the
  // product turns out to want costs a migration and a blocked user; permitting
  // one it does not want costs a single application condition, against zero
  // existing rows. SIGNING_REQUEST_PRODUCT_INVENTORY.md records the reasoning.
  await sql`
    create index signing_requests_document_idx
      on signing_requests (workspace_id, document_id, created_at desc)
  `.execute(db);

  // ── signing_request_recipients ──────────────────────────────────────────────
  await sql`
    create table signing_request_recipients (
      request_recipient_id  varchar(64)  primary key,
      workspace_id          varchar(64)  not null,
      signing_request_id    varchar(64)  not null,

      -- PROVENANCE only. Which preparation recipient this was copied from, so a
      -- support case can be traced. Nothing reads it to resolve a name or an
      -- email: those are the snapshot columns below.
      --
      -- ON DELETE SET NULL because the mutable side must stay editable - a
      -- sender who removes a participant from the draft must not be blocked by,
      -- or destroy, a workflow already created from it.
      source_preparation_recipient_id varchar(64),

      -- ── The snapshot ──────────────────────────────────────────────────────
      name                  varchar(200) not null,
      -- The delivery address exactly as entered. Unverified, and NOT rewritten
      -- to match the comparison key: an invitation goes where it was typed.
      email                 varchar(254) not null,
      -- The fold, retained for the duplicate rule below and for BACKEND-34's
      -- comparison. Internal - it never leaves the backend.
      normalized_email      varchar(254) not null,
      organization          varchar(200),
      recipient_type        varchar(32)  not null,
      is_required           boolean      not null,
      order_index           integer      not null,
      routing_order         integer      not null,

      created_at            timestamptz  not null,

      -- The compound-key target for a field's assignment. All THREE columns, so
      -- a field can only name a recipient of its OWN request - the check
      -- tenant isolation cannot make, because two requests in one workspace are
      -- both legitimately visible.
      constraint signing_request_recipients_request_key
        unique (workspace_id, signing_request_id, request_recipient_id),
      constraint signing_request_recipients_workspace_key
        unique (workspace_id, request_recipient_id),

      -- The preparation's duplicate rule, preserved at request scope. Not a new
      -- semantic: BACKEND-31 already refuses two recipients sharing an address
      -- on one preparation, and a snapshot that relaxed it would let a
      -- constraint hold for the draft and not for the thing actually sent.
      constraint signing_request_recipients_email_key
        unique (workspace_id, signing_request_id, normalized_email),

      constraint signing_request_recipients_name_present
        check (length(btrim(name)) > 0),
      constraint signing_request_recipients_email_present
        check (length(btrim(email)) > 0),
      constraint signing_request_recipients_email_normalized
        check (normalized_email = lower(normalized_email)),
      constraint signing_request_recipients_type_check
        check (recipient_type in (${inList(RECIPIENT_TYPES)})),
      constraint signing_request_recipients_order_check
        check (order_index >= 0),
      constraint signing_request_recipients_routing_check
        check (routing_order >= 1),

      constraint signing_request_recipients_request_fk
        foreign key (workspace_id, signing_request_id)
        references signing_requests (workspace_id, signing_request_id)
        -- CASCADE, matching preparation_recipients: a snapshot row has no
        -- meaning without the request that holds it, and nothing outside the
        -- request references it.
        on delete cascade,

      constraint signing_request_recipients_source_fk
        foreign key (workspace_id, source_preparation_recipient_id)
        references preparation_recipients (workspace_id, recipient_id)
        -- The column list, not a bare clause. A composite SET NULL nulls EVERY
        -- referencing column including workspace_id, which is NOT NULL - so a
        -- bare clause would make deleting a preparation recipient FAIL rather
        -- than forget the provenance. Migration 018 shipped that bug once.
        on delete set null (source_preparation_recipient_id)
    )
  `.execute(db);

  await sql`
    create index signing_request_recipients_order_idx
      on signing_request_recipients
         (workspace_id, signing_request_id, order_index, request_recipient_id)
  `.execute(db);

  // ── signing_request_fields ──────────────────────────────────────────────────
  //
  // The same shape as `preparation_fields`, with two differences: the ids are
  // request-scoped, and `recipient_id` names a REQUEST recipient.
  await sql`
    create table signing_request_fields (
      request_field_id      varchar(64)  primary key,
      workspace_id          varchar(64)  not null,
      signing_request_id    varchar(64)  not null,

      -- PROVENANCE only, same rules as the recipient's. A sender who deletes a
      -- field from the draft must not be blocked by a request created from it.
      source_preparation_field_id varchar(64),

      field_type            varchar(32)  not null,
      -- 1-BASED, matching the canonical coordinate model and preparation. Page
      -- 0 is not page 1.
      page_number           integer      not null,
      -- Normalized 0-1, TOP-LEFT origin, y to the field's TOP edge. Copied
      -- exactly - never recomputed, never re-rounded.
      x                     double precision not null,
      y                     double precision not null,
      width                 double precision not null,
      height                double precision not null,
      required              boolean      not null,
      label                 varchar(200) not null,
      layer                 integer      not null,

      -- ── The assignment ────────────────────────────────────────────────────
      --
      -- NOT NULL here, unlike preparation. An unassigned field is a legitimate
      -- AUTHORING state - the editor places a box before deciding who fills it
      -- - and an impossible WORKFLOW state: nobody could ever complete it. The
      -- readiness gate refuses to snapshot one, and this column makes that
      -- refusal structural rather than a rule someone must remember (OD-127).
      request_recipient_id  varchar(64)  not null,

      created_at            timestamptz  not null,

      constraint signing_request_fields_request_key
        unique (workspace_id, signing_request_id, request_field_id),

      constraint signing_request_fields_type_check
        check (field_type in (${inList(FIELD_TYPES)})),
      constraint signing_request_fields_page_check
        check (page_number >= 1),
      -- The same geometry rules migration 017 applies, restated rather than
      -- assumed: a writer that skipped the domain still cannot store a
      -- rectangle that falls off the page.
      constraint signing_request_fields_bounds_check check (
        x >= 0 and y >= 0 and width > 0 and height > 0
        and x + width <= 1 and y + height <= 1
      ),
      constraint signing_request_fields_layer_check check (layer >= 0),

      constraint signing_request_fields_request_fk
        foreign key (workspace_id, signing_request_id)
        references signing_requests (workspace_id, signing_request_id)
        on delete cascade,

      -- THREE columns. The one that matters is the middle: a field of request A
      -- cannot name a recipient of request B, even though both rows belong to
      -- the same tenant and RLS sees both.
      constraint signing_request_fields_recipient_fk
        foreign key (workspace_id, signing_request_id, request_recipient_id)
        references signing_request_recipients
          (workspace_id, signing_request_id, request_recipient_id)
        on delete restrict,

      constraint signing_request_fields_source_fk
        foreign key (workspace_id, source_preparation_field_id)
        references preparation_fields (workspace_id, field_id)
        on delete set null (source_preparation_field_id)
    )
  `.execute(db);

  await sql`
    create index signing_request_fields_order_idx
      on signing_request_fields
         (workspace_id, signing_request_id, page_number, layer, request_field_id)
  `.execute(db);

  // BACKEND-34 and BACKEND-37 both look fields up BY RECIPIENT - "what is this
  // signer being asked for". Added now because the access pattern is certain
  // and an index is cheaper than the query plan that finds out later.
  await sql`
    create index signing_request_fields_recipient_idx
      on signing_request_fields
         (workspace_id, signing_request_id, request_recipient_id)
  `.execute(db);

  // ── Grants and RLS ──────────────────────────────────────────────────────────
  //
  // Note the asymmetry, and that it is deliberate: the request row gets UPDATE
  // because BACKEND-33 will transition its STATE. The two snapshot tables get
  // INSERT and SELECT and no UPDATE at all - immutability enforced by a grant
  // rather than by a convention a repository author has to remember.
  //
  // DELETE is granted on all three so a CASCADE from the request works, and
  // because the product may yet want to abandon an unsent request. No
  // application code deletes one today.
  await sql`
    grant select, insert, update, delete on table signing_requests to lagda_app
  `.execute(db);
  await sql`
    grant select, insert, delete on table signing_request_recipients to lagda_app
  `.execute(db);
  await sql`
    grant select, insert, delete on table signing_request_fields to lagda_app
  `.execute(db);

  for (const table of [
    "signing_requests", "signing_request_recipients", "signing_request_fields",
  ]) {
    await sql`alter table ${sql.ref(table)} enable row level security`.execute(db);
    await sql`alter table ${sql.ref(table)} force row level security`.execute(db);
    await sql`
      create policy tenant_isolation on ${sql.ref(table)}
      using (workspace_id = lagda_current_workspace())
      with check (workspace_id = lagda_current_workspace())
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    "signing_request_fields", "signing_request_recipients", "signing_requests",
  ]) {
    await sql`drop policy if exists tenant_isolation on ${sql.ref(table)}`.execute(db);
    await db.schema.dropTable(table).ifExists().execute();
  }
}
