// 036 — the invitation token, recoverable while the invitation is open.
//
// The same move migration 035 made for password reset, against the table with
// the richest lifecycle in the schema (OD-184).
//
// An invitation email must contain the raw token. The flow persists a digest
// and drops the raw value, so by the time the delivery worker renders the
// message the value it needs exists nowhere.
//
// ── Why here rather than on the notification ───────────────────────────────
//
// `notification_intents` is immutable (INV-647). A ciphertext written there
// could never be cleared, so an invitation token would remain openable long
// after the invitation was accepted, revoked or declined.
//
// This table already tracks all four ways an invitation stops being live —
// `accepted_at`, `revoked_at`, `declined_at`, `superseded_at` — plus
// `expires_at`. Putting the sealed value beside them bounds its life to the
// invitation's own life by construction.
//
// ── Why the terminal check lists four columns and reset listed two ─────────
//
// Because an invitation has four ways to end and a reset challenge has two.
// The constraint enumerates them rather than deriving them, so adding a fifth
// terminal state fails this constraint loudly instead of silently leaving a
// live credential behind it.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table workspace_invitations
      add column sealed_secret      text,
      add column sealed_key_version varchar(32)
  `.execute(db);

  await sql`
    alter table workspace_invitations
      add constraint workspace_invitation_sealed_pairing check (
        (sealed_secret is null and sealed_key_version is null)
        or (sealed_secret is not null and sealed_key_version is not null)
      )
  `.execute(db);

  await sql`
    alter table workspace_invitations
      add constraint workspace_invitation_sealed_only_while_open check (
        sealed_secret is null
        or (accepted_at is null and revoked_at is null
            and declined_at is null and superseded_at is null)
      )
  `.execute(db);

  // Drives the expiry scrub. Expiry is the one ending that performs no write of
  // its own, so without this an invitation nobody answered would keep an
  // openable token indefinitely. Partial, and empty in a healthy system.
  await sql`
    create index workspace_invitation_sealed_expired_idx
      on workspace_invitations (expires_at)
      where sealed_secret is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists workspace_invitation_sealed_expired_idx`.execute(db);
  await sql`
    alter table workspace_invitations
      drop constraint if exists workspace_invitation_sealed_only_while_open,
      drop constraint if exists workspace_invitation_sealed_pairing,
      drop column if exists sealed_key_version,
      drop column if exists sealed_secret
  `.execute(db);
}
