// 026 — the completion step vocabulary, and the merged-candidate artifact.
//
// ── What this reverses, and why ────────────────────────────────────────────
//
// Migration 025 declared three steps — `seal`, `persist`, `finalize` — because
// `DocumentSealer.seal()` is ONE operation that merges fields and renders the
// certificate internally, and splitting it would have split the seam INV-002
// protects.
//
// BACKEND-39 reverses that, deliberately. Its specification requires FIELD_MERGE
// to be a distinct durable step producing a distinct immutable artifact, and
// requires that step NOT to invoke `DocumentSealer`. Those two together are only
// satisfiable if merging is separable from sealing.
//
// The objection in SEALING_ARCHITECTURE.md §2 was that exposing `mergeFields`,
// `hashDocument` and `renderCertificate` would give "twenty callers a reason to
// reach past the boundary". That argument holds for twenty callers and does not
// hold here: the completion pipeline is the ONLY caller, and the steps are
// sequential stages of one orchestration that already exists. The PDF work stays
// inside `@lagda/sealing`; what changes is that the package exposes two
// operations to one caller instead of one.
//
// **BACKEND-41 must narrow `seal()` to sealing alone.** It merges fields today,
// so once FIELD_MERGE renders them, leaving `seal()` as it is would render every
// field twice. That is recorded as the handoff's first requirement.
//
// ── The new artifact kind ──────────────────────────────────────────────────
//
// `merged-candidate`. Named for what it IS — a signed-document candidate whose
// fields are rendered and which has NOT been sealed. §8 and §81 both forbid
// calling it final, and `sealed` already means something else.

import { type Kysely, sql } from "kysely";

/**
 * The completion steps, in order.
 *
 * `finalize` survives from 025. `persist` does not: it existed because one seal
 * call produced two artifacts that were stored together, and each step now
 * persists its own output as part of being that step.
 */
const STEPS = ["field-merge", "certificate", "final-seal", "finalize"] as const;

/** 025's vocabulary, needed to walk the CHECK back on `down`. */
const OLD_STEPS = ["seal", "persist", "finalize"] as const;

/**
 * Artifact kinds, widened by one.
 *
 * `original` and `sealed` are migration 003's; `completion-certificate` too.
 * `merged-candidate` is the intermediate BACKEND-39 produces.
 */
const ARTIFACT_TYPES = [
  "original", "sealed", "completion-certificate", "merged-candidate",
] as const;

const OLD_ARTIFACT_TYPES = ["original", "sealed", "completion-certificate"] as const;

const inList = (values: readonly string[]) =>
  sql.raw(values.map(value => `'${value}'`).join(", "));

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── The step vocabulary ─────────────────────────────────────────────────────
  //
  // No data migration accompanies this. Migration 025 shipped in the same
  // development sequence and nothing has run a completion — `processCompletionRun`
  // cannot reach a step at all, because the sealer was never wired. The CHECK is
  // therefore replaced rather than translated, and a row carrying an old value
  // would be a row nothing could have written.
  await sql`
    alter table signing_request_completion_steps
      drop constraint if exists signing_request_completion_steps_step_check
  `.execute(db);
  await sql`
    alter table signing_request_completion_steps
      add constraint signing_request_completion_steps_step_check
      check (step in (${inList(STEPS)}))
  `.execute(db);

  // The run's failure column names the step it failed at, so it moves too.
  await sql`
    alter table signing_request_completion_runs
      drop constraint if exists signing_request_completion_runs_step_check
  `.execute(db);
  await sql`
    alter table signing_request_completion_runs
      add constraint signing_request_completion_runs_step_check
      check (failure_step is null or failure_step in (${inList(STEPS)}))
  `.execute(db);

  // ── The merged candidate ────────────────────────────────────────────────────
  await sql`
    alter table document_artifacts
      drop constraint if exists document_artifacts_artifact_type_check
  `.execute(db);
  await sql`
    alter table document_artifacts
      add constraint document_artifacts_artifact_type_check
      check (artifact_type in (${inList(ARTIFACT_TYPES)}))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // A merged candidate cannot exist under the old vocabulary. Removing the rows
  // before narrowing the CHECK is the only way `down` can succeed on data `up`
  // permitted — the alternative is a reversible migration that is not.
  await sql`
    delete from document_artifacts where artifact_type = 'merged-candidate'
  `.execute(db);
  await sql`
    alter table document_artifacts
      drop constraint if exists document_artifacts_artifact_type_check
  `.execute(db);
  await sql`
    alter table document_artifacts
      add constraint document_artifacts_artifact_type_check
      check (artifact_type in (${inList(OLD_ARTIFACT_TYPES)}))
  `.execute(db);

  await sql`
    delete from signing_request_completion_steps
     where step in ('field-merge', 'certificate', 'final-seal')
  `.execute(db);
  await sql`
    update signing_request_completion_runs set failure_step = null, failure_code = null
     where failure_step in ('field-merge', 'certificate', 'final-seal')
  `.execute(db);

  for (const [table, constraint] of [
    ["signing_request_completion_steps", "signing_request_completion_steps_step_check"],
    ["signing_request_completion_runs", "signing_request_completion_runs_step_check"],
  ] as const) {
    await sql`
      alter table ${sql.raw(table)} drop constraint if exists ${sql.raw(constraint)}
    `.execute(db);
  }
  await sql`
    alter table signing_request_completion_steps
      add constraint signing_request_completion_steps_step_check
      check (step in (${inList(OLD_STEPS)}))
  `.execute(db);
  await sql`
    alter table signing_request_completion_runs
      add constraint signing_request_completion_runs_step_check
      check (failure_step is null or failure_step in (${inList(OLD_STEPS)}))
  `.execute(db);
}
