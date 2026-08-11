// The `certificate` step and its model builder (BACKEND-40).
//
// The builder's tests carry the weight here. A certificate is read as a record
// of what happened, so the interesting question is never "does it render" — it
// is "does it REFUSE when a fact it would assert is missing".

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WorkspaceId, DocumentId, UserId, Sha256Digest } from "@lagda/contracts";
import type {
  ArtifactId, PreparationId, SigningRequestId, SigningRequestRecipientId,
  CompletionRunId, CertifiedParticipantFacts, CompletionCertificateModelV1,
} from "../common/ports/index.js";
import type { StorageKeyStrategy, StorageObjectRef } from "../common/ports/storage.js";
import {
  FixedClock, FakeTransactionManager, InMemoryStore, SequentialCompletionIds,
} from "../test-support/fakes.js";
import {
  buildCompletionCertificateModel, CertificateFactMissingError,
} from "./certificate-model.js";
import {
  runCertificateStep, certificateFailureCode,
  type CertificateStepDependencies,
} from "./certificate-step.js";

const WS = "ws_1" as WorkspaceId;
const DOC = "doc_1" as DocumentId;
const REQUEST = "sr_1" as SigningRequestId;
const RUN = "crn_1" as CompletionRunId;
const R1 = "srr_1" as SigningRequestRecipientId;
const SOURCE = "art_source" as ArtifactId;
const MERGED = "art_merged" as ArtifactId;
const AT = Date.parse("2026-08-11T09:30:00.000Z");

const DIGEST = "a".repeat(64) as Sha256Digest;
const CERT_BYTES = new TextEncoder().encode("%PDF-1.7 certificate");
const CERT_DIGEST = "c".repeat(64) as Sha256Digest;

// ── The builder ──────────────────────────────────────────────────────────────

function facts(overrides: Partial<CertifiedParticipantFacts> = {}): CertifiedParticipantFacts {
  return {
    recipientId: "srr_1",
    name: "Juan dela Cruz",
    email: "juan@example.com",
    recipientType: "signer",
    routingOrder: 1,
    orderIndex: 0,
    signedAt: AT - 60_000,
    authenticationMethod: "email-otp",
    firstEnteredAt: AT - 120_000,
    consentType: "electronic-records",
    consentVersion: "1.2",
    consentAcceptedAt: AT - 110_000,
    ...overrides,
  };
}

const buildInput = (overrides: Partial<Parameters<typeof buildCompletionCertificateModel>[0]> = {}) => ({
  signingRequestId: "sr_1",
  documentTitle: "Contract of Lease",
  sourceDocumentDigest: DIGEST,
  participants: [facts()],
  generatedAt: AT,
  ...overrides,
});

describe("building the model — what it certifies", () => {
  it("carries the snapshot name and a MASKED email", () => {
    const model = buildCompletionCertificateModel(buildInput());
    expect(model.participants[0]?.name).toBe("Juan dela Cruz");
    // Masked in the MODEL, so the renderer never holds the full address.
    expect(model.participants[0]?.maskedEmail).toBe("j***@example.com");
    expect(JSON.stringify(model)).not.toContain("juan@example.com");
  });

  it("uses the submission's signing time unchanged", () => {
    // §8: never regenerated at certificate time.
    const signedAt = Date.parse("2026-08-10T01:02:03.000Z");
    const model = buildCompletionCertificateModel(
      buildInput({ participants: [facts({ signedAt })] }));
    expect(model.participants[0]?.signedAt).toBe(signedAt);
  });

  it("carries consent exactly as recorded", () => {
    const model = buildCompletionCertificateModel(buildInput());
    expect(model.participants[0]?.consent).toEqual({
      consentType: "electronic-records",
      consentVersion: "1.2",
      acceptedAt: AT - 110_000,
    });
  });

  it("treats absent consent as legitimately absent", () => {
    // Not every recipient is asked. Absence is not a failure.
    const model = buildCompletionCertificateModel(buildInput({
      participants: [facts({
        consentType: null, consentVersion: null, consentAcceptedAt: null,
      })],
    }));
    expect(model.participants[0]?.consent).toBeNull();
  });

  it("stamps the schema version", () => {
    expect(buildCompletionCertificateModel(buildInput()).certificateVersion)
      .toBe("completion-certificate-v1");
  });
});

describe("building the model — what it REFUSES", () => {
  const problem = (input: Parameters<typeof buildCompletionCertificateModel>[0]): string => {
    try {
      buildCompletionCertificateModel(input);
    } catch (error) {
      return (error as CertificateFactMissingError).reason;
    }
    throw new Error("Expected the build to be refused, but it succeeded.");
  };

  it("refuses a certificate with no signers", () => {
    expect(problem(buildInput({ participants: [] }))).toBe("no-signed-participants");
  });

  it("refuses a missing document title rather than using the current one", () => {
    // §22. Substituting the mutable Document's title would present today's name
    // as historical evidence.
    expect(problem(buildInput({ documentTitle: "   " }))).toBe("missing-document-title");
  });

  it("refuses a malformed source digest", () => {
    expect(problem(buildInput({ sourceDocumentDigest: "nope" as Sha256Digest })))
      .toBe("missing-source-digest");
  });

  it("refuses a participant with no signing time", () => {
    // They reached this list by HAVING a submission, so a missing time means
    // the submission row is corrupt (§148).
    expect(problem(buildInput({ participants: [facts({ signedAt: 0 })] })))
      .toBe("missing-signed-at");
  });

  it("refuses an authentication method it cannot certify", () => {
    // §179, and it fails at the point the DECISION is missing rather than
    // letting the renderer pick a default label.
    expect(problem(buildInput({
      participants: [facts({ authenticationMethod: "sms-otp" })],
    }))).toBe("unsupported-authentication-method");
  });

  it.each([
    ["no version", { consentVersion: null }],
    ["no time", { consentAcceptedAt: null }],
    ["no type", { consentType: null }],
  ])("refuses PARTIAL consent — %s", (_label, overrides) => {
    // Certifying "consented" without saying to what, or when, is the overclaim
    // §40 guards against. Absent is fine; half-present is corruption.
    expect(problem(buildInput({ participants: [facts(overrides)] })))
      .toBe("incomplete-consent");
  });

  it("never puts a recipient value in the refusal message", () => {
    // §42: these messages are logged.
    try {
      buildCompletionCertificateModel(buildInput({
        participants: [facts({ authenticationMethod: "sms-otp" })],
      }));
    } catch (error) {
      expect((error as Error).message).not.toContain("juan@example.com");
      expect((error as Error).message).not.toContain("Juan dela Cruz");
    }
  });
});

// ── The step ─────────────────────────────────────────────────────────────────

function storage() {
  const objects = new Map<string, Uint8Array>();
  const api = {
    objects,
    failPut: false,
    getObject: () => Promise.resolve(null),
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
    zone: "artifacts", key: `artifacts/ws_1/${String(artifactId)}.pdf`,
  }),
} as unknown as StorageKeyStrategy;

interface Harness {
  readonly store: InMemoryStore;
  readonly objects: ReturnType<typeof storage>;
  readonly generate: ReturnType<typeof vi.fn>;
  readonly deps: CertificateStepDependencies;
}

function harness(): Harness {
  const store = new InMemoryStore();
  const objects = storage();
  const generate = vi.fn((_model: CompletionCertificateModelV1) => Promise.resolve({
    certificate: CERT_BYTES,
    mediaType: "application/pdf" as const,
    sizeBytes: CERT_BYTES.byteLength,
    digestAlgorithm: "sha-256" as const,
    digest: CERT_DIGEST,
    certificateVersion: "completion-certificate-v1" as const,
    rendererVersion: "certificate-renderer-v1" as const,
  }));
  return {
    store, objects, generate,
    deps: {
      transactions: new FakeTransactionManager(store),
      clock: new FixedClock(AT),
      ids: Object.assign(new SequentialCompletionIds(), {
        nextArtifactId: () => "art_cert",
      }),
      storage: objects,
      keys,
      certificates: { generate },
    } as unknown as CertificateStepDependencies,
  };
}

function seed(h: Harness, opts: { mergeSucceeded?: boolean; mergedPresent?: boolean } = {}): void {
  const { mergeSucceeded = true, mergedPresent = true } = opts;

  h.store.signingRequests.push({
    signingRequestId: REQUEST, workspaceId: WS, documentId: DOC,
    sourceArtifactId: SOURCE,
    sourcePreparationId: "prep_1" as PreparationId, sourcePreparationRevision: 1,
    state: "completion-ready", completionReadyAt: AT,
    completedAt: null,
    terminatedAt: null, terminationReason: null, cancellationNote: null,
    documentTitle: "Contract of Lease", createdByUserId: "usr_1" as UserId,
    createdAt: AT, updatedAt: AT,
  });
  h.store.artifacts.push({
    artifactId: SOURCE, workspaceId: WS, documentId: DOC, artifactType: "original",
    storageReference: "artifacts/ws_1/art_source.pdf" as never,
    mediaType: "application/pdf", sizeBytes: 10,
    digestAlgorithm: "sha-256", digest: DIGEST,
    pageCount: 2, rotatedPageCount: 0, createdAt: AT,
  });
  if (mergedPresent) {
    h.store.artifacts.push({
      artifactId: MERGED, workspaceId: WS, documentId: DOC,
      artifactType: "merged-candidate",
      storageReference: "artifacts/ws_1/art_merged.pdf" as never,
      mediaType: "application/pdf", sizeBytes: 12,
      digestAlgorithm: "sha-256", digest: "b".repeat(64) as Sha256Digest,
      pageCount: 2, rotatedPageCount: 0, createdAt: AT,
    });
  }
  h.store.completionRuns.push({
    completionRunId: RUN, workspaceId: WS, signingRequestId: REQUEST,
    state: "processing", pipelineVersion: 1, attemptCount: 1,
    createdAt: AT, startedAt: AT, lastAttemptAt: AT, succeededAt: null,
    failureStep: null, failureCode: null,
  } as never);
  h.store.completionSteps.push({
    completionStepId: "cst_fm" as never, completionRunId: RUN, workspaceId: WS,
    step: "field-merge", state: mergeSucceeded ? "succeeded" : "failed",
    outputArtifactId: MERGED, attemptCount: 1, succeededAt: AT, failureCode: null,
  } as never);

  h.store.signingRequestRecipients.push({
    recipientId: R1, sourcePreparationRecipientId: null,
    name: "Juan dela Cruz", email: "juan@example.com",
    normalizedEmail: "juan@example.com", organization: null,
    type: "signer", isRequired: true, orderIndex: 0, routingOrder: 1,
  });
  h.store.snapshotOwners.set(String(R1), REQUEST);
  h.store.submissions.push({
    submissionId: "sub_1", workspaceId: String(WS),
    signingRequestId: String(REQUEST), recipientId: String(R1),
    acceptedAt: AT - 60_000, authenticationMethod: "email-otp",
    valueCount: 0, representations: [], values: [],
  });
}

const run = (h: Harness) => runCertificateStep(
  { workspaceId: WS, runId: RUN, signingRequestId: REQUEST }, h.deps);

let h: Harness;
beforeEach(() => { h = harness(); });

describe("the certificate step", () => {
  it("renders, uploads and records a completion-certificate artifact", async () => {
    seed(h);
    const result = await run(h);

    expect(result.outcome).toBe("certified");
    const artifact = h.store.artifacts.find(a => a.artifactId === "art_cert");
    expect(artifact?.artifactType).toBe("completion-certificate");
    expect(artifact?.digest).toBe(CERT_DIGEST);
    expect(artifact?.sizeBytes).toBe(CERT_BYTES.byteLength);
    expect(h.objects.objects.has("artifacts:artifacts/ws_1/art_cert.pdf")).toBe(true);
  });

  it("does not touch the source or merged artifacts", async () => {
    // §222. They are immutable inputs.
    seed(h);
    const before = JSON.stringify(
      h.store.artifacts.filter(a => a.artifactId !== "art_cert"));
    await run(h);
    const after = JSON.stringify(
      h.store.artifacts.filter(a => a.artifactId !== "art_cert"));
    expect(after).toBe(before);
  });

  it("supplies generatedAt from the clock, not from the renderer", async () => {
    seed(h);
    await run(h);
    const model = h.generate.mock.calls[0]?.[0] as CompletionCertificateModelV1;
    expect(model.generatedAt).toBe(AT);
  });

  it("certifies the SOURCE digest, never the merged one", async () => {
    // Owner decision: the merged digest is internal provenance only.
    seed(h);
    await run(h);
    const model = h.generate.mock.calls[0]?.[0] as CompletionCertificateModelV1;
    expect(model.sourceDocumentDigest).toBe(DIGEST);
    expect(JSON.stringify(model)).not.toContain("b".repeat(64));
  });

  it("REUSES an already-accepted certificate rather than rendering again", async () => {
    // §117. Re-rendering would produce a second certificate for one step — and
    // because the model carries `generatedAt`, not even an identical one.
    seed(h);
    h.store.completionSteps.push({
      completionStepId: "cst_c" as never, completionRunId: RUN, workspaceId: WS,
      step: "certificate", state: "succeeded",
      outputArtifactId: "art_previous" as ArtifactId,
      attemptCount: 1, succeededAt: AT, failureCode: null,
    } as never);

    const result = await run(h);
    expect(result).toMatchObject({
      outcome: "already-certified", artifactId: "art_previous",
    });
    expect(h.generate).not.toHaveBeenCalled();
  });
});

describe("preconditions", () => {
  it("refuses when field-merge has not succeeded", async () => {
    // §118. A certificate for a run whose merge never completed would certify a
    // signing whose document was never assembled.
    seed(h, { mergeSucceeded: false });
    const result = await run(h);
    expect(result).toMatchObject({ outcome: "failed", failureCode: "input-inconsistent" });
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("refuses when the merged artifact the step named is gone", async () => {
    // §77/§120: a status is not proof the object exists.
    seed(h, { mergedPresent: false });
    const result = await run(h);
    expect(result).toMatchObject({ outcome: "failed", failureCode: "output-missing" });
  });

  it("refuses when the frozen source artifact is gone", async () => {
    seed(h);
    const index = h.store.artifacts.findIndex(a => a.artifactId === SOURCE);
    h.store.artifacts.splice(index, 1);
    const result = await run(h);
    expect(result).toMatchObject({
      outcome: "failed", failureCode: "source-artifact-missing",
    });
  });

  it("refuses a request with no signed participants", async () => {
    seed(h);
    h.store.submissions.length = 0;
    const result = await run(h);
    expect(result).toMatchObject({ outcome: "failed", failureCode: "input-inconsistent" });
  });
});

describe("failure windows", () => {
  it("an upload failure is RETRYABLE and leaves no artifact row", async () => {
    seed(h);
    h.objects.failPut = true;
    const result = await run(h);

    expect(result).toMatchObject({ outcome: "failed", failureCode: "storage-unavailable" });
    expect(h.store.artifacts.some(a => a.artifactType === "completion-certificate"))
      .toBe(false);
    expect(h.store.completionRuns[0]?.state).toBe("waiting-retry");
  });

  it("uploads BEFORE recording, so no row can name absent bytes", async () => {
    seed(h);
    const order: string[] = [];
    const put = h.objects.putObject;
    h.objects.putObject = (input) => { order.push("put"); return put(input); };
    const push = h.store.artifacts.push.bind(h.store.artifacts);
    h.store.artifacts.push = (...rows) => { order.push("row"); return push(...rows); };

    await run(h);
    expect(order).toEqual(["put", "row"]);
  });

  it("records a terminal renderer failure as failed-terminal", async () => {
    seed(h);
    h.generate.mockRejectedValueOnce({ code: "unrenderable_text", retryable: false });
    const result = await run(h);

    expect(result).toMatchObject({ outcome: "failed", failureCode: "unrenderable-value" });
    expect(h.store.completionRuns[0]?.state).toBe("failed-terminal");
  });

  it("records a retryable renderer failure as waiting-retry", async () => {
    seed(h);
    h.generate.mockRejectedValueOnce({ code: "typeface_unavailable", retryable: true });
    const result = await run(h);

    expect(result).toMatchObject({ outcome: "failed", failureCode: "typeface-unavailable" });
    expect(h.store.completionRuns[0]?.state).toBe("waiting-retry");
  });
});

describe("mapping renderer failures", () => {
  it.each([
    ["unrenderable_text", "unrenderable-value"],
    ["typeface_unavailable", "typeface-unavailable"],
    ["unsupported_representation", "unsupported-representation"],
    ["invalid_seal_input", "input-inconsistent"],
  ])("maps %s onto %s", (code, expected) => {
    expect(certificateFailureCode({ code, retryable: false })).toBe(expected);
  });

  it("treats a non-sealing throw as the generator being unreachable", () => {
    expect(certificateFailureCode(new Error("boom"))).toBe("sealer-unavailable");
  });
});

describe("evidence (BACKEND-43)", () => {
  it("records certificate-generated in the SAME transaction as the step", async () => {
    // §157, §252.
    seed(h);
    await run(h);

    expect(h.store.evidence).toHaveLength(1);
    expect(h.store.evidence[0]?.eventType).toBe("certificate-generated");
    expect(h.store.evidence[0]?.actor).toEqual({ type: "system" });
  });

  it("stamps the STEP's success time and sources the event from the step", async () => {
    // §14 for the time, §260 for the source — the key the partial unique index
    // uses to make a duplicate worker converge.
    seed(h);
    await run(h);

    const step = h.store.completionSteps.at(-1);
    expect(h.store.evidence[0]?.occurredAt).toBe(step?.succeededAt);
    expect(h.store.evidence[0]?.source)
      .toEqual({ type: "completion-step", id: step?.completionStepId });
  });

  it("carries no certificate content — the event is a fact, not a copy", () => {
    // §35, §90. The certificate is an artifact; the event says one was made.
    seed(h);
    return run(h).then(() => {
      const wire = JSON.stringify(h.store.evidence[0]).toLowerCase();
      for (const forbidden of ["%pdf", "certificate of completion", "signature"]) {
        expect(wire).not.toContain(forbidden);
      }
    });
  });

  it("writes NO evidence when the step never succeeds", async () => {
    seed(h);
    h.objects.failPut = true;
    const result = await run(h);

    expect(result).toMatchObject({ outcome: "failed" });
    expect(h.store.evidence).toHaveLength(0);
  });
});
