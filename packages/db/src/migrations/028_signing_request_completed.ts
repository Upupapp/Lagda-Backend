// 028 — the `completed` state, its timestamp, and the merged-artifact relation.
//
// ── The value BACKEND-37 refused to admit ──────────────────────────────────
//
// `SIGNING_REQUEST_STATES` in `@lagda/contracts` has listed `completed` since
// BACKEND-37, and the database has deliberately refused it ever since. Migration
// 024's CHECK admits six values and not this one, with the reason recorded in
// the contracts comment: `completed` is terminal and legally significant, and a
// request that reached it wrongly cannot be walked back — so the value arrives
// with the code that earns it.
//
// BACKEND-41 is that code. This migration admits `completed` and nothing else:
// `ready-to-send` and `expired` are also in the contracts union and are also
// still refused here, because nothing transitions into them either.
//
// ── `completed_at` is BICONDITIONAL, and that is stronger than asked ───────
//
// The command asks only that `completed` implies a timestamp. The constraint
// below also asserts the converse — a timestamp implies `completed` — because a
// `completed_at` sitting on a request that is not completed is a half-written
// completion, and the whole point of this state is that it is never half true.
//
// It follows the `sent_at` precedent in this table, which is biconditional for
// the same reason.

import { type Kysely, sql } from "kysely";

/**
 * Request states the database admits AFTER this migration.
 *
 * Migration 024's six, plus `completed`. Duplicated rather than imported: a
 * migration describes the schema at ITS point in history, and a constant that
 * keeps moving underneath it is how 026 came to admit a step vocabulary its own
 * CHECK did not.
 */
const REQUEST_STATES = [
  "draft",
  "sent",
  "partially-completed",
  "completion-ready",
  "completed",
  "declined",
  "cancelled",
] as const;

/** 024's vocabulary, for `down`. */
const OLD_REQUEST_STATES = [
  "draft",
  "sent",
  "partially-completed",
  "completion-ready",
  "declined",
  "cancelled",
] as const;

const inList = (values: readonly string[]) =>
  sql.raw(values.map(value => `'${value}'`).join(", "));

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── `completed_at` ────────────────────────────────────────────────────────
  await sql`
    alter table signing_requests
      add column if not exists completed_at timestamptz
  `.execute(db);

  // ── The state vocabulary ──────────────────────────────────────────────────
  await sql`
    alter table signing_requests
      drop constraint if exists signing_requests_state_check
  `.execute(db);
  await sql`
    alter table signing_requests
      add constraint signing_requests_state_check
      check (state in (${inList(REQUEST_STATES)}))
  `.execute(db);

  // The timestamp and the state agree, in BOTH directions.
  await sql`
    alter table signing_requests
      drop constraint if exists signing_requests_completed_at_matches_state
  `.execute(db);
  await sql`
    alter table signing_requests
      add constraint signing_requests_completed_at_matches_state
      check ((state = 'completed') = (completed_at is not null))
  `.execute(db);

  // ── Merged-artifact provenance on the completion record ───────────────────
  //
  // The completion already references the certificate and the final artifact.
  // The merged candidate was missing, so the provenance chain
  // source -> merged -> final could not be reconstructed from the completion
  // row alone — it had to be inferred from the run's step rows, which are
  // operational records rather than the completion's own evidence.
  //
  // NOT NULL: the table is empty (no completion has ever occurred), and a
  // completion without its merged input is not a completion whose provenance
  // can be read.
  await sql`
    alter table signing_request_completions
      add column if not exists merged_artifact_id varchar(64) not null
  `.execute(db);

  // Tenant-safe by construction, matching the certificate and final FKs: the
  // compound key makes a cross-tenant artifact reference a constraint
  // violation rather than an application check.
  await sql`
    alter table signing_request_completions
      drop constraint if exists signing_request_completions_merged_fk
  `.execute(db);
  await sql`
    alter table signing_request_completions
      add constraint signing_request_completions_merged_fk
      foreign key (workspace_id, merged_artifact_id)
      references document_artifacts (workspace_id, artifact_id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // ── This `down` REFUSES rather than reverting a completion ────────────────
  //
  // A deliberate exception to the pattern 026 and 027 follow, where `down`
  // deletes the rows the widened CHECK permitted so that reversing cannot fail
  // on data `up` allowed.
  //
  // That pattern is right for operational rows. It is wrong here. `completed`
  // is terminal and legally significant: reverting it would silently downgrade
  // a request whose final document exists and whose completion record a public
  // verifier may already have read. §110 forbids exactly that transition even
  // as an incident response, and a migration script is a worse place to make
  // it than an incident response is.
  //
  // So reversing past a real completion requires a human decision, and this
  // says so loudly instead of making it quietly.
  const completed = await sql<{ count: string }>`
    select count(*)::text as count from signing_requests where state = 'completed'
  `.execute(db);

  if (Number(completed.rows[0]?.count ?? "0") > 0) {
    throw new Error(
      "Migration 028 cannot be reversed: completed signing requests exist. "
        + "Reverting would downgrade a terminal, legally significant state and "
        + "orphan final artifacts a verifier may already have looked up. "
        + "Resolve those completions deliberately before reversing.",
    );
  }

  await sql`
    alter table signing_request_completions
      drop constraint if exists signing_request_completions_merged_fk
  `.execute(db);
  await sql`
    alter table signing_request_completions
      drop column if exists merged_artifact_id
  `.execute(db);

  await sql`
    alter table signing_requests
      drop constraint if exists signing_requests_completed_at_matches_state
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
    alter table signing_requests drop column if exists completed_at
  `.execute(db);
}
