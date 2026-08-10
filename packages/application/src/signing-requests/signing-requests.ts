// Signing request creation (BACKEND-32).
//
// ── The transition this module performs ────────────────────────────────────
//
//   MUTABLE                                  IMMUTABLE
//   Document                                 SigningRequest
//   DocumentPreparation revision N     -->   SigningRequestRecipient[]
//   PreparationRecipient[]                   SigningRequestField[]
//   PreparationField[]                       + the exact source ArtifactId
//
// Afterwards the preparation moves to revision N+1 and the request does not
// notice. That is the whole point, and it is why every value is COPIED rather
// than referenced.
//
// ── Creating is not sending ────────────────────────────────────────────────
//
// No email, no signing link, no access token, no OTP, no queued job, no PDF, no
// sealer. A request that exists has been configured; nothing has left the
// building. Architecture guards assert each absence, and BACKEND-33 owns send.
//
// ── What the client may supply ─────────────────────────────────────────────
//
// The workspace and the document, from the URL. An idempotency key, from a
// header. That is all.
//
// It may NOT supply recipients, fields, a source artifact, a state or a title.
// Every one of those is read from trusted preparation state inside the
// transaction — because a client that could send its own recipient array could
// create a signing workflow that does not match the document anyone reviewed.

import type { DocumentId, WorkspaceId, IdempotencyKey } from "@lagda/contracts";
import type { SigningRequestState } from "@lagda/contracts";
import {
  assessSnapshotReadiness, describeBlocker, canPlaceFields,
  type WorkspaceCapability,
} from "@lagda/core";
import type {
  Clock, TransactionManager, WorkspaceUnitOfWork,
  ArtifactRecord, PreparationRecord,
  SigningRequestId, SigningRequestIdGenerator, SigningRequestRecord,
  SigningRequestRecipientId, SigningRequestRecipientRecord,
  SigningRequestFieldRecord,
} from "../common/ports/index.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import {
  ApplicationError, ApplicationValidationError, ResourceNotFoundError,
} from "../common/errors/index.js";
import {
  createIdempotencyService, type IdempotencyDependencies,
} from "../idempotency/service.js";
import { assertCapability, type WorkspaceAccessContext } from "../workspaces/workspace-access.js";
// The same error, the same meaning, one declaration. BACKEND-30 already
// refuses to place fields on a document with no accepted bytes; refusing to
// snapshot one is the same refusal at a later moment.
import { DocumentNotReadyError } from "../preparation/preparation.js";

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * The authoring state cannot become a workflow.
 *
 * A validation error rather than a conflict: the caller can fix it, and the
 * blockers say exactly what to fix. It carries indexes, never labels or names —
 * see `describeBlocker`.
 */
export class PreparationNotReadyError extends ApplicationValidationError {
  constructor(issues: readonly string[]) {
    super("This document is not ready to send.", issues);
  }
}

/**
 * Nothing has been prepared, so there is nothing to snapshot.
 *
 * Distinct from "not ready": a document with no preparation at all has not been
 * half-configured, it has not been started.
 */
export class DocumentNotPreparedError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "document_not_prepared";
  constructor() {
    super("Add recipients and fields to this document before sending it.");
  }
}

/**
 * The stored preparation violates an invariant it should not be able to.
 *
 * Every case this can report is refused at write time by BACKEND-30 or
 * BACKEND-31 — a rotated source, a dangling assignee, an ineligible one. If one
 * arrives here the data is corrupt, and the right response is to refuse to
 * build an immutable legal record on top of it rather than to snapshot it
 * anyway.
 *
 * Deliberately a 500-class error, not a 4xx: the caller did nothing wrong and
 * cannot fix it, and it should be operationally visible.
 */
export class PreparationIntegrityError extends ApplicationError {
  readonly category = "internal" as const;
  readonly code = "preparation_integrity";
  constructor(public readonly detail: string) {
    super("This document's configuration could not be read.");
  }
}

// ── Projections ──────────────────────────────────────────────────────────────

export interface SigningRequestRecipientView {
  readonly recipientId: string;
  readonly name: string;
  readonly email: string;
  readonly organization: string | null;
  readonly type: SigningRequestRecipientRecord["type"];
  readonly isRequired: boolean;
  readonly orderIndex: number;
  readonly routingOrder: number;
}

export interface SigningRequestFieldView {
  readonly fieldId: string;
  readonly type: SigningRequestFieldRecord["type"];
  readonly pageNumber: number;
  readonly rect: {
    readonly x: number; readonly y: number;
    readonly width: number; readonly height: number;
  };
  readonly required: boolean;
  readonly label: string;
  readonly layer: number;
  readonly recipientId: string;
}

/**
 * A request as a client receives it.
 *
 * Read the absences. No `sourceArtifactId`, `sourcePreparationId` or
 * `sourcePreparationRevision`: provenance is an operator's concern, and a
 * client holding the artifact id is one step from asking for its storage key. No
 * `normalizedEmail`. No `createdByUserId` — the sender knows who they are, and
 * a request created by a colleague names that colleague to anyone who can read
 * it.
 */
export interface SigningRequestView {
  readonly signingRequestId: string;
  readonly documentId: DocumentId;
  /** The title AS SNAPSHOTTED. Not the document's current title. */
  readonly documentTitle: string;
  readonly state: SigningRequestState;
  readonly recipients: readonly SigningRequestRecipientView[];
  readonly fields: readonly SigningRequestFieldView[];
  readonly createdAt: number;
}

/**
 * What creation returns.
 *
 * Counts rather than the whole snapshot. The caller just supplied the
 * preparation this was built from, so echoing every party's name and address
 * back adds nothing and puts the participants of a contract in one more place.
 */
export interface SigningRequestCreatedView {
  readonly signingRequestId: string;
  readonly documentId: DocumentId;
  readonly state: SigningRequestState;
  readonly recipientCount: number;
  readonly fieldCount: number;
  readonly createdAt: number;
}

const toRecipientView = (
  record: SigningRequestRecipientRecord,
): SigningRequestRecipientView => ({
  recipientId: record.recipientId,
  name: record.name,
  email: record.email,
  organization: record.organization,
  type: record.type,
  isRequired: record.isRequired,
  orderIndex: record.orderIndex,
  routingOrder: record.routingOrder,
});

const toFieldView = (record: SigningRequestFieldRecord): SigningRequestFieldView => ({
  fieldId: record.fieldId,
  type: record.type,
  pageNumber: record.pageNumber,
  rect: { x: record.x, y: record.y, width: record.width, height: record.height },
  required: record.required,
  label: record.label,
  layer: record.layer,
  recipientId: record.recipientId,
});

export interface SigningRequestDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly ids: SigningRequestIdGenerator;
  /**
   * Everything the idempotency service needs EXCEPT the repository, which comes
   * from the unit of work so the claim commits with the snapshot.
   */
  readonly idempotency: Omit<IdempotencyDependencies, "repository">;
}

// ── Shared resolution ────────────────────────────────────────────────────────

async function authorize(
  uow: WorkspaceUnitOfWork,
  actor: AuthenticatedActor,
  capability: WorkspaceCapability,
): Promise<WorkspaceAccessContext> {
  const membership = await uow.memberships.findByUser(actor.userId);
  // Not a member, or no longer one. The same hidden 404 as everywhere else, and
  // read INSIDE the transaction so a demotion mid-request cannot commit under
  // authority that has just been lost.
  if (membership === null) throw new ResourceNotFoundError("Workspace");
  const access: WorkspaceAccessContext = {
    workspaceId: membership.workspaceId,
    userId: membership.userId,
    membershipId: membership.memberId,
    role: membership.role,
  };
  assertCapability(access, capability);
  return access;
}

// ── Create ───────────────────────────────────────────────────────────────────

export interface CreateSigningRequestInput {
  readonly actor: AuthenticatedActor;
  readonly workspaceId: WorkspaceId;
  readonly documentId: DocumentId;
  /**
   * Optional at the type level, effectively required at the route.
   *
   * A lost response is indistinguishable from a failure to the browser that
   * sent it, and the natural reaction — retry — would create a SECOND signing
   * workflow over the same document. Unlike most duplicates that is not
   * cosmetic: BACKEND-33 could then send both, and two sets of invitations for
   * one agreement reach the same counterparties.
   */
  readonly idempotencyKey?: IdempotencyKey;
}

/**
 * Turns one coherent preparation state into an immutable signing workflow.
 *
 * ── One transaction, and nothing outside PostgreSQL ────────────────────────
 *
 * The document, the artifact, the preparation, its recipients and its fields
 * are all read, and the whole snapshot plus the idempotency claim are all
 * written, on ONE unit of work. There is no email, no queue, no storage call
 * and no PDF work inside it — so it is short, and it either happens completely
 * or not at all.
 *
 * ── Why one transaction is the whole concurrency story ─────────────────────
 *
 * The five reads happen at one snapshot of the database. A concurrent
 * `saveDocumentPreparation` either committed before them — in which case this
 * request captures the new layout, coherently — or commits after, in which case
 * it captures the old one, coherently. There is no interleaving that produces
 * recipients from revision 7 and fields from revision 8.
 *
 * `sourcePreparationRevision` is recorded from the same read, so the snapshot
 * can always say which revision it IS.
 *
 * ── What it deliberately does not do ───────────────────────────────────────
 *
 * It does not freeze the preparation. `locked_at` is left NULL, and a sender
 * may keep editing. That is a decision, not an omission: the schema permits
 * more than one request per document, and freezing would make the second one
 * impossible. SIGNING_REQUEST_IMMUTABILITY.md records it.
 */
export async function createSigningRequest(
  input: CreateSigningRequestInput,
  deps: SigningRequestDependencies,
): Promise<SigningRequestCreatedView> {
  const { actor, workspaceId, documentId } = input;

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "signing-request.create");

    let created: SigningRequestCreatedView | undefined;

    // Returns the STATUS as well as the body, because a replay must reproduce
    // the original response rather than just its payload.
    const write = async (): Promise<{ statusCode: number; body: unknown }> => {
      const now = deps.clock.now();
      const snapshot = await buildSnapshot(uow, input, deps, now);
      await uow.signingRequests.createSnapshot(snapshot);
      created = {
        signingRequestId: snapshot.request.signingRequestId,
        documentId: snapshot.request.documentId,
        state: snapshot.request.state,
        recipientCount: snapshot.recipients.length,
        fieldCount: snapshot.fields.length,
        createdAt: snapshot.request.createdAt,
      };
      return { statusCode: 201, body: created };
    };

    if (input.idempotencyKey === undefined) {
      await write();
      // Defined by construction: `write` assigns before returning, and a throw
      // would have propagated. Narrowed rather than asserted.
      if (created === undefined) throw new PreparationIntegrityError("snapshot not built");
      return created;
    }

    const outcome = await createIdempotencyService({
      ...deps.idempotency,
      repository: uow.idempotency,
    }).execute({
      key: input.idempotencyKey,
      operation: "signingRequest.create",
      scope: { type: "workspace", workspaceId },
      // ── The fingerprint is the ASK, not the answer ────────────────────────
      //
      // The workspace and the document, and nothing else. Deliberately NOT the
      // preparation revision, the recipients, the fields or the generated ids.
      //
      // The reason is §92 and it is the subtle part of this command. "Create a
      // signing request for document D" is one logical request. If the revision
      // were in the fingerprint, then this sequence:
      //
      //   T0  create with key K            (preparation at revision 7)
      //   T1  it commits
      //   T2  the sender edits             (preparation reaches revision 8)
      //   T3  the network retry resends K
      //
      // would compute a DIFFERENT fingerprint at T3 and report a conflict — for
      // a retry of a request that already succeeded. Or worse, under a
      // different design, create a second workflow from revision 8.
      //
      // With the document alone, T3 replays the revision-7 request that was
      // actually created. The stored body wins, and the caller learns the id of
      // the workflow that exists rather than one that never will.
      request: { documentId },
      execute: write,
    });

    // On a REPLAY the stored body wins. Returning the locally-built result
    // would be the exact bug this mechanism exists to prevent: the caller would
    // receive an id generated for an attempt that wrote nothing.
    return outcome.body as SigningRequestCreatedView;
  });
}

/**
 * Reads the trusted authoring state and builds the immutable snapshot.
 *
 * Nothing here comes from the caller except which document. Everything else is
 * read from the database inside the open transaction.
 */
async function buildSnapshot(
  uow: WorkspaceUnitOfWork,
  input: CreateSigningRequestInput,
  deps: SigningRequestDependencies,
  now: number,
) {
  const { documentId } = input;

  const document = await uow.documents.findById(documentId);
  // Another tenant's document is indistinguishable from an absent one.
  if (document === null) throw new ResourceNotFoundError("Document");

  const preparation = await uow.preparations.findByDocument(documentId);
  if (preparation === null) throw new DocumentNotPreparedError();

  // ── The source artifact ────────────────────────────────────────────────────
  //
  // Resolved from the PREPARATION, not from the document and not from input.
  // The preparation names the exact bytes its coordinates were authored
  // against; "the document's current original" would be a different question
  // with a different answer the day a source is replaced.
  const source = await resolveSourceArtifact(uow, preparation);

  const recipients = await uow.recipients.list(preparation.preparationId);
  const fields = await uow.preparations.listFields(preparation.preparationId);

  // ── Readiness ──────────────────────────────────────────────────────────────
  //
  // Evaluated on the rows just read, before a single id is generated. A
  // workflow that cannot complete must not become a durable record.
  const readiness = assessSnapshotReadiness(
    recipients.map(recipient => ({
      recipientId: recipient.recipientId,
      type: recipient.type,
      isRequired: recipient.isRequired,
    })),
    fields.map(field => ({ type: field.type, recipientId: field.recipientId })),
  );
  if (!readiness.ready) {
    throw new PreparationNotReadyError(readiness.blockers.map(describeBlocker));
  }

  // ── The recipient remapping ────────────────────────────────────────────────
  //
  // Each preparation recipient gets a NEW request-scoped id, and the mapping is
  // held only for the length of this function. Nothing persists it: the request
  // recipient's own columns are authoritative, and `sourcePreparationRecipientId`
  // is provenance that may become NULL.
  const remap = new Map<string, SigningRequestRecipientId>();
  const requestRecipients: SigningRequestRecipientRecord[] = recipients.map(recipient => {
    const recipientId = deps.ids.nextSigningRequestRecipientId();
    remap.set(String(recipient.recipientId), recipientId);
    return {
      recipientId,
      sourcePreparationRecipientId: recipient.recipientId,
      // Copied, not referenced. Every one of these is what the sender had
      // configured at this instant, and none of them changes again.
      name: recipient.name,
      email: recipient.email,
      normalizedEmail: recipient.emailKey,
      organization: recipient.organization,
      type: recipient.type,
      isRequired: recipient.isRequired,
      orderIndex: recipient.orderIndex,
      routingOrder: recipient.routingOrder,
    };
  });

  const requestFields: SigningRequestFieldRecord[] = fields.map(field => {
    // Readiness already proved every field has an assignee that exists here.
    // This is the belt: if the map misses, the data changed under an open
    // transaction or the readiness rule and this loop disagree, and either way
    // an immutable record must not be built on it.
    const assignee = field.recipientId === null
      ? undefined
      : remap.get(String(field.recipientId));
    if (assignee === undefined) {
      throw new PreparationIntegrityError(
        "a field's assignee is not a recipient of its preparation");
    }
    return {
      fieldId: deps.ids.nextSigningRequestFieldId(),
      sourcePreparationFieldId: field.fieldId,
      type: field.type,
      pageNumber: field.pageNumber,
      // Copied EXACTLY. Not re-rounded, not recomputed, not converted: the
      // coordinates were canonicalized once when the layout was saved, and a
      // second rounding here would move fields by a pixel for no reason.
      x: field.x,
      y: field.y,
      width: field.width,
      height: field.height,
      required: field.required,
      label: field.label,
      layer: field.layer,
      recipientId: assignee,
    };
  });

  const request: SigningRequestRecord = {
    signingRequestId: deps.ids.nextSigningRequestId(),
    workspaceId: uow.workspaceId,
    documentId,
    sourceArtifactId: source.artifactId,
    sourcePreparationId: preparation.preparationId,
    sourcePreparationRevision: preparation.revision,
    // The ONLY state this command can produce. Not from input — no schema
    // accepts one — and not a variable.
    state: "draft",
    // Nothing has happened to it yet, so every workflow column is null. They
    // are stated rather than omitted: an optional field is one a future writer
    // forgets, and these four decide whether a request is finished.
    completionReadyAt: null,
    terminatedAt: null,
    terminationReason: null,
    cancellationNote: null,
    // The title AS IT IS NOW, which is what makes a later rename harmless.
    documentTitle: document.title,
    // From the session, never from a body field.
    createdByUserId: input.actor.userId,
    createdAt: now,
    updatedAt: now,
  };

  return { request, recipients: requestRecipients, fields: requestFields };
}

/**
 * The document's ORIGINAL artifact, as named by the preparation.
 *
 * ── ORIGINAL, not PREPARED ─────────────────────────────────────────────────
 *
 * There is no prepared artifact to choose. BACKEND-30's preparation is
 * metadata-only: it writes no bytes, and the frontend has no PDF library at
 * all. A request therefore signs against the original plus its field snapshot,
 * and SIGNING_REQUEST_SNAPSHOT_MODEL.md says so explicitly rather than leaving
 * it to be inferred.
 */
async function resolveSourceArtifact(
  uow: WorkspaceUnitOfWork,
  preparation: PreparationRecord,
): Promise<ArtifactRecord> {
  const artifacts = await uow.artifacts.listForDocument(preparation.documentId);
  const source = artifacts.find(
    artifact => artifact.artifactId === preparation.sourceArtifactId);
  if (source === undefined) {
    // The compound foreign key makes this unreachable — a preparation cannot
    // name an artifact that does not exist in its workspace. Refused rather
    // than assumed, because the alternative is a request pointing at nothing.
    throw new PreparationIntegrityError("the preparation's source artifact is missing");
  }
  if (source.pageCount === undefined) throw new DocumentNotReadyError();
  // The same refusal BACKEND-30 applies when placing fields. A rotated source
  // would put every field in the wrong coordinate space, and creating a
  // workflow over one would send that error to counterparties (OD-124).
  if (!canPlaceFields(source.rotatedPageCount ?? null)) {
    throw new PreparationIntegrityError("the source document has rotated pages");
  }
  return source;
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * One request, from its own snapshot rows.
 *
 * ── Read the joins that are NOT here ───────────────────────────────────────
 *
 * `uow.recipients`, `uow.contacts` and `uow.preparations` are not touched. The
 * recipients and fields come from `signing_request_recipients` and
 * `signing_request_fields`, and the title from the request's own column.
 *
 * This is the single most important property of the read path, and an
 * architecture guard asserts it: a detail endpoint that resolved a name through
 * the current contact would silently undo the entire snapshot.
 */
export async function getSigningRequest(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  signingRequestId: string,
  deps: SigningRequestDependencies,
): Promise<SigningRequestView> {
  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "signing-request.view");

    const request = await uow.signingRequests.find(signingRequestId as SigningRequestId);
    // Another tenant's request is indistinguishable from an absent one.
    if (request === null) throw new ResourceNotFoundError("SigningRequest");

    const [recipients, fields] = await Promise.all([
      uow.signingRequests.listRecipients(request.signingRequestId),
      uow.signingRequests.listFields(request.signingRequestId),
    ]);

    return {
      signingRequestId: request.signingRequestId,
      documentId: request.documentId,
      documentTitle: request.documentTitle,
      state: request.state,
      recipients: recipients.map(toRecipientView),
      fields: fields.map(toFieldView),
      createdAt: request.createdAt,
    };
  });
}

/**
 * Deliberately absent from this module.
 *
 * **sendSigningRequest** — BACKEND-33. It must act on the snapshot alone and
 * never re-read preparation; SIGNING_REQUEST_CREATION_REPORT.md states the
 * handoff.
 *
 * **issueRecipientAccess / generateSigningLink** — BACKEND-34, bound to
 * `SigningRequestRecipientId`.
 *
 * **cancelSigningRequest / deleteSigningRequest** — the product has no
 * abandon-unsent control, and cancellation semantics for a SENT request are a
 * different thing entirely.
 *
 * **updateSigningRequest / patch anything** — a snapshot is immutable, and the
 * runtime role holds no UPDATE grant on either snapshot table.
 *
 * **listSigningRequests** — no product surface needs it. BACKEND-49 owns the
 * dashboard.
 */
export type SigningRequestOperationsDeferred = never;
