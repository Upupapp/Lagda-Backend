// 015 — workspace contacts.
//
// ── A contact is address-book data, not an identity ────────────────────────
//
// The table deliberately carries no `user_id`, no `email_verified_at`, no
// membership reference and no recipient reference. A contact is a convenience
// record a workspace member typed in; LAGDA has authenticated nothing about it.
//
// ── No unique constraint on email ──────────────────────────────────────────
//
// The product DETECTS duplicates and surfaces them for review — there is a
// `duplicates` view, a `review-duplicate` action and a `findDuplicates` query —
// rather than preventing them. And shared inboxes (`legal@`, `contracts@`) are
// legitimately several business contacts.
//
// So there is no `UNIQUE(workspace_id, normalized_email)`. See
// CONTACT_DUPLICATE_POLICY.md, which records the decision and the cases.
//
// ── Archive, not delete ────────────────────────────────────────────────────
//
// `ContactActionId` in the product has `archive` and `restore`. It has no
// delete. The schema follows: `archived_at`, and no DELETE grant.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("contacts")
    .addColumn("contact_id", "varchar(64)", col => col.primaryKey())
    // First-class tenant column. Every workspace-owned table carries it.
    .addColumn("workspace_id", "varchar(64)", col => col.notNull())

    // ── Identity fields, all display data ──────────────────────────────────
    .addColumn("name", "varchar(200)", col => col.notNull())
    .addColumn("email", "varchar(254)", col => col.notNull())
    // A comparison key for duplicate DETECTION and exact-match search. It is
    // NOT a uniqueness key and NOT an account identity — the column name says
    // `contact` so it cannot be mistaken for `users.normalized_email`, which
    // is an authentication identity with entirely different guarantees.
    .addColumn("normalized_contact_email", "varchar(254)", col => col.notNull())
    // Three optional fields, all present on the product's create form.
    .addColumn("phone", "varchar(50)")
    .addColumn("organization", "varchar(200)")
    .addColumn("title", "varchar(200)")

    .addColumn("created_at", "timestamptz", col => col.notNull())
    // Read by the product's default sort (`updatedAt desc`), which is why this
    // table has one where `workspaces` deliberately does not.
    .addColumn("updated_at", "timestamptz", col => col.notNull())
    // NULL means active. The product's archive/restore pair, as a timestamp
    // rather than a status column — the same reasoning as invitations: state
    // derived from a timestamp cannot disagree with the timestamp.
    .addColumn("archived_at", "timestamptz")

    .addForeignKeyConstraint(
      "fk_contacts_workspace", ["workspace_id"], "workspaces", ["workspace_id"],
      // RESTRICT, matching every other reference in this schema. Workspace hard
      // deletion does not exist (BACKEND-55), and a cascade would answer that
      // question destructively by default.
      builder => builder.onDelete("restrict"),
    )

    .addCheckConstraint("chk_contacts_name_present", sql`length(btrim(name)) > 0`)
    .addCheckConstraint("chk_contacts_email_present", sql`length(btrim(email)) > 0`)
    // The comparison key must actually be normalized. Without this a caller
    // that skipped the normalizer could store a mixed-case key that duplicate
    // detection would never match.
    .addCheckConstraint(
      "chk_contacts_email_normalized",
      sql`normalized_contact_email = lower(normalized_contact_email)`,
    )
    .execute();

  // ── The compound-key target (BACKEND-07) ──────────────────────────────────
  //
  // Redundant today — `contact_id` is the primary key — and present on purpose.
  // It is what a future tenant-safe reference needs:
  //
  //   FOREIGN KEY (workspace_id, source_contact_id)
  //     REFERENCES contacts (workspace_id, contact_id)
  //
  // A signing recipient referencing only `contact_id` could point at a contact
  // in another workspace, with nothing but application code to stop it.
  await db.schema
    .createIndex("uq_contacts_workspace_contact")
    .on("contacts")
    .columns(["workspace_id", "contact_id"])
    .unique()
    .execute();

  // The default list order: `updated_at desc`, tenant-first.
  await db.schema
    .createIndex("idx_contacts_workspace_updated_at")
    .on("contacts")
    .columns(["workspace_id", "updated_at desc"])
    .execute();

  // Duplicate detection and exact-address lookup. NOT unique — see above.
  await db.schema
    .createIndex("idx_contacts_workspace_email")
    .on("contacts")
    .columns(["workspace_id", "normalized_contact_email"])
    .execute();

  // Name-ordered listing. Both indexes lead with the tenant, because every
  // contact query is workspace-scoped first and an index that did not would be
  // near-useless for the queries this system runs.
  await db.schema
    .createIndex("idx_contacts_workspace_name")
    .on("contacts")
    .columns(["workspace_id", "name"])
    .execute();

  // ── Row Level Security ────────────────────────────────────────────────────
  //
  // The ordinary tenant pattern, with nothing special about it. Contacts have
  // no public path and no credential lookup — unlike invitations, every caller
  // is an authenticated member with tenant context, so this is the simple case.
  await sql`grant select, insert, update on table contacts to lagda_app`.execute(db);

  // No DELETE grant. The product archives; the runtime role has no statement
  // available that erases a contact, which is enforcement rather than a
  // repository that merely omits the method.

  await sql`alter table contacts enable row level security`.execute(db);
  await sql`alter table contacts force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on contacts
    using (workspace_id = lagda_current_workspace())
    with check (workspace_id = lagda_current_workspace())
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists tenant_isolation on contacts`.execute(db);
  await db.schema.dropTable("contacts").ifExists().execute();
}
