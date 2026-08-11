// The signing workflow use cases (BACKEND-37).
//
// These exercise the ADVANCE, the DECLINE and the CANCEL against the in-memory
// unit of work. The concurrency and row-level-security claims are asserted
// against real PostgreSQL in `signing-state.integration.test.ts` — a fake
// cannot prove a conditional UPDATE serializes, and pretending otherwise is
// the failure `feedback_run_the_built_artefact` describes.

import { describe, it, expect, beforeEach } from "vitest";
import type {
  ArtifactId, PreparationId, RecipientSubmissionId,
  SigningRequestId, SigningRequestRecipientId, SigningWorkflowIntentId,
} from "../common/ports/index.js";
import type {
  WorkspaceId, RecipientType, DocumentId, UserId,
} from "@lagda/contracts";
import {
  FixedClock, FakeTransactionManager, InMemoryStore,
  SequentialSigningWorkflowIds, SequentialSigningAccessIds,
  SequentialCompletionIds,
} from "../test-support/fakes.js";
import {
  advanceSigningWorkflow, cancelSigningRequest, reconcileSigningWorkflow,
  applyRecipientSubmissionToWorkflow,
  SigningWorkflowIntegrityError, SigningRequestNotCancellableError,
  type SigningWorkflowDependencies,
} from "./signing-workflow.js";

const WS = "ws_1" as WorkspaceId;
const REQUEST = "sr_1" as SigningRequestId;
const OWNER = "usr_owner" as UserId;
const AT = 1_760_000_000_000;

interface Harness {
  readonly store: InMemoryStore;
  readonly deps: SigningWorkflowDependencies;
}

function harness(): Harness {
  const store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);
  const clock = new FixedClock(AT);
  return {
    store,
    deps: {
      transactions, clock,
      workflowIds: new SequentialSigningWorkflowIds(),
      completionIds: new SequentialCompletionIds(),
      access: {
        ids: new SequentialSigningAccessIds(),
        // A recording token factory would add nothing here: what these tests
        // assert is THAT the BACKEND-33 provisioner ran and left a grant and an
        // intent, not what the credential looked like. Its bytes are BACKEND-33's
        // test's subject and are never asserted twice.
        tokens: { issue: () => ({ raw: "raw", digest: "d".repeat(64) as never }),
          digest: () => null },
        sealer: { keyVersion: "v1", seal: (plaintext: string) => plaintext as never },
        links: { build: (raw: string) => `https://app.lagda.test/sign/${raw}` },
        policy: { bootstrapLifetimeMs: 7 * 24 * 3_600_000 },
      },
    },
  };
}

interface Spec {
  readonly id: string;
  readonly order: number;
  readonly state: "waiting" | "active" | "signed" | "declined";
  readonly type?: RecipientType;
  readonly required?: boolean;
}

function seed(h: Harness, people: readonly Spec[], state = "sent"): void {
  h.store.workspaces.set(WS, { workspaceId: WS, name: "Ayala Law", createdAt: AT });
  h.store.memberships.push({
    memberId: "wm_1" as never, workspaceId: WS, userId: OWNER,
    role: "owner", createdAt: AT,
  });
  h.store.signingRequests.push({
    signingRequestId: REQUEST, workspaceId: WS,
    documentId: "doc_1" as DocumentId, sourceArtifactId: "art_1" as ArtifactId,
    sourcePreparationId: "prep_1" as PreparationId, sourcePreparationRevision: 1,
    state: state as never,
    completionReadyAt: null, terminatedAt: null,
    completedAt: null,
    terminationReason: null, cancellationNote: null,
    documentTitle: "Office Lease", createdByUserId: OWNER,
    createdAt: AT, updatedAt: AT,
  });
  for (const spec of people) {
    h.store.signingRequestRecipients.push({
      recipientId: spec.id as SigningRequestRecipientId,
      sourcePreparationRecipientId: null,
      name: `Person ${spec.id}`, email: `${spec.id}@example.test`,
      normalizedEmail: `${spec.id}@example.test`, organization: null,
      type: spec.type ?? "signer", isRequired: spec.required ?? true,
      orderIndex: 0, routingOrder: spec.order,
    });
    // The fake resolves snapshot ownership through this map, exactly as the
    // real repository resolves it through the composite key.
    h.store.snapshotOwners.set(spec.id, REQUEST);
    h.store.activations.push({
      signingRequestId: String(REQUEST),
      recipientId: spec.id as SigningRequestRecipientId,
      state: spec.state,
      activatedAt: spec.state === "waiting" ? null : AT,
      signedAt: spec.state === "signed" ? AT : null,
      submissionId: spec.state === "signed" ? ("sub_x" as RecipientSubmissionId) : null,
      declinedAt: spec.state === "declined" ? AT : null,
      declineReason: spec.state === "declined" ? "not-agree" : null,
    });
  }
}

function intent(h: Harness, recipientId: string, trigger: "submission" | "decline"): void {
  h.store.workflowIntents.push({
    intentId: `swi_${recipientId}` as SigningWorkflowIntentId,
    workspaceId: WS, signingRequestId: REQUEST,
    recipientId: recipientId as SigningRequestRecipientId,
    trigger, submissionId: null, createdAt: AT,
    appliedAt: null, attempts: 0, lastFailureCode: null,
  });
}

const advance = (h: Harness) =>
  advanceSigningWorkflow({ workspaceId: WS, signingRequestId: REQUEST }, h.deps);

let h: Harness;
beforeEach(() => { h = harness(); });

// ── Parallel ─────────────────────────────────────────────────────────────────

describe("parallel routing", () => {
  it("leaves the other signer active and the request partially completed", () => {
    seed(h, [{ id: "a", order: 1, state: "signed" }, { id: "b", order: 1, state: "active" }]);
    intent(h, "a", "submission");

    return advance(h).then(result => {
      expect(result.outcome).toBe("no-change");
      expect(h.store.activations.find(r => r.recipientId === "b")?.state).toBe("active");
      expect(h.store.signingRequests[0]?.state).toBe("partially-completed");
      // No credential was minted for anybody: nobody activated.
      expect(h.store.signingAccessGrants).toHaveLength(0);
    });
  });

  it("becomes completion-ready when the last required signer signs", async () => {
    seed(h, [{ id: "a", order: 1, state: "signed" }, { id: "b", order: 1, state: "signed" }]);
    intent(h, "b", "submission");

    const result = await advance(h);
    expect(result.outcome).toBe("completion-ready");
    expect(h.store.signingRequests[0]?.state).toBe("completion-ready");
    expect(h.store.signingRequests[0]?.completionReadyAt).toBe(AT);
    // The distinction the command exists for.
    expect(h.store.signingRequests[0]?.state).not.toBe("completed");
  });

  it("is not held open by a carbon-copy", async () => {
    seed(h, [
      { id: "a", order: 1, state: "signed" },
      { id: "cc", order: 1, state: "active", type: "carbon-copy" },
    ]);
    intent(h, "a", "submission");

    expect((await advance(h)).outcome).toBe("completion-ready");
  });
});

// ── Sequential ───────────────────────────────────────────────────────────────

describe("sequential routing", () => {
  it("activates the next cohort and provisions it through BACKEND-33", async () => {
    seed(h, [
      { id: "a", order: 1, state: "signed" }, { id: "b", order: 2, state: "waiting" },
    ]);
    intent(h, "a", "submission");

    const result = await advance(h);
    expect(result.outcome).toBe("cohort-activated");
    expect(result.activatedCount).toBe(1);
    expect(result.provisionedCount).toBe(1);

    expect(h.store.activations.find(r => r.recipientId === "b")?.state).toBe("active");
    // ONE grant and ONE delivery intent, written by the provisioner Send uses.
    // A second implementation of credential generation is what §49 forbids and
    // what these two assertions would not distinguish on their own — the shared
    // function is asserted by `tests/architecture/signing-state.test.ts`.
    expect(h.store.signingAccessGrants).toHaveLength(1);
    expect(h.store.deliveryIntents).toHaveLength(1);
    expect(h.store.deliveryIntents[0]?.recipientEmail).toBe("b@example.test");
  });

  it("does NOT activate the next cohort on a partial one", async () => {
    seed(h, [
      { id: "a", order: 1, state: "signed" },
      { id: "b", order: 1, state: "active" },
      { id: "c", order: 2, state: "waiting" },
    ]);
    intent(h, "a", "submission");

    await advance(h);
    expect(h.store.activations.find(r => r.recipientId === "c")?.state).toBe("waiting");
    expect(h.store.signingAccessGrants).toHaveLength(0);
  });

  it("activates the next cohort EXACTLY ONCE across repeated advances", async () => {
    // §59, §236, §242. The advance is a function of durable facts, so the
    // second run sees `c` as active rather than waiting and does nothing.
    seed(h, [
      { id: "a", order: 1, state: "signed" },
      { id: "b", order: 1, state: "signed" },
      { id: "c", order: 2, state: "waiting" },
    ]);
    intent(h, "a", "submission");
    intent(h, "b", "submission");

    await advance(h);
    await advance(h);
    await advance(h);

    expect(h.store.signingAccessGrants).toHaveLength(1);
    expect(h.store.deliveryIntents).toHaveLength(1);
  });

  it("clears every outstanding intent for the request in one pass", async () => {
    seed(h, [
      { id: "a", order: 1, state: "signed" }, { id: "b", order: 1, state: "signed" },
    ]);
    intent(h, "a", "submission");
    intent(h, "b", "submission");

    const result = await advance(h);
    expect(result.intentsApplied).toBe(2);
    expect(h.store.workflowIntents.every(row => row.appliedAt !== null)).toBe(true);
  });
});

// ── Decline ──────────────────────────────────────────────────────────────────

describe("decline", () => {
  it("ends the request for everyone and revokes access", async () => {
    // OD-017, answered by the product: `status-map.ts` calls `declined`
    // terminal, and the C37 resolver's reason is "A participant declined."
    seed(h, [
      { id: "a", order: 1, state: "declined" }, { id: "b", order: 1, state: "active" },
    ]);
    intent(h, "a", "decline");
    h.store.signingAccessGrants.push({
      grantId: "sag_x" as never, workspaceId: WS, signingRequestId: REQUEST,
      recipientId: "b" as SigningRequestRecipientId,
      credentialDigest: "d".repeat(64) as never, createdAt: AT, expiresAt: AT + 1,
    });

    const result = await advance(h);
    expect(result.outcome).toBe("declined");
    expect(h.store.signingRequests[0]?.state).toBe("declined");
    expect(h.store.signingRequests[0]?.terminationReason).toBe("declined");
    // §85. Denied by state AND revoked, so a forwarded link stops resolving at
    // the lookup rather than at the policy.
    expect(h.store.signingAccessGrants).toHaveLength(0);
  });

  it("does not activate a waiting cohort on the way out", async () => {
    seed(h, [
      { id: "a", order: 1, state: "declined" }, { id: "b", order: 2, state: "waiting" },
    ]);
    intent(h, "a", "decline");

    await advance(h);
    expect(h.store.activations.find(r => r.recipientId === "b")?.state).toBe("waiting");
    expect(h.store.deliveryIntents).toHaveLength(0);
  });
});

// ── Terminal states ──────────────────────────────────────────────────────────

describe("a request that is no longer advanceable", () => {
  it("clears its intents without touching anybody", async () => {
    seed(h, [{ id: "a", order: 1, state: "signed" }], "cancelled");
    intent(h, "a", "submission");

    const result = await advance(h);
    expect(result.outcome).toBe("not-advanceable");
    expect(result.intentsApplied).toBe(1);
    expect(h.store.signingRequests[0]?.state).toBe("cancelled");
  });
});

// ── Integrity ────────────────────────────────────────────────────────────────

describe("integrity failures", () => {
  it("leaves the intents OUTSTANDING with a bounded code", async () => {
    // §139. A corrupt snapshot may be repairable, and marking the intents
    // applied would hide a broken request forever.
    seed(h, [{ id: "a", order: 1, state: "active", type: "viewer" }]);
    intent(h, "a", "submission");

    const result = await advance(h);
    expect(result.outcome).toBe("integrity-failure");
    expect(result.intentsApplied).toBe(0);
    const row = h.store.workflowIntents[0];
    expect(row?.appliedAt).toBeNull();
    expect(row?.lastFailureCode).toBe("routing-no-required-participants");
    // A CODE, not a message. Nothing unbounded reaches this column.
    expect(row?.lastFailureCode?.length).toBeLessThanOrEqual(64);
  });

  it("refuses to mark a WAITING recipient signed", async () => {
    // §28. There is no pathway to SIGNED that skips a turn.
    seed(h, [{ id: "a", order: 1, state: "waiting" }]);
    const uow = {
      workflow: {
        markSignedFromSubmission: () => Promise.resolve(false),
        getState: () => Promise.resolve("waiting" as const),
        markDeclined: () => Promise.resolve(false),
        enqueueAdvance: () => Promise.resolve(true),
      },
    } as never;

    await expect(applyRecipientSubmissionToWorkflow(uow, {
      submissionId: "sub_1" as RecipientSubmissionId,
      acceptedAt: AT,
      intentId: "swi_1" as SigningWorkflowIntentId,
      newEvidenceEventId: (() => {
        let n = 0;
        return () => `ev_${String(++n)}` as never;
      })(),
    })).rejects.toBeInstanceOf(SigningWorkflowIntegrityError);
  });
});

// ── Reconciliation ───────────────────────────────────────────────────────────

describe("reconciliation", () => {
  it("applies an advance nobody ever ran", async () => {
    // §175, §245, §296. The process died between committing a signature and
    // applying its consequences; nothing manual is required to recover.
    seed(h, [
      { id: "a", order: 1, state: "signed" }, { id: "b", order: 2, state: "waiting" },
    ]);
    intent(h, "a", "submission");

    const result = await reconcileSigningWorkflow({
      ...h.deps, policy: { batchSize: 50, maxAttempts: 5 },
    });
    expect(result).toEqual({ examined: 1, advanced: 1, failed: 0 });
    expect(h.store.activations.find(r => r.recipientId === "b")?.state).toBe("active");
  });

  it("sweeps one request once even with several outstanding intents", async () => {
    seed(h, [
      { id: "a", order: 1, state: "signed" }, { id: "b", order: 1, state: "signed" },
    ]);
    intent(h, "a", "submission");
    intent(h, "b", "submission");

    const result = await reconcileSigningWorkflow({
      ...h.deps, policy: { batchSize: 50, maxAttempts: 5 },
    });
    expect(result.examined).toBe(1);
  });

  it("stops sweeping an intent that has failed too many times", async () => {
    // It stays in the table with its failure code — a signal an operator can
    // act on, rather than an infinite retry that starves everything behind it.
    seed(h, [{ id: "a", order: 1, state: "active", type: "viewer" }]);
    intent(h, "a", "submission");
    const row = h.store.workflowIntents[0];
    if (row !== undefined) row.attempts = 5;

    const result = await reconcileSigningWorkflow({
      ...h.deps, policy: { batchSize: 50, maxAttempts: 5 },
    });
    expect(result.examined).toBe(0);
  });
});

// ── Cancellation ─────────────────────────────────────────────────────────────

describe("sender cancellation", () => {
  const cancel = (reason = "Client withdrew the offer") => cancelSigningRequest({
    actor: { userId: OWNER } as never,
    workspaceId: WS, signingRequestId: String(REQUEST), reason,
  }, h.deps);

  it("ends an active request and revokes grants and sessions", async () => {
    seed(h, [{ id: "a", order: 1, state: "active" }]);
    h.store.signingAccessGrants.push({
      grantId: "sag_x" as never, workspaceId: WS, signingRequestId: REQUEST,
      recipientId: "a" as SigningRequestRecipientId,
      credentialDigest: "d".repeat(64) as never, createdAt: AT, expiresAt: AT + 1,
    });
    h.store.recipientSessions.push({
      signingSessionId: "rss_1" as never, workspaceId: WS,
      signingRequestId: REQUEST, recipientId: "a" as SigningRequestRecipientId,
      sourceGrantId: "sag_x" as never, tokenDigest: "t".repeat(64) as never,
      csrfTokenDigest: "c".repeat(64) as never, authenticationMethod: "link-only",
      authenticatedAt: AT, createdAt: AT, expiresAt: AT + 1,
    });

    const result = await cancel();
    expect(result.state).toBe("cancelled");
    expect(result.revokedGrantCount).toBe(1);
    expect(result.revokedSessionCount).toBe(1);
    expect(h.store.signingRequests[0]?.cancellationNote).toBe("Client withdrew the offer");
  });

  it("REFUSES once the request is completion-ready", async () => {
    // §95, answered by the product: cancel is offered only while the
    // transaction is active, and a request whose signatures are all collected
    // is not. Allowing it would withdraw a document people have already signed.
    seed(h, [{ id: "a", order: 1, state: "signed" }], "completion-ready");

    await expect(cancel()).rejects.toBeInstanceOf(SigningRequestNotCancellableError);
    expect(h.store.signingRequests[0]?.state).toBe("completion-ready");
  });

  it("refuses a member who lacks the capability", async () => {
    seed(h, [{ id: "a", order: 1, state: "active" }]);
    const membership = h.store.memberships[0];
    if (membership !== undefined) h.store.memberships[0] = { ...membership, role: "member" };

    await expect(cancel()).rejects.toThrow();
    expect(h.store.signingRequests[0]?.state).toBe("sent");
  });
});

// ── The completion trigger (BACKEND-38, OD-158) ──────────────────────────────

describe("the completion trigger", () => {
  it("creates a CompletionRun in the SAME transaction as readiness", async () => {
    // §49-§55. The window this closes: every signature collected, the request
    // looking finished, and no completion work in existence. It fails silently,
    // which is why the trigger cannot be an event or a best-effort enqueue.
    seed(h, [{ id: "a", order: 1, state: "signed" }]);
    intent(h, "a", "submission");

    expect(h.store.completionRuns).toHaveLength(0);
    const result = await advance(h);

    expect(result.outcome).toBe("completion-ready");
    expect(h.store.completionRuns).toHaveLength(1);
    const run = h.store.completionRuns[0];
    expect(run?.signingRequestId).toBe(REQUEST);
    expect(run?.state).toBe("pending");
    expect(run?.attemptCount).toBe(0);
    // The version travels with the RUN, not with the running build.
    expect(run?.pipelineVersion).toBe(1);
  });

  it("creates exactly ONE run however many times the advance runs", async () => {
    // §138, §139, §240. The uniqueness is what makes a duplicate trigger, a
    // duplicate job and two workers converge rather than fork.
    seed(h, [{ id: "a", order: 1, state: "signed" }]);
    intent(h, "a", "submission");

    await advance(h);
    await advance(h);
    await advance(h);

    expect(h.store.completionRuns).toHaveLength(1);
  });

  it("creates NO run while a signature is still outstanding", async () => {
    seed(h, [
      { id: "a", order: 1, state: "signed" }, { id: "b", order: 1, state: "active" },
    ]);
    intent(h, "a", "submission");

    await advance(h);
    expect(h.store.completionRuns).toHaveLength(0);
  });

  it("creates NO run for a declined request", async () => {
    seed(h, [
      { id: "a", order: 1, state: "declined" }, { id: "b", order: 1, state: "active" },
    ]);
    intent(h, "a", "decline");

    await advance(h);
    expect(h.store.completionRuns).toHaveLength(0);
  });

  it("leaves the request completion-ready, never completed", async () => {
    // The distinction the whole pipeline exists for: the obligations are
    // satisfied and the document does not exist.
    seed(h, [{ id: "a", order: 1, state: "signed" }]);
    intent(h, "a", "submission");

    await advance(h);
    expect(h.store.signingRequests[0]?.state).toBe("completion-ready");
  });
});
