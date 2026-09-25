// 074 — a contact can be personal (visible only to the member who added it)
// or shared with the workspace, can carry a short note, and can carry the
// product's fixed set of tags.
//
// ── Why these were promised but never persisted ────────────────────────────
//
// 015's header explained why the table carries no owner at all: contacts
// launched workspace-shared only, and "personal" was a frontend-only
// demonstration concept with nowhere to land. The product has since asked for
// it for real, so this gives it a column instead of leaving Edit Contact
// accept a choice the server silently drops.
//
// ── Personal visibility is enforced in the APPLICATION layer, not RLS ──────
//
// Every other access rule this table has is tenant isolation: an authenticated
// member of the workspace may see every row, full stop. "Only the owner" is a
// PER-ROW, per-ACTOR rule, and RLS's ordinary tool for that is
// `lagda_current_user_id()` — but that setting exists only inside `runForUser`
// transactions (013), never inside `runForWorkspace`, which every contacts
// call runs in. Wiring a second identity realm through every workspace
// transaction to filter one column would be a change far larger than the
// feature, and every existing workspace-scoped RLS test would need to account
// for a setting most of them have no reason to set.
//
// So `listContacts` filters personal rows to their owner explicitly, in SQL,
// with the caller's own actor id — the same place `authorize()` already
// checks who is asking. `findById` on someone else's personal contact returns
// null, the same "indistinguishable from absent" answer a cross-tenant read
// gives, for the same reason (§ the header on `findById` above).
//
// ── Tags are a JOIN table, not an array column ──────────────────────────────
//
// A `text[]` column can hold anything a client sends; a join table with a
// CHECK on the tag id can only hold the product's own fixed vocabulary
// (SYSTEM_CONTACT_TAGS in the frontend, mirrored below). Groups are NOT here —
// the product still has no backend concept of a contact group, and this
// migration does not invent one.

import { type Kysely, sql } from "kysely";

const CONTACT_SCOPES = ["personal", "workspace"] as const;

// Mirrors `SYSTEM_CONTACT_TAGS` in models/contacts.ts exactly. A frontend tag
// added without a matching entry here is refused by the CHECK, loudly, rather
// than accepted and silently unrenderable.
const CONTACT_TAG_IDS = [
  "tag-client", "tag-vendor", "tag-internal", "tag-legal", "tag-hr",
  "tag-finance", "tag-approver", "tag-reviewer", "tag-signer", "tag-ack",
  "tag-procurement",
] as const;

const values = (allowed: readonly string[]) => {
  for (const value of allowed) {
    if (!/^[a-z-]+$/u.test(value)) {
      throw new Error(`Refusing to inline an unexpected literal: ${value}`);
    }
  }
  return sql.raw(allowed.map(value => `'${value}'`).join(", "));
};

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("contacts")
    .addColumn("scope", "varchar(20)", col => col.notNull().defaultTo("workspace"))
    .addColumn("owner_user_id", "varchar(64)")
    .addColumn("note", "varchar(2000)")
    .execute();

  await sql`
    alter table contacts
      add constraint chk_contacts_scope check (scope in (${values(CONTACT_SCOPES)}))
  `.execute(db);

  // A personal contact HAS an owner; a workspace contact has none. Not "may
  // have" — the pairing is exact, so a row can never drift into the
  // unowned-personal or owned-workspace states nothing in the product can
  // explain.
  await sql`
    alter table contacts
      add constraint chk_contacts_scope_owner_pairing check (
        (scope = 'personal' and owner_user_id is not null)
        or (scope = 'workspace' and owner_user_id is null)
      )
  `.execute(db);

  // RESTRICT, not CASCADE: a departing member's personal address book is not
  // silently deleted. It becomes an orphaned personal contact — visible to
  // nobody under the rule above, same as an archived one — until an admin
  // decides what to do with it. That is a future action, not this migration's.
  await sql`
    alter table contacts
      add constraint fk_contacts_owner foreign key (owner_user_id)
      references users (user_id) on delete restrict
  `.execute(db);

  // The filter `listContacts` runs for every call: "workspace-scoped rows, or
  // my own personal ones". Composite so that filter is a single index lookup
  // rather than a scan across everyone's personal contacts.
  await db.schema
    .createIndex("idx_contacts_workspace_owner")
    .on("contacts")
    .columns(["workspace_id", "owner_user_id"])
    .execute();

  // ── Tags ───────────────────────────────────────────────────────────────────
  await db.schema
    .createTable("contact_tags")
    .addColumn("workspace_id", "varchar(64)", col => col.notNull())
    .addColumn("contact_id", "varchar(64)", col => col.notNull())
    .addColumn("tag_id", "varchar(32)", col => col.notNull())
    .addColumn("created_at", "timestamptz", col => col.notNull())
    .addPrimaryKeyConstraint("pk_contact_tags", ["contact_id", "tag_id"])
    .addForeignKeyConstraint(
      "fk_contact_tags_contact", ["workspace_id", "contact_id"],
      "contacts", ["workspace_id", "contact_id"],
      // CASCADE: a tag row means nothing once its contact is gone, and
      // contacts have no delete path anyway — this only ever fires if that
      // changes.
      builder => builder.onDelete("cascade"),
    )
    .execute();

  await sql`
    alter table contact_tags
      add constraint chk_contact_tags_tag_id check (tag_id in (${values(CONTACT_TAG_IDS)}))
  `.execute(db);

  await db.schema
    .createIndex("idx_contact_tags_workspace_contact")
    .on("contact_tags")
    .columns(["workspace_id", "contact_id"])
    .execute();

  await sql`grant select, insert, delete on table contact_tags to lagda_app`.execute(db);
  // No UPDATE grant: a tag is present or absent, never edited in place — the
  // repository always adds or removes rows, matching `contacts`' no-DELETE
  // convention in spirit (the smallest grant the actual operations need).

  await sql`alter table contact_tags enable row level security`.execute(db);
  await sql`alter table contact_tags force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on contact_tags
    using (workspace_id = lagda_current_workspace())
    with check (workspace_id = lagda_current_workspace())
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists tenant_isolation on contact_tags`.execute(db);
  await db.schema.dropTable("contact_tags").ifExists().execute();

  await sql`alter table contacts drop constraint if exists fk_contacts_owner`.execute(db);
  await sql`alter table contacts drop constraint if exists chk_contacts_scope_owner_pairing`.execute(db);
  await sql`alter table contacts drop constraint if exists chk_contacts_scope`.execute(db);
  await db.schema.dropIndex("idx_contacts_workspace_owner").ifExists().execute();
  await db.schema
    .alterTable("contacts")
    .dropColumn("note")
    .dropColumn("owner_user_id")
    .dropColumn("scope")
    .execute();
}
