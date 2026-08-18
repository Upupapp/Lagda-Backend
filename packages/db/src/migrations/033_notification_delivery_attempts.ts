// 033 — delivery claiming, and the attempt history behind it.
//
// ── What BACKEND-44 could not build ────────────────────────────────────────
//
// The substrate creates PENDING deliveries and stops. Nothing claims one,
// because claiming without a provider would be a lease held over work that can
// never complete.
//
// BACKEND-45 needs three things before a provider call is safe:
//
//   1. an atomic CLAIM, so at-least-once queue delivery cannot put two workers
//      on one message and send it twice (S66, S128);
//   2. a LEASE, so a worker that dies mid-send does not strand the row in
//      PROCESSING forever (S68);
//   3. an ATTEMPT record, so "this failed four times with a 429" is answerable
//      without a provider's dashboard (S13).
//
// ── Why attempts are a table and not a counter ─────────────────────────────
//
// A counter answers "how many times", which is the least interesting question.
// The operational questions are when, how it failed, and whether the failure
// class changed — a message failing DNS four times is a different incident from
// one rejected once and then rate-limited three times.
//
// It stays deliberately thin. No provider response blob (S17), no rendered body
// (S18), no secret (S19). A raw provider payload is unbounded, vendor-shaped
// and routinely contains the recipient address it failed to reach.
//
// ── What still does not exist ──────────────────────────────────────────────
//
// No provider. This migration adds the machinery a provider adapter plugs into,
// and adds no column naming a vendor (S183 still holds):
// `provider_message_reference` is a neutral string, not `sendgrid_message_id`.

import { type Kysely, sql } from "kysely";

/**
 * How an attempt ended, in LAGDA's vocabulary rather than a vendor's.
 *
 * `AMBIGUOUS` is the one that matters and the one a naive design omits (S50).
 * A connection that drops after the request leaves and before the response
 * arrives leaves LAGDA genuinely unable to say whether the provider accepted
 * the message. Modelling it as a failure invites a retry that duplicates; as a
 * success, a lost security email nobody notices. It is neither, so it is its
 * own class and the policy for it is explicit.
 */
const ATTEMPT_OUTCOMES = [
  "ACCEPTED", "RETRYABLE", "TERMINAL", "AMBIGUOUS",
] as const;

/** Why an attempt failed. Bounded codes; never a provider's response body. */
const ATTEMPT_FAILURE_CODES = [
  "PROVIDER_TIMEOUT", "PROVIDER_RATE_LIMITED", "PROVIDER_UNAVAILABLE",
  "PROVIDER_REJECTED", "DESTINATION_INVALID", "CONFIGURATION_INVALID",
  "CONNECTION_LOST",
] as const;

const inList = (values: readonly string[]) =>
  sql.join(values.map(value => sql.lit(value)), sql`, `);

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── Claiming, on the delivery itself ───────────────────────────────────────
  await sql`
    alter table notification_deliveries
      -- Monotonic per delivery. Not gapless and not global (S20): a gap means a
      -- claim was lost, which is information, and global sequencing would make
      -- every send contend on one counter.
      add column attempt_count integer not null default 0,
      -- When the current claim was taken. Operational, never evidence (S69).
      add column processing_started_at timestamptz,
      -- The lease. A worker that dies leaves this in the past, and the
      -- reclaim query finds it (S68).
      add column claim_expires_at timestamptz,
      -- When this delivery next becomes eligible. Backoff lives here rather
      -- than in the queue so a reconciliation sweep sees the same schedule the
      -- worker does (S107).
      add column next_attempt_at timestamptz,
      -- Provider-neutral, and INTERNAL OPERATIONAL METADATA only (S11).
      -- Never evidence, never a receipt, never shown as proof of delivery.
      add column provider_message_reference varchar(255)
  `.execute(db);

  // A claim is held or it is not: both columns move together, or the row can
  // claim to be leased with no expiry and never be reclaimed.
  await sql`
    alter table notification_deliveries
      add constraint notification_deliveries_claim_pairing check (
        (processing_started_at is null and claim_expires_at is null)
        or (processing_started_at is not null and claim_expires_at is not null)
      )
  `.execute(db);

  // Only a PROCESSING row may hold a claim. Without this a cancelled delivery
  // could carry a live lease and a reclaim sweep would resurrect it.
  await sql`
    alter table notification_deliveries
      add constraint notification_deliveries_claim_requires_processing check (
        claim_expires_at is null or state = 'PROCESSING'
      )
  `.execute(db);

  // How a dispatcher finds eligible work: due, sendable, unclaimed. Partial, so
  // it stays the size of the backlog rather than of history.
  await sql`
    create index notification_deliveries_claimable_idx
      on notification_deliveries (next_attempt_at)
      where state in ('PENDING', 'FAILED_RETRYABLE')
  `.execute(db);

  // How a reclaim sweep finds abandoned leases (S109).
  await sql`
    create index notification_deliveries_expired_claim_idx
      on notification_deliveries (claim_expires_at)
      where state = 'PROCESSING'
  `.execute(db);

  // ── Attempts ───────────────────────────────────────────────────────────────
  await sql`
    create table notification_delivery_attempts (
      notification_delivery_attempt_id varchar(64) primary key,
      notification_delivery_id         varchar(64) not null,

      -- Denormalized so RLS can protect this table without a join, exactly as
      -- the delivery does.
      workspace_id                     varchar(64),
      user_id                          varchar(64),

      attempt_number                   integer     not null,
      started_at                       timestamptz not null,
      -- NULL while in flight. A row with no completion and a stale start is
      -- how an abandoned attempt is recognised.
      completed_at                     timestamptz,

      outcome                          varchar(16),
      failure_code                     varchar(32),
      provider_message_reference       varchar(255),

      constraint notification_delivery_attempts_delivery_fk
        foreign key (notification_delivery_id)
        references notification_deliveries (notification_delivery_id)
        -- RESTRICT, like every other operational-history record. An attempt
        -- without its delivery is a failure nobody can attribute.
        on delete restrict,

      constraint notification_delivery_attempts_scope_check check (
        (workspace_id is not null and user_id is null)
        or (workspace_id is null and user_id is not null)
      ),
      constraint notification_delivery_attempts_number_check
        check (attempt_number >= 1),
      constraint notification_delivery_attempts_outcome_check
        check (outcome is null or outcome in (${inList(ATTEMPT_OUTCOMES)})),
      constraint notification_delivery_attempts_failure_code_check
        check (failure_code is null
          or failure_code in (${inList(ATTEMPT_FAILURE_CODES)})),

      -- An outcome and a completion arrive together. A completed attempt with
      -- no outcome is a row that records nothing.
      constraint notification_delivery_attempts_completion_check check (
        (completed_at is null and outcome is null)
        or (completed_at is not null and outcome is not null)
      ),
      -- A failure code only makes sense on a failure.
      constraint notification_delivery_attempts_failure_pairing check (
        failure_code is null or outcome in ('RETRYABLE', 'TERMINAL', 'AMBIGUOUS')
      ),

      -- One row per attempt number per delivery. A retry that reused a number
      -- would overwrite the history it exists to preserve.
      constraint notification_delivery_attempts_number_key
        unique (notification_delivery_id, attempt_number)
    )
  `.execute(db);

  await sql`
    create index notification_delivery_attempts_delivery_idx
      on notification_delivery_attempts (notification_delivery_id, attempt_number)
  `.execute(db);

  // Attempts take UPDATE: a row is written before the provider call and
  // completed after it. Nothing else about it changes.
  await sql`
    grant select, insert, update, delete
      on table notification_delivery_attempts to lagda_app
  `.execute(db);
  await sql`
    alter table notification_delivery_attempts enable row level security
  `.execute(db);
  await sql`
    alter table notification_delivery_attempts force row level security
  `.execute(db);
  await sql`
    create policy tenant_isolation on notification_delivery_attempts
    using (
      (workspace_id is not null and workspace_id = lagda_current_workspace())
      or (user_id is not null and user_id = lagda_current_user_id())
    )
    with check (
      (workspace_id is not null and workspace_id = lagda_current_workspace())
      or (user_id is not null and user_id = lagda_current_user_id())
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists notification_delivery_attempts`.execute(db);
  await sql`drop index if exists notification_deliveries_expired_claim_idx`.execute(db);
  await sql`drop index if exists notification_deliveries_claimable_idx`.execute(db);
  await sql`
    alter table notification_deliveries
      drop constraint if exists notification_deliveries_claim_requires_processing,
      drop constraint if exists notification_deliveries_claim_pairing,
      drop column if exists provider_message_reference,
      drop column if exists next_attempt_at,
      drop column if exists claim_expires_at,
      drop column if exists processing_started_at,
      drop column if exists attempt_count
  `.execute(db);
}
