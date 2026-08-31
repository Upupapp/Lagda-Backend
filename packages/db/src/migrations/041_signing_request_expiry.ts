// 041 — the `expired` state, the deadline that produces it, and the index a
// sweep can find it through.
//
// ── The last value the contract declared and the database refused ──────────
//
// `SIGNING_REQUEST_STATES` has listed `expired` since BACKEND-32 and migration
// 024 refused it on a stated rule: "a CHECK that admits a state no code can
// reach is a permission granted in advance of the thing it permits". Nothing
// could reach it, so nothing could store it. This migration brings the code.
//
// `@lagda/core` already defines the edges -- `expire` out of `sent` and out of
// `partially-completed`, and deliberately NOT out of `completion-ready`,
// because a deadline that passes after the last signature does not un-sign
// anything.
//
// ── Opt-in, and an absolute instant ────────────────────────────────────────
//
// `expires_at` is NULLABLE and null means NO DEADLINE. That is the product's
// shape rather than an invention: `ExpirationSettings` carries `enabled`
// alongside an optional `expiresAt`, so a transaction without one never
// expires. There is no workspace default and no duration-from-send, because
// the product stores an instant rather than a period and inventing a default
// would expire requests nobody asked to expire.
//
// ── The constraint is NOT biconditional, unlike `sent_at` and `completed_at` ─
//
//   expired  =>  expires_at is not null     ENFORCED. A request cannot claim it
//                                           passed a deadline it never had.
//   expires_at is not null => expired       FALSE, and must be. A deadline in
//                                           the future is the ordinary case for
//                                           a live request.
//
// Writing it biconditionally would make setting a deadline expire the request
// immediately, which is the opposite of what a deadline is.
//
// ── The THIRD unpoliced index, added deliberately ──────────────────────────
//
// A deadline passes with nobody watching, so something must sweep -- and the
// sweep cannot read `signing_requests`. `tenant_isolation` is `workspace_id =
// lagda_current_workspace()`, and a global transaction sets no such context, so
// a cross-tenant scan returns zero rows BY DESIGN. `workspaces` is policed too,
// so tenants cannot even be enumerated and visited one at a time.
//
// `signing_workflow_advance_intents` and `notification_dispatch_index` solved
// the same problem the same way, and `GlobalUnitOfWork` called them "one of TWO
// exceptions". This is the third, built to the identical shape and for the
// identical reason: unpoliced because a cross-tenant scan of a policied table
// would need BYPASSRLS (rejected as INV-334), and IDENTIFIERS ONLY, so nothing
// reachable without a tenant can read a title, a name or a field value.
//
// Maintained by a TRIGGER, following 034. An index the application has to
// remember to write is an index that is correct until the fifth caller forgets;
// a trigger cannot forget. It is not SECURITY DEFINER, for 034's reason: an
// elevated function the tenancy story depends on would be a way around it.

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

/**
 * The states a deadline can still act on.
 *
 * Read by the trigger and by the sweep's index predicate, so the two cannot
 * disagree about what "still expirable" means.
 */
const EXPIRABLE_STATES = ["sent", "partially-completed"] as const;

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

  // ── The index ─────────────────────────────────────────────────────────────
  //
  // Three columns and nothing else. The column list IS the control here, in
  // place of a policy, and it is reviewable by reading it: a workspace to enter,
  // a request to act on, and the instant that decides whether to.
  await sql`
    create table signing_request_expiry_index (
      signing_request_id varchar(64) primary key,
      workspace_id       varchar(64) not null,
      expires_at         timestamptz not null
    )
  `.execute(db);

  // Rows leave with the request they describe. A stranded index row would send
  // the sweep into a workspace to act on something that no longer exists.
  await sql`
    alter table signing_request_expiry_index
      add constraint signing_request_expiry_index_request_fk
      foreign key (signing_request_id) references signing_requests (signing_request_id)
      on delete cascade
  `.execute(db);

  // The sweep's only query: "what is due". Ordered by the deadline so the
  // oldest overdue request is handled first.
  await sql`
    create index signing_request_expiry_index_due
      on signing_request_expiry_index (expires_at)
  `.execute(db);

  // ── The synchroniser ──────────────────────────────────────────────────────
  //
  // A row exists exactly while the request has a deadline AND is still in a
  // state a deadline can act on. Everything else deletes: a request that was
  // sent, given a deadline, then cancelled has no business being swept, and
  // leaving the row would make the sweep enter a workspace to do nothing.
  await sql`
    create or replace function lagda_sync_signing_request_expiry_index()
      returns trigger
      language plpgsql
    as $$
    begin
      if new.expires_at is not null
         and new.state in (${inList(EXPIRABLE_STATES)}) then
        insert into signing_request_expiry_index (
          signing_request_id, workspace_id, expires_at
        ) values (
          new.signing_request_id, new.workspace_id, new.expires_at
        )
        on conflict (signing_request_id) do update set
          expires_at = excluded.expires_at;
      else
        delete from signing_request_expiry_index
          where signing_request_id = new.signing_request_id;
      end if;
      return new;
    end
    $$;
  `.execute(db);

  await sql`
    create trigger signing_request_expiry_index_sync
      after insert or update on signing_requests
      for each row
      execute function lagda_sync_signing_request_expiry_index()
  `.execute(db);

  // No backfill. Nothing can have a deadline yet -- the column arrives in this
  // same migration -- so there is nothing to catch up, and a backfill statement
  // that can only ever match zero rows is a claim that something might exist.

  await sql`
    grant select, insert, update, delete
      on table signing_request_expiry_index to lagda_app
  `.execute(db);

  // ── No row level security, deliberately ───────────────────────────────────
  //
  // Stated as an explicit absence rather than left to be noticed, exactly as
  // 034 states it. `signing_requests` itself enables and FORCEs RLS; this table
  // must not, because a cross-tenant scan of a policied table would need
  // BYPASSRLS. The control is the three-column list above.
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

  await sql`
    drop trigger if exists signing_request_expiry_index_sync on signing_requests
  `.execute(db);
  await sql`
    drop function if exists lagda_sync_signing_request_expiry_index()
  `.execute(db);
  await sql`drop table if exists signing_request_expiry_index`.execute(db);

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
