// Completion retry recovery, against REAL PostgreSQL.
//
// ── What only this suite can prove ─────────────────────────────────────────
//
// The recovery path is made of two things a fake cannot model: a TRIGGER that
// derives eligibility from columns the claim path maintains, and a
// CONDITIONAL UPDATE that decides which of two concurrent workers owns a run.
// The in-memory store has neither — it restates the trigger's arithmetic in
// TypeScript and has one connection — so the only place the real behaviour
// can be observed is here.
//
// The defect being guarded: a run that failed retryably parked in
// `waiting-retry` and nothing ever brought it back. `abandonStaleRuns` only
// reclaims `processing`; `listReadyWithoutRun` only finds requests with no
// run at all; and the handler returns its failure rather than throwing, so
// pg-boss's own `maxAttempts` never applied. A real signed document sat
// unfinished for a day.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type {
  DocumentId, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import {
  driveDueCompletionRuns, CompletionProcessJob,
  type CompletionRunId, type SigningRequestId, type ArtifactId,
  type JobDefinition, type JobReference,
} from "@lagda/application";
import type { LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-09-18T07:00:00.000Z");
const USER = "usr_retry" as UserId;
const WS = "ws_retry" as WorkspaceId;
const DOC = "doc_retry" as DocumentId;
const SR = "sr_retry" as SigningRequestId;
const RUN = "crun_retry" as CompletionRunId;
const DIGEST = "f".repeat(64);
const MINUTE = 60_000;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

/** Captures what the sweep handed to the queue. */
function recordingScheduler() {
  const enqueued: { type: string; payload: unknown }[] = [];
  return {
    enqueued,
    scheduler: {
      enqueue<TPayload>(
        definition: JobDefinition<TPayload>, payload: TPayload,
      ): Promise<JobReference> {
        enqueued.push({ type: definition.type, payload });
        return Promise.resolve({ jobId: `job_${enqueued.length}` } as JobReference);
      },
    },
  };
}

suite("completion retry recovery (real PostgreSQL)", () => {
  let owner: LagdaDatabase;

  beforeAll(async () => { owner = await createTestDatabase(); });
  afterAll(async () => { await owner?.close(); });

  beforeEach(async () => {
    await truncateAll(owner);
    await seedFixtures();
  });

  /**
   * The workspace, document, artifact and a `completion-ready` signing
   * request. One function, because the terminal-states case truncates
   * mid-test and needs exactly the same ground state back.
   *
   * `sent_at` AND `completion_ready_at` are both REQUIRED alongside the
   * state. Two biconditional CHECKs enforce it —
   * `signing_requests_sent_at_matches_state` (anything past
   * `ready-to-send` has been sent) and
   * `signing_requests_completion_ready_at_present` — and real PostgreSQL
   * refused this fixture twice before they were both set. The in-memory
   * store has neither constraint, which is precisely why a suite like this
   * one has to exist.
   */
  async function seedFixtures() {
    await seedUser(owner, USER);
    const tx = createTransactionManager(owner.db);
    await tx.runForWorkspace(WS, async uow => {
      await uow.workspaces.insert({ workspaceId: WS, name: "Retry", createdAt: AT });
      await uow.memberships.insert({
        memberId: "mem_retry" as WorkspaceMemberId, workspaceId: WS,
        userId: USER, role: "owner", createdAt: AT,
      });
      await uow.documents.insert({
        documentId: DOC, workspaceId: WS, title: "Retry probe",
        originalFilename: null, createdByUserId: USER, createdAt: AT,
      });
    });

    await sql`
      insert into document_artifacts (
        artifact_id, workspace_id, document_id, artifact_type, storage_reference,
        media_type, size_bytes, digest_algorithm, digest, created_at,
        page_count, rotated_page_count
      ) values (
        'art_retry', ${WS}, ${DOC}, 'original', 'k/retry',
        'application/pdf', 100, 'sha-256', ${DIGEST}, ${new Date(AT)}, 1, 0
      )
    `.execute(owner.db);
    // The preparation the request was snapshotted from. Required by
    // `signing_requests_preparation_fk`, which is compound on
    // (workspace_id, preparation_id) — so even the fixture cannot accidentally
    // point at another tenant's preparation.
    await sql`
      insert into document_preparations (
        preparation_id, workspace_id, document_id, source_artifact_id,
        revision, created_at, updated_at
      ) values (
        'prep_retry', ${WS}, ${DOC}, 'art_retry', 1,
        ${new Date(AT)}, ${new Date(AT)}
      )
    `.execute(owner.db);
    await sql`
      insert into signing_requests (
        signing_request_id, workspace_id, document_id, source_artifact_id,
        source_preparation_id, source_preparation_revision, state,
        sent_at, completion_ready_at, document_title, created_by_user_id,
        created_at, updated_at
      ) values (
        ${SR}, ${WS}, ${DOC}, 'art_retry', 'prep_retry', 1,
        'completion-ready', ${new Date(AT)}, ${new Date(AT)},
        'Retry probe', ${USER}, ${new Date(AT)}, ${new Date(AT)}
      )
    `.execute(owner.db);
  }

  /** Creates the run, then forces it into a given state as the superuser. */
  async function seedRun(state: string, attempts: number, lastAttemptMinutesAgo: number | null) {
    const tx = createTransactionManager(owner.db);
    await tx.runForWorkspace(WS, uow => uow.completion.ensureRun({
      completionRunId: RUN, signingRequestId: SR, pipelineVersion: 1, createdAt: AT,
    }));
    await sql`
      update signing_request_completion_runs
         set state = ${state},
             attempt_count = ${attempts},
             last_attempt_at = ${lastAttemptMinutesAgo === null
               ? null : new Date(Date.now() - lastAttemptMinutesAgo * MINUTE)}
       where completion_run_id = ${RUN}
    `.execute(owner.db);
  }

  const indexRows = async () => (await sql<{
    completion_run_id: string; workspace_id: string; next_attempt_at: Date;
  }>`select * from signing_request_completion_retry_index`.execute(owner.db)).rows;

  const runState = async () => (await sql<{ state: string; attempt_count: number }>`
    select state, attempt_count from signing_request_completion_runs
     where completion_run_id = ${RUN}
  `.execute(owner.db)).rows[0];

  function sweepDeps(overrides: { maxAttempts?: number; batchSize?: number } = {}) {
    const { enqueued, scheduler } = recordingScheduler();
    return {
      enqueued,
      deps: {
        transactions: createTransactionManager(owner.db),
        scheduler,
        clock: { now: () => Date.now() },
        policy: {
          batchSize: overrides.batchSize ?? 50,
          maxAttempts: overrides.maxAttempts ?? 8,
        },
      },
    };
  }

  // ── 1. Discovery ─────────────────────────────────────────────────────────

  it("indexes a waiting-retry run, and the trigger — not the app — puts it there", async () => {
    await seedRun("waiting-retry", 1, 5);
    const rows = await indexRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.completion_run_id).toBe(RUN);
    // The workspace, so the cross-tenant sweep knows where to go.
    expect(rows[0]?.workspace_id).toBe(WS);
  });

  it("drops the index row the moment a worker claims the run", async () => {
    await seedRun("waiting-retry", 1, 5);
    expect(await indexRows()).toHaveLength(1);

    const tx = createTransactionManager(owner.db);
    const claimed = await tx.runForWorkspace(WS, uow =>
      uow.completion.claimRun({ runId: RUN, at: Date.now() }));
    expect(claimed).not.toBeNull();

    // This is what stops the sweep enqueuing work for a run a worker is
    // already inside — it is not a candidate at all, rather than a candidate
    // that is filtered later.
    expect(await indexRows()).toHaveLength(0);
  });

  it("drops the index row for succeeded and failed-terminal runs", async () => {
    for (const terminal of ["succeeded", "failed-terminal"]) {
      await truncateAll(owner);
      await seedFixtures();
      await seedRun(terminal, 3, 1);
      expect(await indexRows(), terminal).toHaveLength(0);
    }
  });

  it("backs off: the due instant grows with the attempt count", async () => {
    // 60s * 2^(attempts-1), from `last_attempt_at`. Read from the database
    // rather than recomputed here, so the trigger's arithmetic is what is
    // being checked.
    const dueAfter = async (attempts: number) => {
      await seedRun("waiting-retry", attempts, 0);
      const rows = await indexRows();
      const base = (await sql<{ last_attempt_at: Date }>`
        select last_attempt_at from signing_request_completion_runs
         where completion_run_id = ${RUN}`.execute(owner.db)).rows[0];
      return Math.round(
        ((rows[0]?.next_attempt_at.getTime() ?? 0)
          - (base?.last_attempt_at.getTime() ?? 0)) / 1000);
    };

    expect(await dueAfter(1)).toBe(60);
    expect(await dueAfter(2)).toBe(120);
    expect(await dueAfter(3)).toBe(240);
    // Capped at an hour, so a persistent outage does not become a busy loop.
    expect(await dueAfter(20)).toBe(3600);
  });

  // ── 2. Automatic re-drive ────────────────────────────────────────────────

  it("re-enqueues a due run with no manual intervention", async () => {
    // Two attempts means a 120s backoff; ten minutes ago is comfortably due.
    await seedRun("waiting-retry", 2, 10);
    const { enqueued, deps } = sweepDeps();

    const result = await driveDueCompletionRuns(deps);

    expect(result.examined).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(result.exhausted).toBe(0);
    expect(result.failed).toBe(0);
    expect(enqueued).toEqual([{
      type: CompletionProcessJob.type,
      payload: { workspaceId: WS, completionRunId: RUN },
    }]);
  });

  it("leaves a run alone until its backoff has elapsed", async () => {
    // One attempt 10 SECONDS ago: the 60s backoff has not passed.
    await seedRun("waiting-retry", 1, 0);
    await sql`
      update signing_request_completion_runs
         set last_attempt_at = ${new Date(Date.now() - 10_000)}
       where completion_run_id = ${RUN}`.execute(owner.db);

    const { enqueued, deps } = sweepDeps();
    const result = await driveDueCompletionRuns(deps);

    expect(result.examined).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it("also rescues a PENDING run whose immediate enqueue was lost", async () => {
    // The hybrid trigger's other hole: the submission enqueues
    // `completion.process` directly, and if that enqueue is lost the run sits
    // at `pending` — which `listReadyWithoutRun` cannot see either, because
    // the run row exists.
    await seedRun("pending", 0, null);
    await sql`
      update signing_request_completion_runs
         set created_at = ${new Date(Date.now() - 5 * MINUTE)}
       where completion_run_id = ${RUN}`.execute(owner.db);

    const { enqueued, deps } = sweepDeps();
    expect((await driveDueCompletionRuns(deps)).enqueued).toBe(1);
    expect(enqueued).toHaveLength(1);
  });

  // ── 3. A transient failure eventually succeeds ───────────────────────────

  it("carries a transient failure through to success", async () => {
    const tx = createTransactionManager(owner.db);
    await seedRun("pending", 0, null);

    // Attempt 1: claimed, then fails retryably — exactly what a storage blip
    // or the two schema defects produced.
    await tx.runForWorkspace(WS, uow => uow.completion.claimRun({ runId: RUN, at: Date.now() }));
    await tx.runForWorkspace(WS, uow => uow.completion.recordRunFailure({
      runId: RUN, state: "waiting-retry", step: "field-merge",
      code: "storage-unavailable",
    }));
    expect((await runState())?.state).toBe("waiting-retry");

    // Make it due, then let the sweep find it.
    await sql`
      update signing_request_completion_runs
         set last_attempt_at = ${new Date(Date.now() - 10 * MINUTE)}
       where completion_run_id = ${RUN}`.execute(owner.db);

    const { enqueued, deps } = sweepDeps();
    expect((await driveDueCompletionRuns(deps)).enqueued).toBe(1);
    expect(enqueued).toHaveLength(1);

    // Attempt 2, standing in for the job the sweep enqueued: claimed and
    // succeeds.
    const claimed = await tx.runForWorkspace(WS, uow =>
      uow.completion.claimRun({ runId: RUN, at: Date.now() }));
    expect(claimed).not.toBeNull();
    expect(claimed?.attemptCount).toBe(2);
    await tx.runForWorkspace(WS, uow =>
      uow.completion.markRunSucceeded({ runId: RUN, succeededAt: Date.now() }));

    expect((await runState())?.state).toBe("succeeded");
    // And it stops being a candidate, so the sweep goes quiet.
    expect(await indexRows()).toHaveLength(0);
    const second = sweepDeps();
    expect((await driveDueCompletionRuns(second.deps)).examined).toBe(0);
    expect(second.enqueued).toHaveLength(0);
  });

  // ── 4. Terminal failures are not retried forever ─────────────────────────

  it("gives up once the attempts are spent, keeping the last real cause", async () => {
    await seedRun("waiting-retry", 8, 120);
    await sql`
      update signing_request_completion_runs
         set failure_step = 'final-seal', failure_code = 'storage-unavailable'
       where completion_run_id = ${RUN}`.execute(owner.db);

    const { enqueued, deps } = sweepDeps({ maxAttempts: 8 });
    const result = await driveDueCompletionRuns(deps);

    expect(result.exhausted).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(enqueued).toHaveLength(0);

    const row = (await sql<{ state: string; failure_code: string; failure_step: string }>`
      select state, failure_code, failure_step
        from signing_request_completion_runs where completion_run_id = ${RUN}
    `.execute(owner.db)).rows[0];
    expect(row?.state).toBe("failed-terminal");
    // The DIAGNOSTIC survives. "Gave up after 8 attempts, and the last one
    // failed for this reason" is the only useful record; overwriting it with
    // a synthetic "retries exhausted" would restate the state column.
    expect(row?.failure_code).toBe("storage-unavailable");
    expect(row?.failure_step).toBe("final-seal");

    // And it is gone from the index, so it cannot consume another tick.
    expect(await indexRows()).toHaveLength(0);
  });

  it("a run recorded as failed-terminal is never a candidate", async () => {
    const tx = createTransactionManager(owner.db);
    await seedRun("pending", 0, null);
    await tx.runForWorkspace(WS, uow => uow.completion.claimRun({ runId: RUN, at: Date.now() }));
    // `database-rejected` is terminal — the code added precisely so a refused
    // statement stops being retried.
    await tx.runForWorkspace(WS, uow => uow.completion.recordRunFailure({
      runId: RUN, state: "failed-terminal", step: "field-merge",
      code: "database-rejected",
    }));

    expect(await indexRows()).toHaveLength(0);
    const { enqueued, deps } = sweepDeps();
    expect((await driveDueCompletionRuns(deps)).examined).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it("does not give up early, and does not exhaust a run a worker just claimed", async () => {
    await seedRun("waiting-retry", 3, 120);
    const tx = createTransactionManager(owner.db);

    // Attempts remaining → drive it, do not exhaust it.
    const first = sweepDeps({ maxAttempts: 8 });
    expect((await driveDueCompletionRuns(first.deps)).exhausted).toBe(0);
    expect(first.enqueued).toHaveLength(1);

    // Now simulate the race the conditions exist for: the run is claimed
    // between the index read and the exhaust write. Even with the cap
    // exceeded, `exhaustRun` must not talk a processing run into terminal.
    await sql`
      update signing_request_completion_runs set attempt_count = 99
       where completion_run_id = ${RUN}`.execute(owner.db);
    await tx.runForWorkspace(WS, uow => uow.completion.claimRun({ runId: RUN, at: Date.now() }));
    const gaveUp = await tx.runForWorkspace(WS, uow =>
      uow.completion.exhaustRun({ runId: RUN, maxAttempts: 8 }));
    expect(gaveUp).toBe(false);
    expect((await runState())?.state).toBe("processing");
  });

  // ── 5 & 7. Duplicates and concurrency ────────────────────────────────────

  it("repeated sweeps cannot cause duplicate PROCESSING", async () => {
    // The honest invariant. Two sweeps WILL both enqueue — "enqueuing is not
    // claiming", the same design `dispatch.ts` records — and that is safe
    // because the claim is one conditional UPDATE. Asserting "enqueued only
    // once" would be asserting a lock this system deliberately does not have.
    await seedRun("waiting-retry", 2, 30);

    const a = sweepDeps();
    const b = sweepDeps();
    await driveDueCompletionRuns(a.deps);
    await driveDueCompletionRuns(b.deps);
    expect(a.enqueued).toHaveLength(1);
    expect(b.enqueued).toHaveLength(1);

    // What must hold: only ONE of the two resulting jobs can claim the run.
    const tx = createTransactionManager(owner.db);
    const first = await tx.runForWorkspace(WS, uow =>
      uow.completion.claimRun({ runId: RUN, at: Date.now() }));
    const second = await tx.runForWorkspace(WS, uow =>
      uow.completion.claimRun({ runId: RUN, at: Date.now() }));

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    // One attempt consumed, not two.
    expect((await runState())?.attempt_count).toBe(3);
  });

  it("two CONCURRENT claims resolve to exactly one winner", async () => {
    await seedRun("waiting-retry", 1, 30);
    const tx = createTransactionManager(owner.db);

    // Genuinely concurrent, on separate connections — the case an in-memory
    // fake cannot express at all.
    const [a, b] = await Promise.all([
      tx.runForWorkspace(WS, uow => uow.completion.claimRun({ runId: RUN, at: Date.now() })),
      tx.runForWorkspace(WS, uow => uow.completion.claimRun({ runId: RUN, at: Date.now() })),
    ]);

    expect([a, b].filter(claim => claim !== null)).toHaveLength(1);
    expect((await runState())?.attempt_count).toBe(2);
  });

  it("two CONCURRENT sweeps cannot both exhaust the same run", async () => {
    await seedRun("waiting-retry", 9, 120);
    const a = sweepDeps({ maxAttempts: 8 });
    const b = sweepDeps({ maxAttempts: 8 });

    const [ra, rb] = await Promise.all([
      driveDueCompletionRuns(a.deps),
      driveDueCompletionRuns(b.deps),
    ]);

    // Exactly one call was the one that gave up, so the tick counts are not
    // double-reported.
    expect(ra.exhausted + rb.exhausted).toBe(1);
    expect((await runState())?.state).toBe("failed-terminal");
  });

  // ── 6. Durability across a restart ───────────────────────────────────────

  it("survives a worker restart, because the eligibility lives in PostgreSQL", async () => {
    await seedRun("waiting-retry", 2, 30);

    // "Restart": every in-process object is discarded and rebuilt. Nothing
    // about the run's eligibility was held in worker memory — no timer, no
    // in-flight promise — so a fresh sweep finds it unchanged.
    const fresh = createTransactionManager(owner.db);
    const due = await fresh.runGlobal(uow =>
      uow.completionRetryIndex.listDue({ now: Date.now(), limit: 50 }));

    expect(due.map(ref => ref.completionRunId)).toEqual([RUN]);

    const { enqueued, deps } = sweepDeps();
    expect((await driveDueCompletionRuns(deps)).enqueued).toBe(1);
    expect(enqueued).toHaveLength(1);
  });

  it("is bounded, and says so when the bound bites", async () => {
    await seedRun("waiting-retry", 2, 30);
    const { deps } = sweepDeps({ batchSize: 1 });
    const result = await driveDueCompletionRuns(deps);
    expect(result.truncated).toBe(true);
  });

});
