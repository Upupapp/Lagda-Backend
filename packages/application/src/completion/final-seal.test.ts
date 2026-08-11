// The final-seal step and the finalization transaction (BACKEND-41).
//
// The weight here is on what must NOT happen: no completion before the bytes
// exist, no second authoritative final artifact, no signing after completion,
// and no completion when either input's digest disagrees with what the pipeline
// recorded.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WorkspaceId, DocumentId, UserId, Sha256Digest } from "@lagda/contracts";
import type {
  ArtifactId, PreparationId, SigningRequestId, SigningRequestRecipientId,
  CompletionRunId, SealRequest,
} from "../common/ports/index.js";
import type { StorageKeyStrategy, StorageObjectRef } from "../common/ports/storage.js";
import {
  FixedClock, FakeTransactionManager, InMemoryStore, SequentialCompletionIds,
} from "../test-support/fakes.js";
import {
  isRequestSignableState, isRequestTerminal, SIGNABLE_REQUEST_STATES,
} from "@lagda/core";
import {
  runFinalSealStep, sealFailureCode, type FinalSealDependencies,
} from "./final-seal.js";

const WS = "ws_1" as WorkspaceId;
const DOC = "doc_1" as DocumentId;
const REQUEST = "sr_1" as SigningRequestId;
const RUN = "crn_1" as CompletionRunId;
const R1 = "srr_1" as SigningRequestRecipientId;
const SOURCE = "art_source" as ArtifactId;
const MERGED = "art_merged" as ArtifactId;
const CERT = "art_cert" as ArtifactId;
const AT = Date.parse("2026-08-11T10:00:00.000Z");
/** Deliberately earlier than AT, so completedAt cannot be mistaken for it. */
const SIGNED_AT = Date.parse("2026-08-10T08:00:00.000Z");

const SOURCE_DIGEST = "a".repeat(64) as Sha256Digest;
const MERGED_BYTES = new TextEncoder().encode("%PDF-1.7 merged");
const MERGED_DIGEST = "b".repeat(64) as Sha256Digest;
const CERT_BYTES = new TextEncoder().encode("%PDF-1.7 certificate");
const CERT_DIGEST = "c".repeat(64) as Sha256Digest;
const FINAL_BYTES = new TextEncoder().encode("%PDF-1.7 final sealed composed");
const FINAL_DIGEST = "d".repeat(64) as Sha256Digest;

function storage() {
  const objects = new Map<string, Uint8Array>([
    ["artifacts:ws/merged", MERGED_BYTES],
    ["artifacts:ws/cert", CERT_BYTES],
  ]);
  const api = {
    objects,
    failGet: false, failPut: false, missing: false,
    getObject: (ref: StorageObjectRef) => {
      if (api.failGet) return Promise.reject(new Error("storage down"));
      if (api.missing) return Promise.resolve(null);
      const bytes = objects.get(`${ref.zone}:${ref.key}`);
      if (bytes === undefined) return Promise.resolve(null);
      return Promise.resolve({
        ref, sizeBytes: bytes.byteLength, mediaType: "application/pdf",
        // eslint-disable-next-line @typescript-eslint/require-await
        stream: (async function* () { yield bytes; })(),
      });
    },
    putObject: (input: { ref: StorageObjectRef; content: unknown }) => {
      if (api.failPut) return Promise.reject(new Error("storage down"));
      const content = input.content as { bytes: Uint8Array };
      objects.set(`${input.ref.zone}:${input.ref.key}`, content.bytes);
      return Promise.resolve({ ref: input.ref, sizeBytes: content.bytes.byteLength });
    },
    headObject: () => Promise.resolve(null),
    deleteObject: () => Promise.resolve(),
  };
  return api;
}

const keys = {
  artifactKey: ({ artifactId }: { artifactId: ArtifactId }) => ({
    zone: "artifacts", key: `ws/${String(artifactId)}`,
  }),
} as unknown as StorageKeyStrategy;

interface Harness {
  readonly store: InMemoryStore;
  readonly objects: ReturnType<typeof storage>;
  readonly seal: ReturnType<typeof vi.fn>;
  readonly deps: FinalSealDependencies;
}

function harness(): Harness {
  const store = new InMemoryStore();
  const objects = storage();
  const seal = vi.fn((_request: SealRequest) => Promise.resolve({
    sealedDocument: FINAL_BYTES,
    mergedDocumentHash: MERGED_DIGEST,
    completionCertificateHash: CERT_DIGEST,
    signedDocumentHash: FINAL_DIGEST,
    seal: {
      sealScheme: "hash-evidence" as const,
      sealVersion: 1 as const,
      digestAlgorithm: "sha-256" as const,
    },
  }));
  return {
    store, objects, seal,
    deps: {
      transactions: new FakeTransactionManager(store),
      clock: new FixedClock(AT),
      ids: Object.assign(new SequentialCompletionIds(), {
        nextArtifactId: () => "art_final",
        nextSealId: () => "seal_1",
        nextVerificationId: () => "LAGDA-VERIFY-1",
      }),
      storage: objects,
      keys,
      sealer: { seal },
    } as unknown as FinalSealDependencies,
  };
}

function seed(h: Harness, opts: {
  certificateDone?: boolean; mergeDone?: boolean; state?: string;
} = {}): void {
  const { certificateDone = true, mergeDone = true, state = "completion-ready" } = opts;

  h.store.signingRequests.push({
    signingRequestId: REQUEST, workspaceId: WS, documentId: DOC,
    sourceArtifactId: SOURCE,
    sourcePreparationId: "prep_1" as PreparationId, sourcePreparationRevision: 1,
    state: state as never, completionReadyAt: AT - 1000, completedAt: null,
    terminatedAt: null, terminationReason: null, cancellationNote: null,
    documentTitle: "Lease", createdByUserId: "usr_1" as UserId,
    createdAt: AT, updatedAt: AT,
  });

  const artifact = (id: ArtifactId, type: string, key: string, digest: Sha256Digest) => ({
    artifactId: id, workspaceId: WS, documentId: DOC, artifactType: type as never,
    storageReference: key as never, mediaType: "application/pdf", sizeBytes: 10,
    digestAlgorithm: "sha-256" as const, digest,
    pageCount: 2, rotatedPageCount: 0, createdAt: AT,
  });
  h.store.artifacts.push(artifact(SOURCE, "original", "ws/source", SOURCE_DIGEST));
  h.store.artifacts.push(artifact(MERGED, "merged-candidate", "ws/merged", MERGED_DIGEST));
  h.store.artifacts.push(
    artifact(CERT, "completion-certificate", "ws/cert", CERT_DIGEST));

  h.store.completionRuns.push({
    completionRunId: RUN, workspaceId: WS, signingRequestId: REQUEST,
    state: "processing", pipelineVersion: 1, attemptCount: 1,
    createdAt: AT, startedAt: AT, lastAttemptAt: AT, succeededAt: null,
    failureStep: null, failureCode: null,
  } as never);

  if (mergeDone) {
    h.store.completionSteps.push({
      completionStepId: "cst_fm" as never, completionRunId: RUN, workspaceId: WS,
      step: "field-merge", state: "succeeded", outputArtifactId: MERGED,
      attemptCount: 1, succeededAt: AT, failureCode: null,
    } as never);
  }
  if (certificateDone) {
    h.store.completionSteps.push({
      completionStepId: "cst_c" as never, completionRunId: RUN, workspaceId: WS,
      step: "certificate", state: "succeeded", outputArtifactId: CERT,
      attemptCount: 1, succeededAt: AT, failureCode: null,
    } as never);
  }

  h.store.signingRequestRecipients.push({
    recipientId: R1, sourcePreparationRecipientId: null,
    name: "Juan", email: "juan@example.com", normalizedEmail: "juan@example.com",
    organization: null, type: "signer", isRequired: true,
    orderIndex: 0, routingOrder: 1,
  });
  h.store.snapshotOwners.set(String(R1), REQUEST);
  h.store.submissions.push({
    submissionId: "sub_1", workspaceId: String(WS),
    signingRequestId: String(REQUEST), recipientId: String(R1),
    acceptedAt: SIGNED_AT, authenticationMethod: "link-only",
    valueCount: 0, representations: [], values: [],
  });
}

const run = (h: Harness) => runFinalSealStep(
  { workspaceId: WS, runId: RUN, signingRequestId: REQUEST }, h.deps);

const request = (h: Harness) =>
  h.store.signingRequests.find(r => r.signingRequestId === REQUEST);

let h: Harness;
beforeEach(() => { h = harness(); });

describe("the happy path", () => {
  it("seals, uploads, records everything and completes the request", async () => {
    seed(h);
    const result = await run(h);

    expect(result.outcome).toBe("completed");
    expect(result.finalArtifactId).toBe("art_final");

    const final = h.store.artifacts.find(a => a.artifactId === "art_final");
    expect(final?.artifactType).toBe("sealed");
    expect(final?.digest).toBe(FINAL_DIGEST);
    expect(final?.sizeBytes).toBe(FINAL_BYTES.byteLength);

    expect(request(h)?.state).toBe("completed");
    expect(h.store.completions).toHaveLength(1);
    expect(h.objects.objects.has("artifacts:ws/art_final")).toBe(true);
  });

  it("records the SOURCE digest as the original hash, never the merged one", async () => {
    // The §0 trap. `originalDocumentHash` means "the original file at upload"
    // and feeds the record BACKEND-42 exposes publicly.
    seed(h);
    await run(h);
    const seal = h.store.seals?.[0];
    expect(seal?.originalDocumentHash).toBe(SOURCE_DIGEST);
    expect(seal?.originalDocumentHash).not.toBe(MERGED_DIGEST);
    expect(seal?.signedDocumentHash).toBe(FINAL_DIGEST);
  });

  it("hands the sealer BOTH accepted inputs, resolved by identity", async () => {
    seed(h);
    // A newer merged-candidate must not be picked up (§6, §119).
    h.store.artifacts.push({
      artifactId: "art_newer" as ArtifactId, workspaceId: WS, documentId: DOC,
      artifactType: "merged-candidate",
      storageReference: "ws/newer" as never, mediaType: "application/pdf",
      sizeBytes: 99, digestAlgorithm: "sha-256", digest: "e".repeat(64) as Sha256Digest,
      pageCount: 2, rotatedPageCount: 0, createdAt: AT + 1,
    });

    await run(h);
    const sent = h.seal.mock.calls[0]?.[0] as SealRequest;
    expect(Array.from(sent.mergedDocument)).toEqual(Array.from(MERGED_BYTES));
    expect(Array.from(sent.completionCertificate)).toEqual(Array.from(CERT_BYTES));
  });

  it("stamps completedAt from the finalization transaction, not any signing time", async () => {
    // §97/§267. The only signer signed a DAY earlier in this fixture.
    seed(h);
    const result = await run(h);
    expect(result.completedAt).toBe(AT);
    expect(result.completedAt).not.toBe(SIGNED_AT);
    expect(request(h)?.completedAt).toBe(AT);
  });

  it("creates exactly one verification identity", async () => {
    seed(h);
    const result = await run(h);
    expect(result.verificationId).toBe("LAGDA-VERIFY-1");
  });

  it("REVOKES live grants and sessions — layer one of two", async () => {
    // Owner decision: deny by state AND revoke. This asserts ONLY the
    // revocation; the state denial is asserted separately below, on purpose.
    // Testing them together would let either control rot behind the other.
    seed(h);
    h.store.signingAccessGrants.push({
      grantId: "sag_1", workspaceId: String(WS),
      signingRequestId: String(REQUEST), recipientId: String(R1),
    } as never);
    h.store.recipientSessions.push({
      signingSessionId: "rss_1", workspaceId: WS,
      signingRequestId: REQUEST, recipientId: R1,
    } as unknown as (typeof h.store.recipientSessions)[number]);

    await run(h);

    expect(h.store.signingAccessGrants.filter(
      g => String(g.signingRequestId) === String(REQUEST))).toHaveLength(0);
    expect(h.store.recipientSessions.filter(
      s => String(s.signingRequestId) === String(REQUEST))).toHaveLength(0);
  });

  it("leaves the source, merged and certificate artifacts untouched", async () => {
    // §231-§233.
    seed(h);
    const before = JSON.stringify(
      h.store.artifacts.filter(a => a.artifactId !== "art_final"));
    await run(h);
    const after = JSON.stringify(
      h.store.artifacts.filter(a => a.artifactId !== "art_final"));
    expect(after).toBe(before);
  });
});

describe("the lockout's SECOND layer, asserted independently", () => {
  it("denies signing on a completed request by STATE, regardless of credentials", () => {
    // The load-bearing control, and deliberately tested WITHOUT reference to
    // revocation. A recipient holding a session that was somehow never revoked
    // is still refused, because `completed` is not a signable state.
    //
    // `SIGNABLE_REQUEST_STATES` is an ALLOW list, so a state added later cannot
    // accidentally become signable by someone forgetting to deny it.
    expect(isRequestSignableState("completed")).toBe(false);
    expect(SIGNABLE_REQUEST_STATES).toEqual(["sent", "partially-completed"]);
  });

  it("treats a completed request as terminal", () => {
    expect(isRequestTerminal("completed")).toBe(true);
  });
});

describe("nothing claims completion early", () => {
  it("does not complete when the upload fails", async () => {
    // §257. The request must stay completion-ready.
    seed(h);
    h.objects.failPut = true;
    const result = await run(h);

    expect(result).toMatchObject({
      outcome: "failed", failureCode: "storage-unavailable",
    });
    expect(request(h)?.state).toBe("completion-ready");
    expect(request(h)?.completedAt).toBeNull();
    expect(h.store.completions).toHaveLength(0);
  });

  it("uploads BEFORE the completion is recorded", async () => {
    // §101. A completion recorded first would assert a document nobody can
    // fetch.
    seed(h);
    const order: string[] = [];
    const put = h.objects.putObject;
    h.objects.putObject = (input) => { order.push("upload"); return put(input); };
    const push = h.store.completions.push.bind(h.store.completions);
    h.store.completions.push = (...rows) => { order.push("complete"); return push(...rows); };

    await run(h);
    expect(order).toEqual(["upload", "complete"]);
  });

  it("does not complete when the sealer fails", async () => {
    seed(h);
    h.seal.mockRejectedValueOnce({ code: "invalid_pdf", retryable: false });
    const result = await run(h);

    expect(result.outcome).toBe("failed");
    expect(request(h)?.state).toBe("completion-ready");
    expect(h.objects.objects.has("artifacts:ws/art_final")).toBe(false);
  });

  it("refuses an empty seal result rather than uploading it", async () => {
    // §119/§254. It would upload cleanly and complete a request whose final
    // artifact is empty.
    seed(h);
    h.seal.mockResolvedValueOnce({
      sealedDocument: new Uint8Array(0),
      mergedDocumentHash: MERGED_DIGEST,
      completionCertificateHash: CERT_DIGEST,
      signedDocumentHash: FINAL_DIGEST,
      seal: { sealScheme: "hash-evidence", sealVersion: 1, digestAlgorithm: "sha-256" },
    });

    const result = await run(h);
    expect(result).toMatchObject({ outcome: "failed", failureCode: "output-missing" });
    expect(request(h)?.state).toBe("completion-ready");
  });
});

describe("input integrity", () => {
  it.each([
    ["merged", "mergedDocumentHash"],
    ["certificate", "completionCertificateHash"],
  ])("refuses when the %s digest disagrees with the record", async (_label, field) => {
    // §15/§246/§248. Storage returned SOMETHING; these prove it returned the
    // exact accepted bytes.
    seed(h);
    h.seal.mockResolvedValueOnce({
      sealedDocument: FINAL_BYTES,
      mergedDocumentHash: MERGED_DIGEST,
      completionCertificateHash: CERT_DIGEST,
      signedDocumentHash: FINAL_DIGEST,
      seal: { sealScheme: "hash-evidence", sealVersion: 1, digestAlgorithm: "sha-256" },
      [field]: "f".repeat(64),
    });

    const result = await run(h);
    expect(result).toMatchObject({
      outcome: "failed", failureCode: "input-inconsistent",
    });
    expect(request(h)?.state).toBe("completion-ready");
    expect(h.objects.objects.has("artifacts:ws/art_final")).toBe(false);
  });

  it("refuses when a required input object is gone", async () => {
    seed(h);
    h.objects.missing = true;
    const result = await run(h);
    expect(result.outcome).toBe("failed");
    expect(request(h)?.state).toBe("completion-ready");
  });
});

describe("preconditions", () => {
  it.each([
    ["field-merge", { mergeDone: false }],
    ["certificate", { certificateDone: false }],
  ])("refuses when %s has not succeeded", async (_label, opts) => {
    seed(h, opts);
    const result = await run(h);
    expect(result.outcome).toBe("failed");
    expect(h.seal).not.toHaveBeenCalled();
    expect(request(h)?.state).toBe("completion-ready");
  });

  it("refuses a request that is not completion-ready", async () => {
    seed(h, { state: "sent" });
    const result = await run(h);
    expect(result).toMatchObject({
      outcome: "failed", failureCode: "not-completion-ready",
    });
    expect(h.seal).not.toHaveBeenCalled();
  });
});

describe("retry and duplicate workers", () => {
  it("discovers an existing completion instead of sealing again", async () => {
    // §109/§183/§259.
    seed(h);
    await run(h);
    h.seal.mockClear();

    const second = await run(h);
    expect(second.outcome).toBe("already-completed");
    expect(second.finalArtifactId).toBe("art_final");
    expect(h.seal).not.toHaveBeenCalled();
    expect(h.store.completions).toHaveLength(1);
  });

  it("keeps exactly ONE completion under a duplicate run", async () => {
    // §261/§263.
    seed(h);
    await run(h);
    await run(h);
    await run(h);
    expect(h.store.completions).toHaveLength(1);
    expect(h.store.artifacts.filter(a => a.artifactType === "sealed")).toHaveLength(1);
  });
});

describe("mapping sealer failures", () => {
  it.each([
    ["invalid_pdf", "input-inconsistent"],
    ["unsupported_pdf", "input-inconsistent"],
    ["invalid_seal_input", "input-inconsistent"],
    ["unrenderable_text", "unrenderable-value"],
    ["typeface_unavailable", "typeface-unavailable"],
  ])("maps %s onto %s", (code, expected) => {
    expect(sealFailureCode({ code, retryable: false })).toBe(expected);
  });

  it("treats a non-sealing throw as the sealer being unreachable", () => {
    expect(sealFailureCode(new Error("boom"))).toBe("sealer-unavailable");
  });
});
