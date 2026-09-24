// 067 — asking a colleague to supply a document.
//
// ── What this is ───────────────────────────────────────────────────────────
//
// The inverse of every other flow in this product. Everywhere else the sender
// already HAS the file and needs signatures on it; here they do not have it
// and are asking someone else to provide it. "Send me your signed contract",
// "upload the permit", "we need the audited statement".
//
// ── Why the assignee is a USER and not a contact ───────────────────────────
//
// `assignee_user_id`, not `assignee_contact_id`, is what the request is
// ADDRESSED to. Uploading writes into a workspace, and workspace writes are
// authorized by membership — so whoever fulfils this must be a member, and a
// member is a user account. A contact is an address-book entry that has
// verified nothing (see migration 015 and `ContactSchema`'s own description);
// addressing a write to one would be addressing it to an unverified string.
//
// `assignee_contact_id` is kept ALONGSIDE it, nullable, purely so the UI can
// say "you picked Maria from Contacts" — it records where the choice came
// from and is never the authority on who may act. The application resolves
// contact -> member at creation time and refuses when no member matches.
//
// A tokenized no-account upload (the signing realm's model: a sealed
// credential, a public endpoint, its own quarantine path) is a deliberate
// non-goal of this migration, not an oversight. It needs a credential realm
// this table would not be the right place to grow.
//
// ── Why no foreign keys ────────────────────────────────────────────────────
//
// None to `users`, matching 019's `created_by_user_id` and 058's
// `created_by`: a request outlives the account that made it. None to
// `documents` either, and that one is a scar rather than a preference —
// 059 added exactly that FK, and 065 had to drop it because RI triggers need
// row-lock privilege on the referenced table, which 003 deliberately revoked
// to keep evidence append-only. The application validates the reference.

import { type Kysely, sql } from "kysely";

const STATUSES = ["pending", "fulfilled", "cancelled"] as const;

/** Literals, not bind parameters: this renders into a CHECK constraint, which
 *  is DDL and cannot carry parameters. Same helper 058 uses. */
function inList(values: readonly string[]) {
  return sql.join(values.map(value => sql.lit(value)));
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("workspace_document_upload_requests")
    .addColumn("request_id", "varchar(64)", col => col.primaryKey())
    // First-class tenant column. Every workspace-owned table carries it.
    .addColumn("workspace_id", "varchar(64)", col => col.notNull())

    // WHAT is being asked for, in the requester's words. Not a document
    // title — the document does not exist yet — but the name of the thing
    // the assignee has to go and find.
    .addColumn("title", "varchar(200)", col => col.notNull())
    // Optional instruction: which year, which format, where to find it.
    .addColumn("note", "text")

    .addColumn("requested_by_user_id", "varchar(64)", col => col.notNull())
    // The member who must upload. See the header for why this is a user.
    .addColumn("assignee_user_id", "varchar(64)", col => col.notNull())
    // Provenance only — which contact the requester picked. Never consulted
    // when deciding whether someone may fulfil the request.
    .addColumn("assignee_contact_id", "varchar(64)")

    .addColumn("status", "varchar(32)", col => col.notNull())
    // Set exactly when the request is fulfilled: the document that answered
    // it. Null in every other state.
    .addColumn("document_id", "varchar(64)")

    .addColumn("created_at", "timestamptz", col => col.notNull())
    .addColumn("updated_at", "timestamptz", col => col.notNull())
    .addColumn("fulfilled_at", "timestamptz")
    .addColumn("cancelled_at", "timestamptz")

    .addCheckConstraint(
      "upload_requests_status_check",
      sql`status in (${inList(STATUSES)})`,
    )
    // A title that is only whitespace is not a title. Trimmed by the
    // application; this refuses the value it would have stored anyway.
    .addCheckConstraint(
      "upload_requests_title_not_blank",
      sql`length(btrim(title)) > 0`,
    )
    .addCheckConstraint(
      "upload_requests_updated_at_not_before_created",
      sql`updated_at >= created_at`,
    )
    // The state machine, as far as SQL can honestly enforce it: a fulfilled
    // request names the document that fulfilled it and when; a request that
    // is NOT fulfilled names neither. Without this a "pending" row could
    // carry a document_id and nothing would notice.
    .addCheckConstraint(
      "upload_requests_fulfilled_shape",
      sql`(status = 'fulfilled') = (document_id is not null and fulfilled_at is not null)`,
    )
    .addCheckConstraint(
      "upload_requests_cancelled_shape",
      sql`(status = 'cancelled') = (cancelled_at is not null)`,
    )
    .execute();

  // The requester's list: this workspace's requests, newest first.
  await db.schema
    .createIndex("idx_upload_requests_workspace_created")
    .on("workspace_document_upload_requests")
    .columns(["workspace_id", "created_at desc"])
    .execute();

  // "What is being asked of ME" — the assignee's own queue, which is the
  // query the notification drives someone to. Status leads the tail because
  // a pending request is the only kind that queue shows.
  await db.schema
    .createIndex("idx_upload_requests_assignee")
    .on("workspace_document_upload_requests")
    .columns(["workspace_id", "assignee_user_id", "status"])
    .execute();

  // ── Row Level Security ────────────────────────────────────────────────────
  //
  // The ordinary tenant pattern — not "the repository remembers to filter",
  // but "the database will not return or accept a row from another tenant,
  // whatever the query says". `force` so it binds the table owner too.
  await sql`
    grant select, insert, update, delete
      on table workspace_document_upload_requests to lagda_app
  `.execute(db);

  await sql`
    alter table workspace_document_upload_requests enable row level security
  `.execute(db);
  await sql`
    alter table workspace_document_upload_requests force row level security
  `.execute(db);
  await sql`
    create policy tenant_isolation on workspace_document_upload_requests
    using (workspace_id = lagda_current_workspace())
    with check (workspace_id = lagda_current_workspace())
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists tenant_isolation on workspace_document_upload_requests`
    .execute(db);
  await db.schema.dropTable("workspace_document_upload_requests").ifExists().execute();
}
