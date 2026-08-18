// 034 — the dispatch index: how a process with no tenant finds work.
//
// ── The problem this closes (OD-174, S36) ──────────────────────────────────
//
// Three callers must find deliveries across every tenant, and none of them has
// one:
//
//   the DISPATCHER      which deliveries are due?
//   the RECLAIM SWEEP   which leases expired?
//   the WEBHOOK         which delivery does this provider reference name?
//
// Under `tenant_isolation` a connection with no context sees nothing, which is
// the fail-closed behaviour the whole tenancy model is built on. `runGlobal`
// does not solve it: carrying no tenant context and no tenant repositories is
// what `runGlobal` MEANS, not a gap in it.
//
// ── Why a table rather than a policy arm or BYPASSRLS ──────────────────────
//
// Four options were set out in `db/SYSTEM_CONTEXT_OPTIONS.md`. This is the one
// LAGDA has already built twice: `idempotency_records` and
// `signing_workflow_advance_intents` are both unpoliced tables of identifiers,
// read globally, with the safety argument resting on their CONTENTS rather
// than on a predicate.
//
// The alternatives each move the boundary somewhere worse. A third policy arm
// needs a WITH CHECK arm too — or the dispatcher reads and cannot update — and
// a WITH CHECK that accepts any tenant is a policy under which a bug writes
// into the wrong one. A BYPASSRLS role contradicts INV-334, reaffirmed four
// times, and moves the boundary from a policy a reviewer can read to a
// connection string they cannot. Per-tenant fan-out cannot even start:
// `workspaces` is itself under `tenant_isolation`.
//
// ── The safety argument, which is the CONTENT ──────────────────────────────
//
// Opaque server-generated identifiers, a bounded state vocabulary, and three
// timestamps. No destination, no subject, no body, no template input, no
// failure reason, no credential. A reader of every row learns that some
// delivery is due and nothing whatever about anybody.
//
// `failure_code` is deliberately ABSENT even though it is bounded today. It is
// the one field that would grow toward a provider's own vocabulary, and this
// table stops being safe the moment something unbounded lands in it.
//
// ── Why a trigger maintains it ─────────────────────────────────────────────
//
// The index is DERIVED. `notification_deliveries` is authoritative, and the
// invariant "the index mirrors the delivery" is a database-level statement
// about two tables — the same category as the lease-pairing CHECK constraints
// beside it, and maintained in the same place.
//
// The alternative is four repository call sites that must each remember, in two
// files, one of which is edited every time transport gains a state. A rule
// enforced by four rememberings is a rule that lasts until the fifth.
//
// This is NOT the objection raised against invisible RLS policies. A policy
// silently changes what a query returns; a trigger maintains a derived row and
// changes no result anyone reads. It is also not SECURITY DEFINER, for the same
// reason `lagda_current_workspace()` is not: an elevated function that other
// controls depend on is a way around them.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table notification_dispatch_index (
      notification_delivery_id   varchar(64) primary key,

      -- Exactly one, mirroring the delivery's own scope check. This is the
      -- whole point of the table: it is the map from a delivery a background
      -- process knows by id to the transaction scope it must be touched in.
      workspace_id               varchar(64),
      user_id                    varchar(64),

      -- Bounded vocabulary, mirrored. Not re-declared as a CHECK: the
      -- authoritative constraint is on notification_deliveries, and a second
      -- copy here would be a second thing to widen whenever the first moves.
      state                      varchar(32) not null,

      next_attempt_at            timestamptz,
      claim_expires_at           timestamptz,

      -- How the webhook resolves a provider callback to a scope. Neutral, not
      -- vendor-named (S183), and operational metadata rather than evidence
      -- (S11).
      provider_message_reference varchar(255),

      constraint notification_dispatch_index_scope_check check (
        (workspace_id is not null and user_id is null)
        or (workspace_id is null and user_id is not null)
      ),

      -- CASCADE, unlike every other notification FK. The index is derived, so
      -- it must not be the reason a delivery cannot be removed — RESTRICT here
      -- would make a bookkeeping row outrank the record it describes.
      --
      -- Referential integrity checks bypass row security in PostgreSQL, so this
      -- constraint holds from an unscoped connection exactly as it does from a
      -- tenant one.
      constraint notification_dispatch_index_delivery_fk
        foreign key (notification_delivery_id)
        references notification_deliveries (notification_delivery_id)
        on delete cascade
    )
  `.execute(db);

  // How the dispatcher finds work: due, sendable, across every tenant. Partial,
  // so it stays the size of the backlog rather than of history.
  await sql`
    create index notification_dispatch_due_idx
      on notification_dispatch_index (next_attempt_at)
      where state in ('PENDING', 'FAILED_RETRYABLE')
  `.execute(db);

  // How the reclaim sweep finds abandoned leases (S109).
  await sql`
    create index notification_dispatch_expired_claim_idx
      on notification_dispatch_index (claim_expires_at)
      where state = 'PROCESSING'
  `.execute(db);

  // S181. UNIQUE, not merely indexed: a provider message reference identifies
  // one message, and two deliveries claiming the same one is a defect that
  // should stop a transaction rather than make a webhook pick arbitrarily.
  await sql`
    create unique index notification_dispatch_provider_reference_idx
      on notification_dispatch_index (provider_message_reference)
      where provider_message_reference is not null
  `.execute(db);

  // ── The synchroniser ───────────────────────────────────────────────────────
  //
  // Not SECURITY DEFINER. The index carries no policy and `lagda_app` holds
  // ordinary grants on it, so no elevation is needed — and an elevated function
  // that the tenancy story depends on would be a way around it.
  //
  // `on conflict do update` rather than separate INSERT and UPDATE branches:
  // the trigger fires on both, and one idempotent upsert cannot drift from
  // itself the way two branches can.
  await sql`
    create or replace function lagda_sync_notification_dispatch_index()
      returns trigger
      language plpgsql
    as $$
    begin
      insert into notification_dispatch_index (
        notification_delivery_id, workspace_id, user_id,
        state, next_attempt_at, claim_expires_at, provider_message_reference
      ) values (
        new.notification_delivery_id, new.workspace_id, new.user_id,
        new.state, new.next_attempt_at, new.claim_expires_at,
        new.provider_message_reference
      )
      on conflict (notification_delivery_id) do update set
        state                      = excluded.state,
        next_attempt_at            = excluded.next_attempt_at,
        claim_expires_at           = excluded.claim_expires_at,
        provider_message_reference = excluded.provider_message_reference;
      return new;
    end
    $$;
  `.execute(db);

  // DELETE is handled by the cascade above rather than by a third branch here.
  await sql`
    create trigger notification_dispatch_index_sync
      after insert or update on notification_deliveries
      for each row
      execute function lagda_sync_notification_dispatch_index()
  `.execute(db);

  // Backfill. Deliveries created before this migration have no index row, and a
  // dispatcher that silently skipped them would strand exactly the work this
  // table exists to find.
  await sql`
    insert into notification_dispatch_index (
      notification_delivery_id, workspace_id, user_id,
      state, next_attempt_at, claim_expires_at, provider_message_reference
    )
    select
      notification_delivery_id, workspace_id, user_id,
      state, next_attempt_at, claim_expires_at, provider_message_reference
    from notification_deliveries
    on conflict (notification_delivery_id) do nothing
  `.execute(db);

  await sql`
    grant select, insert, update, delete
      on table notification_dispatch_index to lagda_app
  `.execute(db);

  // ── No row level security, deliberately ────────────────────────────────────
  //
  // Stated as an explicit absence rather than left to be noticed. Every other
  // notification table enables and FORCEs RLS; this one must not, because a
  // cross-tenant scan of a policied table would need BYPASSRLS — rejected as
  // INV-334. The control here is the column list above, and it is reviewable by
  // reading it.
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop trigger if exists notification_dispatch_index_sync
      on notification_deliveries
  `.execute(db);
  await sql`
    drop function if exists lagda_sync_notification_dispatch_index()
  `.execute(db);
  await sql`drop table if exists notification_dispatch_index`.execute(db);
}
