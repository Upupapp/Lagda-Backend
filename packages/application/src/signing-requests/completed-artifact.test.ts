// Retrieving a completed request's sealed artifact, tested with fakes.
//
// The claims that carry weight:
//
//   the sender (a real workspace member) can stream the sealed bytes back;
//   a request that is not yet `completed` is indistinguishable from absent;
//   another workspace's request is indistinguishable from absent;
//   a non-member is refused, same as every other signing-request read;
//   a completed request whose finalization/artifact row is missing is a
//     conflict, never silently served as something else.

import { describe, it, expect } from "vitest";
import type { DocumentId, UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type {
  ArtifactId, PreparationId, SealId, SigningRequestId,
} from "../common/ports/index.js";
import { getCompletedArtifact, CompletedArtifactUnavailableError } from "./completed-artifact.js";
import { ResourceNotFoundError, ResourceConflictError } from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import {
  FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
// The in-memory double now lives with the port it implements, in this very
// package. It used to be imported from @lagda/storage, which made
// @lagda/application depend on a package that depends on it.
import { createInMemoryObjectStorage, collect } from "../test-support/index.js";

const AT = Date.parse("2026-09-16T10:00:00.000Z");
const WS = "ws_ca" as WorkspaceId;
const OTHER_WS = "ws_other" as WorkspaceId;
const OWNER = "usr_owner" as UserId;
const STRANGER = "usr_stranger" as UserId;
const DOC = "doc_ca" as DocumentId;
const REQUEST = "sr_ca" as SigningRequestId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

async function harness(overrides: { readonly state?: string; readonly withSeal?: boolean } = {}) {
  const store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);
  const storage = createInMemoryObjectStorage();

  store.memberships.push({
    memberId: "mem_owner" as WorkspaceMemberId, workspaceId: WS,
    userId: OWNER, role: "owner", createdAt: AT,
  });

  const bytes = new TextEncoder().encode("%PDF-1.4 sealed bytes");
  await storage.putObject({
    ref: { zone: "artifacts", key: "ws/doc/art_sealed" as never },
    content: { kind: "bytes", bytes },
    mediaType: "application/pdf",
  });

  store.artifacts.push({
    artifactId: "art_sealed" as ArtifactId, workspaceId: WS, documentId: DOC,
    artifactType: "sealed", storageReference: "ws/doc/art_sealed" as never,
    mediaType: "application/pdf", sizeBytes: bytes.byteLength,
    digestAlgorithm: "sha-256", digest: "f".repeat(64) as never,
    pageCount: 1, rotatedPageCount: 0, createdAt: AT,
  });

  store.signingRequests.push({
    signingRequestId: REQUEST, workspaceId: WS, documentId: DOC,
    sourceArtifactId: "art_original" as ArtifactId,
    sourcePreparationId: "prep_ca" as PreparationId,
    sourcePreparationRevision: 1,
    state: (overrides.state ?? "completed") as never,
    completionReadyAt: AT, expiresAt: null, terminatedAt: null,
    completedAt: overrides.state === undefined || overrides.state === "completed" ? AT : null,
    terminationReason: null, cancellationNote: null,
    documentTitle: "Lease", createdByUserId: OWNER,
    createdAt: AT, updatedAt: AT,
  });

  if (overrides.withSeal !== false) {
    store.seals.push({
      sealId: "seal_ca" as SealId, workspaceId: WS,
      signingRequestId: REQUEST as unknown as never,
      sealedArtifactId: "art_sealed" as ArtifactId,
      sealScheme: "hash-evidence", sealVersion: 1, digestAlgorithm: "sha-256",
      originalDocumentHash: "e".repeat(64) as never,
      signedDocumentHash: "f".repeat(64) as never,
      sealedAt: AT,
    });
  }

  return { store, deps: { transactions, storage } };
}

describe("getCompletedArtifact", () => {
  it("streams the sealed bytes to the sender", async () => {
    const h = await harness();
    const result = await getCompletedArtifact(actor(OWNER), WS, REQUEST, h.deps);
    expect(result.mediaType).toBe("application/pdf");
    const bytes = await collect(result.stream);
    expect(new TextDecoder().decode(bytes)).toBe("%PDF-1.4 sealed bytes");
  });

  it("refuses a request that is not yet completed", async () => {
    const h = await harness({ state: "completion-ready" });
    await expect(getCompletedArtifact(actor(OWNER), WS, REQUEST, h.deps))
      .rejects.toThrow(ResourceNotFoundError);
  });

  it("refuses a non-member entirely", async () => {
    const h = await harness();
    await expect(getCompletedArtifact(actor(STRANGER), WS, REQUEST, h.deps))
      .rejects.toThrow(ResourceNotFoundError);
  });

  it("treats another workspace's request as absent", async () => {
    const h = await harness();
    await expect(getCompletedArtifact(actor(OWNER), OTHER_WS, REQUEST, h.deps))
      .rejects.toThrow(ResourceNotFoundError);
  });

  it("reports a conflict, not a silent fallback, when completed but unsealed", async () => {
    const h = await harness({ withSeal: false });
    await expect(getCompletedArtifact(actor(OWNER), WS, REQUEST, h.deps))
      .rejects.toThrow(ResourceConflictError);
  });

  it("reports the bytes as unavailable if storage no longer has them", async () => {
    const h = await harness();
    // Simulates the row surviving an object that never made it to storage,
    // or was lost there — the row is never trusted over the actual read.
    await h.deps.storage.deleteObject({ zone: "artifacts", key: "ws/doc/art_sealed" as never });
    await expect(getCompletedArtifact(actor(OWNER), WS, REQUEST, h.deps))
      .rejects.toThrow(CompletedArtifactUnavailableError);
  });
});
