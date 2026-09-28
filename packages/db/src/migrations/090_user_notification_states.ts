// 090 — per-account read and dismissed state for the PERSONAL feed.
//
// ── What this closes ────────────────────────────────────────────────────────
//
// `GET /me/notifications` (030, widened by 087 and 089) returns the notices
// addressed to this account: a contact request, a shared document, an
// invitation received or declined. It had no read state at all. The client
// kept "read" and "dismissed" for one page load, so a declined invitation sat
// in "Needs attention" forever and every reload re-counted the whole feed as
// unread. 071 solved exactly this for the document feed; this is the same
// four acts (mark read, mark unread, dismiss, restore) for the personal one.
//
// ── Keyed on the intent, and only on one addressed to this account ─────────
//
// A feed row's id IS its `notification_intent_id`, so a state row is
// (user, intent). The repository writes with INSERT ... SELECT FROM
// notification_intents, filtered by `audience_kind = 'USER'` and
// `audience_user_id = :user` inside the account's own realm (087's
// `notification_audience_user_read` policy). A row can therefore only name a
// notice this account can already read, and a client posting invented or
// foreign ids writes nothing.
//
// ── Deliberately NO foreign key to notification_intents ─────────────────────
//
// The same reasoning as 071's for evidence. An FK check takes a FOR KEY SHARE
// row lock on the intent, and in production `lagda_app` owns
// `notification_intents` under FORCE row-level security with policies scoped
// by workspace and by audience. Whether that lock is permitted is a question
// about grants and policies nobody should have to re-answer every time the
// intent table's privileges change; the INSERT ... SELECT above validates
// without it, and without a lock. `truncateAll` clears this table with the
// intents rather than leaving rows pointing at nothing.
//
// ── Account-owned, no row-level security, like 050, 072 and 084 ─────────────
//
// The only reader and writer is the account itself, by its SESSION's user id:
// `/me/notifications/state` has no `:userId`, and every statement here names
// `user_id` in its WHERE. The feed read joins this table inside the account's
// `lagda.user_id` realm, where a workspace-tenant policy would match nothing.
//
// ── No deletes ─────────────────────────────────────────────────────────────
//
// `lagda_app` may OWN this table in production (075's header), and an owner
// holds every privilege by default. Clearing a state sets its timestamp back
// to NULL; nothing removes a row, so DELETE and TRUNCATE are revoked
// explicitly. The users FK is RESTRICT rather than CASCADE for the same
// reason as 084's: a cascade would need exactly the DELETE this revokes.
//
// No backfill: every existing notice is unread and undismissed, which is what
// an absent row already means.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table user_notification_states (
      user_id                 varchar(64)  not null references users (user_id),
      notification_intent_id  varchar(64)  not null,
      -- NULL means "not read" / "not dismissed". Independent: restoring a
      -- dismissed notice keeps whether it was read.
      read_at                 timestamptz,
      dismissed_at            timestamptz,
      updated_at              timestamptz  not null default now(),

      primary key (user_id, notification_intent_id)
      -- No FK to notification_intents — see the header.
    )
  `.execute(db);

  await sql`
    grant select, insert, update on table user_notification_states to lagda_app
  `.execute(db);
  // Explicit, not implied: an OWNING lagda_app would otherwise hold both.
  await sql`
    revoke delete, truncate on table user_notification_states from lagda_app
  `.execute(db);
}

/** Drops the table and every state in it. Read state is not evidence. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists user_notification_states`.execute(db);
}
