// 040 — folders, and the two lifecycle states a document can be in.
//
// ── What the model could not say ───────────────────────────────────────────
//
// Documents were a flat list. The product's own navigation names My Documents,
// Department Documents, Shared With Me, Recent, Favourites, Templates,
// Completed, Archived and Trash -- nine areas over a table with no folder, no
// archive state and no deletion state.
//
// ── Why archive and trash are TWO columns and not one status ───────────────
//
// They are different acts with different meanings and different reversals.
// Archiving says "this is finished, keep it out of my way" and a document can
// live archived forever. Trashing says "I meant to remove this" and is a staging
// area for deletion. A single `status` column would force one to overwrite the
// other, and restoring from trash would then have to guess whether the document
// had been archived before it was thrown away.
//
// Both are nullable timestamps rather than booleans, because WHEN something was
// archived is the question a retention policy asks and a boolean cannot answer.
//
// ── Why the folder is on the document, not a join table ────────────────────
//
// A document is in ONE folder. Filing is not tagging; a document that could be
// in two places has no answer to "where is it", and the product's own model is a
// tree with a breadcrumb. Tags are the many-to-many concept and are a separate
// concern with a separate table when they arrive.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table document_folders (
      folder_id        varchar(64)  primary key,
      workspace_id     varchar(64)  not null,

      -- NULL is the workspace root. Several roots are impossible by
      -- construction: there is one root and it is the absence of a parent.
      parent_folder_id varchar(64),

      name             varchar(120) not null,
      created_by_user_id varchar(64) not null,
      created_at       timestamptz  not null,
      -- Archived, never dropped. Documents reference folders, and a folder that
      -- vanished would strand every document filed in it.
      archived_at      timestamptz,

      constraint document_folders_name_present
        check (length(btrim(name)) > 0),
      constraint document_folders_not_self_parent
        check (parent_folder_id is null or parent_folder_id <> folder_id),

      constraint document_folders_tenant_identity
        unique (workspace_id, folder_id),

      constraint document_folders_workspace_fk
        foreign key (workspace_id) references workspaces (workspace_id)
        on delete restrict
    )
  `.execute(db);

  // Compound self-reference: a parent in another workspace is unrepresentable
  // rather than merely refused. RESTRICT, so archiving a parent is a deliberate
  // reparenting rather than a cascade that empties a filing system.
  await sql`
    alter table document_folders
      add constraint document_folders_parent_fk
        foreign key (workspace_id, parent_folder_id)
        references document_folders (workspace_id, folder_id)
        on delete restrict
  `.execute(db);

  // Two folders with one name under one parent are ambiguous to a person
  // choosing from a list. Partial on the root case, since NULL parents do not
  // compare equal to each other.
  await sql`
    create unique index document_folders_sibling_name_idx
      on document_folders (workspace_id, parent_folder_id, lower(name))
      where parent_folder_id is not null and archived_at is null
  `.execute(db);
  await sql`
    create unique index document_folders_root_name_idx
      on document_folders (workspace_id, lower(name))
      where parent_folder_id is null and archived_at is null
  `.execute(db);

  await sql`
    create index document_folders_tree_idx
      on document_folders (workspace_id, parent_folder_id)
      where archived_at is null
  `.execute(db);

  // ── The document's place, and its two lifecycle states ─────────────────────
  await sql`
    alter table documents
      add column folder_id   varchar(64),
      add column archived_at timestamptz,
      add column deleted_at  timestamptz
  `.execute(db);

  // Compound again. A document cannot be filed into another tenant's folder
  // even if somebody supplies a valid-looking folder id.
  await sql`
    alter table documents
      add constraint documents_folder_fk
        foreign key (workspace_id, folder_id)
        references document_folders (workspace_id, folder_id)
        -- RESTRICT: a folder holding documents cannot be removed out from under
        -- them. Emptying it is a decision somebody makes explicitly.
        on delete restrict
  `.execute(db);

  // A trashed document is not also archived. The two states are exclusive
  // because "restore" would otherwise have no single answer -- restore to
  // where, the folder or the archive?
  await sql`
    alter table documents
      add constraint documents_lifecycle_exclusive check (
        archived_at is null or deleted_at is null
      )
  `.execute(db);

  // How every list view finds its rows: one folder, live documents only.
  // Partial, so the index stays the size of the working set rather than of
  // everything ever trashed.
  await sql`
    create index documents_folder_live_idx
      on documents (workspace_id, folder_id)
      where archived_at is null and deleted_at is null
  `.execute(db);

  // How Trash and Archived find theirs.
  await sql`
    create index documents_trashed_idx
      on documents (workspace_id, deleted_at)
      where deleted_at is not null
  `.execute(db);
  await sql`
    create index documents_archived_idx
      on documents (workspace_id, archived_at)
      where archived_at is not null
  `.execute(db);

  await sql`grant select, insert, update, delete on table document_folders to lagda_app`
    .execute(db);
  await sql`alter table document_folders enable row level security`.execute(db);
  await sql`alter table document_folders force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on document_folders
    using (workspace_id = lagda_current_workspace())
    with check (workspace_id = lagda_current_workspace())
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists documents_archived_idx`.execute(db);
  await sql`drop index if exists documents_trashed_idx`.execute(db);
  await sql`drop index if exists documents_folder_live_idx`.execute(db);
  await sql`
    alter table documents
      drop constraint if exists documents_lifecycle_exclusive,
      drop constraint if exists documents_folder_fk,
      drop column if exists deleted_at,
      drop column if exists archived_at,
      drop column if exists folder_id
  `.execute(db);
  await sql`drop table if exists document_folders`.execute(db);
}
