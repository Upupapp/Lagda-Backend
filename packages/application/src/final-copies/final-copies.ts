// Final copies (073): every participant gets the finished document.
//
// Two halves:
//
//   produceFinalCopies   inside the finalization transaction, after the
//                        request is marked completed: one download grant and
//                        one email intent per participant (viewers excepted),
//                        unless the sender switched it off for this document
//   downloadFinalCopy    a presented download credential -> the sealed PDF
//
// The download credential can open nothing but the sealed artifact of its own
// completed request. It is not a signing link: those are revoked at
// completion and stay revoked.

import { ApplicationError, ResourceConflictError } from "../common/errors/index.js";
import type {
  Clock, WorkspaceUnitOfWork, TransactionManager,
  SigningRequestRecord, DeliverySecretSealer,
  NotificationIntentIdGenerator, NotificationDeliveryIdGenerator,
  FinalCopyTokenFactory, FinalCopyGrantIdGenerator,
} from "../common/ports/index.js";
import type { ObjectStorage } from "../common/ports/storage.js";
import type { NotificationTemplateRegistry } from "../notifications/template-registry.js";
import { createNotificationIntent } from "../notifications/create-intent.js";

/** How long a download link works. Long enough to find the email again. */
export const FINAL_COPY_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export interface FinalCopyProducerDependencies {
  readonly tokens: FinalCopyTokenFactory;
  readonly sealer: DeliverySecretSealer;
  readonly ids: FinalCopyGrantIdGenerator
    & NotificationIntentIdGenerator & NotificationDeliveryIdGenerator;
  readonly templates: NotificationTemplateRegistry;
  readonly clock: Clock;
}

/**
 * Mints each participant's download grant and queues their email.
 *
 * Runs INSIDE the transaction that completes the request, after the state
 * change, for the same reason the sender's completion email does: no email
 * for a completion that rolled back, and no completion that loses its emails
 * to a mail outage (these are intents; delivery happens later).
 *
 * Idempotent: a grant is UNIQUE per participant, so a re-driven completion
 * finds the grant exists and queues nothing more.
 *
 * Returns how many were queued.
 */
export async function produceFinalCopies(
  request: SigningRequestRecord,
  completedAt: number,
  uow: WorkspaceUnitOfWork,
  deps: FinalCopyProducerDependencies,
): Promise<number> {
  // The sender's per-document choice. Absent means yes.
  if (request.shareFinalCopy === false) return 0;

  const recipients = await uow.signingRequests.listRecipients(request.signingRequestId);
  // A viewer's access was read-only and ended with the signing.
  const entitled = recipients.filter(recipient => recipient.type !== "viewer");
  if (entitled.length === 0) return 0;

  const workspace = await uow.workspaces.find();
  const workspaceName = workspace?.name ?? "LAGDA";
  const senderName = await uow.actorProfiles.displayNameOf(request.createdByUserId)
    ?? workspaceName;

  let queued = 0;
  for (const recipient of entitled) {
    const credential = deps.tokens.issue();
    const grantId = deps.ids.nextFinalCopyGrantId();
    // Sealed BEFORE the grant is written: an unconfigured key throws here,
    // before anything about this copy is durable.
    const sealed = deps.sealer.seal(credential.raw);

    const inserted = await uow.finalCopies.insertGrant({
      grantId,
      workspaceId: request.workspaceId,
      signingRequestId: request.signingRequestId,
      recipientId: recipient.recipientId,
      credentialDigest: credential.digest,
      createdAt: completedAt,
      expiresAt: completedAt + FINAL_COPY_LIFETIME_MS,
    });
    if (!inserted) continue;

    await createNotificationIntent({
      notifications: uow.notifications,
      templates: deps.templates,
      ids: deps.ids,
      clock: deps.clock,
    })({
      notificationType: "FINAL_COPY_AVAILABLE",
      sourceId: grantId,
      scope: { kind: "WORKSPACE", workspaceId: request.workspaceId },
      audience: {
        kind: "SIGNING_REQUEST_RECIPIENT",
        signingRequestRecipientId: recipient.recipientId,
      },
      destination: recipient.email,
      templateInput: {
        recipientName: recipient.name,
        documentTitle: request.documentTitle,
        senderDisplayName: senderName,
        workspaceName,
      },
      secretRef: { kind: "SEALED", sealed, keyVersion: deps.sealer.keyVersion },
    }, uow);
    queued++;
  }
  return queued;
}

// ── Download ─────────────────────────────────────────────────────────────────

/** One answer for every way a link can fail: unknown, expired, revoked. */
export class FinalCopyLinkInvalidError extends ApplicationError {
  readonly category = "authentication" as const;
  readonly code = "invalid_or_expired_final_copy_link";
  constructor() {
    super("This download link is no longer valid.");
  }
}

export interface FinalCopyDownloadDependencies {
  readonly transactions: TransactionManager;
  readonly tokens: FinalCopyTokenFactory;
  readonly storage: ObjectStorage;
  readonly clock: Clock;
}

export interface FinalCopyDownload {
  readonly documentTitle: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly stream: AsyncIterable<Uint8Array>;
}

export async function downloadFinalCopy(
  rawCredential: string,
  deps: FinalCopyDownloadDependencies,
): Promise<FinalCopyDownload> {
  const digest = deps.tokens.digest(rawCredential);
  if (digest === null) throw new FinalCopyLinkInvalidError();
  const now = deps.clock.now();

  const found = await deps.transactions.runForFinalCopyCredential(digest, async credential => {
    const grant = await credential.lookup.findByCredentialDigest(digest);
    if (grant === null || grant.revokedAt !== null || grant.expiresAt <= now) {
      throw new FinalCopyLinkInvalidError();
    }
    // The workspace comes from the resolved grant, never from the caller.
    return credential.enterWorkspace(grant.workspaceId, async uow => {
      const request = await uow.signingRequests.find(grant.signingRequestId);
      // A grant exists only for a completed request; anything else is not a
      // download this link can make.
      if (request === null || request.state !== "completed") {
        throw new FinalCopyLinkInvalidError();
      }
      const seal = await uow.finalizations.findBySigningRequest(
        grant.signingRequestId as never);
      if (seal === null) {
        throw new ResourceConflictError(
          "This request is marked completed but has no recorded finalization.");
      }
      const artifact = await uow.artifacts.find(seal.sealedArtifactId);
      if (artifact === null) {
        throw new ResourceConflictError("This request's sealed artifact record is missing.");
      }
      return { artifact, documentTitle: request.documentTitle };
    });
  });

  const content = await deps.storage.getObject({
    zone: "artifacts", key: found.artifact.storageReference,
  });
  if (content === null) {
    throw new ResourceConflictError("The completed document's stored bytes could not be read.");
  }
  return {
    documentTitle: found.documentTitle,
    mediaType: found.artifact.mediaType,
    sizeBytes: found.artifact.sizeBytes,
    stream: content.stream,
  };
}
