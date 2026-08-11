// The `field-merge` step (BACKEND-39, OD-164).
//
// The tests that carry the most weight here are the FAILURE WINDOW ones. The
// step cannot be atomic — object storage is not transactional — so what matters
// is that each window fails in the recoverable direction and reports a code an
// operator can act on.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WorkspaceId, DocumentId, UserId, Sha256Digest } from "@lagda/contracts";
import type {
  ArtifactId, PreparationId, SigningRequestId,
  CompletionRunId, MergeFieldsRequest, MergeFieldsResult,
} from "../common/ports/index.js";
import type {
  StorageKeyStrategy, StorageObjectRef,
} from "../common/ports/storage.js";
import {
  FixedClock, FakeTransactionManager, InMemoryStore, SequentialCompletionIds,
} from "../test-support/fakes.js";
import {
  runFieldMergeStep, failureCodeForSealingError, toMergeableField,
  type FieldMergeDependencies,
} from "./field-merge.js";

const WS = "ws_1" as WorkspaceId;
const DOC = "doc_1" as DocumentId;
const REQUEST = "sr_1" as SigningRequestId;
const RUN = "crn_1" as CompletionRunId;
const SOURCE_ART = "art_1" as ArtifactId;
const AT = 1_760_000_000_000;

const SOURCE_BYTES = new TextEncoder().encode("%PDF-1.7 source");
const SOURCE_DIGEST = "a".repeat(64) as Sha256Digest;
const MERGED_BYTES = new TextEncoder().encode("%PDF-1.7 merged");
const MERGED_DIGEST = "b".repeat(64) as Sha256Digest;

/** Minimal storage, with each failure mode switchable. */
function storage() {
  const objects = new Map<string, Uint8Array>([
    ["artifacts:artifacts/ws_1/art_1.pdf", SOURCE_BYTES],
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
    zone: "artifacts",
    key: `artifacts/ws_1/${String(artifactId)}.pdf`,
  }),
} as unknown as StorageKeyStrategy;

interface Harness {
  readonly store: InMemoryStore;
  readonly objects: ReturnType<typeof storage>;
  readonly merge: ReturnType<typeof vi.fn>;
  readonly deps: FieldMergeDependencies;
}

function harness(): Harness {
  const store = new InMemoryStore();
  const objects = storage();
  const merge = vi.fn(
    (request: MergeFieldsRequest): Promise<MergeFieldsResult> => Promise.resolve({
      mergedDocument: MERGED_BYTES,
      // Matches the artifact's recorded digest, so the integrity check passes.
      sourceDocumentHash: SOURCE_DIGEST,
      mergedDocumentHash: MERGED_DIGEST,
      renderedFieldCount: request.fields.length,
    }),
  );
  return {
    store, objects, merge,
    deps: {
      transactions: new FakeTransactionManager(store),
      clock: new FixedClock(AT),
      ids: Object.assign(new SequentialCompletionIds(), {
        nextArtifactId: () => "art_merged",
      }),
      storage: objects,
      keys,
      merger: { mergeFields: merge },
    } as unknown as FieldMergeDependencies,
  };
}

function seed(h: Harness): void {
  h.store.signingRequests.push({
    signingRequestId: REQUEST, workspaceId: WS, documentId: DOC,
    sourceArtifactId: SOURCE_ART,
    sourcePreparationId: "prep_1" as PreparationId, sourcePreparationRevision: 1,
    state: "completion-ready", completionReadyAt: AT,
    terminatedAt: null, terminationReason: null, cancellationNote: null,
    documentTitle: "Office Lease", createdByUserId: "usr_1" as UserId,
    createdAt: AT, updatedAt: AT,
  });
  h.store.artifacts.push({
    artifactId: SOURCE_ART, workspaceId: WS, documentId: DOC,
    artifactType: "original",
    storageReference: "artifacts/ws_1/art_1.pdf" as never,
    mediaType: "application/pdf", sizeBytes: SOURCE_BYTES.byteLength,
    digestAlgorithm: "sha-256", digest: SOURCE_DIGEST,
    pageCount: 4, rotatedPageCount: 0, createdAt: AT,
  });
  h.store.completionRuns.push({
    completionRunId: RUN, workspaceId: WS, signingRequestId: REQUEST,
    state: "processing", pipelineVersion: 1, attemptCount: 1,
    createdAt: AT, startedAt: AT, lastAttemptAt: AT, succeededAt: null,
    failureStep: null, failureCode: null,
  } as never);
}

const run = (h: Harness) => runFieldMergeStep(
  { workspaceId: WS, runId: RUN, signingRequestId: REQUEST }, h.deps);

let h: Harness;
beforeEach(() => { h = harness(); seed(h); });

describe("the happy path", () => {
  it("merges, uploads, and records the artifact and the step together", async () => {
    const result = await run(h);

    expect(result.outcome).toBe("merged");
    expect(result.artifactId).toBe("art_merged");

    const artifact = h.store.artifacts.find(a => a.artifactId === "art_merged");
    expect(artifact?.artifactType).toBe("merged-candidate");
    expect(artifact?.digest).toBe(MERGED_DIGEST);
    // Provenance as a RELATION, never inferred from naming.
    expect(artifact?.sourceArtifactId).toBe(SOURCE_ART);

    // Bytes exist before the row that names them (INV-226).
    expect(h.objects.objects.has("artifacts:artifacts/ws_1/art_merged.pdf")).toBe(true);
  });

  it("merges onto the artifact the REQUEST froze, not the document's latest", async () => {
    // §9. A newer artifact on the same document must not be picked up: it would
    // seal bytes nobody agreed to.
    h.store.artifacts.push({
      artifactId: "art_newer" as ArtifactId, workspaceId: WS, documentId: DOC,
      artifactType: "original",
      storageReference: "artifacts/ws_1/art_newer.pdf" as never,
      mediaType: "application/pdf", sizeBytes: 99,
      digestAlgorithm: "sha-256", digest: "c".repeat(64) as Sha256Digest,
      pageCount: 4, rotatedPageCount: 0, createdAt: AT + 1,
    });

    const result = await run(h);
    expect(result.outcome).toBe("merged");
    const request = h.merge.mock.calls[0]?.[0] as MergeFieldsRequest;
    expect(Array.from(request.sourceDocument)).toEqual(Array.from(SOURCE_BYTES));
  });

  it("supplies mergedAt rather than letting the renderer read a clock", async () => {
    await run(h);
    const request = h.merge.mock.calls[0]?.[0] as MergeFieldsRequest;
    expect(request.mergedAt).toBe(new Date(AT).toISOString());
  });
});

describe("retry convergence", () => {
  it("REUSES an already-accepted output instead of merging again", async () => {
    // §117. Re-merging would produce a second artifact for one step, and the
    // certificate would then have two candidates to sit beside.
    h.store.completionSteps.push({
      completionStepId: "cst_0" as never, completionRunId: RUN, workspaceId: WS,
      step: "field-merge", state: "succeeded",
      outputArtifactId: "art_previous" as ArtifactId,
      attemptCount: 1, succeededAt: AT, failureCode: null,
    } as never);

    const result = await run(h);

    expect(result.outcome).toBe("already-merged");
    expect(result.artifactId).toBe("art_previous");
    expect(h.merge).not.toHaveBeenCalled();
  });
});

describe("the integrity check", () => {
  it("refuses when storage returns bytes that are not the frozen artifact", async () => {
    // The reason this step verifies at all. Storage returned SOMETHING; without
    // this the pipeline would render onto a restored object, a key collision or
    // a partially written file and seal it as the agreed document.
    h.merge.mockResolvedValueOnce({
      mergedDocument: MERGED_BYTES,
      sourceDocumentHash: "f".repeat(64) as Sha256Digest,
      mergedDocumentHash: MERGED_DIGEST,
      renderedFieldCount: 0,
    });

    const result = await run(h);

    expect(result).toMatchObject({
      outcome: "failed", failureCode: "source-artifact-missing",
    });
    expect(h.store.artifacts.some(a => a.artifactId === "art_merged")).toBe(false);
  });

  it("refuses when the object is absent although the row says it exists", async () => {
    // §77: a status is not proof that an object exists.
    h.objects.missing = true;
    const result = await run(h);
    expect(result).toMatchObject({
      outcome: "failed", failureCode: "source-artifact-missing",
    });
  });

  it("refuses when the request's frozen artifact has no row at all", async () => {
    h.store.artifacts.length = 0;
    const result = await run(h);
    expect(result).toMatchObject({
      outcome: "failed", failureCode: "source-artifact-missing",
    });
  });
});

describe("failure windows", () => {
  it("a download failure is RETRYABLE and writes nothing", async () => {
    h.objects.failGet = true;
    const result = await run(h);

    expect(result).toMatchObject({
      outcome: "failed", failureCode: "storage-unavailable",
    });
    const runRow = h.store.completionRuns.find(r => r.completionRunId === RUN);
    expect(runRow?.state).toBe("waiting-retry");
  });

  it("an upload failure is RETRYABLE and leaves no artifact row", async () => {
    // Nothing references anything, so a retry re-merges under a new artifact id.
    h.objects.failPut = true;
    const result = await run(h);

    expect(result).toMatchObject({
      outcome: "failed", failureCode: "storage-unavailable",
    });
    expect(h.store.artifacts.some(a => a.artifactType === "merged-candidate")).toBe(false);
  });

  it("uploads BEFORE recording, so no row can name absent bytes", async () => {
    // INV-226, asserted by ordering rather than by comment. The reverse window
    // — a row naming an object that does not exist — has no recovery.
    const order: string[] = [];
    const put = h.objects.putObject.bind(h.objects);
    (h.objects as { putObject: unknown }).putObject = (input: never) => {
      order.push("put");
      return put(input);
    };
    const original = h.store.artifacts.push.bind(h.store.artifacts);
    h.store.artifacts.push = (...rows) => {
      order.push("row");
      return original(...rows);
    };

    await run(h);
    expect(order).toEqual(["put", "row"]);
  });
});

describe("mapping the renderer's failures", () => {
  it.each([
    ["unrenderable_text", false, "unrenderable-value"],
    ["typeface_unavailable", true, "typeface-unavailable"],
    ["unsupported_representation", false, "unsupported-representation"],
    ["invalid_field_placement", false, "invalid-geometry"],
    ["invalid_pdf", false, "source-artifact-missing"],
    ["unsupported_pdf", false, "source-artifact-missing"],
    ["invalid_seal_input", false, "input-inconsistent"],
  ])("maps %s onto %s", (code, retryable, expected) => {
    expect(failureCodeForSealingError({ code, retryable })).toBe(expected);
  });

  it("falls back on the renderer's own retryability for an unknown code", () => {
    // Guessing `invalid-geometry` here would send an operator to inspect
    // coordinates that are fine.
    expect(failureCodeForSealingError({ code: "who_knows", retryable: true }))
      .toBe("sealer-unavailable");
    expect(failureCodeForSealingError({ code: "who_knows", retryable: false }))
      .toBe("input-inconsistent");
  });

  it("treats a non-sealing throw as the sealer being unreachable", () => {
    expect(failureCodeForSealingError(new Error("boom"))).toBe("sealer-unavailable");
  });

  it("records a terminal renderer failure as failed-terminal", async () => {
    h.merge.mockRejectedValueOnce({ code: "unrenderable_text", retryable: false });
    const result = await run(h);

    expect(result).toMatchObject({
      outcome: "failed", failureCode: "unrenderable-value",
    });
    const runRow = h.store.completionRuns.find(r => r.completionRunId === RUN);
    expect(runRow?.state).toBe("failed-terminal");
  });

  it("records a retryable renderer failure as waiting-retry", async () => {
    h.merge.mockRejectedValueOnce({ code: "typeface_unavailable", retryable: true });
    const result = await run(h);

    expect(result).toMatchObject({
      outcome: "failed", failureCode: "typeface-unavailable",
    });
    const runRow = h.store.completionRuns.find(r => r.completionRunId === RUN);
    expect(runRow?.state).toBe("waiting-retry");
  });
});

describe("projecting stored values", () => {
  const base = {
    fieldId: "f1", recipientId: "r1", fieldType: "signature",
    pageNumber: 2, x: 0.1, y: 0.2, width: 0.3, height: 0.04,
  };

  it("carries geometry through unchanged", () => {
    const field = toMergeableField({ ...base, value: { kind: "text", text: "x" } });
    expect(field).toMatchObject({
      fieldId: "f1", pageNumber: 2,
      rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
    });
  });

  it("maps a typed signature to a typed representation", () => {
    const field = toMergeableField({
      ...base,
      value: { kind: "typed-signature", text: "Ana", styleIndex: 2 },
    });
    expect(field.value).toEqual({
      kind: "signature",
      representation: { kind: "typed", text: "Ana", styleIndex: 2 },
    });
  });

  it("maps a drawn signature to a raster representation", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const field = toMergeableField({
      ...base,
      value: {
        kind: "raster-signature", bytes,
        mediaType: "image/png", width: 8, height: 4,
      },
    });
    expect(field.value).toEqual({
      kind: "signature",
      representation: {
        kind: "raster", bytes, mediaType: "image/png", width: 8, height: 4,
      },
    });
  });

  it("renders a DATE_SIGNED instant as a LABELLED UTC date — OD-166", () => {
    // The product is not Philippine-only, so the renderer assumes no
    // jurisdiction. The label is what stops the remaining ambiguity from being
    // silent: this instant is 07:00 on the 12th in Manila and renders as the
    // 11th, which a reader can only reconcile because the frame is stated.
    const field = toMergeableField({
      ...base,
      value: { kind: "instant", at: Date.parse("2026-08-11T23:00:00.000Z") },
    });
    expect(field.value).toEqual({ kind: "text", text: "2026-08-11 (UTC)" });
  });

  it("never renders a bare date that could be read as local", () => {
    // The regression guard for the above. A future simplification back to
    // `.slice(0, 10)` would look tidier and would silently reintroduce a date
    // that is off by one for every signer east of UTC.
    const field = toMergeableField({
      ...base,
      value: { kind: "instant", at: Date.parse("2026-01-01T00:00:00.000Z") },
    });
    expect((field.value as { text: string }).text).toMatch(/\(UTC\)$/);
  });

  it("maps a checkbox to a boolean, not a string", () => {
    expect(toMergeableField({ ...base, value: { kind: "checkbox", checked: false } })
      .value).toEqual({ kind: "checkbox", checked: false });
  });
});
