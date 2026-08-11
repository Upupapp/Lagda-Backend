// The `certificate` step (BACKEND-40).
//
// Builds the curated certificate model from immutable facts, renders it, and
// persists it as a `completion-certificate` artifact.
//
// Same three-phase shape as `field-merge`, for the same reason: object storage
// is not transactional and cannot be enrolled in one.
//
//   1. READ, in a transaction
//   2. RENDER and UPLOAD, outside one
//   3. RECORD the artifact and accept the step, together
//
// Bytes THEN row (INV-226). A row naming an object that does not exist is a
// completion the pipeline believes in and cannot deliver; the reverse leaves a
// private unreferenced object, which OD-160's sweeper collects.
//
// It never invokes `DocumentSealer` (§67), never marks the request completed
// (§268), never creates a verification record (§269), and never sends anything.

import type { WorkspaceId, DocumentId } from "@lagda/contracts";
import type { CompletionFailureCode } from "@lagda/contracts";
import type {
  Clock, TransactionManager, WorkspaceUnitOfWork,
  ArtifactId, ArtifactIdGenerator, ArtifactRecord,
  CompletionRunId, CompletionIdGenerator,
  SigningRequestId,
  CompletionCertificateGenerator, CompletionCertificateModelV1,
} from "../common/ports/index.js";
import type {
  ObjectStorage, StorageKeyStrategy, StorageObjectRef,
} from "../common/ports/storage.js";
import {
  buildCompletionCertificateModel, CertificateFactMissingError,
} from "./certificate-model.js";

export interface CertificateStepDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly ids: CompletionIdGenerator & ArtifactIdGenerator;
  readonly storage: ObjectStorage;
  readonly keys: StorageKeyStrategy;
  /** A PORT. This module never imports `@lagda/sealing`, and a guard asserts it. */
  readonly certificates: CompletionCertificateGenerator;
}

export interface CertificateStepResult {
  readonly outcome: "certified" | "already-certified" | "failed";
  readonly artifactId?: ArtifactId;
  readonly failureCode?: CompletionFailureCode;
}

interface CertificatePlan {
  readonly documentId: DocumentId;
  readonly model: CompletionCertificateModelV1;
  readonly alreadyAcceptedArtifactId: ArtifactId | null;
}

/**
 * Runs `certificate` for one claimed run.
 *
 * The caller has claimed the run and revalidated eligibility. This does not
 * claim, and does not decide whether the request may complete.
 */
export async function runCertificateStep(
  input: {
    readonly workspaceId: WorkspaceId;
    readonly runId: CompletionRunId;
    readonly signingRequestId: SigningRequestId;
  },
  deps: CertificateStepDependencies,
): Promise<CertificateStepResult> {
  const generatedAt = deps.clock.now();

  // ── 1. Read the authoritative facts ───────────────────────────────────────
  let plan: CertificatePlan;
  try {
    plan = await deps.transactions.runForWorkspace(input.workspaceId, uow =>
      buildPlan(uow, input.signingRequestId, input.runId, generatedAt));
  } catch (error) {
    if (error instanceof CertificateFactMissingError) {
      // Every one of these is deterministic: the same records produce the same
      // refusal forever, so retrying only burns the attempt budget.
      return fail(input, deps, "input-inconsistent");
    }
    if (error instanceof Precondition) return fail(input, deps, error.code);
    throw error;
  }

  // §117: a retry finds the previous attempt's output and REUSES it. Rendering
  // again would produce a second certificate for one step — and because the
  // model carries `generatedAt`, the two would not even be byte-identical.
  if (plan.alreadyAcceptedArtifactId !== null) {
    return {
      outcome: "already-certified", artifactId: plan.alreadyAcceptedArtifactId,
    };
  }

  // ── 2. Render and upload ──────────────────────────────────────────────────
  let rendered;
  try {
    rendered = await deps.certificates.generate(plan.model);
  } catch (error) {
    return fail(input, deps, certificateFailureCode(error));
  }

  const artifactId = deps.ids.nextArtifactId();
  const ref: StorageObjectRef = deps.keys.artifactKey({
    workspaceId: input.workspaceId,
    documentId: plan.documentId,
    artifactId,
  });

  try {
    await deps.storage.putObject({
      ref,
      content: { kind: "bytes", bytes: rendered.certificate },
      mediaType: rendered.mediaType,
    });
  } catch {
    // No row was written, so nothing references anything. A retry re-renders
    // under a NEW artifact id; the abandoned object is OD-160's to collect.
    return fail(input, deps, "storage-unavailable");
  }

  // ── 3. Record the artifact and accept the step, together ──────────────────
  try {
    await deps.transactions.runForWorkspace(input.workspaceId, async uow => {
      await uow.artifacts.insert({
        artifactId,
        workspaceId: input.workspaceId,
        documentId: plan.documentId,
        artifactType: "completion-certificate",
        storageReference: ref.key,
        mediaType: rendered.mediaType,
        // OBSERVED from the bytes, never claimed (§219).
        sizeBytes: rendered.sizeBytes,
        digestAlgorithm: rendered.digestAlgorithm,
        digest: rendered.digest,
        createdAt: generatedAt,
      } satisfies ArtifactRecord);

      await uow.completion.acceptStep({
        completionStepId: deps.ids.nextCompletionStepId(),
        runId: input.runId,
        step: "certificate",
        outputArtifactId: artifactId,
        succeededAt: generatedAt,
      });
    });
  } catch {
    // Bytes exist, no row. Recoverable, and deliberately NOT cleaned up here:
    // deleting on an uncertain transaction outcome is how a real artifact is
    // destroyed (§78).
    return fail(input, deps, "database-unavailable");
  }

  return { outcome: "certified", artifactId };
}

// ── Reading the plan ─────────────────────────────────────────────────────────

/** A precondition failure that already knows its bounded code. */
class Precondition extends Error {
  constructor(readonly code: CompletionFailureCode) {
    super("The certificate step's preconditions are not met.");
  }
}

async function buildPlan(
  uow: WorkspaceUnitOfWork,
  signingRequestId: SigningRequestId,
  runId: CompletionRunId,
  generatedAt: number,
): Promise<CertificatePlan> {
  const request = await uow.signingRequests.find(signingRequestId);
  if (request === null) throw new Precondition("input-inconsistent");

  const steps = await uow.completion.listSteps(runId);

  // §118-§120. `field-merge` must have SUCCEEDED, and its output must exist.
  //
  // Not because the certificate renders the merged document — it does not, and
  // the merged digest is deliberately not on the page. It is because a
  // certificate produced for a run whose merge never completed would certify a
  // signing whose document was never assembled, and the step ledger is what
  // makes that impossible.
  const merge = steps.find(step => step.step === "field-merge");
  if (merge === undefined || merge.state !== "succeeded") {
    throw new Precondition("input-inconsistent");
  }
  if (merge.outputArtifactId === null) {
    // §77: a status is not proof. A step that says succeeded and names no
    // artifact has not produced one.
    throw new Precondition("output-missing");
  }

  const artifacts = await uow.artifacts.listForDocument(request.documentId);

  // The merged candidate the step accepted — verified present, by identity,
  // never by "the latest merged artifact" (§119).
  const merged = artifacts.find(
    artifact => artifact.artifactId === merge.outputArtifactId);
  if (merged === undefined) throw new Precondition("output-missing");

  // The EXACT artifact the request froze. Its digest is what the certificate
  // shows, because it is the document the signers signed against (§92).
  const source = artifacts.find(
    artifact => artifact.artifactId === request.sourceArtifactId);
  if (source === undefined) throw new Precondition("source-artifact-missing");

  const accepted = steps.find(
    step => step.step === "certificate" && step.state === "succeeded");

  const participants = await uow.completionInputs.listCertifiedParticipants(
    signingRequestId);

  return {
    documentId: request.documentId,
    model: buildCompletionCertificateModel({
      signingRequestId: String(signingRequestId),
      documentTitle: request.documentTitle,
      sourceDocumentDigest: source.digest,
      participants,
      generatedAt,
    }),
    alreadyAcceptedArtifactId: accepted?.outputArtifactId ?? null,
  };
}

// ── Failure mapping ──────────────────────────────────────────────────────────

/**
 * Renderer failure to completion failure code.
 *
 * Structural, on `code`/`retryable`, never `instanceof` — the application layer
 * must not import `@lagda/sealing`, and a guard asserts it does not.
 */
export function certificateFailureCode(error: unknown): CompletionFailureCode {
  if (typeof error !== "object" || error === null) return "sealer-unavailable";
  const candidate = error as { code?: unknown; retryable?: unknown };
  if (typeof candidate.code !== "string") return "sealer-unavailable";

  switch (candidate.code) {
    case "unrenderable_text": return "unrenderable-value";
    case "typeface_unavailable": return "typeface-unavailable";
    case "unsupported_representation": return "unsupported-representation";
    case "invalid_seal_input": return "input-inconsistent";
    default:
      return candidate.retryable === true ? "sealer-unavailable" : "input-inconsistent";
  }
}

const RETRYABLE = new Set<CompletionFailureCode>([
  "storage-unavailable", "sealer-unavailable", "step-not-implemented",
  "typeface-unavailable", "database-unavailable", "attempt-abandoned",
]);

async function fail(
  input: { readonly workspaceId: WorkspaceId; readonly runId: CompletionRunId },
  deps: CertificateStepDependencies,
  code: CompletionFailureCode,
): Promise<CertificateStepResult> {
  await deps.transactions.runForWorkspace(input.workspaceId, uow =>
    uow.completion.recordRunFailure({
      runId: input.runId,
      state: RETRYABLE.has(code) ? "waiting-retry" : "failed-terminal",
      step: "certificate",
      code,
    }));
  return { outcome: "failed", failureCode: code };
}
