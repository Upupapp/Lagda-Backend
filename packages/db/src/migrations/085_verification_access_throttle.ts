// 085 — the Verify Document code-request throttle.
//
// 083 bounded code requests with fixed-window counters (5 per 15 minutes per
// address-on-document, 20 per hour per IP). This adds the controls a fixed
// window cannot express:
//
//   * a 60-second resend cooldown per (verification ID, email);
//   * 10 codes per (verification ID, email) per ROLLING 24 hours;
//   * 30 codes per verification ID per ROLLING hour, across all emails;
//   * a one-hour lockout after 3 consecutive challenges exhausted by wrong
//     guesses for one (verification ID, email).
//
// ── Two tables ────────────────────────────────────────────────────────────
//
//   verification_access_code_requests   one row per ACCEPTED code request —
//       the timestamps a cooldown and a rolling window need. Refused requests
//       are not rows: the cooldown would otherwise never lift under a retry
//       loop, and 083's fixed-window counters already meter refusals.
//   verification_access_pair_states     one row per (verification ID, email):
//       the wrong guesses spent on the current challenge window, the streak of
//       exhausted windows, and the lockout end.
//
// ── Keyed on what was TYPED, never on participation ──────────────────────
//
// A pair is whatever the caller sent, participant or not, real reference or
// not; the throttle never looks at a document. A participant and a stranger
// therefore meet each limit at the same count, and a 429 says no more than a
// 202 does. Both keys are domain-separated SHA-256 digests: an email is
// personal data, and a throttle only ever compares.
//
// ── No RLS, like 006 ──────────────────────────────────────────────────────
//
// There is no workspace to isolate by — a pair may name no document at all —
// and a policy forced to interpret a missing workspace would have to treat it
// as unrestricted. The rows hold digests and timestamps and nothing else.
//
// ── Deletes ───────────────────────────────────────────────────────────────
//
// Rows are abuse counters, not evidence, so the runtime role may DELETE the
// ones past every window (the store purges a bounded batch as it goes).
// TRUNCATE is revoked explicitly: an owning lagda_app would otherwise hold it,
// and wiping every lockout at once is never a runtime operation.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table verification_access_code_requests (
      request_id        bigint       generated always as identity primary key,
      pair_key          varchar(64)  not null,
      verification_key  varchar(64)  not null,
      requested_at      timestamptz  not null,

      constraint verification_access_code_requests_pair_shape
        check (pair_key ~ '^[a-f0-9]{64}$'),
      constraint verification_access_code_requests_verification_shape
        check (verification_key ~ '^[a-f0-9]{64}$')
    )
  `.execute(db);
  await sql`
    create index verification_access_code_requests_pair_idx
      on verification_access_code_requests (pair_key, requested_at)
  `.execute(db);
  await sql`
    create index verification_access_code_requests_verification_idx
      on verification_access_code_requests (verification_key, requested_at)
  `.execute(db);
  await sql`
    create index verification_access_code_requests_age_idx
      on verification_access_code_requests (requested_at)
  `.execute(db);

  await sql`
    create table verification_access_pair_states (
      pair_key          varchar(64)  primary key,
      attempts          integer      not null default 0,
      exhausted_streak  integer      not null default 0,
      locked_until      timestamptz,
      updated_at        timestamptz  not null,

      constraint verification_access_pair_states_pair_shape
        check (pair_key ~ '^[a-f0-9]{64}$'),
      constraint verification_access_pair_states_attempts_check
        check (attempts >= 0 and attempts <= 5),
      constraint verification_access_pair_states_streak_check
        check (exhausted_streak >= 0)
    )
  `.execute(db);
  await sql`
    create index verification_access_pair_states_age_idx
      on verification_access_pair_states (updated_at)
  `.execute(db);

  for (const table of ["verification_access_code_requests", "verification_access_pair_states"]) {
    await sql`grant select, insert, update, delete on table ${sql.table(table)} to lagda_app`.execute(db);
    await sql`revoke truncate on table ${sql.table(table)} from lagda_app`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists verification_access_pair_states`.execute(db);
  await sql`drop table if exists verification_access_code_requests`.execute(db);
}
