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
import {
  diagnoseDatabaseFailure, databaseFailureFields,
  type DatabaseFailureDiagnosis,
} from "./database-failure.js";
import type { CompletionFailureCode } from "@lagda/contracts";
import { COMPLETION_FAILURE_CLASSIFICATION } from "@lagda/contracts";
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
  /** SQLSTATE of a refusing database, when the failure was one. */
  readonly sqlstate?: string;
  /** The constraint that refused the write, when it named itself. */
  readonly constraint?: string;
  /**
   * This attempt lost a race to a concurrent one and rolled itself back.
   *
   * Carried on the RESULT rather than logged here, matching how database
   * diagnostics already travel: the worker's job logger owns the log line, and
   * this layer owns the fact. Identifiers only — never document contents.
   *
   * A non-zero rate of this in production is the signal that `abandonStaleRuns`
   * is reclaiming attempts that are slow rather than dead.
   */
  readonly supersededAttempt?: boolean;
}

/**
 * A concurrent attempt accepted this step first.
 *
 * A private sentinel, not an exported error: nothing outside this module
 * should catch it, and it never escapes — the catch below converts it into an
 * `already-merged` result.
 */
class StepAlreadyAcceptedError extends Error {
  constructor() {
    super("Another attempt accepted this completion step first.");
    this.name = "StepAlreadyAcceptedError";
  }
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
  // Reviewed over Name (081): the stored value is the instant the review was
  // accepted, drawn as the outcome over the reviewer's name.
  if (record.fieldType === "review-block" && record.value.kind === "instant") {
    return {
      kind: "outcomeBlock",
      label: `REVIEWED ${renderInstant(record.value.at)}`,
      name: requireRecipientName(record, "Review block"),
    };
  }
  const base = toBaseValue(record);
  if (record.fieldType !== "signature-block" || base.kind !== "signature") return base;
  return {
    kind: "signatureBlock", representation: base.representation,
    name: requireRecipientName(record, "Signature block"),
  };
}

function requireRecipientName(record: RenderableFieldRecord, what: string): string {
  if (record.recipientName === null) {
    // Every submitted value names its recipient; a block without one is a
    // query that lost its join, and printing no name would hide that.
    throw new Error(`${what} ${record.fieldId} has no recipient name.`);
  }
  return record.recipientName;
}

function toBaseValue(record: RenderableFieldRecord): MergeableFieldValue {
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
      const accepted = await uow.completion.acceptStep({
        completionStepId: stepId,
        runId: input.runId,
        step: "field-merge",
        outputArtifactId: artifactId,
        succeededAt: mergedAt,
      });

      // `acceptStep` returns FALSE when `signing_request_completion_steps_one_per_step`
      // already holds a row for this run and step — i.e. a concurrent attempt
      // accepted this step first. That is reachable today: `abandonStaleRuns`
      // is purely time-based, so a merely SLOW attempt can be re-claimed while
      // it is still alive.
      //
      // Throwing here is the point. It rolls back the artifact row and the
      // evidence event this attempt just wrote, which would otherwise survive
      // as rows nothing references: the step ledger points at the WINNER's
      // artifact, and evidence is sourced from this attempt's own `stepId`, so
      // `evidence_events_source_unique` does not dedupe them away.
      //
      // Caught below and converged onto the winner's output — this is not a
      // failure of the run, which is shared with the attempt that won.
      if (!accepted) throw new StepAlreadyAcceptedError();

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
  } catch (error) {
    // A concurrent attempt won this step. Nothing of ours was committed, so
    // there is nothing to undo and nothing to report as broken: converge on
    // the artifact the winner recorded and let the run carry on.
    //
    // Deliberately NOT `fail()`. The run is shared with the attempt that won,
    // and marking it failed here would push a healthy run toward
    // `failed-terminal` because it happened to be worked twice.
    if (error instanceof StepAlreadyAcceptedError) {
      const winner = await readAcceptedArtifact(input, deps);
      if (winner !== null) {
        return { outcome: "already-merged", artifactId: winner, supersededAttempt: true };
      }
      // The row vanished between the conflict and this read, which should be
      // impossible — an accepted step is never deleted. Fall through to the
      // ordinary failure path rather than inventing an artifact id.
      return fail(input, deps, "database-rejected");
    }

    // Bytes exist, no row. Recoverable and deliberately NOT cleaned up here:
    // deleting on an uncertain transaction outcome is how a real artifact is
    // destroyed (§78). The object is private and unreferenced.
    const diagnosis = diagnoseDatabaseFailure(error);
    return fail(input, deps, diagnosis.code, diagnosis);
  }

  return { outcome: "merged", artifactId };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The artifact the WINNING attempt recorded for this step.
 *
 * Read in its own transaction, after ours rolled back. Resolved from the step
 * ledger rather than by querying `document_artifacts` for the newest
 * `merged-candidate`: a losing attempt may have left bytes in storage, and
 * "the latest merged artifact" is exactly the wrong way to pick between them.
 */
async function readAcceptedArtifact(
  input: { readonly workspaceId: WorkspaceId; readonly runId: CompletionRunId },
  deps: FieldMergeDependencies,
): Promise<ArtifactId | null> {
  return deps.transactions.runForWorkspace(input.workspaceId, async uow => {
    const steps = await uow.completion.listSteps(input.runId);
    const accepted = steps.find(step => step.step === "field-merge");
    return accepted?.outputArtifactId ?? null;
  });
}

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
  const outcomes = await approverOutcomeLabels(uow, signingRequestId, records);

  return {
    documentId: request.documentId,
    sourceArtifactId: source.artifactId,
    sourceRef: { zone: "artifacts", key: source.storageReference },
    sourceDigest: source.digest,
    fields: [...records.map(toMergeableField), ...outcomes],
    alreadyAcceptedArtifactId: accepted?.outputArtifactId ?? null,
  };
}

/**
 * An approver's empty fields, drawn as what the approver actually did (069).
 *
 * An approver approves or skips; their fields are optional, so a signature
 * box placed for them is usually left empty. Leaving it blank on the final
 * document would read as a missing signature. Instead it states the outcome
 * and its date: `APPROVED 2026-09-25 (UTC)` or `SKIPPED 2026-09-25 (UTC)`.
 * A field the approver DID fill keeps its value.
 *
 * An `approval-block` (081) is never filled — it stores nothing — and is drawn
 * as the same outcome set over a rule with the approver's name beneath it,
 * the name read from the recipient snapshot exactly as a signature block's is.
 */
async function approverOutcomeLabels(
  uow: WorkspaceUnitOfWork,
  signingRequestId: SigningRequestId,
  records: readonly RenderableFieldRecord[],
): Promise<MergeableField[]> {
  const recipients = await uow.signingWorkflow.listRecipientStates(signingRequestId);
  const labelByRecipient = new Map<string, string>();
  for (const r of recipients) {
    if (r.type !== "approver") continue;
    if (r.state === "approved" && r.approvedAt !== null) {
      labelByRecipient.set(String(r.recipientId), `APPROVED ${renderInstant(r.approvedAt)}`);
    } else if (r.state === "skipped" && r.skippedAt !== null) {
      labelByRecipient.set(String(r.recipientId), `SKIPPED ${renderInstant(r.skippedAt)}`);
    }
  }
  if (labelByRecipient.size === 0) return [];

  const filled = new Set(records.map(record => record.fieldId));
  const fields = await uow.signingRequests.listFields(signingRequestId);
  // Read only when a block needs a name — most requests hold none.
  let names: ReadonlyMap<string, string> | null = null;
  const nameOf = async (recipientId: string, fieldId: string): Promise<string> => {
    names ??= new Map((await uow.signingRequests.listRecipients(signingRequestId))
      .map(recipient => [String(recipient.recipientId), recipient.name]));
    const name = names.get(recipientId);
    // The assignment's own recipient, missing from the snapshot: a join that
    // lost a row, and printing no name would hide it.
    if (name === undefined) throw new Error(`Approval block ${fieldId} has no recipient name.`);
    return name;
  };

  const labels: MergeableField[] = [];
  for (const field of fields) {
    if (field.recipientId === null || filled.has(String(field.fieldId))) continue;
    const text = labelByRecipient.get(String(field.recipientId));
    if (text === undefined) continue;
    const value: MergeableFieldValue = field.type === "approval-block"
      ? {
        kind: "outcomeBlock", label: text,
        name: await nameOf(String(field.recipientId), String(field.fieldId)),
      }
      : { kind: "text", text };
    labels.push({
      fieldId: String(field.fieldId),
      pageNumber: field.pageNumber,
      rect: { x: field.x, y: field.y, width: field.width, height: field.height },
      value,
    });
  }
  return labels;
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
  // Present only for a DATABASE failure. The SQLSTATE and constraint
  // name ride out on the result so the worker's job logger records
  // WHICH rule refused the write, not merely that one did.
  diagnosis?: DatabaseFailureDiagnosis,
): Promise<FieldMergeResult> {
  await deps.transactions.runForWorkspace(input.workspaceId, uow =>
    uow.completion.recordRunFailure({
      runId: input.runId,
      state: isRetryable(code) ? "waiting-retry" : "failed-terminal",
      step: "field-merge",
      code,
    }));
  return {
    outcome: "failed", failureCode: code,
    ...(diagnosis === undefined ? {} : databaseFailureFields(diagnosis)),
  };
}

/**
 * Reads the canonical classification — now actually rather than in name.
 *
 * This was a locally restated `Set` in each of the three step files,
 * under a comment claiming it read the classification. Three copies of a
 * total record is three places to forget: a code added as retryable in
 * `COMPLETION_FAILURE_CLASSIFICATION` but missed here would have been
 * treated as terminal, permanently failing runs the contract says to
 * retry. The record is frozen and total, so there is nothing to restate.
 */
function isRetryable(code: CompletionFailureCode): boolean {
  return COMPLETION_FAILURE_CLASSIFICATION[code] === "retryable";
}

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
