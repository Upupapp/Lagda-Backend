// 047 — the cross-tenant index that makes a parked completion run eligible
// again.
//
// ── The gap this closes ─────────────────────────────────────────────────────
//
// A completion run that fails retryably lands in `waiting-retry` and stays
// there forever. Nothing re-enqueues `completion.process` for it:
//
//   * `abandonStaleRuns` only touches `state = 'processing'` — it MOVES a
//     dead worker's run INTO `waiting-retry`, it does not drive one out.
//   * `listReadyWithoutRun` only finds `completion-ready` requests with NO
//     run row at all; a parked run is a row, so the request is skipped.
//   * The handler RETURNS a failed result rather than throwing, so pg-boss
//     sees a successful job and its own `maxAttempts` never applies.
//
// Verified in production: a real signed document sat at `completion-ready`
// for a day with `attempt_count = 1`, and only completed because the job was
// enqueued by hand three times.
//
// ── Why an index table, and why THIS shape ─────────────────────────────────
//
// `reconcileCompletionRuns` takes a single workspace, and the completion
// handler's own comment explains why: "there is no system-wide completion
// index the way `signing-request.expiry` has one". This adds exactly that,
// copying migration 041's design rather than inventing a second shape —
// `signing_request_expiry_index`, `notification_dispatch_index` and
// `signing_workflow` reconciliation are all already read this way, and
// `transactions/index.ts` documents the convention: identifiers only, from a
// table that carries no tenancy policy, after which the caller enters each
// workspace properly and does the work under normal RLS.
//
// Three columns, and the column list IS the control: a workspace to enter, a
// run to act on, and the instant that decides whether to. Nothing about the
// document, the signers, or why the run failed is reachable from here.
//
// ── The eligibility instant is computed here, on purpose ───────────────────
//
// `signing_request_completion_runs` has `attempt_count` and `last_attempt_at`
// but no `next_attempt_at`, and adding one would mean every writer had to
// remember to maintain it. The trigger derives it instead, so a run becomes
// due by arithmetic on columns the claim path already maintains — there is no
// second field for a future writer to forget.

import { sql, type Kysely } from "kysely";

/** The states a run can be driven OUT of. Matches the repository's CLAIMABLE. */
const RETRIABLE_STATES = ["pending", "waiting-retry"] as const;

/**
 * Backoff, in seconds: `60 * 2^(attempts-1)`, capped at an hour.
 *
 * A completion failure is usually infrastructure — object storage, the
 * database, a typeface — so the early retries are close together to recover
 * quickly from a blip, and the cap keeps a persistent outage from turning
 * into a busy loop. Eight attempts under this curve spans roughly three
 * hours before the sweep gives up (the cap itself is applied by the sweep,
 * not here: how many times to try is policy, when to try next is data).
 *
 * A FRESH run (`pending`, zero attempts) is scheduled one interval after
 * creation rather than immediately. The submission already enqueues
 * `completion.process` directly — this index is the recovery half of that
 * hybrid trigger, and making it due instantly would have it racing the
 * immediate job on every single completion instead of catching the rare lost
 * one.
 */
const BACKOFF_BASE_SECONDS = 60;
const BACKOFF_CAP_SECONDS = 3600;

const inList = (values: readonly string[]) =>
  sql.raw(values.map(value => `'${value}'`).join(", "));

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table signing_request_completion_retry_index (
      completion_run_id  varchar(64) primary key,
      workspace_id       varchar(64) not null,
      next_attempt_at    timestamptz not null
    )
  `.execute(db);

  // Rows leave with the run they describe. A stranded index row would send the
  // sweep into a workspace to act on a run that no longer exists.
  await sql`
    alter table signing_request_completion_retry_index
      add constraint signing_request_completion_retry_index_run_fk
      foreign key (completion_run_id)
      references signing_request_completion_runs (completion_run_id)
      on delete cascade
  `.execute(db);

  // The sweep's only query: "what is due". Ordered by the instant, so the
  // longest-waiting run is driven first and none can starve behind a batch
  // bound.
  await sql`
    create index signing_request_completion_retry_index_due
      on signing_request_completion_retry_index (next_attempt_at)
  `.execute(db);

  // ── The synchroniser ──────────────────────────────────────────────────────
  //
  // A row exists exactly while the run is claimable. `processing` deletes it,
  // which is what stops the sweep from enqueuing work for a run a worker is
  // already inside; `succeeded` and `failed-terminal` delete it because there
  // is nothing left to drive.
  await sql`
    create or replace function lagda_sync_completion_retry_index()
      returns trigger
      language plpgsql
    as $$
    begin
      if new.state in (${inList(RETRIABLE_STATES)}) then
        insert into signing_request_completion_retry_index (
          completion_run_id, workspace_id, next_attempt_at
        ) values (
          new.completion_run_id,
          new.workspace_id,
          coalesce(new.last_attempt_at, new.created_at)
            + make_interval(secs => least(
                ${sql.lit(BACKOFF_BASE_SECONDS)}::double precision
                  * power(2, greatest(new.attempt_count - 1, 0)),
                ${sql.lit(BACKOFF_CAP_SECONDS)}::double precision))
        )
        on conflict (completion_run_id) do update set
          workspace_id    = excluded.workspace_id,
          next_attempt_at = excluded.next_attempt_at;
      else
        delete from signing_request_completion_retry_index
          where completion_run_id = new.completion_run_id;
      end if;
      return new;
    end
    $$;
  `.execute(db);

  await sql`
    create trigger signing_request_completion_retry_index_sync
      after insert or update on signing_request_completion_runs
      for each row
      execute function lagda_sync_completion_retry_index()
  `.execute(db);

  // ── Backfill ──────────────────────────────────────────────────────────────
  //
  // Unlike migration 041, a backfill here is REAL: runs already exist, and at
  // least one is parked in `waiting-retry` precisely because nothing could
  // drive it. Without this, every run stranded before today stays stranded
  // after it — the trigger only fires on write, and a parked run is by
  // definition not being written to.
  await sql`
    insert into signing_request_completion_retry_index (
      completion_run_id, workspace_id, next_attempt_at
    )
    select
      completion_run_id,
      workspace_id,
      coalesce(last_attempt_at, created_at)
        + make_interval(secs => least(
            ${sql.lit(BACKOFF_BASE_SECONDS)}::double precision
              * power(2, greatest(attempt_count - 1, 0)),
            ${sql.lit(BACKOFF_CAP_SECONDS)}::double precision))
      from signing_request_completion_runs
     where state in (${inList(RETRIABLE_STATES)})
    on conflict (completion_run_id) do nothing
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop trigger if exists signing_request_completion_retry_index_sync
      on signing_request_completion_runs
  `.execute(db);
  await sql`drop function if exists lagda_sync_completion_retry_index()`.execute(db);
  await sql`drop table if exists signing_request_completion_retry_index`.execute(db);
}
