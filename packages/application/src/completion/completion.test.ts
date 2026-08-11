// The completion pipeline orchestration (BACKEND-38).

import { describe, it, expect, beforeEach } from "vitest";
import type { WorkspaceId, DocumentId, UserId } from "@lagda/contracts";
import type {
  ArtifactId, PreparationId, SigningRequestId, SigningRequestRecipientId,
  CompletionRunId,
} from "../common/ports/index.js";
import {
  FixedClock, FakeTransactionManager, InMemoryStore, SequentialCompletionIds,
} from "../test-support/fakes.js";
import {
  ensureCompletionRun, processCompletionRun, reconcileCompletionRuns,
  type CompletionDependencies,
} from "./completion.js";

const WS = "ws_1" as WorkspaceId;
const REQUEST = "sr_1" as SigningRequestId;
const AT = 1_760_000_000_000;

interface Harness {
  readonly store: InMemoryStore;
  readonly deps: CompletionDependencies;
}

function harness(): Harness {
  const store = new InMemoryStore();
  return {
    store,
    deps: {
      transactions: new FakeTransactionManager(store),
      clock: new FixedClock(AT),
      ids: new SequentialCompletionIds(),
      policy: { staleAttemptMs: 300_000, reconcileBatchSize: 50 },
    },
  };
}

function seed(h: Harness, state = "completion-ready"): void {
  h.store.signingRequests.push({
    signingRequestId: REQUEST, workspaceId: WS,
    documentId: "doc_1" as DocumentId, sourceArtifactId: "art_1" as ArtifactId,
    sourcePreparationId: "prep_1" as PreparationId, sourcePreparationRevision: 1,
    state: state as never,
    completionReadyAt: state === "completion-ready" ? AT : null,
    terminatedAt: null, terminationReason: null, cancellationNote: null,
    documentTitle: "Office Lease", createdByUserId: "usr_1" as UserId,
    createdAt: AT, updatedAt: AT,
  });
  h.store.signingRequestRecipients.push({
    recipientId: "r1" as SigningRequestRecipientId,
    sourcePreparationRecipientId: null,
    name: "Maria", email: "m@example.test", normalizedEmail: "m@example.test",
    organization: null, type: "signer", isRequired: true,
    orderIndex: 0, routingOrder: 1,
  });
  h.store.snapshotOwners.set("r1", REQUEST);
  // The EXACT artifact the request froze. Its presence is a completion
  // precondition, so a fixture without it fails for the wrong reason.
  h.store.artifacts.push({
    artifactId: "art_1" as ArtifactId, workspaceId: WS,
    documentId: "doc_1" as DocumentId, artifactType: "original",
    storageReference: "artifacts/ws_1/art_1.pdf" as never,
    mediaType: "application/pdf", sizeBytes: 12,
    digestAlgorithm: "sha-256", digest: "a".repeat(64) as never,
    pageCount: 4, rotatedPageCount: 0, createdAt: AT,
  });
  h.store.activations.push({
    signingRequestId: String(REQUEST),
    recipientId: "r1" as SigningRequestRecipientId,
    state: "signed", activatedAt: AT, signedAt: AT,
    submissionId: "sub_1" as never, declinedAt: null, declineReason: null,
  });
}

let h: Harness;
beforeEach(() => { h = harness(); });

// ── Ensuring a run ───────────────────────────────────────────────────────────

describe("ensuring a completion run", () => {
  it("creates one and returns it", async () => {
    seed(h);
    const run = await ensureCompletionRun(
      { workspaceId: WS, signingRequestId: REQUEST }, h.deps);

    expect(run.signingRequestId).toBe(REQUEST);
    expect(run.state).toBe("pending");
    expect(run.pipelineVersion).toBe(1);
    expect(h.store.completionRuns).toHaveLength(1);
  });

  it("is idempotent — the same run, however many calls", async () => {
    // §14, §138, §240. One logical completion per request; a duplicate trigger
    // converges rather than forking.
    seed(h);
    const first = await ensureCompletionRun(
      { workspaceId: WS, signingRequestId: REQUEST }, h.deps);
    const second = await ensureCompletionRun(
      { workspaceId: WS, signingRequestId: REQUEST }, h.deps);

    expect(second.completionRunId).toBe(first.completionRunId);
    expect(h.store.completionRuns).toHaveLength(1);
  });
});

// ── Processing ───────────────────────────────────────────────────────────────

describe("processing a completion run", () => {
  const runId = (): CompletionRunId => {
    const run = h.store.completionRuns[0];
    if (run === undefined) throw new Error("no run");
    return run.completionRunId;
  };

  it("claims a claimable run exactly once", async () => {
    // §63, §241. Two workers handed the same job: one claim, one refusal.
    seed(h);
    await ensureCompletionRun({ workspaceId: WS, signingRequestId: REQUEST }, h.deps);

    const first = await processCompletionRun({ workspaceId: WS, runId: runId() }, h.deps);
    expect(first.outcome).not.toBe("not-claimable");

    const run = h.store.completionRuns[0];
    if (run !== undefined) run.state = "processing";
    const second = await processCompletionRun({ workspaceId: WS, runId: runId() }, h.deps);
    expect(second.outcome).toBe("not-claimable");
  });

  it("cannot report success, because the seal step has no implementation", async () => {
    // §22, §176, §178, §309. A pass-through merger or a no-op sealer would make
    // this succeed and mark a request completed with no document behind it —
    // the one failure that cannot be walked back.
    seed(h);
    await ensureCompletionRun({ workspaceId: WS, signingRequestId: REQUEST }, h.deps);

    const result = await processCompletionRun({ workspaceId: WS, runId: runId() }, h.deps);
    expect(result.outcome).toBe("claimed-and-blocked");

    // And the run went BACK to the claimable pool: this is a build that cannot
    // do the work, not data that cannot be completed.
    expect(h.store.completionRuns[0]?.state).toBe("waiting-retry");
    expect(h.store.completionRuns[0]?.failureCode).toBe("sealer-unavailable");
    expect(h.store.completionSteps).toHaveLength(0);
  });

  it("counts the attempt", async () => {
    seed(h);
    await ensureCompletionRun({ workspaceId: WS, signingRequestId: REQUEST }, h.deps);
    await processCompletionRun({ workspaceId: WS, runId: runId() }, h.deps);
    expect(h.store.completionRuns[0]?.attemptCount).toBe(1);
    expect(h.store.completionRuns[0]?.startedAt).toBe(AT);
  });

  it("fails TERMINALLY when the facts no longer support readiness", async () => {
    // §6, §244. The state is a projection; the submissions are the evidence.
    // Deterministic corruption is not retried forever.
    seed(h);
    await ensureCompletionRun({ workspaceId: WS, signingRequestId: REQUEST }, h.deps);
    const activation = h.store.activations[0];
    if (activation !== undefined) activation.submissionId = null;

    const result = await processCompletionRun({ workspaceId: WS, runId: runId() }, h.deps);
    expect(result.outcome).toBe("failed");
    expect(result.failureCode).toBe("missing-submission");
    expect(h.store.completionRuns[0]?.state).toBe("failed-terminal");
  });

  it("fails TERMINALLY when the request is not completion-ready", async () => {
    seed(h, "sent");
    await ensureCompletionRun({ workspaceId: WS, signingRequestId: REQUEST }, h.deps);

    const result = await processCompletionRun({ workspaceId: WS, runId: runId() }, h.deps);
    expect(result.failureCode).toBe("not-completion-ready");
    expect(h.store.completionRuns[0]?.state).toBe("failed-terminal");
  });

  it("never marks the request completed", async () => {
    // §21, §175, §265, and the point of the whole command.
    seed(h);
    await ensureCompletionRun({ workspaceId: WS, signingRequestId: REQUEST }, h.deps);
    await processCompletionRun({ workspaceId: WS, runId: runId() }, h.deps);

    expect(h.store.signingRequests[0]?.state).toBe("completion-ready");
  });

  it("modifies no signing fact", async () => {
    // §36, §219, §262. A completion failure never touches what anybody signed.
    seed(h);
    await ensureCompletionRun({ workspaceId: WS, signingRequestId: REQUEST }, h.deps);
    const before = JSON.stringify(h.store.activations);

    await processCompletionRun({ workspaceId: WS, runId: runId() }, h.deps);
    expect(JSON.stringify(h.store.activations)).toBe(before);
  });
});

// ── Reconciliation ───────────────────────────────────────────────────────────

describe("completion reconciliation", () => {
  it("gives a stranded completion-ready request a run", async () => {
    // §131, §269. The trigger was lost to a crash, or the request reached
    // readiness before this pipeline existed. Manual repair is not the
    // mechanism that prevents a stranded request.
    seed(h);
    expect(h.store.completionRuns).toHaveLength(0);

    const result = await reconcileCompletionRuns(WS, h.deps);
    expect(result.runsCreated).toBe(1);
    expect(h.store.completionRuns).toHaveLength(1);
  });

  it("creates nothing for a request that already has one", async () => {
    seed(h);
    await ensureCompletionRun({ workspaceId: WS, signingRequestId: REQUEST }, h.deps);

    const result = await reconcileCompletionRuns(WS, h.deps);
    expect(result.runsCreated).toBe(0);
    expect(h.store.completionRuns).toHaveLength(1);
  });

  it("creates nothing for a request that is not completion-ready", async () => {
    seed(h, "sent");
    const result = await reconcileCompletionRuns(WS, h.deps);
    expect(result.runsCreated).toBe(0);
  });

  it("returns an abandoned attempt to the claimable pool", async () => {
    // §133, §270. Without this a crashed worker leaves the run in `processing`
    // forever, looking busy, and no other worker will touch it.
    seed(h);
    await ensureCompletionRun({ workspaceId: WS, signingRequestId: REQUEST }, h.deps);
    const run = h.store.completionRuns[0];
    if (run !== undefined) {
      run.state = "processing";
      run.lastAttemptAt = AT - 600_000;
    }

    const result = await reconcileCompletionRuns(WS, h.deps);
    expect(result.runsAbandoned).toBe(1);
    expect(h.store.completionRuns[0]?.state).toBe("waiting-retry");
    expect(h.store.completionRuns[0]?.failureCode).toBe("attempt-abandoned");
  });

  it("leaves a RECENT attempt alone", async () => {
    seed(h);
    await ensureCompletionRun({ workspaceId: WS, signingRequestId: REQUEST }, h.deps);
    const run = h.store.completionRuns[0];
    if (run !== undefined) {
      run.state = "processing";
      run.lastAttemptAt = AT - 1_000;
    }

    const result = await reconcileCompletionRuns(WS, h.deps);
    expect(result.runsAbandoned).toBe(0);
    expect(h.store.completionRuns[0]?.state).toBe("processing");
  });
});
