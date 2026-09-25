// 071 — per-user read and dismissed state for the document notification feed.
//
// ── What this closes ────────────────────────────────────────────────────────
//
// #52 built the feed as a VIEW of evidence, and said so: "There is no
// read/unread column behind this: the client tracks that itself, keyed on the
// evidence event id." The client could only keep it for one page load. Every
// reload re-reported the whole feed as unread, and brought back everything
// the reader had dismissed — the bell's badge could rise but never fall. An
// account with three completed documents showed sixteen unread notifications,
// permanently.
//
// The product's notification UI offers four acts: mark read, mark unread,
// dismiss, restore. All four were per-session. This table makes all four
// durable. It is written by the reader, about themselves; it is not evidence
// and must not become any — who looked at a notification is not a fact about
// the document.
//
// ── Keyed on the evidence event, and only a real one ────────────────────────
//
// The feed row's id IS its evidence event id, so a state row is
// (user, event). The foreign key to `evidence_events (workspace_id,
// evidence_event_id)` means a row can only name an event that exists in the
// same workspace, so a client posting invented ids cannot grow this table.
//
// Because the feed shows each document's LATEST event, a new transition on a
// document produces a new id, and that document reads as unread and
// undismissed again. That is intended: something new happened.
//
// ── Tenancy ─────────────────────────────────────────────────────────────────
//
// Workspace-scoped under the same `tenant_isolation` policy as every other
// tenant table. `user_id` is the reader, taken from the session by the use
// case — never from a request body — so one member cannot change, or read,
// another member's state. No DELETE is granted: clearing a state sets its
// timestamp to NULL rather than removing the row.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table document_notification_states (
      workspace_id       varchar(64) not null,
      user_id            varchar(64) not null,
      evidence_event_id  varchar(64) not null,
      -- NULL means "not read" / "not dismissed". Each is independent: a
      -- dismissed notification that is restored keeps whether it was read.
      read_at            timestamptz,
      dismissed_at       timestamptz,
      updated_at         timestamptz not null default now(),

      primary key (workspace_id, user_id, evidence_event_id),

      constraint document_notification_states_user_fk
        foreign key (user_id) references users (user_id) on delete cascade,

      -- Evidence is append-only and never deleted, so no cascade is needed
      -- or wanted: nothing may remove the event a state row points at.
      constraint document_notification_states_event_fk
        foreign key (workspace_id, evidence_event_id)
        references evidence_events (workspace_id, evidence_event_id)
    )
  `.execute(db);

  await sql`
    grant select, insert, update on table document_notification_states to lagda_app
  `.execute(db);
  await sql`alter table document_notification_states enable row level security`.execute(db);
  await sql`alter table document_notification_states force row level security`.execute(db);
  await sql`
    create policy tenant_isolation on document_notification_states
    using (workspace_id = lagda_current_workspace())
    with check (workspace_id = lagda_current_workspace())
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists tenant_isolation on document_notification_states`.execute(db);
  await sql`drop table if exists document_notification_states`.execute(db);
}
