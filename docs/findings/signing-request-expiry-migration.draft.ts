// 041 — the `expired` state, and the deadline that produces it.
//
// ── The last value the contract declared and the database refused ──────────
//
// `SIGNING_REQUEST_STATES` has listed `expired` since BACKEND-32 and migration
// 024 refused it on a stated rule: "a CHECK that admits a state no code can
// reach is a permission granted in advance of the thing it permits". Nothing
// could reach it, so nothing could store it.
//
// This migration brings the code. `@lagda/core` already defines the edges --
// `expire` out of `sent` and out of `partially-completed`, and deliberately
// NOT out of `completion-ready`, because a deadline that passes after the last
// signature does not un-sign anything.
//
// ── Opt-in, and an absolute instant ────────────────────────────────────────
//
// `expires_at` is NULLABLE and null means NO DEADLINE. That is the product's
// shape, not an invention: `ExpirationSettings` carries `enabled` alongside an
// optional `expiresAt`, so a transaction without one never expires. There is no
// workspace default and no duration-from-send, because the product stores an
// instant rather than a period and inventing a default would expire requests
// nobody asked to expire.
//
// ── The constraint is NOT biconditional, unlike `sent_at` and `completed_at` ─
//
// Both of those assert the timestamp and the state imply each other. This one
// cannot, and the asymmetry is the point:
//
//   expired  =>  expires_at is not null     ENFORCED. A request cannot claim it
//                                           passed a deadline it never had.
//   expires_at is not null => expired       FALSE, and must be. A deadline in
//                                           the future is the ordinary case for
//                                           a live request.
//
// Writing it biconditionally would make setting a deadline expire the request
// immediately, which is the opposite of what a deadline is.

import { type Kysely, sql } from "kysely";

/** Request states the database admits AFTER this migration. Eight. */
const REQUEST_STATES = [
  "draft",
  "sent",
  "partially-completed",
  "completion-ready",
  "completed",
  "declined",
  "cancelled",
  "expired",
] as const;

/** 028's vocabulary, for `down`. */
const OLD_REQUEST_STATES = [
  "draft",
  "sent",
  "partially-completed",
  "completion-ready",
  "completed",
  "declined",
  "cancelled",
] as const;

const inList = (values: readonly string[]) =>
  sql.raw(values.map(value => `'${value}'`).join(", "));

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table signing_requests
      add column if not exists expires_at timestamptz
  `.execute(db);

  await sql`
    alter table signing_requests
      drop constraint if exists signing_requests_state_check
  `.execute(db);
  await sql`
    alter table signing_requests
      add constraint signing_requests_state_check
      check (state in (${inList(REQUEST_STATES)}))
  `.execute(db);

  // One direction only. See the header for why the converse must be false.
  await sql`
    alter table signing_requests
      drop constraint if exists signing_requests_expired_has_deadline
  `.execute(db);
  await sql`
    alter table signing_requests
      add constraint signing_requests_expired_has_deadline
      check (state <> 'expired' or expires_at is not null)
  `.execute(db);

  // A deadline before the request was created is not a deadline; it is a
  // request that was born expired, which no transition can produce.
  await sql`
    alter table signing_requests
      drop constraint if exists signing_requests_expiry_after_creation
  `.execute(db);
  await sql`
    alter table signing_requests
      add constraint signing_requests_expiry_after_creation
      check (expires_at is null or expires_at > created_at)
  `.execute(db);

  // ── The index the sweep needs, and its shape ──────────────────────────────
  //
  // PARTIAL, on the two states that can expire. The sweep asks "which live
  // requests are past their deadline", and over a table whose rows are mostly
  // finished, a partial index is the difference between reading the deadlines
  // that can still matter and reading every row ever written.
  //
  // Not tenant-scoped: the sweep runs across workspaces by design -- a deadline
  // does not wait for someone to open the workspace.
  await sql`
    create index if not exists signing_requests_due_for_expiry
      on signing_requests (expires_at)
      where expires_at is not null
        and state in ('sent', 'partially-completed')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refuses rather than silently rewriting history: an expired request cannot
  // be narrowed back into the old vocabulary without choosing a state for it,
  // and every choice claims something the request did not do.
  const { rows } = await sql<{ count: string }>`
    select count(*)::text as count from signing_requests where state = 'expired'
  `.execute(db);
  const expired = Number(rows[0]?.count ?? "0");
  if (expired > 0) {
    throw new Error(
      `Refusing to revert 041: ${String(expired)} request(s) are 'expired' and `
      + "the previous vocabulary has no value for them.",
    );
  }

  await sql`drop index if exists signing_requests_due_for_expiry`.execute(db);
  await sql`
    alter table signing_requests
      drop constraint if exists signing_requests_expiry_after_creation
  `.execute(db);
  await sql`
    alter table signing_requests
      drop constraint if exists signing_requests_expired_has_deadline
  `.execute(db);
  await sql`
    alter table signing_requests
      drop constraint if exists signing_requests_state_check
  `.execute(db);
  await sql`
    alter table signing_requests
      add constraint signing_requests_state_check
      check (state in (${inList(OLD_REQUEST_STATES)}))
  `.execute(db);
  await sql`
    alter table signing_requests drop column if exists expires_at
  `.execute(db);
}
