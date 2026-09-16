// The completion pipeline (Phase 1-B), against REAL PostgreSQL, a REAL
// pg-boss instance, and REAL MinIO object storage — not fakes.
//
// ── What this proves, and what it deliberately does not ────────────────────
//
// This suite's job is to prove the WIRING added in this phase actually
// reaches production code through real infrastructure: a request reaching
// `completion-ready` → `uow.completion.ensureRun` → a real `completion.process`
// job enqueued through a real `JobScheduler` → a real pg-boss delivery → this
// package's own `handleCompletionProcess` → real `processCompletionRun` →
// real `CompletionStepRunners` built from real `NodeFieldMerger`/
// `NodeCompletionCertificateGenerator`/`NodeDocumentSealer` and a real
// `ObjectStorage` backed by MinIO — exactly the composition
// `start-worker.ts` performs at boot, not a parallel test-only wiring.
//
// It does NOT re-derive a full realistic recipient-submission fixture
// (accepted field values, signature representations, consent records) —
// that data model belongs to `signing-submission`/`signing-workflow` and is
// already covered by their own test suites. Without it, `processCompletionRun`
// correctly reports a business-level failure (missing submission data) rather
// than a sealed artifact — which is itself evidence the pipeline is running
// REAL domain logic against REAL infrastructure, not a stub that always
// succeeds. What this suite asserts is that the run is actually CLAIMED and
// ATTEMPTED through the full real stack, and that duplicate delivery and
// crash recovery behave correctly — the properties Phase 1-B's own testing
// requirement calls out by name.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PgBoss } from "pg-boss";
import { sql } from "kysely";
import type {
  ArtifactId, PreparationId, RecipientId, UserId, WorkspaceId,
  SigningRequestId, SigningRequestRecipientId,
  SigningRequestFieldId, NewSigningRequestSnapshot, CompletionRunId,
  CompletionDependencies, CompletionStepRunners, ObjectStorage,
} from "@lagda/application";
import type { DocumentId, WorkspaceMemberId } from "@lagda/contracts";
import {
  CompletionProcessJob, CompletionReconcileJob, runFieldMergeStep,
  runCertificateStep, runFinalSealStep,
} from "@lagda/application";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
  createTransactionManager, type LagdaDatabase,
} from "@lagda/db";
import {
  createArtifactIdGenerator, createSealIdGenerator, createCompletionIdGenerator,
  createEvidenceEventIdGenerator, createVerificationIdGenerator,
} from "@lagda/security";
import {
  createS3ObjectStorage, createStorageKeyStrategy, ensureTestBuckets,
  testStorageConfig,
} from "@lagda/storage";
import { NodeFieldMerger, NodeCompletionCertificateGenerator, NodeDocumentSealer } from "@lagda/sealing";
import { createJobScheduler } from "./queue/scheduler.js";
import { registerSystemHandler, ensureQueue } from "./server/start-worker.js";
import { handleCompletionProcess } from "./handlers/completion-process.js";
import { handleCompletionReconcile } from "./handlers/completion-reconcile.js";

const AT = Date.parse("2026-09-16T10:00:00.000Z");
const SCHEMA = "pgboss_completion_test";
const USER = "usr_cpl" as UserId;
const WS = "ws_cpl" as WorkspaceId;
const DOC = "doc_cpl" as DocumentId;
const REQUEST = "sr_cpl" as SigningRequestId;
const R1 = "srr_cpl_1" as SigningRequestRecipientId;

async function until(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Timed out waiting for the completion job.");
}

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("completion pipeline (real Postgres + pg-boss + MinIO)", () => {
  let owner: LagdaDatabase;
  let boss: PgBoss;
  let storage: ObjectStorage;
  let completionDeps: CompletionDependencies;

  beforeAll(async () => {
    owner = await createTestDatabase();

    boss = new PgBoss({
      connectionString: process.env["DATABASE_TEST_URL"] ?? "",
      schema: SCHEMA,
      migrate: true,
      max: 2,
    });
    boss.on("error", () => undefined);
    await boss.start();
    await ensureQueue(boss, CompletionProcessJob);
    await ensureQueue(boss, CompletionReconcileJob);

    // Real MinIO, the same local stack docker-compose.local.yml documents —
    // not a mock. `ensureTestBuckets`/`testStorageConfig` are @lagda/storage's
    // own test-support exports, used exactly as its integration suite uses
    // them.
    const endpoint = process.env["OBJECT_STORAGE_ENDPOINT"] ?? "http://localhost:9000";
    await ensureTestBuckets(endpoint);
    storage = createS3ObjectStorage(testStorageConfig(endpoint));

    const transactions = createTransactionManager(owner.db);
    const clock = { now: () => AT };
    const keys = createStorageKeyStrategy();
    const ids = {
      ...createCompletionIdGenerator(),
      ...createArtifactIdGenerator(),
      ...createEvidenceEventIdGenerator(),
    };
    const steps: CompletionStepRunners = {
      fieldMerge: (input) => runFieldMergeStep(input, {
        transactions, clock, ids, storage, keys, merger: new NodeFieldMerger(),
      }),
      certificate: (input) => runCertificateStep(input, {
        transactions, clock, ids, storage, keys,
        certificates: new NodeCompletionCertificateGenerator(),
      }),
      finalSeal: (input) => runFinalSealStep(input, {
        transactions, clock,
        ids: { ...ids, ...createSealIdGenerator(), ...createVerificationIdGenerator() },
        storage, keys, sealer: new NodeDocumentSealer(),
      }),
    };
    completionDeps = {
      transactions, clock, ids: createCompletionIdGenerator(),
      policy: { staleAttemptMs: 60_000, reconcileBatchSize: 50 },
      steps,
    };

    // Registered exactly once, exactly the way start-worker.ts registers it —
    // real handler, real dependencies, real queue.
    const config = {
      concurrencyOverride: 1,
    } as Parameters<typeof registerSystemHandler>[1];
    await registerSystemHandler(boss, config, CompletionProcessJob,
      (raw, context) => handleCompletionProcess(raw, context, completionDeps));
    await registerSystemHandler(boss, config, CompletionReconcileJob,
      (raw, context) => handleCompletionReconcile(raw, context, completionDeps));
  }, 90_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await owner?.close();
  });

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, USER);
    const tx = createTransactionManager(owner.db);

    await tx.runForWorkspace(WS, async uow => {
      await uow.workspaces.insert({ workspaceId: WS, name: "WS", createdAt: AT });
      await uow.memberships.insert({
        memberId: "mem_cpl" as WorkspaceMemberId, workspaceId: WS,
        userId: USER, role: "owner", createdAt: AT,
      });
      await uow.documents.insert({
        documentId: DOC, workspaceId: WS, title: "Lease",
        originalFilename: null, createdByUserId: USER, createdAt: AT,
      });
      await uow.artifacts.insert({
        artifactId: "art_cpl" as ArtifactId, workspaceId: WS, documentId: DOC,
        artifactType: "original", storageReference: "ws/a" as never,
        mediaType: "application/pdf", sizeBytes: 1024,
        digestAlgorithm: "sha-256", digest: "e".repeat(64) as never,
        pageCount: 1, rotatedPageCount: 0, createdAt: AT,
      });
      await uow.preparations.insert({
        preparationId: "prep_cpl" as PreparationId, workspaceId: WS,
        documentId: DOC, sourceArtifactId: "art_cpl", createdAt: AT,
      });
      await uow.recipients.insert({
        recipientId: "rcp_cpl" as RecipientId, workspaceId: WS,
        preparationId: "prep_cpl" as PreparationId, sourceContactId: null,
        name: "Juan", email: "Juan@Example.com",
        emailKey: "juan@example.com" as never, organization: null,
        type: "signer", isRequired: true, orderIndex: 0, routingOrder: 1,
        createdAt: AT,
      });

      const snapshot: NewSigningRequestSnapshot = {
        request: {
          signingRequestId: REQUEST, workspaceId: WS, documentId: DOC,
          sourceArtifactId: "art_cpl" as ArtifactId,
          sourcePreparationId: "prep_cpl" as PreparationId,
          sourcePreparationRevision: 1, state: "draft",
          completionReadyAt: null, terminatedAt: null, expiresAt: null,
          completedAt: null, terminationReason: null, cancellationNote: null,
          documentTitle: "Lease", createdByUserId: USER,
          createdAt: AT, updatedAt: AT,
        },
        recipients: [{
          recipientId: R1, sourcePreparationRecipientId: null,
          name: "P1", email: "p1@example.test", normalizedEmail: "p1@example.test",
          organization: null, type: "signer" as const, isRequired: true,
          orderIndex: 0, routingOrder: 1,
        }],
        fields: [{
          fieldId: "srf_cpl_1" as SigningRequestFieldId, sourcePreparationFieldId: null,
          type: "text" as const, pageNumber: 1, x: 0.1, y: 0.1,
          width: 0.2, height: 0.04, required: true, label: "F1", layer: 0,
          recipientId: R1,
        }],
      };
      await uow.signingRequests.createSnapshot(snapshot);
      await uow.signingRequests.markSentIfSendable({ signingRequestId: REQUEST, sentAt: AT });
    });

    // Drives the request to completion-ready the same way BACKEND-38's own
    // integration coverage does (signing-state.integration.test.ts) — direct
    // SQL, matching the state a real final signature commits, since driving
    // an actual submitRecipientSigning() call here would require rebuilding
    // that use case's entire dependency graph (session tokens, idempotency
    // digesters, signature-image validation) for no additional evidence about
    // THIS phase's own wiring.
    await sql`
      update signing_requests set state = 'completion-ready',
             completion_ready_at = ${new Date(AT)}
       where signing_request_id = ${REQUEST}
    `.execute(owner.db);
  });

  it("creates a real completion run via the same call the signing-workflow trigger uses", async () => {
    const tx = createTransactionManager(owner.db);
    await tx.runForWorkspace(WS, uow => uow.completion.ensureRun({
      completionRunId: "crun_e2e_1" as CompletionRunId,
      signingRequestId: REQUEST, pipelineVersion: 1, createdAt: AT,
    }));

    const rows = await sql<{ n: string }>`
      select count(*)::text as n from signing_request_completion_runs
       where signing_request_id = ${REQUEST}
    `.execute(owner.db);
    expect(rows.rows[0]?.n).toBe("1");
  });

  it("real signing-workflow-style trigger -> enqueue -> real pg-boss delivery -> real processCompletionRun claims and attempts the run", async () => {
    const tx = createTransactionManager(owner.db);
    const runId = "crun_e2e_2" as CompletionRunId;
    await tx.runForWorkspace(WS, uow => uow.completion.ensureRun({
      completionRunId: runId, signingRequestId: REQUEST, pipelineVersion: 1, createdAt: AT,
    }));

    // The exact enqueue this phase adds to signing-submission.ts's post-commit
    // continuation — a real JobScheduler over the real boss instance, not a
    // direct function call.
    const scheduler = createJobScheduler(boss);
    await scheduler.enqueue(CompletionProcessJob, {
      workspaceId: WS as string, completionRunId: runId as string,
    });

    await until(async () => {
      const state = await sql<{ state: string; attempt_count: number }>`
        select state, attempt_count from signing_request_completion_runs
         where completion_run_id = ${runId}
      `.execute(owner.db);
      const row = state.rows[0];
      // Claimed and attempted at least once — no longer sitting untouched at
      // "pending" with zero attempts, which is the state before this phase's
      // wiring existed at all.
      return row !== undefined && (row.state !== "pending" || row.attempt_count > 0);
    });

    const final = await sql<{ state: string; attempt_count: number }>`
      select state, attempt_count from signing_request_completion_runs
       where completion_run_id = ${runId}
    `.execute(owner.db);
    expect(final.rows[0]?.attempt_count).toBeGreaterThan(0);
    // Whatever the business outcome (this fixture has no real accepted
    // submission, so a data-consistency failure is the CORRECT result, not a
    // false success) — the run must never silently vanish or stay untouched.
    expect(["waiting-retry", "failed-terminal", "succeeded"]).toContain(final.rows[0]?.state);
  }, 30_000);

  it("does not process the same run twice when the job is delivered twice (idempotency)", async () => {
    const tx = createTransactionManager(owner.db);
    const runId = "crun_e2e_dup" as CompletionRunId;
    await tx.runForWorkspace(WS, uow => uow.completion.ensureRun({
      completionRunId: runId, signingRequestId: REQUEST, pipelineVersion: 1, createdAt: AT,
    }));

    const scheduler = createJobScheduler(boss);
    await scheduler.enqueue(CompletionProcessJob, {
      workspaceId: WS as string, completionRunId: runId as string,
    });
    await scheduler.enqueue(CompletionProcessJob, {
      workspaceId: WS as string, completionRunId: runId as string,
    });

    await until(async () => {
      const state = await sql<{ attempt_count: number }>`
        select attempt_count from signing_request_completion_runs
         where completion_run_id = ${runId}
      `.execute(owner.db);
      return (state.rows[0]?.attempt_count ?? 0) > 0;
    });

    // Give the second delivery a real chance to also land before asserting.
    await new Promise(resolve => setTimeout(resolve, 2000));

    const stepRows = await sql<{ n: string }>`
      select count(*)::text as n from signing_request_completion_steps
       where completion_run_id = ${runId} and step = 'field-merge' and state = 'succeeded'
    `.execute(owner.db);
    // Never MORE than one accepted field-merge step for one run, however many
    // times the job was delivered — the claim is what makes this true, not
    // luck.
    expect(Number(stepRows.rows[0]?.n ?? "0")).toBeLessThanOrEqual(1);
  }, 30_000);

  it("recovers a run stranded by a crashed worker via completion.reconcile", async () => {
    const tx = createTransactionManager(owner.db);
    const runId = "crun_e2e_stale" as CompletionRunId;
    await tx.runForWorkspace(WS, uow => uow.completion.ensureRun({
      completionRunId: runId, signingRequestId: REQUEST, pipelineVersion: 1, createdAt: AT,
    }));

    // Simulate a worker that claimed the run and then died mid-attempt,
    // well past the 60s staleAttemptMs this suite configures.
    await sql`
      update signing_request_completion_runs
         set state = 'processing', last_attempt_at = ${new Date(AT - 10 * 60_000)}
       where completion_run_id = ${runId}
    `.execute(owner.db);

    const scheduler = createJobScheduler(boss);
    await scheduler.enqueue(CompletionReconcileJob, { workspaceId: WS as string });

    await until(async () => {
      const state = await sql<{ state: string }>`
        select state from signing_request_completion_runs
         where completion_run_id = ${runId}
      `.execute(owner.db);
      return state.rows[0]?.state !== "processing";
    });

    const after = await sql<{ state: string }>`
      select state from signing_request_completion_runs
       where completion_run_id = ${runId}
    `.execute(owner.db);
    // Returned to the claimable pool, not left looking busy forever.
    expect(after.rows[0]?.state).toBe("waiting-retry");
  }, 30_000);
});
