// 032 — a real foreign key for the signing-recipient audience.
//
// ── Correcting migration 030 ───────────────────────────────────────────────
//
// 030 shipped `audience_recipient_id` as a bare column with no reference, and
// OD-175 recorded the consequence: retiring `signing_delivery_intents` (031)
// dropped compound foreign keys to the recipient and the grant, and nothing
// replaced them.
//
// The stated reason was wrong. It claimed the recipient's compound primary key
// could not be referenced from one audience column — but
// `signing_request_recipients` carries `unique (workspace_id,
// request_recipient_id)` alongside its single-column primary key, precisely so
// a tenant-scoped child can point at it. So the FK the old table had is
// available here, and the only thing missing was this migration.
//
// ── Why compound rather than the single-column primary key ─────────────────
//
// `foreign key (audience_recipient_id) references signing_request_recipients
// (request_recipient_id)` would compile and would be weaker. It proves the
// recipient exists; it does not prove the recipient belongs to the workspace
// the notification claims. Including `workspace_id` makes a cross-tenant
// audience a constraint violation rather than a code review item — the same
// argument migration 019 makes for field assignment, and the reason Kysely was
// chosen over Prisma in the first place.
//
// ── RESTRICT, not CASCADE ──────────────────────────────────────────────────
//
// Migration 020's delivery intent cascaded with its recipient. This does not.
//
// A notification is a record that LAGDA decided to communicate something, and
// §200 requires that mutable-side deletion cannot destroy queued or historical
// notification records. RESTRICT also restores, indirectly, the protection the
// grant FK used to give: a recipient with an outstanding invitation cannot be
// deleted out from under it, so the credential and the message that carries it
// cannot be separated.
//
// It matches the repository-wide default. Deletion semantics in a legal-
// evidence system are unresolved, and CASCADE answers that question silently
// and destructively.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Partial by nature: `audience_recipient_id` is NULL for USER and
  // WORKSPACE_INVITEE audiences, and a NULL in a foreign key is unconstrained,
  // so no filtered index or trigger is needed to let those rows through.
  await sql`
    alter table notification_intents
      add constraint notification_intents_audience_recipient_fk
      foreign key (workspace_id, audience_recipient_id)
      references signing_request_recipients (workspace_id, request_recipient_id)
      on delete restrict
  `.execute(db);

  // The FK's own lookup index. PostgreSQL indexes the REFERENCED side
  // automatically and the referencing side not at all, so without this every
  // recipient delete scans `notification_intents` to check the constraint.
  await sql`
    create index notification_intents_audience_recipient_idx
      on notification_intents (workspace_id, audience_recipient_id)
      where audience_recipient_id is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists notification_intents_audience_recipient_idx`.execute(db);
  await sql`
    alter table notification_intents
      drop constraint if exists notification_intents_audience_recipient_fk
  `.execute(db);
}
