// 055 — "Signed by me": the documents an account has signed.
//
// ══════════════════════════════════════════════════════════════════════════
//  THE RULE THIS TABLE MUST NOT OUTLIVE
// ══════════════════════════════════════════════════════════════════════════
//
//  `user_signed_documents` is WRITTEN ONCE, AT SUBMISSION, and READ ONLY BY
//  ITS OWNER. It must never become a join key for a workspace list, a sender
//  dashboard, a report or a notification.
//
//  It is the answer to the question migration 051 refused to answer for free:
//  "show me what I signed". 051 said that feature must arrive with its own
//  authorization story rather than as a consequence of a provenance table.
//  This is that story:
//
//    WHO MAY WRITE   the submission itself, in the SAME transaction that
//                    accepts the signature, and only when the recipient was
//                    bound to an account (a `signing_account_links` row
//                    exists for them). A signature and the record that says
//                    this account made it commit together or not at all.
//
//    WHO MAY READ    the account in `user_id`, through a query that takes the
//                    authenticated user id and nothing else. There is no
//                    by-workspace read, no by-request read and no index that
//                    would serve one.
//
//  `workspace_id` is stored FOR REFERENCE ONLY — so a row can say where the
//  document lives — and must never appear in a WHERE clause. A workspace
//  reading this table by its own id would be reading which of its outside
//  signers hold LAGDA accounts, which is exactly the cross-realm read 051 was
//  written to prevent.
//
// ── Snapshots, not references ─────────────────────────────────────────────
//
// The title, the sender and the workspace name are copied as they stood when
// the document was signed. A sender who renames the document, changes their
// display name or leaves the workspace must not change what an account holder
// sees about what they put their name to. There is deliberately no foreign
// key to the request: it lives in another tenant's RLS scope, and this row
// must stand on its own.
//
// ── Append-only ───────────────────────────────────────────────────────────
//
// SELECT and INSERT only. A record that someone signed is not edited; it is
// the same posture the evidence tables take.

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table user_signed_documents (
      user_id               varchar(64)  not null
        references users (user_id) on delete cascade,

      signing_request_id    varchar(64)  not null,
      request_recipient_id  varchar(64)  not null,

      -- FOR REFERENCE ONLY. Never a filter. See the rule above.
      workspace_id          varchar(64)  not null,

      -- As it was when signed.
      document_title        varchar(500) not null,
      -- Who sent it: the request's creator, as they stood when this was
      -- signed. Null only when that account no longer existed by then.
      sender_name           varchar(200),
      sender_email          varchar(254),
      workspace_name        varchar(200),

      signed_at             timestamptz  not null,
      recorded_at           timestamptz  not null,

      -- One record per recipient of a request. A recipient signs once
      -- (recipient_submissions_one_per_recipient), so a second row would be
      -- a second claim about the same act.
      constraint user_signed_documents_pkey
        primary key (signing_request_id, request_recipient_id)
    )
  `.execute(db);

  // The ONLY supported read: one account's own history, newest first.
  await sql`
    create index user_signed_documents_by_owner
      on user_signed_documents (user_id, signed_at desc)
  `.execute(db);

  await sql`
    grant select, insert on table user_signed_documents to lagda_app
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists user_signed_documents`.execute(db);
}
