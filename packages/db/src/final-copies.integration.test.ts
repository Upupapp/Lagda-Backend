// Final-copy download grants (073) on real PostgreSQL, as the runtime role:
// the credential realm resolves exactly one grant, tenants stay apart, a
// participant gets one grant, and the sender's choice is stored.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { DocumentId, UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type {
  ArtifactId, PreparationId, SigningRequestId, SigningRequestRecipientId,
  SigningRequestFieldId, FinalCopyDigest, FinalCopyGrantId, NewSigningRequestSnapshot,
} from "@lagda/application";
import { type LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-09-25T07:00:00.000Z");
const USER = "usr_fc" as UserId;
const WS_A = "ws_fc_a" as WorkspaceId;
const WS_B = "ws_fc_b" as WorkspaceId;
const DIGEST_A = "a".repeat(64) as FinalCopyDigest;
const DIGEST_B = "b".repeat(64) as FinalCopyDigest;
const UNKNOWN = "c".repeat(64) as FinalCopyDigest;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("final-copy grants (RLS, runtime role)", () => {
  let owner: LagdaDatabase;
  let app: LagdaDatabase;

  beforeAll(async () => {
    owner = await createTestDatabase();
    app = await createRuntimeRoleDatabase(owner);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
  });

  const requestOf = (ws: WorkspaceId) => `sr_${ws}` as SigningRequestId;
  const recipientOf = (ws: WorkspaceId) => `srr_${ws}` as SigningRequestRecipientId;
  const grantOf = (ws: WorkspaceId) => `fcg_${ws}` as FinalCopyGrantId;
  const grant = (ws: WorkspaceId, digest: FinalCopyDigest, grantId = grantOf(ws)) => ({
    grantId, workspaceId: ws, signingRequestId: requestOf(ws), recipientId: recipientOf(ws),
    credentialDigest: digest, createdAt: AT, expiresAt: AT + 30 * 24 * 3_600_000,
  });

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, USER);
    const tx = createTransactionManager(app.db);

    for (const [ws, member, digest] of [
      [WS_A, "mem_fca", DIGEST_A], [WS_B, "mem_fcb", DIGEST_B],
    ] as const) {
      const doc = `doc_${ws}` as DocumentId;
      await tx.runForWorkspace(ws, async uow => {
        await uow.workspaces.insert({ workspaceId: ws, name: `WS ${ws}`, createdAt: AT });
        await uow.memberships.insert({
          memberId: member as WorkspaceMemberId, workspaceId: ws,
          userId: USER, role: "owner", createdAt: AT,
        });
        await uow.documents.insert({
          documentId: doc, workspaceId: ws, title: "Office Lease",
          originalFilename: null, createdByUserId: USER, createdAt: AT,
        });
        await uow.artifacts.insert({
          artifactId: `art_${doc}` as ArtifactId, workspaceId: ws, documentId: doc,
          artifactType: "original", storageReference: `${ws}/a` as never,
          mediaType: "application/pdf", sizeBytes: 1024,
          digestAlgorithm: "sha-256", digest: "f".repeat(64) as never,
          pageCount: 1, rotatedPageCount: 0, createdAt: AT,
        });
        await uow.preparations.insert({
          preparationId: `prep_${doc}` as PreparationId, workspaceId: ws,
          documentId: doc, sourceArtifactId: `art_${doc}`, createdAt: AT,
        });
        const snapshot: NewSigningRequestSnapshot = {
          request: {
            signingRequestId: requestOf(ws), workspaceId: ws, documentId: doc,
            sourceArtifactId: `art_${doc}` as ArtifactId,
            sourcePreparationId: `prep_${doc}` as PreparationId,
            sourcePreparationRevision: 1, state: "draft",
            completionReadyAt: null, terminatedAt: null, expiresAt: null, completedAt: null,
            terminationReason: null, cancellationNote: null,
            documentTitle: `Lease for ${ws}`, createdByUserId: USER,
            createdAt: AT, updatedAt: AT,
          },
          recipients: [{
            recipientId: recipientOf(ws), sourcePreparationRecipientId: null,
            name: "Juan dela Cruz", email: "Juan@Example.com",
            normalizedEmail: "juan@example.com", organization: null,
            type: "signer", isRequired: true, orderIndex: 0, routingOrder: 1,
          }],
          fields: [{
            fieldId: `srf_${ws}` as SigningRequestFieldId,
            sourcePreparationFieldId: null, type: "signature", pageNumber: 1,
            x: 0.1, y: 0.2, width: 0.3, height: 0.05, required: true,
            label: "Signature", layer: 0, recipientId: recipientOf(ws), staticValue: null,
          }],
        };
        await uow.signingRequests.createSnapshot(snapshot);
        await uow.signingRequests.markSentIfSendable({
          signingRequestId: requestOf(ws), sentAt: AT,
          ...(ws === WS_B ? { shareFinalCopy: false } : {}),
        });
        expect(await uow.finalCopies.insertGrant(grant(ws, digest))).toBe(true);
      });
    }
  });

  it("stores the sender's choice with the send, defaulting to yes", async () => {
    const tx = createTransactionManager(app.db);
    const a = await tx.runForWorkspace(WS_A, uow => uow.signingRequests.find(requestOf(WS_A)));
    const b = await tx.runForWorkspace(WS_B, uow => uow.signingRequests.find(requestOf(WS_B)));
    expect(a?.shareFinalCopy).toBe(true);
    expect(b?.shareFinalCopy).toBe(false);
  });

  it("a presented credential resolves exactly its own grant", async () => {
    const tx = createTransactionManager(app.db);
    const resolved = await tx.runForFinalCopyCredential(DIGEST_A,
      uow => uow.lookup.findByCredentialDigest(DIGEST_A));
    expect(resolved).toMatchObject({
      grantId: grantOf(WS_A), workspaceId: WS_A,
      signingRequestId: requestOf(WS_A), recipientId: recipientOf(WS_A), revokedAt: null,
    });
    // Another tenant's digest, asked inside A's realm: the policy hides it.
    expect(await tx.runForFinalCopyCredential(DIGEST_A,
      uow => uow.lookup.findByCredentialDigest(DIGEST_B))).toBeNull();
    expect(await tx.runForFinalCopyCredential(UNKNOWN,
      uow => uow.lookup.findByCredentialDigest(UNKNOWN))).toBeNull();
  });

  it("entering the grant's workspace reads its request, and no other tenant's", async () => {
    const tx = createTransactionManager(app.db);
    const [own, other] = await tx.runForFinalCopyCredential(DIGEST_A, uow =>
      uow.enterWorkspace(WS_A, async inner => [
        await inner.signingRequests.find(requestOf(WS_A)),
        await inner.signingRequests.find(requestOf(WS_B)),
      ]));
    expect(own?.signingRequestId).toBe(requestOf(WS_A));
    expect(other).toBeNull();
  });

  it("a participant holds one grant; a second converges instead of adding", async () => {
    const tx = createTransactionManager(app.db);
    const again = await tx.runForWorkspace(WS_A, uow =>
      uow.finalCopies.insertGrant(grant(WS_A, "d".repeat(64) as FinalCopyDigest,
        "fcg_second" as FinalCopyGrantId)));
    expect(again).toBe(false);
  });

  it("usability is scoped to the workspace", async () => {
    const tx = createTransactionManager(app.db);
    expect(await tx.runForWorkspace(WS_A, uow =>
      uow.finalCopies.isGrantUsable(grantOf(WS_A), AT))).toBe(true);
    expect(await tx.runForWorkspace(WS_A, uow =>
      uow.finalCopies.isGrantUsable(grantOf(WS_B), AT))).toBe(false);
    expect(await tx.runForWorkspace(WS_A, uow =>
      uow.finalCopies.isGrantUsable(grantOf(WS_A), AT + 31 * 24 * 3_600_000))).toBe(false);
  });
});
