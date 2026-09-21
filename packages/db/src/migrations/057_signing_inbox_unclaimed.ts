// 057 — "Documents I must sign" for accounts that did not exist yet.
//
// 056 opened an entry only when the invited address already belonged to a
// VERIFIED account. Someone invited first and signed up (or verified) later
// never saw that document in the app, and there was no way to add it
// afterwards: the invitation lives in the sender's workspace, and forced RLS
// -- with a single runtime role that cannot bypass it -- means no query,
// function or migration can read it from anywhere else. That is the design
// working, not a gap to route around.
//
// So the entry is now written for EVERY invited address, at invitation time,
// in the sender's own transaction, with `user_id` left NULL when no verified
// account holds the address yet. When an account with that verified address
// opens its list, it CLAIMS its unclaimed entries by address. The only rows it
// can ever reach are ones addressed to the address it has proved it owns.
//
// ── What an unclaimed row is ──────────────────────────────────────────────
//
// Exactly what the invitation email already says to that inbox: a document
// title, who sent it, from which organisation, and until when. The rule in
// 056 is unchanged -- read only by the verified owner of the address, never by
// a workspace, and `workspace_id` is never a filter.

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table user_signing_inbox alter column user_id drop not null`.execute(db);

  // The claim: "open entries sent to my address that nobody owns yet".
  await sql`
    create index user_signing_inbox_unclaimed_by_address
      on user_signing_inbox (recipient_normalized_email)
      where user_id is null and closed_at is null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists user_signing_inbox_unclaimed_by_address`.execute(db);
  await sql`delete from user_signing_inbox where user_id is null`.execute(db);
  await sql`alter table user_signing_inbox alter column user_id set not null`.execute(db);
}
