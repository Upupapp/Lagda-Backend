// Retrieving a document's ORIGINAL artifact for its own workspace, to view.
//
// ── Scope: the document's own workspace, any state ─────────────────────────
//
// Unlike `completed-artifact.ts` (sender, COMPLETED signing requests only,
// the sealed artifact), this covers the document itself — viewable from the
// moment its bytes land, through every signing-request state including none
// at all. A document with no signing request yet still has bytes a workspace
// member may want to see.
//
// ── Streaming, not a presigned URL ──────────────────────────────────────────
//
// Same reasoning as `completed-artifact.ts`: works identically regardless of
// object-storage provider, and a presigned URL's bearer-credential lifetime
// is a separate, unmade security decision (OD-114) this does not reopen.

import type { DocumentId, WorkspaceId } from "@lagda/contracts";
import { ResourceNotFoundError, ResourceConflictError } from "../common/errors/index.js";
import type { TransactionManager } from "../common/ports/index.js";
import type { AuthenticatedActor } from "../common/ports/session.js";
import type { ObjectStorage } from "../common/ports/storage.js";
import { assertCapability, type WorkspaceAccessContext } from "../workspaces/workspace-access.js";

export interface DocumentContentDependencies {
  readonly transactions: TransactionManager;
  readonly storage: ObjectStorage;
}

export interface DocumentContentStream {
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly stream: AsyncIterable<Uint8Array>;
}

/** The bytes are recorded, and could not be read back. */
export class DocumentContentUnavailableError extends ResourceConflictError {
  constructor() {
    super("This document's stored bytes could not be read.");
  }
}

/**
 * Streams a document's original artifact, to a member of its own workspace.
 *
 * Same authorization as reading the document at all (`document.view`) — there
 * is no separate "download" capability, mirroring `getCompletedArtifact`'s
 * own reasoning.
 *
 * @throws ResourceNotFoundError if the document does not exist in this
 *         workspace, or has no uploaded bytes yet — made indistinguishable
 *         deliberately, same as every other document read in this module.
 */
export async function getDocumentContent(
  actor: AuthenticatedActor,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  deps: DocumentContentDependencies,
): Promise<DocumentContentStream> {
  const artifact = await deps.transactions.runForWorkspace(workspaceId, async uow => {
    const membership = await uow.memberships.findByUser(actor.userId);
    if (membership === null) throw new ResourceNotFoundError("Workspace");
    const access: WorkspaceAccessContext = {
      workspaceId: membership.workspaceId,
      userId: membership.userId,
      membershipId: membership.memberId,
      role: membership.role,
    };
    assertCapability(access, "document.view");

    const document = await uow.documents.findById(documentId);
    if (document === null) throw new ResourceNotFoundError("Document");

    const artifacts = await uow.artifacts.listForDocument(documentId);
    const original = artifacts.find(candidate => candidate.artifactType === "original");
    if (original === undefined) throw new ResourceNotFoundError("Document");
    return original;
  });

  const content = await deps.storage.getObject({
    zone: "artifacts",
    key: artifact.storageReference,
  });
  if (content === null) throw new DocumentContentUnavailableError();

  return {
    mediaType: artifact.mediaType,
    sizeBytes: artifact.sizeBytes,
    stream: content.stream,
  };
}
