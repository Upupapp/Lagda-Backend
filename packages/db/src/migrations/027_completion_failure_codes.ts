// 027 — the completion failure-code vocabulary.
//
// ── A defect migration 026 left behind ─────────────────────────────────────
//
// 026 added `step-not-implemented` to `COMPLETION_FAILURE_CODES` in
// `@lagda/contracts` and widened the STEP CHECK — and never touched the FAILURE
// CODE CHECK. The two tables carrying `failure_code` therefore still admitted
// only migration 025's thirteen values.
//
// That is not latent. `processCompletionRun` writes exactly that code on its
// ONLY reachable path today:
//
//     await uow.completion.recordRunFailure({
//       runId, state: "waiting-retry", step: next ?? "field-merge",
//       code: "step-not-implemented",
//     })
//
// So the first real completion attempt would have raised Postgres 23514 against
// `signing_request_completion_runs_code_check` instead of parking the run for
// retry. The unit suite could not see it — it runs against fakes — and the
// integration suite never drove that path.
//
// It went unnoticed because a vocabulary lives in TWO places and only one of
// them is typechecked. The frozen `Record` makes adding a code without
// classifying it a compile error; nothing makes adding a code without widening
// its CHECK anything at all.
//
// ── Two new codes ──────────────────────────────────────────────────────────
//
// BACKEND-39's renderer produces two terminal failures the vocabulary cannot
// express, plus one retryable one:
//
//   unrenderable-value    a value contains a character the embedded typeface
//                         has no glyph for. TERMINAL — the same value is
//                         missing the same glyph forever
//   typeface-unavailable  the typeface could not be loaded at all. RETRYABLE,
//                         and the distinction is the point: a missing font file
//                         is a broken INSTALLATION, not a broken document, so
//                         failing it terminally would permanently fail every
//                         request in flight over a fault a redeploy fixes
//
// `unsupported-representation` already exists and is REUSED for an undecodable
// raster, an unsupported media type and an out-of-range typed style. Its
// documentation said "a signature representation VERSION this build cannot
// interpret"; the contracts comment is broadened rather than a near-duplicate
// code added, because none of those is operationally distinct — all four mean
// "this signature cannot be rendered by this build, terminally".
//
// `unrenderable-value` is NOT folded into it. That one says the signature is
// fine and the TEXT cannot be drawn, which sends an operator somewhere else
// entirely.

import { type Kysely, sql } from "kysely";

/**
 * Mirrors `COMPLETION_FAILURE_CODES` as of BACKEND-39.
 *
 * Duplicated from the contracts package on purpose — a migration must describe
 * the schema at ITS point in history, not import a constant that keeps moving
 * underneath it. That is also exactly why 026's omission was possible, so the
 * accompanying guard test asserts the two agree.
 */
const FAILURE_CODES = [
  // Terminal
  "not-completion-ready", "missing-submission", "missing-field-value",
  "input-inconsistent", "source-artifact-missing", "invalid-geometry",
  "unsupported-representation", "unrenderable-value", "output-missing",
  "pipeline-version-incompatible",
  // Retryable
  "storage-unavailable", "sealer-unavailable", "step-not-implemented",
  "typeface-unavailable", "database-unavailable", "attempt-abandoned",
] as const;

/** 025's vocabulary — what both CHECKs actually admit before this migration. */
const OLD_FAILURE_CODES = [
  "not-completion-ready", "missing-submission", "missing-field-value",
  "input-inconsistent", "source-artifact-missing", "invalid-geometry",
  "unsupported-representation", "output-missing", "pipeline-version-incompatible",
  "storage-unavailable", "sealer-unavailable", "database-unavailable",
  "attempt-abandoned",
] as const;

const TABLES = [
  ["signing_request_completion_runs", "signing_request_completion_runs_code_check"],
  ["signing_request_completion_steps", "signing_request_completion_steps_code_check"],
] as const;

const inList = (values: readonly string[]) =>
  sql.raw(values.map(value => `'${value}'`).join(", "));

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const [table, constraint] of TABLES) {
    await sql`
      alter table ${sql.raw(table)} drop constraint if exists ${sql.raw(constraint)}
    `.execute(db);
    await sql`
      alter table ${sql.raw(table)}
        add constraint ${sql.raw(constraint)}
        check (failure_code is null or failure_code in (${inList(FAILURE_CODES)}))
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Clear the rows the widened CHECK permitted before narrowing it. A
  // reversible migration that fails on the data it admitted is not reversible —
  // the same reasoning 026's `down` used.
  //
  // `failure_step` goes with it: a paired CHECK asserts
  // `(failure_step is null) = (failure_code is null)`, so nulling one column
  // alone would trade this constraint violation for that one.
  await sql`
    update signing_request_completion_runs
       set failure_step = null, failure_code = null
     where failure_code in ('unrenderable-value', 'typeface-unavailable',
                            'step-not-implemented')
  `.execute(db);
  await sql`
    update signing_request_completion_steps
       set failure_code = null
     where failure_code in ('unrenderable-value', 'typeface-unavailable',
                            'step-not-implemented')
  `.execute(db);

  for (const [table, constraint] of TABLES) {
    await sql`
      alter table ${sql.raw(table)} drop constraint if exists ${sql.raw(constraint)}
    `.execute(db);
    await sql`
      alter table ${sql.raw(table)}
        add constraint ${sql.raw(constraint)}
        check (failure_code is null or failure_code in (${inList(OLD_FAILURE_CODES)}))
    `.execute(db);
  }
}
