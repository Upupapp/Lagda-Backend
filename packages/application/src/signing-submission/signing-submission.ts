// Authoritative recipient signature submission (BACKEND-36).
//
// ── The one operation ──────────────────────────────────────────────────────
//
//   recipient session cookie + recipient CSRF + Idempotency-Key
//        -> RecipientSigningContext
//        -> claim the key, scoped to THIS recipient
//        -> revalidate signability, routing and consent AT COMMIT TIME
//        -> resolve the submitted values against the immutable assignments
//        -> validate the adopted representation
//        -> one RecipientSubmission + its representations + its values
//        -> complete the key
//   all in ONE transaction
//
// ── What this owns, and what it does not ───────────────────────────────────
//
// It owns: what this recipient submitted, and when.
// BACKEND-37 owns: what workflow state follows from that.
//
// The seam is `acceptedAt`. BACKEND-37 must reuse it rather than taking a
// second clock reading, because one signing act with two timestamps is a
// scheduling artefact presented as a fact.

import type { WorkspaceId } from "@lagda/contracts";
import type { PreparedSignature } from "../common/ports/prepared-signatures.js";
import {
  assessCeremonyAccess, resolveSubmission, canonicalSubmissionFingerprint,
  CEREMONY_CONSENT_TYPE,
  type SubmittedValue, type SubmissionProblem, type ResolvedFieldValue,
} from "@lagda/core";
import type { IdempotencyKey } from "@lagda/contracts";
import type {
  IdempotencyKeyDigester, IdempotencyRecordIdGenerator, IdempotencyScope,
} from "../common/ports/idempotency.js";
import type {
  Clock, TransactionManager,
  RecipientSessionTokenFactory, RecipientCeremonyUnitOfWork,
  RecipientSubmissionIdGenerator, SignatureImageValidator,
  TypedSignatureRenderability,
  NewSigningRepresentation, NewSigningFieldValue, RepresentationPurpose,
  SigningRequestFieldId, SigningConsentId, AcceptedSubmissionRecord,
  SigningRequestRecord,
} from "../common/ports/index.js";
import { ApplicationError } from "../common/errors/index.js";
import {
  resolveRecipientSession,
  type RecipientSigningContext, type SigningAccessDependencies,
} from "../signing-access/signing-access.js";
import {
  applyRecipientSubmissionToWorkflow, advanceSigningWorkflow,
} from "../signing-workflow/signing-workflow.js";
import type {
  SigningAccessProvisioningDependencies,
} from "../signing-requests/send.js";
import type {
  SigningWorkflowIdGenerator, CompletionIdGenerator, EvidenceEventIdGenerator,
} from "../common/ports/index.js";
import type { JobScheduler } from "../common/ports/jobs.js";
import { CompletionProcessJob, CompletionReconcileJob } from "../jobs/definitions.js";

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Why each refusal is worth telling the signer.
 *
 * The envelope carries a `code` per detail, and the API's code field is
 * deliberately an open string so a domain command can add one without editing
 * the contract. So these reach the client as-is and a ceremony can react to
 * them — which matters most for `signature-unrenderable`: without it a signer
 * whose typed name cannot be drawn sees "could not be accepted" and has no way
 * to know that drawing it instead would work.
 *
 * No message echoes the submitted value. A detail that quoted a rejected name
 * would put it in logs and error reporting, which is the thing §42 and §217
 * keep signing content out of.
 */
const PROBLEM_MESSAGES: Record<SubmissionProblem["code"], string> = {
  "field-not-available": "That field is not available on this request.",
  "field-duplicated": "A field was supplied more than once.",
  "field-type-mismatch": "A field was supplied with the wrong kind of value.",
  "field-required": "A required field is missing.",
  "field-value-invalid": "A field value is not valid.",
  "field-server-owned": "That field is filled in by LAGDA and cannot be supplied.",
  "signature-missing": "A signature is required on this document.",
  "initials-missing": "Initials are required on this document.",
  "signature-unrenderable":
    "This cannot be drawn into the document. Try a different spelling, "
    + "or draw or upload it instead.",
};

/** The submission was refused. Carries only fields the caller owns. */
export class SigningSubmissionInvalidError extends ApplicationError {
  readonly category = "validation" as const;
  readonly code = "signing_submission_invalid";
  /**
   * The envelope's `details`, derived from `problems`.
   *
   * A derived view rather than a second field the constructor must remember to
   * populate: one source, so a producer cannot add a problem that never
   * reaches the client.
   *
   * `fieldId` is used as the path when the problem names one — it is a field
   * the caller already owns and supplied — and the representation purposes are
   * named directly otherwise, so a ceremony can map a detail to the control
   * that produced it.
   */
  get details(): readonly { field: string; code: string; message: string }[] {
    return this.problems.map(problem => ({
      field: problem.fieldId
        ?? (problem.code === "initials-missing" ? "initials" : "signature"),
      code: problem.code,
      message: PROBLEM_MESSAGES[problem.code],
    }));
  }

  constructor(readonly problems: readonly SubmissionProblem[]) {
    super("The signing submission could not be accepted.");
  }
}

/**
 * This recipient has already signed.
 *
 * A DELIBERATE refusal rather than a silent convergence (§39). A second
 * intentional submission is not a retry — the client chose a new key, which
 * means it believes this is a new act. An immutable signing record has no way
 * to be a second one, so saying so is the only honest answer.
 */
export class RecipientAlreadySubmittedError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "recipient_already_submitted";
  constructor() { super("This recipient has already submitted their signature."); }
}

/** The request or the recipient is not currently signable. */
export class SigningNotPermittedError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "signing_not_permitted";
  constructor(readonly reason: string) {
    super(`Signing is not currently permitted: ${reason}.`);
  }
}

/** The required disclosure has not been accepted. */
export class SigningConsentRequiredError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "signing_consent_required";
  constructor() { super("The electronic signature disclosure must be accepted first."); }
}

/** Same key, different logical submission. */
export class SigningIdempotencyConflictError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "idempotency_conflict";
  constructor() {
    super("That idempotency key was used for a different submission.");
  }
}

/** A concurrent attempt holds the key. */
export class SigningSubmissionInProgressError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "signing_submission_in_progress";
  constructor() { super("A submission with that key is already in progress."); }
}

// ── Input and output ─────────────────────────────────────────────────────────

export interface SignatureRepresentationInput {
  readonly method: "typed" | "drawn" | "saved";
  /**
   * How the signer produced this, as their client reports it.
   *
   * Absent when the client says nothing, which older clients will. The value
   * `applied-from-saved` is NOT accepted here — only the server may record
   * that, because only the server knows whether it took bytes from a stored
   * signature.
   */
  readonly provenance?: "typed-live" | "drawn-live" | "uploaded-live";
  readonly text?: string;
  readonly styleIndex?: number;
  readonly base64?: string;
}

export interface SubmitRecipientSigningInput {
  readonly rawSessionToken: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly fieldValues: readonly SubmittedValue[];
  readonly signature?: SignatureRepresentationInput;
  readonly initials?: SignatureRepresentationInput;
}

export interface SubmitRecipientSigningResult {
  readonly submissionId: string;
  readonly acceptedAt: number;
  readonly acceptedFieldCount: number;
  /** True when a stored result was replayed rather than a new act accepted. */
  readonly replayed: boolean;
}

export interface SigningSubmissionDependencies {
  readonly transactions: TransactionManager;
  /** BACKEND-37. The advance intent needs an identity like anything else. */
  readonly workflowIds: SigningWorkflowIdGenerator;
  /** BACKEND-38. The completion run the advance creates when readiness lands. */
  readonly completionIds: CompletionIdGenerator;
  /**
   * The BACKEND-33 provisioner's slice, for the advance that follows a commit.
   *
   * Present here so the submission route can drive the whole progression
   * without a second composition root. It is NOT used inside the transaction —
   * nothing in the recipient realm may provision anybody.
   */
  readonly workflowAccess: SigningAccessProvisioningDependencies;
  readonly clock: Clock;
  readonly sessionTokens: RecipientSessionTokenFactory;
  readonly ids: RecipientSubmissionIdGenerator & EvidenceEventIdGenerator;
  readonly idempotencyKeys: IdempotencyKeyDigester;
  readonly idempotencyIds: IdempotencyRecordIdGenerator;
  readonly signatureImages: SignatureImageValidator;
  /**
   * Whether the renderer can draw a typed signature, asked HERE rather than
   * discovered at merge time. See the port's own note: the merge refuses
   * uncoverable text terminally, and by then the signer is long gone.
   */
  readonly typedSignatures: TypedSignatureRenderability;
  readonly policy: {
    readonly consentVersion: string;
    readonly idempotencyRetentionMs: number;
  };
  /**
   * Phase 1-B. Enqueues real completion processing the instant a request
   * becomes `completion-ready` — the "immediate" half of the hybrid trigger.
   *
   * Optional and deliberately best-effort, same reasoning as
   * `advanceSigningWorkflow` itself just below: the durable work already
   * committed via `completion.ensureRun` inside that call, so a failed or
   * absent enqueue only delays processing until `completion.reconcile`
   * (enqueued alongside it) picks the run up — it never loses anything, and
   * a deployment that supplies neither still gets a correct, if slower,
   * completion pipeline once one is composed.
   */
  readonly completionScheduler?: JobScheduler;
}

type SessionDeps = Pick<
  SigningAccessDependencies, "transactions" | "clock" | "sessionTokens"
>;

// ── The use case ─────────────────────────────────────────────────────────────

export async function submitRecipientSigning(
  input: SubmitRecipientSigningInput,
  deps: SigningSubmissionDependencies,
): Promise<SubmitRecipientSigningResult> {
  const sessionDeps: SessionDeps = {
    transactions: deps.transactions,
    clock: deps.clock,
    sessionTokens: deps.sessionTokens,
  };
  // Authentication FIRST. An idempotency key is not a credential and grants
  // nothing; BACKEND-14's ordering puts identity before the key, and a caller
  // holding only a key must fail here (§32).
  const context = await resolveRecipientSession(
    input.rawSessionToken, sessionDeps as SigningAccessDependencies);

  const digest = deps.sessionTokens.digestToken(input.rawSessionToken);
  if (digest === null) throw new SigningNotPermittedError("session");

  // What this session was handed, if anything. Read before the transaction
  // for the same reason the image validation is: a database lock must not be
  // held while unrelated work happens.
  //
  // Session-scoped, so a forwarded link cannot reach a mark prepared for the
  // browser that was actually verified.
  const handed = await deps.transactions.runGlobal(async uow =>
    uow.preparedSignatures.listForSession(
      String(context.signingRequestId), String(context.recipientId),
      String(context.signingSessionId)));

  // Decoded and validated OUTSIDE the transaction. §129: a database lock must
  // not be held while an image header is parsed.
  const prepared = prepareRepresentations(input, deps, handed);

  const now = deps.clock.now();
  const scope: IdempotencyScope = {
    type: "recipient",
    recipientId: String(context.recipientId),
    signingRequestId: String(context.signingRequestId),
  };
  const fingerprint = deps.idempotencyKeys.fingerprint(
    canonicalSubmissionFingerprint({
      signingRequestId: String(context.signingRequestId),
      recipientId: String(context.recipientId),
      submitted: input.fieldValues,
      signatureMethod: input.signature?.method ?? null,
      initialsMethod: input.initials?.method ?? null,
    }));

  const accepted = await deps.transactions.runForRecipientSession(digest, sessionUow =>
    sessionUow.enterWorkspace(
      {
        workspaceId: context.workspaceId,
        signingRequestId: context.signingRequestId,
        recipientId: context.recipientId,
      },
      uow => acceptSubmission({
        uow, context, input, deps, now, scope, fingerprint, prepared,
      }),
    ));

  // ── The advance, AFTER the commit ────────────────────────────────────────
  //
  // Not part of the transaction above, and the reason is not performance:
  // activating the next cohort needs to read the NEXT recipient's snapshot and
  // write their email into a delivery intent, and migration 022 binds this
  // realm to its own recipient row. See the module comment in
  // `signing-workflow.ts`.
  //
  // Best-effort ON PURPOSE. The durable intent committed with the signature, so
  // a failure here delays the next invitation and loses nothing — the
  // reconciler picks it up. Letting this throw would fail a request whose
  // signature is already accepted and immutable, telling the signer their
  // signing failed when it did not (§172).
  try {
    const advanced = await advanceSigningWorkflow(
      {
        workspaceId: context.workspaceId,
        signingRequestId: context.signingRequestId,
      },
      {
        transactions: deps.transactions,
        clock: deps.clock,
        workflowIds: deps.workflowIds,
        completionIds: deps.completionIds,
        access: deps.workflowAccess,
      });

    // Phase 1-B, the "immediate" half of the hybrid completion trigger. The
    // run itself was already created durably, inside `advanceSigningWorkflow`
    // above (`uow.completion.ensureRun`, in the transition's own transaction)
    // — this enqueue is purely a latency optimization on top of that, which
    // is exactly why it belongs in this same best-effort try: whether it
    // succeeds, fails, or never runs at all (no scheduler composed),
    // `completion.reconcile` — enqueued alongside it, self-scheduled a few
    // minutes out via its singleton key — is what actually GUARANTEES the
    // run gets processed either way.
    if (advanced.outcome === "completion-ready" && deps.completionScheduler !== undefined) {
      const workspaceId = context.workspaceId as string;
      await deps.completionScheduler.enqueue(CompletionProcessJob, {
        workspaceId, completionRunId: advanced.completionRunId as string,
      });
      await deps.completionScheduler.enqueue(CompletionReconcileJob, {
        workspaceId,
      }, {
        startAfter: now + 5 * 60_000,
        singletonKey: workspaceId,
        singletonSeconds: 5 * 60,
      });
    }
  } catch {
    // Swallowed without the error object: an exception message is unbounded
    // text that may carry a value from the row it failed on, and the recipient
    // path must not be where that surfaces (§197, §199).
  }

  // The handoff ends here.
  //
  // AFTER the submission has committed, and best-effort. A prepared mark is a
  // copy — the evidence row already holds its own bytes and its own digest,
  // and nothing signed depends on this row surviving. So a failure here
  // leaves a spent copy behind rather than costing a signature, which is the
  // right way round: the alternative is holding the submission open to tidy
  // up after it.
  //
  // It is session-scoped and the session is about to end, so a stray row is
  // unreachable even if it lingers.
  if (handed.length > 0) {
    try {
      await deps.transactions.runGlobal(async uow =>
        uow.preparedSignatures.consumeForRecipient(
          String(context.signingRequestId), String(context.recipientId)));
    } catch { /* a spent copy outliving its use is not worth a failed sign. */ }
  }

  return accepted;
}

interface PreparedRepresentation {
  readonly purpose: RepresentationPurpose;
  readonly build: (id: string) => NewSigningRepresentation;
}

/**
 * Decodes and validates the adopted representations before any lock is taken.
 *
 * A typed signature is bounded by the schema and needs no decoding. A drawn one
 * is base64 that must be decoded, magic-byte checked and dimension checked —
 * work that is cheap but not free, and that has no business happening inside a
 * transaction holding the recipient's row.
 */
function prepareRepresentations(
  input: SubmitRecipientSigningInput,
  deps: SigningSubmissionDependencies,
  handed: readonly PreparedSignature[],
): readonly PreparedRepresentation[] {
  const prepared: PreparedRepresentation[] = [];
  for (const [purpose, supplied] of [
    ["signature", input.signature], ["initials", input.initials],
  ] as const) {
    if (supplied === undefined) continue;

    if (supplied.method === "saved") {
      // The bytes come from what the server was handed, never from the
      // request. That is what makes `applied-from-saved` a fact rather than
      // a claim: a client that could supply the content could assert this
      // provenance for anything.
      const source = handed.find(entry => entry.purpose === purpose);
      if (source === undefined) {
        throw new SigningSubmissionInvalidError([{ code: "field-value-invalid" }]);
      }
      prepared.push({
        purpose,
        build: id => ({
          representationId: id as never,
          purpose,
          representationType: source.representationType,
          typedText: source.typedText,
          typedStyleIndex: source.typedStyleIndex,
          // A FRESH evidence row holding its own copy of the bytes. It does
          // not reference the prepared row or the library entry, so deleting
          // either afterwards cannot reach into a signed document.
          rasterBytes: source.rasterBytes,
          rasterMediaType: source.rasterMediaType,
          rasterWidth: source.rasterWidth,
          rasterHeight: source.rasterHeight,
          digest: source.digest,
          // Server-decided. The only provenance value a client cannot say.
          captureProvenance: "applied-from-saved",
        }),
      });
      continue;
    }

    if (supplied.method === "typed") {
      const text = supplied.text ?? "";
      const styleIndex = supplied.styleIndex ?? -1;
      if (text.trim().length === 0 || styleIndex < 0) {
        throw new SigningSubmissionInvalidError([{ code: "field-value-invalid" }]);
      }
      // Can the renderer actually DRAW this? Asked while the signer is still
      // present, because the merge asks it much later — in the completion
      // pipeline, after the tab is closed — and its refusal ends the request.
      //
      // Both failure modes are the adapter's business, and both must be
      // refused here: missing glyphs fail the merge terminally on
      // `unrenderable-value`, and a shaping failure fails it as
      // `sealer-unavailable`, which is RETRYABLE and therefore burns the whole
      // attempt budget before dying exhausted. Neither ever completes, and the
      // sender is never notified either way.
      //
      // Checked against the trimmed text because that is what is stored and
      // therefore what the merge will draw.
      if (deps.typedSignatures.check(text.trim()) !== null) {
        throw new SigningSubmissionInvalidError([{ code: "signature-unrenderable" }]);
      }
      // The digest covers the canonical typed payload, so a typed signature has
      // an integrity identifier for the same reasons a raster does.
      const canonical = JSON.stringify({ v: 1, text, styleIndex });
      prepared.push({
        purpose,
        build: id => ({
          representationId: id as never,
          purpose,
          representationType: "TYPED_SIGNATURE_V1",
          typedText: text,
          typedStyleIndex: styleIndex,
          rasterBytes: null, rasterMediaType: null,
          rasterWidth: null, rasterHeight: null,
          digest: deps.signatureImages.digestCanonical(canonical),
          // The client's account of the act, or null when it said nothing.
          // Never inferred from the payload's shape: a typed payload proves
          // the mark is typed, not that a person typed it here — and
          // inventing that distinction would put a claim nobody made into a
          // row that can never be corrected.
          captureProvenance: supplied.provenance ?? null,
        }),
      });
      continue;
    }

    const validated = deps.signatureImages.validate(supplied.base64 ?? "");
    if (validated === null) {
      throw new SigningSubmissionInvalidError([{ code: "field-value-invalid" }]);
    }
    prepared.push({
      purpose,
      build: id => ({
        representationId: id as never,
        purpose,
        representationType: "RASTER_SIGNATURE_V1",
        typedText: null, typedStyleIndex: null,
        rasterBytes: validated.bytes,
        rasterMediaType: validated.mediaType,
        rasterWidth: validated.width,
        rasterHeight: validated.height,
        // Over the bytes AS STORED. If validation had normalized them, this
        // would still be the stored bytes rather than what arrived (§202).
        digest: validated.digest,
        // Drawn and uploaded are indistinguishable once both are PNGs, so
        // this is the client's report rather than an observation. Worth
        // recording anyway: the alternative in force until now was filing an
        // uploaded image as though it had been drawn.
        captureProvenance: supplied.provenance ?? null,
      }),
    });
  }
  return prepared;
}

async function acceptSubmission(args: {
  uow: RecipientCeremonyUnitOfWork;
  context: RecipientSigningContext;
  input: SubmitRecipientSigningInput;
  deps: SigningSubmissionDependencies;
  now: number;
  scope: IdempotencyScope;
  fingerprint: ReturnType<IdempotencyKeyDigester["fingerprint"]>;
  prepared: readonly PreparedRepresentation[];
}): Promise<SubmitRecipientSigningResult> {
  const { uow, context, input, deps, now, scope, fingerprint, prepared } = args;

  const recordId = deps.idempotencyIds.nextIdempotencyRecordId();
  const keyDigest = deps.idempotencyKeys.digestKey(input.idempotencyKey);

  const claim = await uow.idempotency.claim({
    recordId, scope, operation: "signature.submit", keyDigest,
    requestFingerprint: fingerprint,
    now, expiresAt: now + deps.policy.idempotencyRetentionMs,
  });

  if (claim.kind === "completed") {
    // A LOST RESPONSE. The act already happened; hand back exactly what it
    // produced, including its original `acceptedAt` (§35, §37).
    const stored = claim.result.body as {
      submissionId: string; acceptedAt: number; acceptedFieldCount: number;
    };
    return { ...stored, replayed: true };
  }
  if (claim.kind === "conflict") throw new SigningIdempotencyConflictError();
  if (claim.kind === "inProgress") throw new SigningSubmissionInProgressError();

  // ── Revalidate. Not "assume it was true when the page loaded". ────────────
  const request = await uow.ceremony.getRequest();
  const recipient = await uow.ceremony.getRecipient();
  if (request === null || recipient === null) {
    throw new SigningNotPermittedError("snapshot");
  }
  const activationState = await uow.ceremony.getActivationState();
  const consents = await uow.ceremony.listConsents();
  const matchingConsent = consents.find(
    c => c.consentType === CEREMONY_CONSENT_TYPE
      && c.consentVersion === deps.policy.consentVersion) ?? null;

  const access = assessCeremonyAccess({
    requestState: request.state,
    recipientState: activationState,
    recipientType: recipient.type,
    consentAccepted: matchingConsent !== null,
  });
  if (!access.mayEnter) {
    // BACKEND-37 gave the canonical policy a state for "this recipient already
    // signed", and it now fires BEFORE the one-per-recipient constraint would.
    // Mapped back to the precise error rather than reported as a generic
    // denial: a client that sent a new key deliberately is owed the true
    // reason, and `recipient_already_submitted` is what the route maps (§39).
    if (access.blocker === "already-signed") throw new RecipientAlreadySubmittedError();
    throw new SigningNotPermittedError(access.blocker ?? "not-permitted");
  }
  // Consent is checked from the RECORD, never from a client boolean (§24).
  if (access.consentRequired && matchingConsent === null) {
    throw new SigningConsentRequiredError();
  }
  if (!access.mayProceedToInput) {
    throw new SigningNotPermittedError("recipient-cannot-sign");
  }

  // Already signed? The unique constraint would catch it, but a clear error
  // beats a constraint violation surfacing as a 500.
  const existing = await uow.submissions.findAccepted();
  if (existing !== null) throw new RecipientAlreadySubmittedError();

  // ── Resolve against the IMMUTABLE assignments ─────────────────────────────
  const assigned = await uow.ceremony.listAssignedFields();
  const resolution = resolveSubmission({
    assigned: assigned.map(f => ({
      fieldId: String(f.fieldId), type: f.type, required: f.required,
    })),
    submitted: input.fieldValues,
    recipient: {
      name: recipient.name, email: recipient.email,
      organization: recipient.organization,
    },
    acceptedAt: now,
  });
  if (!resolution.ok) throw new SigningSubmissionInvalidError(resolution.problems);

  const byPurpose = new Map<RepresentationPurpose, NewSigningRepresentation>();
  for (const item of prepared) {
    byPurpose.set(item.purpose, item.build(deps.ids.nextSigningRepresentationId()));
  }
  if (resolution.needsSignature && !byPurpose.has("signature")) {
    throw new SigningSubmissionInvalidError([{ code: "signature-missing" }]);
  }
  if (resolution.needsInitials && !byPurpose.has("initials")) {
    throw new SigningSubmissionInvalidError([{ code: "initials-missing" }]);
  }

  const submissionId = deps.ids.nextRecipientSubmissionId();
  const values: NewSigningFieldValue[] = resolution.values.map(
    (resolved: ResolvedFieldValue) => ({
      valueId: deps.ids.nextSigningFieldValueId(),
      fieldId: resolved.fieldId as SigningRequestFieldId,
      fieldType: resolved.type,
      valueKind: resolved.value.kind,
      valueSource: resolved.source,
      textValue: resolved.value.kind === "text" ? resolved.value.text : null,
      booleanValue: resolved.value.kind === "boolean" ? resolved.value.checked : null,
      instantValue: resolved.value.kind === "instant" ? resolved.value.at : null,
      representationId: resolved.value.kind === "representation"
        ? byPurpose.get(resolved.value.purpose)?.representationId ?? null
        : null,
    }));

  await uow.submissions.create({
    submissionId,
    acceptedAt: now,
    signingSessionId: context.signingSessionId,
    authenticationMethod: context.authenticationMethod,
    consentId: (matchingConsent as { consentId?: SigningConsentId } | null)
      ?.consentId ?? null,
    representations: [...byPurpose.values()],
    values,
  });

  // ── The workflow transition, IN THIS TRANSACTION ──────────────────────────
  //
  // This is what closes the gap BACKEND-36 documented and deliberately left
  // open (§23): after this line an accepted submission and the state that says
  // it happened commit together, or neither does.
  //
  // `now` is the submission's own `acceptedAt`, passed through. No second clock
  // reading exists on this path (INV-548).
  await applyRecipientSubmissionToWorkflow(uow, {
    submissionId,
    acceptedAt: now,
    intentId: deps.workflowIds.nextSigningWorkflowIntentId(),
    // BACKEND-43. The two evidence events for this signature are appended by
    // the workflow application, inside this same transaction.
    newEvidenceEventId: () => deps.ids.nextEvidenceEventId(),
  });

  // ── "Signed by me" and "must sign", IN THIS TRANSACTION ───────────────────
  //
  // Migration 055: when this recipient was bound to an account, that account
  // gets a record of what it signed, committing with the signature itself.
  // Migration 056: the account's "must sign" entry closes, for the same
  // reason -- a signature that landed while the entry still said "waiting"
  // would be the two tables disagreeing about one act.
  await recordForAccountHolder(uow, { request, now });

  const result = {
    submissionId: String(submissionId),
    acceptedAt: now,
    acceptedFieldCount: values.length,
  };
  // In the SAME transaction. A completed key whose mutation rolled back would
  // replay a submission that never happened.
  await uow.idempotency.complete(
    recordId, { version: 1, statusCode: 201, body: result }, now);

  return { ...result, replayed: false };
}

/**
 * The account holder's side of a signature, written with it.
 *
 * Only when `findLinkForRecipient` returns a link: an account that never
 * signed in for this recipient is not the signer as far as the record is
 * concerned, whatever its address is.
 *
 * The sender comes from the "must sign" entry the invitation opened, which
 * snapshotted it in the workspace realm. When there is no entry (the account
 * was created after the invitation), the creator is looked up directly: the
 * account table is global, and a name is all that is read.
 */
async function recordForAccountHolder(
  uow: RecipientCeremonyUnitOfWork,
  input: { readonly request: SigningRequestRecord; readonly now: number },
): Promise<void> {
  const signingRequestId = String(uow.signingRequestId);
  const recipientId = String(uow.recipientId);

  const entry = await uow.userSigningRecords.findInboxEntryForRecipient(signingRequestId, recipientId);
  await uow.userSigningRecords.closeInboxForRecipient(signingRequestId, recipientId, "signed", input.now);

  const link = await uow.accountLinks.findLinkForRecipient(signingRequestId, recipientId);
  if (link === null) return;

  const sender = entry !== null
    ? { name: entry.senderName, email: entry.senderEmail }
    : await uow.userSigningRecords.findUserContact(String(input.request.createdByUserId));

  await uow.userSigningRecords.recordSigned({
    userId: link.userId,
    signingRequestId,
    recipientId,
    workspaceId: String(uow.workspaceId),
    documentTitle: input.request.documentTitle,
    senderName: sender?.name ?? null,
    senderEmail: sender?.email ?? null,
    workspaceName: entry?.workspaceName ?? null,
    signedAt: input.now,
    recordedAt: input.now,
  });
}

/**
 * Deliberately absent from this module.
 *
 * **Any workflow transition.** No recipient SIGNED state, no request
 * completion, no routing advancement, no next-recipient activation, no
 * delivery. BACKEND-37 owns all of it and must reuse `acceptedAt`.
 *
 * **Any PDF work.** No merge, no signed artifact, no sealer. BACKEND-38+.
 *
 * **Amendment.** No update path exists, at any layer, and the runtime role
 * holds no UPDATE privilege on the three tables.
 *
 * **Decline.** BACKEND-37, in `signing-workflow.ts`.
 *
 * **Routing advancement.** BACKEND-37, and NOT in this transaction — the
 * recipient realm cannot read the next recipient.
 */
export type SigningSubmissionOperationsDeferred = never;

export type { WorkspaceId, AcceptedSubmissionRecord };
