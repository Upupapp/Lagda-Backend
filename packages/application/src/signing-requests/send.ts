// Sending a signing request (BACKEND-33).
//
// ── What Send is ───────────────────────────────────────────────────────────
//
// A durable workflow-state transition. Not an email call.
//
//   immutable SigningRequest
//        -> eligibility, from the snapshot
//        -> the active routing cohort
//        -> a bootstrap credential per eligible active recipient
//        -> a durable delivery intent carrying the SEALED credential
//        -> state SENT, with sentAt
//   commit
//
// No provider is contacted inside that transaction, and none is contacted by
// this module at all. A provider that is down must not stop a sender sending.
//
// ── What SENT means ────────────────────────────────────────────────────────
//
// The sender committed the request, and every piece of durable work required
// for initial recipient access was written. It does NOT mean an email was
// delivered, opened, viewed, authenticated against or signed.
//
// ── The snapshot is the only source ────────────────────────────────────────
//
// Recipient identity, field configuration, routing and the source artifact all
// come from `signing_request_*`. This module never reads `contacts`,
// `preparation_recipients` or `preparation_fields`, and an architecture guard
// asserts it. A contact renamed after creation changes nothing about what is
// sent.

import type { WorkspaceId, IdempotencyKey } from "@lagda/contracts";
import {
  assessSendEligibility, describeSendBlocker, planActivation, routingShape,
  needsSigningAccess,
  type WorkspaceCapability, type SendableRecipient,
} from "@lagda/core";
import type {
  Clock, TransactionManager, WorkspaceUnitOfWork,
  SigningRequestId, SigningRequestRecord, SigningRequestRecipientRecord,
  SigningAccessTokenFactory, DeliverySecretSealer, SigningLinkBuilder,
  SigningAccessIdGenerator, RecipientActivationRecord,
} from "../common/ports/index.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import {
  ApplicationError, ApplicationValidationError, ResourceConflictError,
  ResourceNotFoundError,
} from "../common/errors/index.js";
import {
  createIdempotencyService, type IdempotencyDependencies,
} from "../idempotency/service.js";
import { assertCapability, type WorkspaceAccessContext } from "../workspaces/workspace-access.js";

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * The request has already been sent.
 *
 * A conflict, not a validation failure: nothing about the caller's input is
 * wrong, and the correct response is to show them the request as it now is.
 *
 * Distinct from an idempotent REPLAY, which returns the original success. This
 * is what a caller gets when they send again with a NEW key — a deliberate
 * second attempt, not a retry — and it must not silently re-invite anyone.
 */
export class SigningRequestAlreadySentError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "signing_request_already_sent";
  constructor() {
    super("This request has already been sent.");
  }
}

/** The request's snapshot cannot be sent as it stands. */
export class SigningRequestNotSendableError extends ApplicationValidationError {
  constructor(issues: readonly string[]) {
    super("This request cannot be sent.", issues);
  }
}

/**
 * The snapshot violates an invariant it should not be able to.
 *
 * A missing source artifact, or a recipient the constraints should have
 * refused. Never a 4xx: the caller did nothing wrong and cannot fix it, and
 * sending a broken workflow to counterparties is worse than failing loudly.
 */
export class SigningRequestIntegrityError extends ApplicationError {
  readonly category = "internal" as const;
  readonly code = "signing_request_integrity";
  constructor(public readonly detail: string) {
    super("This request could not be sent.");
  }
}

// ── Result ───────────────────────────────────────────────────────────────────

/**
 * What Send returns.
 *
 * ── Read the absences ──────────────────────────────────────────────────────
 *
 * No raw credential, no digest, no signing URL, no delivery intent id. The
 * sender does not need the recipient's bearer link, and a "copy signing link"
 * feature — which the product does not have — would be a deliberate secret
 * RETRIEVAL operation with its own authorization and audit, not a field on
 * this response.
 */
export interface SigningRequestSentView {
  readonly signingRequestId: string;
  readonly state: "sent";
  readonly sentAt: number;
  /** How many recipients became active now. Not who. */
  readonly activatedRecipientCount: number;
  /** How many are waiting on a later routing cohort. */
  readonly waitingRecipientCount: number;
  /**
   * `parallel`, `sequential` or `mixed`, derived from the snapshot.
   *
   * Returned so the route has a BOUNDED metric label. The alternative was the
   * route inferring it from the waiting count, which cannot tell sequential
   * from mixed and would have made the label lie on a three-cohort request.
   */
  readonly routingShape: "parallel" | "sequential" | "mixed";
}

export interface SendSigningRequestDependencies {
  readonly transactions: TransactionManager;
  readonly clock: Clock;
  readonly ids: SigningAccessIdGenerator;
  readonly tokens: SigningAccessTokenFactory;
  /** Makes the raw credential recoverable by an async renderer. */
  readonly sealer: DeliverySecretSealer;
  /** Builds the recipient URL from CONFIGURED base. Never a request header. */
  readonly links: SigningLinkBuilder;
  readonly policy: SigningAccessPolicy;
  readonly idempotency: Omit<IdempotencyDependencies, "repository">;
}

export interface SigningAccessPolicy {
  /**
   * How long a bootstrap credential stays usable.
   *
   * Explicit and always set. A bearer credential that never expires is a
   * permanent key to a legal document sitting in an inbox, and the fact that
   * REQUEST expiration is BACKEND-46's problem is not a reason to leave one
   * lying around (§49, §50).
   */
  readonly bootstrapLifetimeMs: number;
}

export interface SendSigningRequestInput {
  readonly actor: AuthenticatedActor;
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: string;
  /** Required at the route. A retry must not re-invite anyone. */
  readonly idempotencyKey?: IdempotencyKey;
}

// ── The use case ─────────────────────────────────────────────────────────────

async function authorize(
  uow: WorkspaceUnitOfWork,
  actor: AuthenticatedActor,
  capability: WorkspaceCapability,
): Promise<WorkspaceAccessContext> {
  const membership = await uow.memberships.findByUser(actor.userId);
  // Read INSIDE the transaction. Send is the highest-impact mutation in the
  // system, and a sender demoted a moment ago must not commit under authority
  // they have lost (§89, §90). The route's middleware is not the check.
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

/**
 * Commits a signing request for recipient delivery.
 *
 * ── The credential is generated BEFORE the transaction ─────────────────────
 *
 * Random bytes are not a database operation, and generating them inside an
 * open transaction would hold it open for no reason. If the transaction then
 * fails, the raw values are simply discarded — they were never delivered and
 * never persisted.
 *
 * ── Lock ordering ──────────────────────────────────────────────────────────
 *
 * Idempotency claim FIRST, then the conditional state transition. One order,
 * everywhere, so two sends cannot deadlock by taking them in opposite
 * sequences. The claim is the cheaper contention point and the one that
 * resolves a genuine retry without touching the request at all.
 */
export async function sendSigningRequest(
  input: SendSigningRequestInput,
  deps: SendSigningRequestDependencies,
): Promise<SigningRequestSentView> {
  const { actor, workspaceId, signingRequestId } = input;

  return deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "signing-request.send");

    let sent: SigningRequestSentView | undefined;

    const write = async (): Promise<{ statusCode: number; body: unknown }> => {
      sent = await performSend(uow, input, deps);
      return { statusCode: 200, body: sent };
    };

    if (input.idempotencyKey === undefined) {
      await write();
      if (sent === undefined) throw new SigningRequestIntegrityError("send produced nothing");
      return sent;
    }

    const outcome = await createIdempotencyService({
      ...deps.idempotency,
      repository: uow.idempotency,
    }).execute({
      key: input.idempotencyKey,
      operation: "signingRequest.send",
      scope: { type: "workspace", workspaceId },
      // The request, and nothing else. BACKEND-33 owns no send-level
      // configuration — the product has no send screen, so there is no
      // subject or message to include. If BACKEND-46 adds one, it belongs
      // here, because sending the same request with a different message is a
      // different logical request.
      request: { signingRequestId },
      execute: write,
    });

    // On a REPLAY the stored body wins. Returning the local value would defeat
    // the entire mechanism: nothing was written on that path.
    return outcome.body as SigningRequestSentView;
  });
}

async function performSend(
  uow: WorkspaceUnitOfWork,
  input: SendSigningRequestInput,
  deps: SendSigningRequestDependencies,
): Promise<SigningRequestSentView> {
  const signingRequestId = input.signingRequestId as SigningRequestId;

  const request = await uow.signingRequests.find(signingRequestId);
  // Another tenant's request is indistinguishable from an absent one.
  if (request === null) throw new ResourceNotFoundError("SigningRequest");
  if (request.state !== "draft") throw new SigningRequestAlreadySentError();

  const recipients = await uow.signingRequests.listRecipients(signingRequestId);
  const fields = await uow.signingRequests.listFields(signingRequestId);

  const sendable: SendableRecipient[] = recipients.map(recipient => ({
    recipientId: recipient.recipientId,
    email: recipient.email,
    type: recipient.type,
    routingOrder: recipient.routingOrder,
  }));

  const eligibility = assessSendEligibility(request.state, sendable, fields.length);
  if (!eligibility.ready) {
    const blockers = eligibility.blockers.map(describeSendBlocker);
    // `already-sent` is a conflict, not a validation failure, and it is the
    // one a UI actually hits. Separated so the status is right.
    if (eligibility.blockers.some(blocker => blocker.kind === "already-sent")) {
      throw new SigningRequestAlreadySentError();
    }
    throw new SigningRequestNotSendableError(blockers);
  }

  // The exact bytes, from the request. Verified to still exist — a request
  // pointing at a missing artifact is a workflow nobody could complete, and it
  // must not be sent (§96). No bytes are downloaded and no PDF is parsed.
  await assertSourceArtifactPresent(uow, request);

  const plan = planActivation(sendable);
  const now = deps.clock.now();

  // ── Activation ────────────────────────────────────────────────────────────
  //
  // Every recipient gets a row, active or waiting, so a later cohort advance
  // has somewhere to look and so "who is outstanding" is answerable without
  // recomputing routing.
  const activeSet = new Set(plan.active);
  const activations: RecipientActivationRecord[] = recipients.map(recipient => (
    activeSet.has(recipient.recipientId)
      ? { recipientId: recipient.recipientId, state: "active" as const, activatedAt: now }
      : { recipientId: recipient.recipientId, state: "waiting" as const, activatedAt: null }
  ));
  await uow.signingAccess.insertActivations({
    signingRequestId, activations, createdAt: now,
  });

  // ── Provisioning ──────────────────────────────────────────────────────────
  //
  // Only recipients that are BOTH in the active cohort and of a type that can
  // act. A waiting recipient gets no credential — a bearer secret minted now
  // for a turn that may be days away is a secret sitting in a database for no
  // reason (§47). A viewer gets none either, because a signing credential is
  // not what a viewer needs (§101, OD-135).
  const byId = new Map(
    recipients.map(recipient => [String(recipient.recipientId), recipient]));

  for (const recipientId of plan.provision) {
    const recipient = byId.get(String(recipientId));
    if (recipient === undefined) {
      throw new SigningRequestIntegrityError("activation names an unknown recipient");
    }
    await provisionSigningRecipientAccess(uow, { request, recipient, now }, deps);
  }

  // ── The transition ────────────────────────────────────────────────────────
  //
  // LAST, and conditional. Everything a recipient needs is already durable, so
  // the request can only reach SENT once the work that makes SENT true has
  // been written — and the `where state = 'draft'` predicate means a
  // concurrent send under a different key matches zero rows rather than
  // sending twice.
  const transitioned = await uow.signingRequests.markSentIfDraft({
    signingRequestId, sentAt: now,
  });
  if (!transitioned) {
    // Another send committed between the read at the top and here. Rolling
    // back is correct: the other transaction did the whole job, and this one's
    // grants and intents must not survive alongside it.
    throw new ResourceConflictError("This request was sent by another request.");
  }

  return {
    signingRequestId: request.signingRequestId,
    state: "sent",
    sentAt: now,
    activatedRecipientCount: plan.active.length,
    waitingRecipientCount: plan.waiting.length,
    routingShape: routingShape(sendable),
  };
}

/**
 * The reusable provisioner.
 *
 * ── Why it is a function and not inline ────────────────────────────────────
 *
 * BACKEND-37 will call it again, when a sequential cohort completes and the
 * next one activates. Credential generation, sealing, grant persistence and
 * delivery-intent creation must be identical then — a second implementation
 * would be a second place for the digest domain, the TTL and the "raw value
 * never persisted" rule to drift.
 *
 * It is application-internal. There is no route, and BACKEND-34 must not be
 * able to call it: provisioning is a consequence of activation, never
 * something a request asks for.
 */
async function provisionSigningRecipientAccess(
  uow: WorkspaceUnitOfWork,
  context: {
    readonly request: SigningRequestRecord;
    readonly recipient: SigningRequestRecipientRecord;
    readonly now: number;
  },
  deps: SendSigningRequestDependencies,
): Promise<void> {
  const { request, recipient, now } = context;

  if (!needsSigningAccess(recipient.type)) {
    throw new SigningRequestIntegrityError(
      "attempted to provision signing access for a participant that cannot act");
  }

  // Generated here, held in one local, and never assigned anywhere else. It
  // reaches the sealer and nothing else — not a log, not an error, not a
  // return value.
  const credential = deps.tokens.issue();
  const grantId = deps.ids.nextSigningAccessGrantId();

  // Sealed BEFORE the grant is written. If no key is configured this throws,
  // and it throws before anything about this send is durable — so an
  // unconfigured deployment cannot mark a request sent with a credential
  // nobody can ever render (§234).
  const sealed = deps.sealer.seal(credential.raw);

  await uow.signingAccess.insertGrant({
    grantId,
    workspaceId: request.workspaceId,
    signingRequestId: request.signingRequestId,
    recipientId: recipient.recipientId,
    // The DIGEST. The raw value is not written here and an architecture guard
    // asserts the field name.
    credentialDigest: credential.digest,
    createdAt: now,
    expiresAt: now + deps.policy.bootstrapLifetimeMs,
  });

  await uow.signingAccess.insertDeliveryIntent({
    deliveryIntentId: deps.ids.nextDeliveryIntentId(),
    workspaceId: request.workspaceId,
    signingRequestId: request.signingRequestId,
    recipientId: recipient.recipientId,
    grantId,
    purpose: "signing-invitation",
    // The DELIVERY SNAPSHOT, from the request's own immutable rows. A retry
    // hours from now renders the same email.
    recipientEmail: recipient.email,
    recipientName: recipient.name,
    documentTitle: request.documentTitle,
    // Presentation metadata the renderer needs. Snapshotted for the same
    // reason: a sender who changes their display name tomorrow must not
    // change the message a queued invitation renders (§181, §182).
    senderDisplayName: await senderDisplayName(uow),
    workspaceName: await workspaceName(uow),
    sealedCredential: sealed,
    sealedKeyVersion: deps.sealer.keyVersion,
    createdAt: now,
  });

  // The link is NOT built here and NOT stored. `deps.links` exists so the
  // renderer can build it from the sealed token; building it now would mean
  // persisting a URL, and a persisted URL is a persisted host.
}

/**
 * The exact source artifact, verified present.
 *
 * Existence only. No bytes are read, no digest recomputed, no PDF parsed —
 * this asks the metadata whether the row is still there, because a request
 * pointing at nothing is a workflow that cannot be completed.
 */
async function assertSourceArtifactPresent(
  uow: WorkspaceUnitOfWork,
  request: SigningRequestRecord,
): Promise<void> {
  const artifacts = await uow.artifacts.listForDocument(request.documentId);
  const present = artifacts.some(
    artifact => artifact.artifactId === request.sourceArtifactId);
  if (!present) {
    throw new SigningRequestIntegrityError("the request's source artifact is missing");
  }
}

/**
 * The workspace's CURRENT display name, snapshotted into the intent.
 *
 * Takes no request: `find()` needs no argument because the repository is
 * already bound to this workspace, which is the whole tenancy convention.
 */
async function workspaceName(uow: WorkspaceUnitOfWork): Promise<string> {
  const workspace = await uow.workspaces.find();
  if (workspace === null) throw new SigningRequestIntegrityError("workspace missing");
  return workspace.name;
}

/**
 * A display name for the sender line of the invitation.
 *
 * The request's CREATOR, not the actor sending it — those can differ, and the
 * person a recipient should recognise is the one whose document it is.
 *
 * Falls back to the workspace name rather than exposing a user id: an email
 * saying "usr_3f2a invited you to sign" is worse than one saying the firm did.
 */
async function senderDisplayName(uow: WorkspaceUnitOfWork): Promise<string> {
  return workspaceName(uow);
}

/**
 * Deliberately absent from this module.
 *
 * **Any provider call.** No mailer, no SMTP, no SDK. BACKEND-45 renders and
 * transmits the delivery intents this module writes.
 *
 * **resendSigningRequest** — a transport retry reuses the same intent and the
 * same credential. A deliberate resend rotates one, and rotation is
 * BACKEND-34's lifecycle.
 *
 * **cancelSigningRequest / voidSigningRequest** — a request that has been sent
 * cannot be un-sent, and cancellation semantics need the ceremony's states.
 *
 * **advanceRouting** — activating the next cohort needs to know what
 * "complete" means. BACKEND-37, through `provisionSigningRecipientAccess`.
 *
 * **Anything a recipient does.** No signing page, no OTP, no session, no
 * signature, no completion, no sealing.
 */
export type SendOperationsDeferred = never;
