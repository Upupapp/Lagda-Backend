// The signatures surface: who signed a request, and when.
//
// The interesting cases are the ABSENCES. A request nobody has acted on must
// not read as though somebody had, and a recipient with no workflow row yet
// (later in the routing order, or never activated because nothing was sent)
// must still appear as a party rather than vanishing from the list — "who
// are the parties" is answered by the snapshot, not by how far the workflow
// has got.

import { describe, it, expect } from "vitest";
import type {
  ContactId, DocumentId, UserId, WorkspaceId,
} from "@lagda/contracts";
import { createSigningRequest, type SigningRequestDependencies } from "./signing-requests.js";
import { getSigningRequestSignatures } from "./signatures.js";
import { addRecipient, type RecipientDependencies } from "../recipients/recipients.js";
import {
  saveDocumentPreparation, type PreparationDependencies,
} from "../preparation/preparation.js";
import { CreateWorkspace } from "../workspaces/create-workspace.js";
import { ResourceNotFoundError } from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import type { ArtifactId, SigningRequestId } from "../common/ports/index.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialPreparationIds, SequentialRecipientIds, SequentialSigningRequestIds,
  FakeTransactionManager, InMemoryStore,
  signingAccountLinks, fakeVerifiedAccounts,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

const AT = Date.parse("2026-08-10T14:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const DOC = "doc_1" as DocumentId;
const CONTACT = "con_1" as ContactId;
const DIGEST = "b".repeat(64);

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

interface Harness {
  readonly store: InMemoryStore;
  readonly workspaceId: WorkspaceId;
  readonly deps: SigningRequestDependencies;
  readonly recipientDeps: RecipientDependencies;
  readonly prepDeps: PreparationDependencies;
}

async function harness(): Promise<Harness> {
  const store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);
  const clock = new FixedClock(AT);

  const created = await new CreateWorkspace({
    transactions, clock,
    workspaceIds: new SequentialWorkspaceIds(),
    memberIds: new SequentialMemberIds(),
    idempotency: {
      digester: createIdempotencyKeyDigester(),
      ids: createIdempotencyRecordIds(),
      clock,
      policy: { retentionMs: 86_400_000 },
    },
  }).execute({ actor: actor(OWNER), name: "Acme Legal" });

  store.documents.push({
    documentId: DOC, workspaceId: created.workspaceId, title: "Office Lease",
    originalFilename: "lease.pdf", createdByUserId: OWNER,
    folderId: null, createdAt: AT, updatedAt: AT,
  });
  store.artifacts.push({
    artifactId: "art_original" as ArtifactId,
    workspaceId: created.workspaceId, documentId: DOC, artifactType: "original",
    storageReference: "ws/doc/art" as never,
    mediaType: "application/pdf", sizeBytes: 204_800,
    digestAlgorithm: "sha-256", digest: DIGEST as never,
    pageCount: 5, rotatedPageCount: 0, createdAt: AT + 2000,
  });
  store.contacts.push({
    contactId: CONTACT, workspaceId: created.workspaceId,
    name: "Maria Santos", email: "Maria.Santos@AyalaLand.com.ph",
    emailKey: "maria.santos@ayalaland.com.ph" as never,
    phone: null, organization: "Ayala Land", title: "General Counsel",
    createdAt: AT, updatedAt: AT, archivedAt: null,
  });

  const recipientIds = new SequentialRecipientIds();
  const preparationIds = new SequentialPreparationIds();
  const authoring = {
    nextRecipientId: () => recipientIds.nextRecipientId(),
    nextPreparationId: () => preparationIds.nextPreparationId(),
    nextPreparationFieldId: () => preparationIds.nextPreparationFieldId(),
  };

  return {
    store,
    workspaceId: created.workspaceId,
    deps: {
      transactions, clock, ids: new SequentialSigningRequestIds(),
      idempotency: {
        digester: createIdempotencyKeyDigester(),
        ids: createIdempotencyRecordIds(),
        clock,
        policy: { retentionMs: 86_400_000 },
      },
    },
    recipientDeps: { transactions, clock, ids: authoring },
    prepDeps: { transactions, clock, ids: authoring },
  };
}

/** A request over a document prepared with one required signer. */
async function oneSigner() {
  const h = await harness();
  const recipient = await addRecipient(
    actor(OWNER), h.workspaceId, DOC,
    { source: "contact", contactId: CONTACT, type: "signer" } as never,
    h.recipientDeps);

  await saveDocumentPreparation(
    actor(OWNER), h.workspaceId, DOC,
    {
      expectedRevision: 1,
      fields: [{
        type: "signature", pageNumber: 1,
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
        required: true, label: "Landlord signature", layer: 0,
        recipientId: recipient.recipientId,
      }],
    } as never,
    h.prepDeps);

  const created = await createSigningRequest(
    { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.deps);

  return { h, signingRequestId: created.signingRequestId as SigningRequestId };
}

describe("getSigningRequestSignatures", () => {
  it("lists every party, with nobody signed before anybody acts", async () => {
    const { h, signingRequestId } = await oneSigner();

    const view = await getSigningRequestSignatures(
      actor(OWNER), h.workspaceId, signingRequestId, h.deps);

    expect(view.signingRequestId).toBe(signingRequestId);
    expect(view.signatories).toHaveLength(1);
    expect(view.signatories[0]?.name).toBe("Maria Santos");
    // The whole point: a request nobody has acted on reports nobody acting.
    // An un-activated party must never present as one who did something.
    expect(view.signatories[0]?.state).toBe("waiting");
    expect(view.signatories[0]?.signedAt).toBeNull();
    expect(view.signatories[0]?.declinedAt).toBeNull();
    expect(view.signatories[0]?.declineReason).toBeNull();
    expect(view.signedCount).toBe(0);
    expect(view.requiredCount).toBe(1);
  });

  // 069. An approver who APPROVED — or was skipped — has finished their
  // part. Counting only `signed` meant a completed request with an approver
  // never read as complete, and the dialog could not render their state.
  it.each(["approved", "skipped"] as const)("counts a %s participant as done", async (state) => {
    const { h, signingRequestId } = await oneSigner();
    const recipientId = h.store.signingRequestRecipients[0]!.recipientId;
    const at = Date.parse("2026-09-25T10:00:00Z");
    h.store.activations.push({
      signingRequestId: String(signingRequestId), recipientId, state,
      activatedAt: at, signedAt: null, submissionId: null,
      approvedAt: state === "approved" ? at : null,
      skippedAt: state === "skipped" ? at : null,
      declinedAt: null, declineReason: null,
    });

    const view = await getSigningRequestSignatures(
      actor(OWNER), h.workspaceId, signingRequestId, h.deps);

    expect(view.signedCount).toBe(1);
    expect(view.signatories[0]?.state).toBe(state);
    expect(state === "approved" ? view.signatories[0]?.approvedAt : view.signatories[0]?.skippedAt).toBe(at);
  });

  it("refuses a request that belongs to another tenant, as an absence", async () => {
    const { h } = await oneSigner();

    await expect(getSigningRequestSignatures(
      actor(OWNER), h.workspaceId, "sr_not_mine" as SigningRequestId, h.deps),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("exposes no raw account id or credential, linked or not", async () => {
    const { h, signingRequestId } = await oneSigner();

    const view = await getSigningRequestSignatures(
      actor(OWNER), h.workspaceId, signingRequestId, h.deps);
    const serialized = JSON.stringify(view);

    for (const absent of [
      // A DISPLAY name and address are the deliberate exception this view
      // now carries (see `linkedAccountName`/`linkedAccountEmail` below) --
      // but never the account id, or its own normalized comparison value.
      "userId", "isRegisteredUser", "normalizedEmail", "emailKey",
      // Nothing that could be used to enter the ceremony.
      "accessToken", "signingUrl", "otp", "tokenDigest", "sessionId",
      // Provenance is an operator's concern, and an artifact id is one step
      // from a storage key.
      "sourceArtifactId", "storageReference", "sourcePreparationId",
    ]) {
      expect(serialized, `exposes ${absent}`).not.toContain(absent);
    }
  });

  it("has no linked account, by default", async () => {
    const { h, signingRequestId } = await oneSigner();

    const view = await getSigningRequestSignatures(
      actor(OWNER), h.workspaceId, signingRequestId, h.deps);

    expect(view.signatories[0]?.linkedAccountName).toBeNull();
    expect(view.signatories[0]?.linkedAccountEmail).toBeNull();
  });

  it("shows the bound account's OWN name and address, distinct from the sender's snapshot", async () => {
    const { h, signingRequestId } = await oneSigner();
    const recipientId = (await getSigningRequestSignatures(
      actor(OWNER), h.workspaceId, signingRequestId, h.deps))
      .signatories[0]?.recipientId;

    // The sender typed "Maria Santos"; the account she actually signed in
    // with is a different display name and a different verified address --
    // exactly the case this view exists to surface for the record.
    fakeVerifiedAccounts.set("maria.signer@example.com", {
      userId: "usr_maria_account",
      name: "Ma. Teresa Santos",
      email: "maria.signer@example.com",
    });
    await signingAccountLinks().createLink({
      signingAccountLinkId: "sal_test",
      userId: "usr_maria_account",
      workspaceId: h.workspaceId,
      signingRequestId,
      recipientId: recipientId as never,
      matchedNormalizedEmail: "maria.signer@example.com",
      linkedAt: new Date(AT),
    });

    const view = await getSigningRequestSignatures(
      actor(OWNER), h.workspaceId, signingRequestId, h.deps);

    expect(view.signatories[0]?.name).toBe("Maria Santos");
    expect(view.signatories[0]?.linkedAccountName).toBe("Ma. Teresa Santos");
    expect(view.signatories[0]?.linkedAccountEmail).toBe("maria.signer@example.com");
    // The account id itself never appears.
    expect(JSON.stringify(view)).not.toContain("usr_maria_account");
  });
});
