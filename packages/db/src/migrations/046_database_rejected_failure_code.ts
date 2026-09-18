// 046 — admits `database-rejected` into the completion failure vocabulary.
//
// The code splits the old catch-all `database-unavailable` in two. That code
// is classified RETRYABLE, which is right for an unreachable server and
// exactly wrong for a refused statement — and every completion step recorded
// it for any throw out of its persistence transaction. Two schema defects
// (migrations 044 and 045) therefore presented as transient outages and were
// retried instead of failing loudly.
//
// `database-rejected` is TERMINAL: a CHECK constraint does not change its
// mind on the second attempt.
//
// ── Both tables, because both carry the vocabulary ─────────────────────────
//
// The steps table records the code for the step that failed, and the run
// records the code for the step it failed AT. Migration 026 widened the step
// vocabulary and forgot the failure-code CHECK on one of them, which is the
// omission migration 027 exists to correct and
// `completion-vocabulary.integration.test.ts` exists to catch. Both are
// rewritten here from one list for that reason.

import { sql, type Kysely } from "kysely";

/**
 * The full vocabulary as of this migration.
 *
 * Declared locally, like every other migration's copy: a migration describes
 * the schema at a point in time and must not shift when the contract's
 * constant is edited later. `completion-vocabulary.integration.test.ts`
 * compares the two against the LIVE constraint, so drift fails there rather
 * than in production.
 */
const FAILURE_CODES = [
  "not-completion-ready", "missing-submission", "missing-field-value",
  "input-inconsistent", "source-artifact-missing", "invalid-geometry",
  "unsupported-representation", "unrenderable-value", "output-missing",
  "pipeline-version-incompatible", "database-rejected",
  "storage-unavailable", "sealer-unavailable", "step-not-implemented",
  "typeface-unavailable", "database-unavailable", "attempt-abandoned",
] as const;

/** Migration 027's list — this one minus the new code. */
const OLD_FAILURE_CODES = FAILURE_CODES.filter(code => code !== "database-rejected");

const inList = (values: readonly string[]) =>
  sql.raw(values.map(value => `'${value}'`).join(", "));

async function setFailureCodeChecks(
  db: Kysely<unknown>,
  codes: readonly string[],
): Promise<void> {
  // The run: nullable, because a run that has not failed carries no code.
  await sql`
    alter table signing_request_completion_runs
      drop constraint if exists signing_request_completion_runs_code_check
  `.execute(db);
  await sql`
    alter table signing_request_completion_runs
      add constraint signing_request_completion_runs_code_check
      check (failure_code is null or failure_code in (${inList(codes)}))
  `.execute(db);

  await sql`
    alter table signing_request_completion_steps
      drop constraint if exists signing_request_completion_steps_code_check
  `.execute(db);
  await sql`
    alter table signing_request_completion_steps
      add constraint signing_request_completion_steps_code_check
      check (failure_code is null or failure_code in (${inList(codes)}))
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await setFailureCodeChecks(db, FAILURE_CODES);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Rows carrying the retired code would violate the narrower CHECK. They are
  // cleared rather than translated: mapping `database-rejected` back to
  // `database-unavailable` would restate a deterministic refusal as a
  // transient one, which is the exact confusion this code was added to end.
  await sql`
    update signing_request_completion_runs
       set failure_code = null
     where failure_code = 'database-rejected'
  `.execute(db);
  await sql`
    update signing_request_completion_steps
       set failure_code = null
     where failure_code = 'database-rejected'
  `.execute(db);

  await setFailureCodeChecks(db, OLD_FAILURE_CODES);
}
