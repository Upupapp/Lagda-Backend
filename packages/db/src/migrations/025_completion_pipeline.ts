// 025 — the completion pipeline's durable state.
//
// ── Three tables, three different jobs ─────────────────────────────────────
//
//   signing_request_completion_runs    OPERATIONAL. One per request. Carries
//                                      processing state, attempts and the
//                                      failure classification
//   signing_request_completion_steps   the step ledger. One accepted result per
//                                      logical step, so a retry RESUMES
//   signing_request_completions        AUTHORITATIVE. The immutable fact that a
//                                      request completed, and what it produced
//
// §107 asks whether the last of these is worth having separately from the run's
// `succeeded` state. It is: a run is operational debris that an operator may
// one day want to prune, and "this request completed, here is its final
// artifact" is a legal record that must outlive it. They are also written under
// different rules — the run is UPDATEd throughout, and the completion row is
// INSERT-only with no UPDATE grant.
//
// ── The request's state does NOT change here ───────────────────────────────
//
// `signing_requests.state` stays `completion-ready` for the whole pipeline, and
// migration 025 does not widen the CHECK to admit `completed`. That is
// deliberate: BACKEND-41 adds the value alongside the code path that can earn
// it, exactly as BACKEND-33 added `sent` alongside the send that writes it. A
// CHECK admitting a state nothing can reach is a permission granted in advance
// of the thing it permits.
//
// ── What is NOT here ───────────────────────────────────────────────────────
//
// No merged-candidate artifact type. `document_artifacts.artifact_type` has
// admitted `original`, `sealed` and `completion-certificate` since migration
// 003, and `DocumentSealer.seal()` produces the last two together — so there is
// no intermediate artifact for LAGDA to persist. See the `seal` step's comment
// in the contracts vocabulary.

import { type Kysely, sql } from "kysely";

/** Mirrors `COMPLETION_RUN_STATES`. */
const RUN_STATES = [
  "pending", "processing", "waiting-retry", "succeeded", "failed-terminal",
] as const;

/**
 * The step vocabulary AS OF 025. Migration 026 replaces it - see the comment
 * there for why the sealer stopped being one step.
 */
const STEPS = ["seal", "persist", "finalize"] as const;

/** Mirrors `COMPLETION_STEP_STATES`. */
const STEP_STATES = ["pending", "processing", "succeeded", "failed"] as const;

/** Mirrors `COMPLETION_FAILURE_CODES`. A closed set, never an exception string. */
const FAILURE_CODES = [
  "not-completion-ready", "missing-submission", "missing-field-value",
  "input-inconsistent", "source-artifact-missing", "invalid-geometry",
  "unsupported-representation", "output-missing", "pipeline-version-incompatible",
  "storage-unavailable", "sealer-unavailable", "database-unavailable",
  "attempt-abandoned",
] as const;

const inList = (values: readonly string[]) =>
  sql.raw(values.map(value => `'${value}'`).join(", "));

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── The run ─────────────────────────────────────────────────────────────────
  await sql`
    create table signing_request_completion_runs (
      completion_run_id     varchar(64)  primary key,
      workspace_id          varchar(64)  not null,
      signing_request_id    varchar(64)  not null,

      state                 varchar(32)  not null,

      -- The ORCHESTRATION's semantic version, not a package version and not a
      -- git SHA. A run started under one version must not be resumed under
      -- another that reads its step rows differently, so the version travels
      -- with the run rather than being inferred from the running build.
      pipeline_version      integer      not null,

      -- Operational, never evidence. An attempt count says how hard the system
      -- tried; it says nothing about what anybody signed.
      attempt_count         integer      not null default 0,

      created_at            timestamptz  not null,
      started_at            timestamptz,
      last_attempt_at       timestamptz,
      succeeded_at          timestamptz,

      -- BOUNDED. A raw exception or stack trace here would be the one place in
      -- the completion schema that unbounded text could carry a field value or
      -- a document title into a business table.
      failure_step          varchar(32),
      failure_code          varchar(64),

      constraint signing_request_completion_runs_state_check
        check (state in (${inList(RUN_STATES)})),
      constraint signing_request_completion_runs_step_check
        check (failure_step is null or failure_step in (${inList(STEPS)})),
      constraint signing_request_completion_runs_code_check
        check (failure_code is null or failure_code in (${inList(FAILURE_CODES)})),
      constraint signing_request_completion_runs_failure_agrees
        check ((failure_step is null) = (failure_code is null)),
      constraint signing_request_completion_runs_attempts_bounded
        check (attempt_count >= 0),
      -- A succeeded run has a success instant, and nothing else does.
      constraint signing_request_completion_runs_succeeded_at_matches_state check (
        (state = 'succeeded' and succeeded_at is not null)
        or (state <> 'succeeded' and succeeded_at is null)
      ),

      -- ONE LOGICAL RUN PER REQUEST (§14, §15, §167).
      --
      -- This is what makes a duplicate trigger, a duplicate job and two workers
      -- racing all converge on the same run instead of producing three. It is a
      -- constraint rather than an application check because the race is between
      -- transactions, where an application check cannot see the other side.
      constraint signing_request_completion_runs_one_per_request
        unique (workspace_id, signing_request_id),

      constraint signing_request_completion_runs_request_fk
        foreign key (workspace_id, signing_request_id)
        references signing_requests (workspace_id, signing_request_id)
        on delete restrict
    )
  `.execute(db);

  // How a dispatcher finds work. Partial, so the index stays the size of the
  // backlog rather than the size of history - the shape BACKEND-33's pending
  // delivery index established.
  await sql`
    create index signing_request_completion_runs_claimable_idx
      on signing_request_completion_runs (created_at)
      where state in ('pending', 'waiting-retry')
  `.execute(db);

  // How the reconciler finds a run whose worker died.
  await sql`
    create index signing_request_completion_runs_processing_idx
      on signing_request_completion_runs (last_attempt_at)
      where state = 'processing'
  `.execute(db);

  // ── The step ledger ─────────────────────────────────────────────────────────
  //
  // TYPED and CLOSED, not a workflow engine (§71, §283). Three rows at most per
  // run, in one fixed order, and the step name is CHECK-constrained - so there
  // is no arbitrary DAG for a future caller to build and nothing to review that
  // is not in a migration.
  await sql`
    create table signing_request_completion_steps (
      completion_step_id    varchar(64)  primary key,
      workspace_id          varchar(64)  not null,
      completion_run_id     varchar(64)  not null,

      step                  varchar(32)  not null,
      state                 varchar(32)  not null,

      -- What the step produced, when it produced an artifact. NEVER bytes:
      -- §74, and a blob here would put the most sensitive content in the
      -- operational table rather than in object storage behind an artifact row.
      output_artifact_id    varchar(64),

      attempt_count         integer      not null default 0,
      created_at            timestamptz  not null,
      succeeded_at          timestamptz,
      failure_code          varchar(64),

      constraint signing_request_completion_steps_step_check
        check (step in (${inList(STEPS)})),
      constraint signing_request_completion_steps_state_check
        check (state in (${inList(STEP_STATES)})),
      constraint signing_request_completion_steps_code_check
        check (failure_code is null or failure_code in (${inList(FAILURE_CODES)})),
      constraint signing_request_completion_steps_succeeded_at_matches_state check (
        (state = 'succeeded' and succeeded_at is not null)
        or (state <> 'succeeded' and succeeded_at is null)
      ),
      constraint signing_request_completion_steps_attempts_bounded
        check (attempt_count >= 0),

      -- ONE ACCEPTED RESULT PER LOGICAL STEP (§166).
      --
      -- The constraint that makes §116 survivable: a certificate carrying a
      -- backend timestamp means two attempts may legitimately produce different
      -- bytes, so the system must be unable to accept both. A second row
      -- VIOLATES rather than overwrites.
      constraint signing_request_completion_steps_one_per_step
        unique (completion_run_id, step),

      constraint signing_request_completion_steps_run_fk
        foreign key (completion_run_id)
        references signing_request_completion_runs (completion_run_id)
        on delete cascade,
      -- The output must live in the SAME tenant. Two columns, so a step cannot
      -- point at another workspace's artifact even by accident (§237).
      constraint signing_request_completion_steps_artifact_fk
        foreign key (workspace_id, output_artifact_id)
        references document_artifacts (workspace_id, artifact_id)
    )
  `.execute(db);

  // ── The authoritative completion ────────────────────────────────────────────
  //
  // The immutable fact. INSERT and SELECT only - no UPDATE grant below, so a
  // completed request's final artifact cannot be repointed by any statement the
  // runtime role can issue.
  await sql`
    create table signing_request_completions (
      workspace_id          varchar(64)  not null,
      signing_request_id    varchar(64)  not null,
      completion_run_id     varchar(64)  not null,

      -- The sealed document. The bytes people are handed.
      final_artifact_id     varchar(64)  not null,
      -- A SEPARATE artifact, not a page appended to the above: handoff §15
      -- stores original, signed and certificate as three things, and
      -- SealResult returns the last two separately.
      certificate_artifact_id varchar(64),

      -- Backend-authoritative PIPELINE SUCCESS time.
      --
      -- NOT the last recipient's accepted_at. They are different facts and a
      -- retried completion makes the difference visible: somebody signed at one
      -- instant, and the document they signed came into existence at another.
      completed_at          timestamptz  not null,

      -- How it was produced, so a historical artifact stays interpretable after
      -- the scheme changes. Copied from SealResult.seal, never inferred from
      -- the running build.
      seal_scheme           varchar(32)  not null,
      seal_version          integer      not null,
      digest_algorithm      varchar(32)  not null,
      pipeline_version      integer      not null,

      created_at            timestamptz  not null,

      -- ONE SUCCESSFUL COMPLETION PER REQUEST (§109, §169).
      --
      -- A lost response after a successful finalization cannot create a second:
      -- the retry's INSERT violates, and the caller reads the existing row
      -- instead (§110, §259).
      constraint signing_request_completions_pk
        primary key (workspace_id, signing_request_id),

      constraint signing_request_completions_run_fk
        foreign key (completion_run_id)
        references signing_request_completion_runs (completion_run_id)
        on delete restrict,
      constraint signing_request_completions_request_fk
        foreign key (workspace_id, signing_request_id)
        references signing_requests (workspace_id, signing_request_id)
        on delete restrict,
      -- Both artifacts, tenant-safe. A completion cannot cite another
      -- workspace's bytes (§238).
      constraint signing_request_completions_final_artifact_fk
        foreign key (workspace_id, final_artifact_id)
        references document_artifacts (workspace_id, artifact_id),
      constraint signing_request_completions_certificate_fk
        foreign key (workspace_id, certificate_artifact_id)
        references document_artifacts (workspace_id, artifact_id)
    )
  `.execute(db);

  // The final artifact belongs to EXACTLY ONE completion. Two requests claiming
  // the same sealed bytes would make "which transaction produced this document"
  // unanswerable.
  await sql`
    create unique index signing_request_completions_final_artifact_idx
      on signing_request_completions (workspace_id, final_artifact_id)
  `.execute(db);

  // ── Grants ──────────────────────────────────────────────────────────────────
  //
  // Runs and steps take UPDATE because both legitimately evolve. The completion
  // record does NOT: it is written once, and "a completed request's final
  // artifact is immutable" is therefore a privilege the runtime role does not
  // hold rather than a rule somebody has to remember.
  for (const table of [
    "signing_request_completion_runs", "signing_request_completion_steps",
  ]) {
    await sql`grant select, insert, update on table ${sql.raw(table)} to lagda_app`
      .execute(db);
  }
  await sql`
    grant select, insert on table signing_request_completions to lagda_app
  `.execute(db);

  // ── Row-level security ──────────────────────────────────────────────────────
  //
  // Ordinary tenant isolation on all three, and NOTHING for the recipient
  // realm. A recipient has no business knowing that completion is running, how
  // many times it has failed, or what it produced - and the way to guarantee
  // that is a restrictive policy that is simply false inside the realm, the
  // same one-line denial migration 024 applied to grants and delivery intents.
  const RECIPIENT_DIGEST = "lagda_current_recipient_session_digest()";
  for (const table of [
    "signing_request_completion_runs", "signing_request_completion_steps",
    "signing_request_completions",
  ]) {
    await sql`alter table ${sql.raw(table)} enable row level security`.execute(db);
    await sql`alter table ${sql.raw(table)} force row level security`.execute(db);
    await sql`
      create policy tenant_isolation on ${sql.raw(table)}
      using (workspace_id = lagda_current_workspace())
      with check (workspace_id = lagda_current_workspace())
    `.execute(db);
    await sql`
      create policy recipient_realm_denied on ${sql.raw(table)}
      as restrictive
      using (${sql.raw(`${RECIPIENT_DIGEST} is null`)})
      with check (${sql.raw(`${RECIPIENT_DIGEST} is null`)})
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    "signing_request_completions", "signing_request_completion_steps",
    "signing_request_completion_runs",
  ]) {
    await sql`drop policy if exists recipient_realm_denied on ${sql.raw(table)}`
      .execute(db);
    await sql`drop policy if exists tenant_isolation on ${sql.raw(table)}`.execute(db);
    await db.schema.dropTable(table).ifExists().execute();
  }
}
