// 005 — durable idempotency.
//
// ── The design decision that shapes everything ─────────────────────────────
//
// The claim row is inserted INSIDE the business transaction (§142). That one
// choice removes three problems that otherwise need machinery:
//
//   Concurrent duplicates   PostgreSQL blocks the second INSERT on the unique
//                           index until the first transaction resolves. No
//                           application-level locking.
//   Rollback               The claim disappears with the failed mutation, so
//                           there is no poisoned key and a retry can execute.
//   Crash mid-operation    The transaction never committed, so no stale
//                           IN_PROGRESS row survives — no lease, no reclaim.
//
// The cost: it only works for mutations contained in one PostgreSQL
// transaction. Operations that call an email provider or seal a PDF need
// staged durable state instead (BACKEND-33/38), and that is recorded rather
// than pretended away.
//
// ── Tenancy: MIXED TYPED SCOPE, no RLS ─────────────────────────────────────
//
// This table serves workspace, user, recipient and system scopes. A
// workspace-only RLS policy would have to treat `workspace_id IS NULL` as
// something, and "unrestricted" is the dangerous answer §54 warns about.
//
// So: no RLS, and every lookup carries the FULL identity (scope type, scope
// key, operation, key digest). The repository has no method that queries by
// key alone.

import { type Kysely, sql } from "kysely";

/**
 * Who a key belongs to.
 *
 * Closed set. A raw idempotency key is NOT globally unique — two unrelated
 * clients can both send `"1"` — so identity must carry the caller.
 */
const SCOPE_TYPES = ["workspace", "user", "recipient", "system"] as const;

/**
 * Only two states, and the second is nearly redundant.
 *
 * With an in-transaction claim, a row is visible to other transactions only
 * once it has committed — by which point the operation has finished. A row
 * that would have been IN_PROGRESS never becomes visible at all.
 *
 * `in-progress` is retained for the future out-of-transaction pattern that
 * long-running operations will need (BACKEND-33/38), so that command does not
 * have to migrate a CHECK constraint under load.
 */
const STATES = ["in-progress", "completed"] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table idempotency_records (
      record_id           varchar(64)  primary key,

      -- Identity. All four parts, always.
      scope_type          varchar(16)  not null,
      -- Derived from the typed scope by the application, never client-supplied.
      scope_key           varchar(128) not null,
      operation           varchar(64)  not null,
      -- SHA-256 of the client key, domain-separated. The raw key is never
      -- stored: it is not needed for lookup, and storing it would keep a
      -- client-supplied string in the database for no purpose.
      key_digest          varchar(64)  not null,

      -- SHA-256 of the CANONICAL logical request. Distinct from key_digest and
      -- from any document hash: reusing a key with different input must fail,
      -- and that requires knowing what the first request was without storing it.
      request_fingerprint varchar(64)  not null,

      state               varchar(16)  not null,

      -- The replayable result. Only ever a small JSON body; a PDF or a stream
      -- belongs in storage with a reference here.
      response_status     integer,
      response_body       jsonb,
      -- Bumped only when the stored SHAPE changes. Records outlive a deploy
      -- inside the retention window, so yesterday's row must stay readable.
      response_version    integer,

      created_at          timestamptz  not null default now(),
      completed_at        timestamptz,
      -- Retention, NOT a processing lease. Different problems (§72).
      expires_at          timestamptz  not null,

      -- THE constraint. Everything else is bookkeeping; this is what makes two
      -- simultaneous requests resolve to one execution.
      constraint idempotency_records_identity
        unique (scope_type, scope_key, operation, key_digest),

      constraint idempotency_records_scope_type_check
        check (scope_type in (${sql.join(SCOPE_TYPES.map(s => sql.lit(s)), sql`, `)})),
      constraint idempotency_records_state_check
        check (state in (${sql.join(STATES.map(s => sql.lit(s)), sql`, `)})),

      -- Tripwires. A raw key or a non-hex value in either digest column means
      -- something upstream is wrong, and failing loudly beats storing it.
      constraint idempotency_records_key_digest_format
        check (key_digest ~ '^[a-f0-9]{64}$'),
      constraint idempotency_records_fingerprint_format
        check (request_fingerprint ~ '^[a-f0-9]{64}$'),

      -- A completed record must actually be replayable. Without this, a bug
      -- could mark a row complete with no stored result, and every retry would
      -- replay nothing.
      constraint idempotency_records_completed_shape check (
        state <> 'completed'
        or (completed_at is not null
            and response_status is not null
            and response_body is not null
            and response_version is not null)
      ),
      -- And an in-progress record must not pretend to have one.
      constraint idempotency_records_in_progress_shape check (
        state <> 'in-progress'
        or (completed_at is null and response_status is null)
      ),

      -- A real HTTP status. Not 999.
      constraint idempotency_records_status_range
        check (response_status is null or (response_status >= 100 and response_status < 600))
    )
  `.execute(db);

  // Cleanup (BACKEND-16). The only query that does not use the identity index.
  await sql`
    create index idempotency_records_expiry_idx on idempotency_records (expires_at)
  `.execute(db);

  // No index on state, fingerprint or scope alone: nothing queries by them, and
  // an index nobody uses is write cost with no read benefit.

  // UPDATE is granted because an expired row is RECLAIMED in place rather than
  // deleted and re-inserted — deletion plus insertion is two statements with a
  // race between them. DELETE is for the cleanup job.
  await sql`
    grant select, insert, update, delete on table idempotency_records to lagda_app
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists idempotency_records`.execute(db);
}
