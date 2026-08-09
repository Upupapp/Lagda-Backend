// 006 — durable abuse counters.
//
// ── Counters, not a request log ────────────────────────────────────────────
//
// One row per (policy, scope, window), incremented in place. NOT a row per
// request: a request log would grow without bound, make the limiter itself the
// most expensive thing on the request path, and duplicate what observability
// already does.
//
// ── Why PostgreSQL rather than process memory ──────────────────────────────
//
// A counter in one Node process is wrong the moment a second instance exists —
// five sign-in attempts per minute becomes five per instance per minute. For a
// brute-force control that is not a rounding error, it is the control failing.
//
// ── Fixed window ───────────────────────────────────────────────────────────
//
// The window start is derived deterministically from the timestamp, so the
// counter identity is computable without reading anything first. A sliding
// window needs per-request timestamps — which is the request log this design
// deliberately avoids — and a token bucket needs read-modify-write on a
// balance. Fixed windows permit a burst across a boundary; for thresholds of
// 5 and 20 that is an acceptable trade, and it is stated rather than hidden.

import { type Kysely, sql } from "kysely";

/**
 * What a counter is keyed by.
 *
 * `ip` and `account` are DIGESTED before storage — an IP address and an email
 * are personal data, and a counter table has no need to hold them in a
 * reversible form. `user` and `workspace` stay semantic: they are already
 * operational identifiers elsewhere, and hashing them would make an
 * investigation impossible for no privacy gain.
 */
const SCOPE_TYPES = ["ip", "user", "workspace", "account", "recipient", "challenge"] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table rate_limit_counters (
      -- Code-defined and bounded, e.g. auth.signin.ip. Never a route string:
      -- routes get renamed, and a renamed route would silently reset a limit.
      policy        varchar(64)  not null,
      scope_type    varchar(16)  not null,
      -- A digest for ip/account/challenge; the plain ID for user/workspace.
      scope_key     varchar(128) not null,
      -- Derived deterministically from the request time and the window length,
      -- so the identity is computable without a prior read.
      window_start  timestamptz  not null,

      count         integer      not null default 0,
      updated_at    timestamptz  not null default now(),
      expires_at    timestamptz  not null,

      -- THE constraint. It is what makes the atomic upsert atomic, and what
      -- makes two API instances share one count.
      primary key (policy, scope_type, scope_key, window_start),

      constraint rate_limit_counters_scope_type_check
        check (scope_type in (${sql.join(SCOPE_TYPES.map(s => sql.lit(s)), sql`, `)})),
      -- A negative count would mean the increment logic is broken; better to
      -- fail than to silently grant unlimited attempts.
      constraint rate_limit_counters_count_check check (count >= 0)
    )
  `.execute(db);

  // Cleanup only. Lookups use the primary key, which is why there is no other
  // index — an index nobody reads is write cost on the hottest security path.
  await sql`
    create index rate_limit_counters_expiry_idx on rate_limit_counters (expires_at)
  `.execute(db);

  // No RLS. Counters span IP, account and challenge scopes that have no
  // workspace at all, and a policy forced to interpret a missing workspace
  // would have to treat it as unrestricted — the dangerous answer. Safety comes
  // from the primary key carrying the full identity, exactly as for idempotency.
  await sql`
    grant select, insert, update, delete on table rate_limit_counters to lagda_app
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists rate_limit_counters`.execute(db);
}
