// Retrieving the completed, sealed artifact for a signing request (Phase 1-C).
//
// ── Scope: sender only ──────────────────────────────────────────────────────
//
// Recipient/participant access to a completed document is a SEPARATE,
// unresolved product decision (their signing-session grants are deliberately
// revoked at finalization — see `final-seal.ts`'s own comment on step 5 — so
// supporting them here would mean designing a new post-completion access
// grant, which nobody has decided the shape of). This module covers exactly
// the surface that already fits the existing authenticated-user +
// workspace-membership pattern: the sender, via the same `signing-request.view`
// capability `getSigningRequest` already requires.
//
// ── Streaming, not a presigned URL ──────────────────────────────────────────
//
// Chosen because it works identically regardless of which object-storage
// provider a deployment configures (`s3-config.ts`'s own comment: "no
// provider host is hard-coded anywhere in this codebase") — a presigned URL's
// signing mechanism is provider-SDK-specific, and its own security review
// (bearer-credential lifetime, revocation) is a separate decision nobody has
// made yet either.

import type { WorkspaceId, TransactionId } from "@lagda/contracts";
import { ResourceNotFoundError, ResourceConflictError } from "../common/errors/index.js";
import { authorize } from "./signing-requests.js";
import type { SigningRequestId, TransactionManager } from "../common/ports/index.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import type { ObjectStorage } from "../common/ports/storage.js";

export interface CompletedArtifactDependencies {
  readonly transactions: TransactionManager;
  readonly storage: ObjectStorage;
}

export interface CompletedArtifactStream {
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly stream: AsyncIterable<Uint8Array>;
}

/** The bytes exist, the row says so, and they could not be read back. */
export class CompletedArtifactUnavailableError extends ResourceConflictError {
  constructor() {
    super("The completed document's stored bytes could not be read.");
  }
}

/**
 * Streams the sealed artifact for a COMPLETED signing request, to its sender.
 *
 * Same authorization as reading the request at all (`signing-request.view`)
 * — there is no separate "download" capability, because nothing about
 * fetching the final bytes is more sensitive than seeing that the request
 * exists and who is on it.
 *
 * @throws ResourceNotFoundError if the request does not exist in this
 *         workspace, or is not yet `completed` — the two are made
 *         indistinguishable deliberately (same reasoning `getSigningRequest`
 *         already applies to another tenant's request: revealing "it exists
 *         but isn't done yet" to someone who should see neither is its own
 *         disclosure).
 */
export async function getCompletedArtifact(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  signingRequestId: SigningRequestId,
  deps: CompletedArtifactDependencies,
): Promise<CompletedArtifactStream> {
  const artifact = await deps.transactions.runForWorkspace(workspaceId, async uow => {
    await authorize(uow, actor, "signing-request.view");

    const request = await uow.signingRequests.find(signingRequestId);
    if (request === null || request.state !== "completed") {
      throw new ResourceNotFoundError("SigningRequest");
    }

    const seal = await uow.finalizations.findBySigningRequest(
      signingRequestId as unknown as TransactionId);
    if (seal === null) {
      // The state says completed; the finalization row disagrees. A real
      // inconsistency, never presented as "not found" — that would look like
      // a routine absence instead of the integrity problem it is.
      throw new ResourceConflictError(
        "This request is marked completed but has no recorded finalization.");
    }

    const record = await uow.artifacts.find(seal.sealedArtifactId);
    if (record === null) {
      throw new ResourceConflictError(
        "This request's sealed artifact record is missing.");
    }
    return record;
  });

  const content = await deps.storage.getObject({
    zone: "artifacts",
    key: artifact.storageReference,
  });
  if (content === null) throw new CompletedArtifactUnavailableError();

  return {
    mediaType: artifact.mediaType,
    sizeBytes: artifact.sizeBytes,
    stream: content.stream,
  };
}
