// Verification challenge supersession.
//
// BACKEND-19 created `email_verification_challenges` with `consumed_at`. This
// adds the second terminal state a challenge needs — SUPERSEDED — and the
// constraint that makes "one active challenge per user" a database fact rather
// than an application hope.
//
// Migration 008 is not edited. Applied migrations are never edited.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── superseded_at ────────────────────────────────────────────────────────
  //
  // A SEPARATE column from `consumed_at`, deliberately. Overloading one
  // timestamp to mean both "the user redeemed this" and "a resend replaced
  // this" would destroy the distinction exactly where it matters: an
  // incident review needs to know whether a code was used or merely rotated.
  await sql`
    alter table email_verification_challenges
      add column superseded_at timestamptz
  `.execute(db);

  // A challenge cannot be both redeemed and rotated. If it ever were, "was this
  // code used?" would have two contradictory answers.
  await sql`
    alter table email_verification_challenges
      add constraint email_verification_single_terminal
      check (consumed_at is null or superseded_at is null)
  `.execute(db);

  // ── One active challenge per user ────────────────────────────────────────
  //
  // A PARTIAL UNIQUE INDEX. This is what makes two concurrent resends unable to
  // leave two live codes: the second insert is rejected by PostgreSQL, not by a
  // check the first one already passed.
  //
  // Expiry is deliberately NOT part of the predicate. `now()` is not immutable,
  // so it cannot appear in an index, and it does not need to: a resend
  // supersedes any prior unconsumed challenge regardless of whether it had
  // already expired, before inserting the replacement. That keeps the rule
  // simple and deterministic - "active" means neither consumed nor superseded,
  // and expiry is derived at read time (§122, §123).
  await sql`
    create unique index email_verification_one_active
      on email_verification_challenges (user_id)
      where consumed_at is null and superseded_at is null
  `.execute(db);

  // Lookup by digest is already unique from 008. This supports finding a user's
  // challenge history, which resend and any future account-security screen need.
  await sql`
    create index email_verification_user_history_idx
      on email_verification_challenges (user_id, created_at desc)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists email_verification_user_history_idx`.execute(db);
  await sql`drop index if exists email_verification_one_active`.execute(db);
  await sql`
    alter table email_verification_challenges
      drop constraint if exists email_verification_single_terminal
  `.execute(db);
  await sql`
    alter table email_verification_challenges drop column if exists superseded_at
  `.execute(db);
}
