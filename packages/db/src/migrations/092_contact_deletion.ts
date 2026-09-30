// 092 — permanently deleting an ARCHIVED contact.
//
// ── Why a contact may now be deleted ──────────────────────────────────────
//
// BACKEND-28 granted no DELETE on `contacts`: archive and restore were the
// whole lifecycle. The product now wants a contact to be removable for good —
// it is an address-book entry, and the person can always be found or added
// again. Only an archived contact can go (the application refuses anything
// else), so deleting is always two deliberate steps.
//
// ── What a delete leaves standing ─────────────────────────────────────────
//
// Nothing that happened is lost. Every table that names a contact also
// SNAPSHOTS what it needed from it:
//
//   preparation_recipients.source_contact_id   already ON DELETE SET NULL
//       (source_contact_id) since 018, written for exactly this day.
//   contact_tags                               ON DELETE CASCADE since 074:
//       a tag means nothing without its contact.
//   contact_requests.contact_id                RESTRICT until now. A request
//       keeps `recipient_name` / `recipient_email`, so this migration makes
//       the column nullable and the key SET NULL (contact_id) — the column
//       list is load-bearing (018's header): a bare SET NULL on the composite
//       key would null `workspace_id` too, which is NOT NULL.
//   document_upload_requests.assignee_contact_id   no foreign key (067).
//   contact_connections (091)                  ids only, no foreign key: a
//       deleted contact simply stops matching, which ends that side of the
//       connection and leaves the other person's contact alone.
//
// ── Grants ────────────────────────────────────────────────────────────────
//
// DELETE on `contacts` for `lagda_app`. `tenant_isolation` governs it like
// every other statement on the table, and the repository's DELETE is
// conditional on the row being archived. `contact_tags` already has DELETE.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table contact_requests
      alter column contact_id drop not null,
      drop constraint contact_requests_contact_fk,
      add constraint contact_requests_contact_fk
        foreign key (workspace_id, contact_id) references contacts (workspace_id, contact_id)
        on delete set null (contact_id)
  `.execute(db);
  await sql`grant delete on table contacts to lagda_app`.execute(db);
}

/** Fails, deliberately, while any request has outlived its contact. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`revoke delete on table contacts from lagda_app`.execute(db);
  await sql`
    alter table contact_requests
      drop constraint contact_requests_contact_fk,
      add constraint contact_requests_contact_fk
        foreign key (workspace_id, contact_id) references contacts (workspace_id, contact_id),
      alter column contact_id set not null
  `.execute(db);
}
