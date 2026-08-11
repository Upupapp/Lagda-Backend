// The `final-seal` step and the finalization transaction (BACKEND-41).
//
// This is the boundary that makes a signing request COMPLETED. It is the only
// business path permitted to invoke `DocumentSealer`.
//
// ── §100's ordering, and why every part of it is load-bearing ──────────────
//
//   1. resolve the accepted inputs BY IDENTITY and fetch their bytes
//   2. seal            — outside any transaction
//   3. VERIFY both inputs against their recorded digests, using the digests the
//      sealer computed (hashing is confined to `@lagda/sealing`)
//   4. upload          — outside any transaction
//   5. THE FINALIZATION TRANSACTION:
//        artifact row + seal metadata + verification record
//        + completion record
//        + revoke grants and sessions
//        + completion-ready -> completed
//
// **Nothing before step 5 may claim completion**, and step 5 happens only once
// the final bytes are durably in storage. The reverse order — mark completed,
// then upload — produces a request that says it has a document nobody can
// fetch, which §110 says must never be silently repaired.
//
// The transaction holds no PDF work and no storage call. Sealing a document can
// take seconds; holding a database transaction across it would pin a connection
// and still not make the two atomic, because object storage cannot enrol in a
// PostgreSQL transaction.

import type {
  WorkspaceId, DocumentId, Sha256Digest, VerificationId, TransactionId,
} from "@lagda/contracts";
import type { CompletionFailureCode } from "@lagda/contracts";
import { COMPLETION_PIPELINE_VERSION } from "@lagda/contracts";
import type {
  Clock, TransactionManager, WorkspaceUnitOfWork,
  ArtifactId, ArtifactIdGenerator, ArtifactRecord,
  CompletionRunId, CompletionIdGenerator,
  SigningRequestId, DocumentSealer, SealResult,
  SealId, SealIdGenerator, VerificationIdGenerator, EvidenceEventIdGenerator,
} from "../common/ports/index.js";
// BACKEND-43. The factories, never a hand-built event literal — see the note in
// `evidence/events.ts` on why the four coupled fields cannot be assembled here.
import {
  finalSealCompleted, documentSealed, verificationRecordCreated, requestCompleted,
} from "../evidence/events.js";
import type {
  ObjectStorage, StorageKeyStrategy, StorageObjectRef,
} from "../common/ports/storage.js";

export interface FinalSealDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly ids: CompletionIdGenerator & ArtifactIdGenerator
  & SealIdGenerator & VerificationIdGenerator & EvidenceEventIdGenerator;
  readonly storage: ObjectStorage;
  readonly keys: StorageKeyStrategy;
  /**
   * THE canonical sealing seam. A PORT — this module never imports
   * `@lagda/sealing`, and an architecture guard asserts the application package
   * never does.
   */
  readonly sealer: DocumentSealer;
}

export interface FinalSealResult {
  readonly outcome: "completed" | "already-completed" | "failed";
  readonly finalArtifactId?: ArtifactId;
  readonly verificationId?: VerificationId;
  readonly completedAt?: number;
  readonly failureCode?: CompletionFailureCode;
}

/** A precondition failure that already knows its bounded code. */
class Precondition extends Error {
  constructor(readonly code: CompletionFailureCode) {
    super("The final-seal step's preconditions are not met.");
  }
}

interface SealPlan {
  readonly documentId: DocumentId;
  readonly sourceDigest: Sha256Digest;
  readonly mergedArtifactId: ArtifactId;
  readonly mergedRef: StorageObjectRef;
  readonly mergedDigest: Sha256Digest;
  readonly certificateArtifactId: ArtifactId;
  readonly certificateRef: StorageObjectRef;
  readonly certificateDigest: Sha256Digest;
  readonly alreadyFinalArtifactId: ArtifactId | null;
}

/**
 * Seals the composed document and finalizes the request.
 *
 * The caller has claimed the run and revalidated eligibility.
 */
export async function runFinalSealStep(
  input: {
    readonly workspaceId: WorkspaceId;
    readonly runId: CompletionRunId;
    readonly signingRequestId: SigningRequestId;
  },
  deps: FinalSealDependencies,
): Promise<FinalSealResult> {
  // ── 1. Read and verify the accepted inputs ────────────────────────────────
  let plan: SealPlan;
  try {
    plan = await deps.transactions.runForWorkspace(input.workspaceId, uow =>
      buildPlan(uow, input.signingRequestId, input.runId));
  } catch (error) {
    if (error instanceof Precondition) return fail(input, deps, error.code);
    throw error;
  }

  // A completion already exists. §109/§183: a retry whose response was lost
  // discovers it rather than sealing again.
  if (plan.alreadyFinalArtifactId !== null) {
    const existing = await deps.transactions.runForWorkspace(input.workspaceId, uow =>
      uow.completion.findCompletion(input.signingRequestId));
    return {
      outcome: "already-completed",
      finalArtifactId: plan.alreadyFinalArtifactId,
      ...(existing === null ? {} : { completedAt: existing.completedAt }),
    };
  }

  // ── 2. Fetch and REHASH both inputs ───────────────────────────────────────
  //
  // §15. The stored digest is what the pipeline recorded; rehashing the bytes
  // storage actually returned is what proves they are still those bytes. A
  // restored object, a key collision or a partial write all produce a readable
  // PDF that is not the one the request accepted — and sealing it would make
  // the wrong document authoritative and immutable in the same instant.
  //
  // §16: the provider's ETag is never used for this. It is the provider's
  // opinion about its own storage, not LAGDA's integrity claim.
  let merged: Uint8Array;
  let certificate: Uint8Array;
  try {
    merged = await load(deps, plan.mergedRef);
    certificate = await load(deps, plan.certificateRef);
  } catch (error) {
    if (error instanceof Precondition) return fail(input, deps, error.code);
    return fail(input, deps, "storage-unavailable");
  }

  // ── 3. Seal ───────────────────────────────────────────────────────────────
  const sealedAt = deps.clock.now();
  let sealed: SealResult;
  try {
    sealed = await deps.sealer.seal({
      workspaceId: input.workspaceId,
      transactionId: input.signingRequestId as unknown as TransactionId,
      documentId: plan.documentId,
      completionRunId: String(input.runId),
      mergedDocument: merged,
      completionCertificate: certificate,
      sealedAt: new Date(sealedAt).toISOString(),
    });
  } catch (error) {
    return fail(input, deps, sealFailureCode(error));
  }

  // §119. The sealer answered; that is not the same as having produced a
  // document. A zero-length result would upload cleanly and complete a request
  // whose final artifact is empty.
  if (sealed.sealedDocument.length === 0) {
    return fail(input, deps, "output-missing");
  }
  // §15, and this is where it happens.
  //
  // The sealer hashed both inputs as it received them, so comparing those
  // digests against what the pipeline RECORDED proves storage returned the
  // exact accepted bytes. A restored object, a key collision or a partial write
  // all produce a readable PDF that is not the one the request accepted.
  //
  // After the seal call rather than before it, because `createHash` is confined
  // to `@lagda/sealing` and exporting a general hash would let any caller hash a
  // document without sealing it. Acceptable: sealing is a pure function over
  // bytes in memory, and NOTHING is uploaded, recorded or completed below this
  // point until both digests match.
  if (sealed.mergedDocumentHash !== plan.mergedDigest) {
    return fail(input, deps, "input-inconsistent");
  }
  if (sealed.completionCertificateHash !== plan.certificateDigest) {
    return fail(input, deps, "input-inconsistent");
  }

  // ── 4. Upload, BEFORE anything claims completion ──────────────────────────
  const finalArtifactId = deps.ids.nextArtifactId();
  const finalRef = deps.keys.artifactKey({
    workspaceId: input.workspaceId,
    documentId: plan.documentId,
    artifactId: finalArtifactId,
  });

  try {
    await deps.storage.putObject({
      ref: finalRef,
      content: { kind: "bytes", bytes: sealed.sealedDocument },
      mediaType: "application/pdf",
    });
  } catch {
    // Nothing references anything. The request stays `completion-ready` (§257)
    // and a retry re-seals under a NEW artifact id.
    return fail(input, deps, "storage-unavailable");
  }

  // ── 5. THE FINALIZATION TRANSACTION ───────────────────────────────────────
  return finalize(input, deps, plan, sealed, finalArtifactId, finalRef, sealedAt);
}

// ── The finalization transaction ─────────────────────────────────────────────

async function finalize(
  input: {
    readonly workspaceId: WorkspaceId;
    readonly runId: CompletionRunId;
    readonly signingRequestId: SigningRequestId;
  },
  deps: FinalSealDependencies,
  plan: SealPlan,
  sealed: SealResult,
  finalArtifactId: ArtifactId,
  finalRef: StorageObjectRef,
  sealedAt: number,
): Promise<FinalSealResult> {
  // Generated ONCE, outside the callback, so a retried transaction body cannot
  // mint a second identity for the same completion.
  const sealId = deps.ids.nextSealId();
  const verificationId = deps.ids.nextVerificationId(input.workspaceId, sealedAt);

  try {
    const completedAt = await deps.transactions.runForWorkspace(
      input.workspaceId, async (uow): Promise<number | null> => {
        // §97: the completion time is generated HERE, inside the transaction
        // that makes it true — not when sealing started, and never any
        // recipient's signing time, all of which are earlier.
        const at = deps.clock.now();

        await uow.artifacts.insert({
          artifactId: finalArtifactId,
          workspaceId: input.workspaceId,
          documentId: plan.documentId,
          artifactType: "sealed",
          storageReference: finalRef.key,
          mediaType: "application/pdf",
          // Server-observed, never claimed (§46, §236).
          sizeBytes: sealed.sealedDocument.byteLength,
          digestAlgorithm: "sha-256",
          // The authoritative final digest, over the exact stored bytes (§44).
          digest: sealed.signedDocumentHash,
          sourceArtifactId: plan.mergedArtifactId,
          createdAt: at,
        } satisfies ArtifactRecord);

        // Seal metadata and the verification record, together.
        //
        // `originalDocumentHash` comes from the request's FROZEN SOURCE
        // artifact — NOT from `sealed.mergedDocumentHash`. That was the §0
        // trap: the field means "the original file at upload" and feeds the
        // record BACKEND-42 exposes publicly, and the merged digest sitting in
        // it would have been wrong forever. The rename of the seal result made
        // the mistake visible; this line is where it would have been made.
        await uow.finalizations.recordFinalization({
          seal: {
            sealId,
            workspaceId: input.workspaceId,
            signingRequestId: input.signingRequestId as unknown as TransactionId,
            sealedArtifactId: finalArtifactId,
            certificateArtifactId: plan.certificateArtifactId,
            sealScheme: sealed.seal.sealScheme,
            sealVersion: sealed.seal.sealVersion,
            digestAlgorithm: sealed.seal.digestAlgorithm,
            originalDocumentHash: plan.sourceDigest,
            signedDocumentHash: sealed.signedDocumentHash,
            sealedAt,
          },
          verification: {
            verificationId,
            workspaceId: input.workspaceId,
            signingRequestId: input.signingRequestId as unknown as TransactionId,
            documentId: plan.documentId,
            sealId,
            completedAt: at,
            participantCount: await countParticipants(uow, input.signingRequestId),
          },
        });

        const finalSealStepId = deps.ids.nextCompletionStepId();
        await uow.completion.acceptStep({
          completionStepId: finalSealStepId,
          runId: input.runId,
          step: "final-seal",
          outputArtifactId: finalArtifactId,
          succeededAt: at,
        });

        const recorded = await uow.completion.recordCompletion({
          signingRequestId: input.signingRequestId,
          completionRunId: input.runId,
          mergedArtifactId: plan.mergedArtifactId,
          certificateArtifactId: plan.certificateArtifactId,
          finalArtifactId,
          completedAt: at,
          sealScheme: sealed.seal.sealScheme,
          sealVersion: sealed.seal.sealVersion,
          digestAlgorithm: sealed.seal.digestAlgorithm,
          pipelineVersion: COMPLETION_PIPELINE_VERSION,
        });
        if (!recorded) {
          // Another worker completed this request. Its work stands.
          return null;
        }

        // ── The lockout, BOTH layers ──────────────────────────────────────
        //
        // Owner decision: deny by state AND revoke. The state check below is
        // the load-bearing control; revoking means a stolen link stops
        // resolving at the LOOKUP rather than at the policy, so a future route
        // added without the state check inherits a dead credential rather than
        // a working one. Neither layer relies on the other.
        await uow.signingWorkflow.revokeActiveGrants({
          signingRequestId: input.signingRequestId, revokedAt: at,
        });
        await uow.signingWorkflow.revokeRecipientSessions({
          signingRequestId: input.signingRequestId, revokedAt: at,
        });

        await uow.completion.markRunSucceeded({ runId: input.runId, succeededAt: at });

        // ── Evidence (BACKEND-43) ─────────────────────────────────────────
        //
        // INSIDE the transaction, deliberately. §160: a critical transition may
        // not be evidence-less, so a failure to record the history must roll
        // back the fact rather than leave a completed request nothing can
        // explain. That is only defensible because these appends are pure
        // inserts against a table this transaction already owns.
        //
        // Before `markCompleted`, so the evidence exists by the time anything
        // observes the completed state.
        //
        // Idempotency comes from the partial unique index on the event source,
        // not from a check here — two workers reaching this point both insert
        // and the second is refused by PostgreSQL (§46). The `recordCompletion`
        // guard above already returned for the loser, so in practice this is a
        // second line rather than the first.
        const evidenceBase = {
          newEventId: () => deps.ids.nextEvidenceEventId(),
          signingRequestId: input.signingRequestId as unknown as TransactionId,
          occurredAt: at,
        };

        await uow.evidence.append(finalSealCompleted(evidenceBase, finalSealStepId));
        await uow.evidence.append(documentSealed(
          evidenceBase, sealId, sealed.seal.digestAlgorithm));
        await uow.evidence.append(
          verificationRecordCreated(evidenceBase, verificationId));
        // The completion record is UNIQUE per signing request, so the request id
        // IS that record's durable identity (§120). No separate completion id
        // exists to reference.
        await uow.evidence.append(requestCompleted(
          evidenceBase, input.signingRequestId));

        // LAST. Everything the completed state asserts now exists.
        const transitioned = await uow.signingWorkflow.markCompleted({
          signingRequestId: input.signingRequestId, completedAt: at,
        });
        if (!transitioned) {
          // The request left `completion-ready` under us. Rolling back is the
          // only safe answer: a completion record without the state, or a state
          // set from somewhere unknown, is worse than retrying.
          throw new Precondition("not-completion-ready");
        }

        return at;
      });

    if (completedAt === null) {
      return { outcome: "already-completed", finalArtifactId };
    }
    return { outcome: "completed", finalArtifactId, verificationId, completedAt };
  } catch (error) {
    if (error instanceof Precondition) return fail(input, deps, error.code);
    // The object exists and no completion was recorded. §258: the request stays
    // non-completed and the object is a reconciliation candidate. NOT deleted —
    // deleting on an uncertain transaction outcome is how a real artifact is
    // destroyed, and a retry that finds the accepted step reuses it.
    return fail(input, deps, "database-unavailable");
  }
}

// ── Reading and verifying inputs ─────────────────────────────────────────────

async function buildPlan(
  uow: WorkspaceUnitOfWork,
  signingRequestId: SigningRequestId,
  runId: CompletionRunId,
): Promise<SealPlan> {
  const request = await uow.signingRequests.find(signingRequestId);
  if (request === null) throw new Precondition("input-inconsistent");

  // §84. Only from `completion-ready`. A request already completed is handled
  // by the completion lookup below; anything else has not earned finalization.
  if (request.state !== "completion-ready" && request.state !== "completed") {
    throw new Precondition("not-completion-ready");
  }

  const steps = await uow.completion.listSteps(runId);
  const merge = steps.find(step => step.step === "field-merge");
  const certificate = steps.find(step => step.step === "certificate");

  if (merge?.state !== "succeeded" || certificate?.state !== "succeeded") {
    // §243/§244: neither may be skipped.
    throw new Precondition("input-inconsistent");
  }
  if (merge.outputArtifactId === null || certificate.outputArtifactId === null) {
    throw new Precondition("output-missing");
  }

  const artifacts = await uow.artifacts.listForDocument(request.documentId);
  const find = (id: ArtifactId): ArtifactRecord => {
    const found = artifacts.find(artifact => artifact.artifactId === id);
    if (found === undefined) throw new Precondition("output-missing");
    return found;
  };

  // Resolved BY IDENTITY from the accepted step outputs — never "the latest
  // merged artifact" (§6, §119).
  const mergedArtifact = find(merge.outputArtifactId);
  const certificateArtifact = find(certificate.outputArtifactId);

  const source = artifacts.find(
    artifact => artifact.artifactId === request.sourceArtifactId);
  if (source === undefined) throw new Precondition("source-artifact-missing");

  const existing = await uow.completion.findCompletion(signingRequestId);

  return {
    documentId: request.documentId,
    sourceDigest: source.digest,
    mergedArtifactId: mergedArtifact.artifactId,
    mergedRef: { zone: "artifacts", key: mergedArtifact.storageReference },
    mergedDigest: mergedArtifact.digest,
    certificateArtifactId: certificateArtifact.artifactId,
    certificateRef: { zone: "artifacts", key: certificateArtifact.storageReference },
    certificateDigest: certificateArtifact.digest,
    alreadyFinalArtifactId: existing?.finalArtifactId ?? null,
  };
}

/** Fetches an object. Absence is terminal — the row says it exists. */
async function load(
  deps: FinalSealDependencies,
  ref: StorageObjectRef,
): Promise<Uint8Array> {
  const content = await deps.storage.getObject(ref);
  if (content === null) throw new Precondition("output-missing");

  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of content.stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ── Failure mapping ──────────────────────────────────────────────────────────

/** Structural, never `instanceof` — the application may not import the sealer. */
export function sealFailureCode(error: unknown): CompletionFailureCode {
  if (typeof error !== "object" || error === null) return "sealer-unavailable";
  const candidate = error as { code?: unknown; retryable?: unknown };
  if (typeof candidate.code !== "string") return "sealer-unavailable";

  switch (candidate.code) {
    case "invalid_pdf":
    case "unsupported_pdf":
      // One of the accepted inputs will not parse. Terminal: the same bytes
      // fail identically forever.
      return "input-inconsistent";
    case "invalid_seal_input": return "input-inconsistent";
    case "unrenderable_text": return "unrenderable-value";
    case "typeface_unavailable": return "typeface-unavailable";
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
  deps: FinalSealDependencies,
  code: CompletionFailureCode,
): Promise<FinalSealResult> {
  // §186/§187: the request stays `completion-ready`. Signatures, the merged
  // candidate and the certificate all survive, and nobody is asked to re-sign.
  await deps.transactions.runForWorkspace(input.workspaceId, uow =>
    uow.completion.recordRunFailure({
      runId: input.runId,
      state: RETRYABLE.has(code) ? "waiting-retry" : "failed-terminal",
      step: "final-seal",
      code,
    }));
  return { outcome: "failed", failureCode: code };
}

async function countParticipants(
  uow: WorkspaceUnitOfWork,
  signingRequestId: SigningRequestId,
): Promise<number> {
  const rows = await uow.completionInputs.listCertifiedParticipants(signingRequestId);
  return rows.length;
}

/** Re-exported so the orchestrator can name the type without the module. */
export type { SealId };
