// The `field-merge` step (BACKEND-39, OD-164).
//
// Renders every accepted value onto the exact bytes the signing request froze,
// and persists the result as a `merged-candidate` artifact.
//
// ── The shape, and why it is three phases rather than one transaction ──────
//
//   1. READ, in a transaction — the request, its frozen source artifact, and
//      the accepted values with their geometry
//   2. FETCH, MERGE, UPLOAD — outside any transaction
//   3. RECORD, in a short transaction — the artifact row and the step
//      acceptance, together
//
// Object storage is not transactional and cannot be enrolled in one. Holding a
// database transaction open across a download, a PDF render and an upload would
// pin a connection for the duration of the slowest thing in the pipeline, and
// it would still not make the two atomic.
//
// So the windows are chosen rather than pretended away, and the ordering is the
// same one BACKEND-18 established for uploads (INV-226):
//
//   bytes THEN row.  A row that names an object which does not exist is a
//                    completion the pipeline believes in and cannot deliver.
//   row missing, bytes present  is a private, unreferenced object — recoverable,
//                    and OD-160's sweeper is what eventually collects it.
//
// The reverse ordering has no such recovery, which is why it is not used.

import type {
  WorkspaceId, DocumentId, Sha256Digest, TransactionId,
} from "@lagda/contracts";
import type { CompletionFailureCode } from "@lagda/contracts";
import type {
  Clock, TransactionManager, WorkspaceUnitOfWork,
  ArtifactId, ArtifactIdGenerator, ArtifactRecord,
  CompletionRunId, CompletionIdGenerator,
  SigningRequestId,
  FieldMerger, MergeableField, MergeableFieldValue,
  RenderableFieldRecord, EvidenceEventIdGenerator,
} from "../common/ports/index.js";
// BACKEND-43. Factory, never a hand-built event literal.
import { fieldMergeCompleted } from "../evidence/events.js";
import type {
  ObjectStorage, StorageKeyStrategy, StorageObjectRef,
} from "../common/ports/storage.js";

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface FieldMergeDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly ids: CompletionIdGenerator & ArtifactIdGenerator
  & EvidenceEventIdGenerator;
  readonly storage: ObjectStorage;
  readonly keys: StorageKeyStrategy;
  /**
   * The renderer. A PORT — this module never imports `@lagda/sealing`, and an
   * architecture guard asserts the application package never does.
   */
  readonly merger: FieldMerger;
}

export interface FieldMergeResult {
  readonly outcome: "merged" | "already-merged" | "failed";
  readonly artifactId?: ArtifactId;
  readonly failureCode?: CompletionFailureCode;
}

// ── Mapping the renderer's failures onto the pipeline's vocabulary ───────────

/**
 * A failure the sealing package raised, seen structurally.
 *
 * NOT `instanceof UnrenderableTextError`: that would need an import of
 * `@lagda/sealing` from the application layer, inverting the dependency the
 * whole seam exists to protect. The package's errors carry a stable `code` and
 * a `retryable` flag precisely so a caller can classify them without knowing
 * the classes.
 */
interface SealingFailureShape {
  readonly code: string;
  readonly retryable: boolean;
}

function asSealingFailure(error: unknown): SealingFailureShape | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { code?: unknown; retryable?: unknown };
  return typeof candidate.code === "string" && typeof candidate.retryable === "boolean"
    ? { code: candidate.code, retryable: candidate.retryable }
    : null;
}

/**
 * Renderer failure to completion failure code.
 *
 * The default is deliberate and is the conservative direction: an
 * *unrecognised* failure from the renderer is treated as whatever the renderer
 * said about retryability, and mapped to a code that does not claim to know
 * more than that. Guessing `invalid-geometry` for an unknown failure would send
 * an operator to inspect coordinates that are fine.
 */
export function failureCodeForSealingError(error: unknown): CompletionFailureCode {
  const failure = asSealingFailure(error);
  if (failure === null) return "sealer-unavailable";

  switch (failure.code) {
    case "unrenderable_text": return "unrenderable-value";
    case "typeface_unavailable": return "typeface-unavailable";
    case "unsupported_representation": return "unsupported-representation";
    case "invalid_field_placement": return "invalid-geometry";
    case "invalid_pdf":
    case "unsupported_pdf":
      // The frozen source cannot be rendered. Terminal, and it is the SOURCE
      // that is wrong rather than anything about this attempt.
      return "source-artifact-missing";
    case "invalid_seal_input": return "input-inconsistent";
    default:
      return failure.retryable ? "sealer-unavailable" : "input-inconsistent";
  }
}

// ── Projecting stored values into renderable fields ──────────────────────────

/**
 * How a `DATE_SIGNED` instant becomes characters.
 *
 * **ISO-8601 date, explicitly LABELLED `UTC`** — `2026-08-11 (UTC)`.
 *
 * ── Why the label, and why not a local date ────────────────────────────────
 *
 * The product is NOT Philippine-only (owner, 2026-08-11), so the renderer must
 * not assume a jurisdiction. Two consequences, and the label is what resolves
 * the second:
 *
 *   - `Asia/Manila` is ruled out. Hard-coding it would be wrong the first time
 *     a document is signed elsewhere, and wrong INVISIBLY, because a date looks
 *     plausible whichever day it says.
 *   - A bare UTC date is also wrong, quietly. PHT is UTC+8, so a signature
 *     accepted at 07:00 in Manila renders as the PREVIOUS day, and a reader has
 *     no way to tell that from a signature genuinely made the day before.
 *
 * Labelling it makes the frame of reference part of the document. The date may
 * differ from the signer's local calendar day, but it can no longer be
 * MISREAD — and on a legal instrument that is the difference that matters.
 *
 * ── The trap for whoever implements the real fix ───────────────────────────
 *
 * There IS a validated IANA timezone in this codebase — `users.timezone`, with
 * `looksLikeIanaZone` and `isKnownTimezone` in `account/profile.ts`. **It is the
 * wrong one.** That is a workspace ACCOUNT HOLDER's display preference, and the
 * person whose date this is signs through a link with no LAGDA account at all
 * (BACKEND-33). Dating a counterparty's signature by the sender's preference
 * would be worse than UTC, because it would look local and be someone else's
 * local.
 *
 * The real fix is to capture the SIGNER's zone during the ceremony and persist
 * it with the submission. OD-166 carries it; the validation helpers above are
 * reusable when it happens.
 */
function renderInstant(at: number): string {
  return `${new Date(at).toISOString().slice(0, 10)} (UTC)`;
}

/** One stored value to one renderable field. */
export function toMergeableField(record: RenderableFieldRecord): MergeableField {
  return {
    fieldId: record.fieldId,
    pageNumber: record.pageNumber,
    rect: { x: record.x, y: record.y, width: record.width, height: record.height },
    value: toMergeableValue(record),
  };
}

function toMergeableValue(record: RenderableFieldRecord): MergeableFieldValue {
  const value = record.value;
  switch (value.kind) {
    case "text":
      return { kind: "text", text: value.text };
    case "checkbox":
      return { kind: "checkbox", checked: value.checked };
    case "instant":
      return { kind: "text", text: renderInstant(value.at) };
    case "typed-signature":
      return {
        kind: "signature",
        representation: {
          kind: "typed", text: value.text, styleIndex: value.styleIndex,
        },
      };
    case "raster-signature":
      return {
        kind: "signature",
        representation: {
          kind: "raster",
          bytes: value.bytes,
          mediaType: value.mediaType,
          width: value.width,
          height: value.height,
        },
      };
  }
}

// ── The step ─────────────────────────────────────────────────────────────────

interface MergePlan {
  readonly documentId: DocumentId;
  readonly sourceArtifactId: ArtifactId;
  /**
   * Taken from the artifact ROW, not re-derived from the id.
   *
   * The row records where the bytes actually are. Re-deriving the key would
   * agree today and diverge silently the first time the derivation changes,
   * and it would read from a location the row never claimed.
   */
  readonly sourceRef: StorageObjectRef;
  readonly sourceDigest: Sha256Digest;
  readonly fields: readonly MergeableField[];
  readonly alreadyAcceptedArtifactId: ArtifactId | null;
}

/**
 * Runs `field-merge` for one claimed run.
 *
 * The caller has already claimed the run and revalidated eligibility. This does
 * not claim, and does not decide whether the request may complete.
 */
export async function runFieldMergeStep(
  input: {
    readonly workspaceId: WorkspaceId;
    readonly runId: CompletionRunId;
    readonly signingRequestId: SigningRequestId;
  },
  deps: FieldMergeDependencies,
): Promise<FieldMergeResult> {
  // ── 1. Read everything the merge needs, in one transaction ────────────────
  let plan: MergePlan;
  try {
    plan = await deps.transactions.runForWorkspace(input.workspaceId, uow =>
      buildPlan(uow, input.signingRequestId, input.runId));
  } catch (error) {
    const code = asPlanFailure(error);
    if (code === null) throw error;
    return fail(input, deps, code);
  }

  // §117: a retry finds the previous attempt's output and REUSES it. Re-merging
  // would produce a second artifact for one step, and the certificate would
  // then have two candidates to sit beside.
  if (plan.alreadyAcceptedArtifactId !== null) {
    return { outcome: "already-merged", artifactId: plan.alreadyAcceptedArtifactId };
  }

  // ── 2. Fetch, merge, upload — outside any transaction ─────────────────────
  let sourceBytes: Uint8Array;
  try {
    const content = await deps.storage.getObject(plan.sourceRef);
    if (content === null) {
      // The row says the artifact exists and the object is not there. Terminal:
      // retrying cannot conjure bytes, and §77 is exactly this — a status is
      // not proof that an object exists.
      return fail(input, deps, "source-artifact-missing");
    }
    sourceBytes = await collect(content.stream);
  } catch {
    return fail(input, deps, "storage-unavailable");
  }

  const mergedAt = deps.clock.now();
  let merged;
  try {
    merged = await deps.merger.mergeFields({
      sourceDocument: sourceBytes,
      fields: plan.fields,
      mergedAt: new Date(mergedAt).toISOString(),
    });
  } catch (error) {
    return fail(input, deps, failureCodeForSealingError(error));
  }

  // The integrity check the step exists to make.
  //
  // Storage returned SOMETHING; this proves it returned the exact bytes the
  // signing request froze. Without it the pipeline would render onto whatever
  // the object store handed back — a restored object, a key collision, a
  // partially written file — and seal it as the document people agreed to.
  //
  // The digest comes from the merger, which hashes the input before touching
  // it. The application layer computes no digests of its own: hashing is
  // confined to `@lagda/sealing` so one implementation cannot disagree with
  // another about hex versus base64.
  if (merged.sourceDocumentHash !== plan.sourceDigest) {
    return fail(input, deps, "source-artifact-missing");
  }

  const artifactId = deps.ids.nextArtifactId();
  const mergedRef = deps.keys.artifactKey({
    workspaceId: input.workspaceId,
    documentId: plan.documentId,
    artifactId,
  });

  try {
    await deps.storage.putObject({
      ref: mergedRef,
      content: { kind: "bytes", bytes: merged.mergedDocument },
      mediaType: "application/pdf",
    });
  } catch {
    // No row was written, so nothing references anything. A retry re-merges
    // and uploads under a NEW artifact id; the abandoned object, if any, is
    // OD-160's to collect.
    return fail(input, deps, "storage-unavailable");
  }

  // ── 3. Record the artifact and accept the step, together ──────────────────
  //
  // ONE transaction. An artifact row without an accepted step would be
  // re-created by the next attempt; an accepted step naming an artifact row
  // that does not exist would let `certificate` proceed against nothing.
  try {
    await deps.transactions.runForWorkspace(input.workspaceId, async uow => {
      await uow.artifacts.insert({
        artifactId,
        workspaceId: input.workspaceId,
        documentId: plan.documentId,
        artifactType: "merged-candidate",
        storageReference: mergedRef.key,
        mediaType: "application/pdf",
        sizeBytes: merged.mergedDocument.byteLength,
        digestAlgorithm: "sha-256",
        digest: merged.mergedDocumentHash,
        sourceArtifactId: plan.sourceArtifactId,
        createdAt: mergedAt,
      } satisfies ArtifactRecord);

      const stepId = deps.ids.nextCompletionStepId();
      await uow.completion.acceptStep({
        completionStepId: stepId,
        runId: input.runId,
        step: "field-merge",
        outputArtifactId: artifactId,
        succeededAt: mergedAt,
      });

      // Evidence, in the SAME transaction as the step acceptance (§156, §160).
      // Sourced by the STEP, so a duplicate worker converges on the one event
      // rather than appending a second (§251, §260).
      //
      // `occurredAt` is the step's own success time, not a clock read here —
      // the two would differ by however long the transaction ran.
      await uow.evidence.append(fieldMergeCompleted({
        newEventId: () => deps.ids.nextEvidenceEventId(),
        signingRequestId: input.signingRequestId as unknown as TransactionId,
        occurredAt: mergedAt,
      }, stepId));
    });
  } catch {
    // Bytes exist, no row. Recoverable and deliberately NOT cleaned up here:
    // deleting on an uncertain transaction outcome is how a real artifact is
    // destroyed (§78). The object is private and unreferenced.
    return fail(input, deps, "database-unavailable");
  }

  return { outcome: "merged", artifactId };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function buildPlan(
  uow: WorkspaceUnitOfWork,
  signingRequestId: SigningRequestId,
  runId: CompletionRunId,
): Promise<MergePlan> {
  const request = await uow.signingRequests.find(signingRequestId);
  if (request === null) throw new PlanFailure("input-inconsistent");

  // The EXACT artifact the request froze. Resolving the document's CURRENT
  // artifact would seal bytes nobody agreed to (§9).
  const artifacts = await uow.artifacts.listForDocument(request.documentId);
  const source = artifacts.find(
    artifact => artifact.artifactId === request.sourceArtifactId);
  if (source === undefined) throw new PlanFailure("source-artifact-missing");

  const steps = await uow.completion.listSteps(runId);
  const accepted = steps.find(
    step => step.step === "field-merge" && step.state === "succeeded");

  const records = await uow.completionInputs.listRenderableFieldValues(signingRequestId);

  return {
    documentId: request.documentId,
    sourceArtifactId: source.artifactId,
    sourceRef: { zone: "artifacts", key: source.storageReference },
    sourceDigest: source.digest,
    fields: records.map(toMergeableField),
    alreadyAcceptedArtifactId: accepted?.outputArtifactId ?? null,
  };
}

/** A read-phase failure that already knows its bounded code. */
class PlanFailure extends Error {
  constructor(readonly failureCode: CompletionFailureCode) {
    super("The field-merge step could not read its inputs.");
  }
}

function asPlanFailure(error: unknown): CompletionFailureCode | null {
  if (error instanceof PlanFailure) return error.failureCode;
  // A projection refusal from the repository — a value whose columns disagree
  // with its own kind. Terminal: the same row projects the same way forever.
  if (error instanceof Error && /value kind|representation|has no/i.test(error.message)) {
    return "input-inconsistent";
  }
  return null;
}

async function fail(
  input: { readonly workspaceId: WorkspaceId; readonly runId: CompletionRunId },
  deps: FieldMergeDependencies,
  code: CompletionFailureCode,
): Promise<FieldMergeResult> {
  await deps.transactions.runForWorkspace(input.workspaceId, uow =>
    uow.completion.recordRunFailure({
      runId: input.runId,
      state: isRetryable(code) ? "waiting-retry" : "failed-terminal",
      step: "field-merge",
      code,
    }));
  return { outcome: "failed", failureCode: code };
}

/** Reads the classification rather than restating it. */
function isRetryable(code: CompletionFailureCode): boolean {
  return RETRYABLE.has(code);
}

const RETRYABLE = new Set<CompletionFailureCode>([
  "storage-unavailable", "sealer-unavailable", "step-not-implemented",
  "typeface-unavailable", "database-unavailable", "attempt-abandoned",
]);

/** Drains a byte stream into one buffer. */
async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
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
