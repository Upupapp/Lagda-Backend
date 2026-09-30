// 091 — finding people by email, and asking to add them as contacts.
//
// ── Two tables ────────────────────────────────────────────────────────────
//
//   contact_connections         one account asks another to become mutual
//       contacts. pending | accepted | declined | cancelled. On acceptance
//       each side gets a PERSONAL contact for the other, and this row records
//       both contact ids — the only link between an address-book entry and an
//       account, and one both people agreed to.
//   contact_discovery_settings  whether an account may be found by an exact
//       email lookup. No row means yes: the product's default is findable,
//       and the switch in My Settings turns it off.
//
// ── Account-owned, no row-level security, like 050, 072, 084 and 090 ──────
//
// A connection is between two ACCOUNTS; the workspaces are where each side's
// contact lives, not who owns the row. No tenant scope can hold it — the two
// people are usually in different workspaces — so, as with 090, the only
// readers and writers are the two accounts themselves, by their SESSION's
// user id: every statement in the repository names `requester_user_id` or
// `recipient_user_id` in its WHERE, and no route takes a user id from a body.
// The contacts themselves are still written inside each workspace's own
// tenant context, where `tenant_isolation` governs them as always.
//
// ── Declining is quiet ────────────────────────────────────────────────────
//
// A declined request keeps `declined_at`, and for 30 days the requester keeps
// seeing it as "Requested" — the product never tells anyone they were turned
// down. A new request inside that window is recorded already declined, with
// the same `declined_at`, and nobody is notified. The application enforces
// the window; this table only makes it expressible.
//
// ── One pending request per pair ──────────────────────────────────────────
//
// In EITHER direction: if Ana has asked Ben, Ben asking Ana is answered by
// "Ana already asked you". The application checks first and answers 409; the
// partial unique index on the unordered pair is the backstop against a race.
//
// ── No deletes ─────────────────────────────────────────────────────────────
//
// Nothing removes a row: a request ends by changing status, so both people's
// history stays whole. DELETE and TRUNCATE are revoked explicitly (080's
// lesson — an owning lagda_app would otherwise hold them), and the users FKs
// are RESTRICT for 090's reason.
//
// ── Notifications ─────────────────────────────────────────────────────────
//
// Two in-app-only USER notices, scoped to the REQUESTER's workspace (where
// the request was sent from): CONTACT_CONNECTION_REQUESTED to the recipient,
// CONTACT_CONNECTION_ACCEPTED back to the requester. 087's
// `notification_audience_user_read` policy already lets an account read
// USER-audience notices from any workspace. Nothing is ever emailed.

import { type Kysely, sql } from "kysely";

const STATUSES = ["pending", "accepted", "declined", "cancelled"] as const;

const TYPES_BEFORE = [
  "ACCOUNT_EMAIL_VERIFICATION", "PASSWORD_RESET", "WORKSPACE_INVITATION",
  "SIGNING_INVITATION", "SIGNING_COMPLETED", "DOCUMENT_UPLOAD_REQUESTED",
  "FINAL_COPY_AVAILABLE", "WORKSPACE_JOIN_LINK", "WORKSPACE_JOIN_REQUESTED",
  "WORKSPACE_JOIN_DECIDED", "VERIFICATION_ACCESS_CODE",
  "CONTACT_REQUEST_RECEIVED", "CONTACT_REQUEST_EMAILED",
  "CONTACT_REQUEST_COMPLETED", "CONTACT_REQUEST_DECLINED",
  "DOCUMENT_SHARE_RECEIVED", "DOCUMENT_SHARE_ACCEPTED", "DOCUMENT_SHARE_REJECTED",
  "DOCUMENT_ACCESS_REQUESTED", "DOCUMENT_ACCESS_APPROVED", "DOCUMENT_ACCESS_REJECTED",
  "SHARED_DOCUMENT_ACCESS_CODE",
  "WORKSPACE_INVITATION_RECEIVED", "WORKSPACE_INVITATION_DECLINED",
] as const;
const TYPES_AFTER = [
  ...TYPES_BEFORE, "CONTACT_CONNECTION_REQUESTED", "CONTACT_CONNECTION_ACCEPTED",
] as const;
const SOURCES_BEFORE = [
  "SIGNING_ACCESS_GRANT", "SECURITY_CHALLENGE", "WORKSPACE_INVITATION",
  "SIGNING_REQUEST", "DOCUMENT_UPLOAD_REQUEST", "FINAL_COPY_GRANT",
  "WORKSPACE_JOIN_TICKET", "WORKSPACE_JOIN_REQUEST", "VERIFICATION_ACCESS_CHALLENGE",
  "CONTACT_REQUEST", "DOCUMENT_SHARE", "DOCUMENT_ACCESS_REQUEST",
  "WORKSPACE_INVITATION_NOTICE",
] as const;
const SOURCES_AFTER = [...SOURCES_BEFORE, "CONTACT_CONNECTION"] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

async function setVocabularies(db: Kysely<unknown>, after: boolean): Promise<void> {
  await sql`
    alter table notification_intents
      drop constraint if exists notification_intents_type_check,
      drop constraint if exists notification_intents_source_kind_check
  `.execute(db);
  await sql`
    alter table notification_intents
      add constraint notification_intents_type_check
        check (notification_type in (${inList(after ? TYPES_AFTER : TYPES_BEFORE)})),
      add constraint notification_intents_source_kind_check
        check (source_kind in (${inList(after ? SOURCES_AFTER : SOURCES_BEFORE)}))
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table contact_connections (
      connection_id           varchar(64)   primary key,
      requester_user_id       varchar(64)   not null references users (user_id),
      -- Where the request was sent from, and where the requester's contact goes.
      requester_workspace_id  varchar(64)   not null references workspaces (workspace_id),
      -- A snapshot: the recipient is usually not a member of that workspace,
      -- so tenant context would not let them read its name.
      requester_workspace_name varchar(200) not null,
      recipient_user_id       varchar(64)   not null references users (user_id),
      -- Chosen by the recipient when accepting.
      recipient_workspace_id  varchar(64)   references workspaces (workspace_id),
      status                  varchar(16)   not null,
      -- The personal contact each side holds for the other, once accepted.
      requester_contact_id    varchar(64),
      recipient_contact_id    varchar(64),
      created_at              timestamptz   not null,
      updated_at              timestamptz   not null,
      accepted_at             timestamptz,
      -- Kept when a declined request is later cancelled: the quiet window
      -- runs from here whatever happens to the row afterwards.
      declined_at             timestamptz,
      cancelled_at            timestamptz,

      constraint contact_connections_status_check check (status in (${inList(STATUSES)})),
      constraint contact_connections_not_self check (requester_user_id <> recipient_user_id),
      constraint contact_connections_updated_after_created check (updated_at >= created_at),
      constraint contact_connections_accepted_shape check (
        (status = 'accepted') = (accepted_at is not null)
        and (status <> 'accepted' or recipient_workspace_id is not null)
      ),
      constraint contact_connections_declined_shape
        check (status <> 'declined' or declined_at is not null),
      constraint contact_connections_cancelled_shape
        check ((status = 'cancelled') = (cancelled_at is not null))
    )
  `.execute(db);
  await sql`
    create unique index contact_connections_one_pending
      on contact_connections (
        least(requester_user_id, recipient_user_id),
        greatest(requester_user_id, recipient_user_id)
      )
      where status = 'pending'
  `.execute(db);
  await sql`
    create index contact_connections_by_recipient
      on contact_connections (recipient_user_id, status, created_at desc)
  `.execute(db);
  await sql`
    create index contact_connections_by_requester
      on contact_connections (requester_user_id, status, created_at desc)
  `.execute(db);
  // "Which account does this contact stand for?" — read on every contact list.
  await sql`
    create index contact_connections_by_requester_contact
      on contact_connections (requester_workspace_id, requester_contact_id)
      where status = 'accepted'
  `.execute(db);
  await sql`
    create index contact_connections_by_recipient_contact
      on contact_connections (recipient_workspace_id, recipient_contact_id)
      where status = 'accepted'
  `.execute(db);

  await sql`
    create table contact_discovery_settings (
      user_id        varchar(64)  primary key references users (user_id),
      discoverable   boolean      not null,
      updated_at     timestamptz  not null
    )
  `.execute(db);

  for (const table of ["contact_connections", "contact_discovery_settings"]) {
    await sql`grant select, insert, update on table ${sql.table(table)} to lagda_app`.execute(db);
    // Explicit, not implied: an OWNING lagda_app would otherwise hold both.
    await sql`revoke delete, truncate on table ${sql.table(table)} from lagda_app`.execute(db);
  }

  await setVocabularies(db, true);
}

/** Fails, deliberately, while any 091 notice exists. Connections are dropped. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await setVocabularies(db, false);
  await sql`drop table contact_discovery_settings`.execute(db);
  await sql`drop table contact_connections`.execute(db);
}
