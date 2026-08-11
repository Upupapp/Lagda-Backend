// Sending a signing request, tested with fakes.
//
// The claims that carry weight:
//
//   Send reads the SNAPSHOT — a contact or preparation edited after creation
//   changes nothing about what is delivered;
//
//   routing decides who activates, and a waiting recipient gets no credential;
//
//   the raw credential is sealed and never persisted in the grant;
//
//   a retry re-invites nobody, and a second send with a new key is refused;
//
//   nothing is sent, in the provider sense, at all.

import { describe, it, expect } from "vitest";
import type {
  ContactId, DocumentId, IdempotencyKey, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import {
  sendSigningRequest,
  SigningRequestAlreadySentError, SigningRequestNotSendableError,
  SigningRequestIntegrityError,
  type SendSigningRequestDependencies,
} from "./send.js";
import { createSigningRequest, type SigningRequestDependencies } from "./signing-requests.js";
import {
  addRecipient, updateRecipient, type RecipientDependencies,
} from "../recipients/recipients.js";
import {
  saveDocumentPreparation, type PreparationDependencies,
} from "../preparation/preparation.js";
import { ResourceNotFoundError } from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import type { ArtifactId, SealedDeliverySecret } from "../common/ports/index.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialPreparationIds, SequentialRecipientIds, SequentialSigningRequestIds,
  SequentialSigningAccessIds, FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";
import { CreateWorkspace } from "../workspaces/create-workspace.js";

const AT = Date.parse("2026-08-10T14:00:00.000Z");
const LIFETIME = 14 * 24 * 3_600_000;
const OWNER = "usr_owner" as UserId;
const AUDITOR = "usr_auditor" as UserId;
const DOC = "doc_1" as DocumentId;
const CONTACT = "con_1" as ContactId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

/**
 * Records every raw credential the factory issued, so tests can hunt for it.
 *
 * The digest deliberately does NOT contain the raw value. An earlier version
 * returned `d${raw}`, and the "never persists the raw credential" assertion
 * failed against it — correctly. A digest that embeds its plaintext would let
 * that test pass for the wrong reason forever if the production factory ever
 * regressed the same way.
 */
class RecordingTokens {
  readonly issued: string[] = [];
  readonly digests = new Map<string, string>();
  private next = 1;
  issue() {
    const serial = this.next++;
    // 43 characters, the real base64url shape.
    const raw = `tok${String(serial).padStart(40, "x")}`;
    // 64 hex characters, the real digest shape, sharing no substring with the
    // raw value beyond what any two hex strings share.
    const digest = String(serial).padStart(64, "a");
    this.issued.push(raw);
    this.digests.set(raw, digest);
    return { raw, digest: digest as never };
  }
  digest() {
    return null;
  }
}

interface Harness {
  readonly store: InMemoryStore;
  readonly workspaceId: WorkspaceId;
  readonly tokens: RecordingTokens;
  readonly sealed: string[];
  readonly deps: SendSigningRequestDependencies;
  readonly createDeps: SigningRequestDependencies;
  readonly recipientDeps: RecipientDependencies;
  readonly prepDeps: PreparationDependencies;
}

async function harness(over: { sealerFails?: boolean } = {}): Promise<Harness> {
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
      clock, policy: { retentionMs: 86_400_000 },
    },
  }).execute({ actor: actor(OWNER), name: "Acme Legal" });

  store.memberships.push({
    memberId: "mem_auditor" as WorkspaceMemberId, workspaceId: created.workspaceId,
    userId: AUDITOR, role: "auditor", createdAt: AT + 1000,
  });
  store.documents.push({
    documentId: DOC, workspaceId: created.workspaceId, title: "Office Lease",
    originalFilename: "lease.pdf", createdByUserId: OWNER, createdAt: AT, updatedAt: AT,
  });
  store.artifacts.push({
    artifactId: "art_original" as ArtifactId, workspaceId: created.workspaceId,
    documentId: DOC, artifactType: "original",
    storageReference: "ws/doc/art" as never, mediaType: "application/pdf",
    sizeBytes: 204_800, digestAlgorithm: "sha-256", digest: "b".repeat(64) as never,
    pageCount: 5, rotatedPageCount: 0, createdAt: AT + 2000,
  });
  store.contacts.push({
    contactId: CONTACT, workspaceId: created.workspaceId,
    name: "Maria Santos", email: "Maria.Santos@AyalaLand.com.ph",
    emailKey: "maria.santos@ayalaland.com.ph" as never,
    phone: null, organization: "Ayala Land", title: null,
    createdAt: AT, updatedAt: AT, archivedAt: null,
  });

  const recipientIds = new SequentialRecipientIds();
  const preparationIds = new SequentialPreparationIds();
  const authoring = {
    nextRecipientId: () => recipientIds.nextRecipientId(),
    nextPreparationId: () => preparationIds.nextPreparationId(),
    nextPreparationFieldId: () => preparationIds.nextPreparationFieldId(),
  };
  const idempotency = {
    digester: createIdempotencyKeyDigester(),
    ids: createIdempotencyRecordIds(),
    clock, policy: { retentionMs: 86_400_000 },
  };

  const tokens = new RecordingTokens();
  const sealed: string[] = [];

  return {
    store, workspaceId: created.workspaceId, tokens, sealed,
    deps: {
      transactions, clock,
      ids: new SequentialSigningAccessIds(),
      tokens,
      sealer: {
        keyVersion: "v1",
        seal: (plaintext: string) => {
          if (over.sealerFails === true) throw new Error("no key configured");
          sealed.push(plaintext);
          return `sealed:${plaintext}` as SealedDeliverySecret;
        },
      },
      links: { build: (raw: string) => `https://app.lagda.test/sign/${raw}` },
      policy: { bootstrapLifetimeMs: LIFETIME },
      idempotency,
    },
    createDeps: {
      transactions, clock, ids: new SequentialSigningRequestIds(), idempotency,
    },
    recipientDeps: { transactions, clock, ids: authoring },
    prepDeps: { transactions, clock, ids: authoring },
  };
}

const field = (recipientId: string, over: Record<string, unknown> = {}) => ({
  type: "signature" as const,
  pageNumber: 1,
  rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
  required: true,
  label: "Landlord signature",
  layer: 0,
  recipientId,
  ...over,
});

/** Creates a sendable request. `people` describes each recipient. */
async function requestWith(
  h: Harness,
  people: readonly { email: string; type?: string; routingOrder?: number }[],
): Promise<string> {
  const ids: string[] = [];
  for (const person of people) {
    const recipient = await addRecipient(
      actor(OWNER), h.workspaceId, DOC, {
        source: "manual", name: `Party ${person.email}`, email: person.email,
        type: (person.type ?? "signer") as never,
        ...(person.routingOrder === undefined
          ? {} : { routingOrder: person.routingOrder }),
      }, h.recipientDeps);
    ids.push(recipient.recipientId);
  }

  const revision = h.store.preparations[0]?.revision ?? 1;
  await saveDocumentPreparation(
    actor(OWNER), h.workspaceId, DOC, {
      expectedRevision: revision,
      // Every recipient that can hold a field gets one, or readiness refuses.
      fields: ids
        .filter((_, index) => (people[index]?.type ?? "signer") !== "viewer"
          && (people[index]?.type ?? "signer") !== "carbon-copy")
        .map((id, index) => field(id, { layer: index })),
    }, h.prepDeps);

  const created = await createSigningRequest(
    { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.createDeps);
  return created.signingRequestId;
}

const send = (h: Harness, id: string, key?: string) => sendSigningRequest({
  actor: actor(OWNER), workspaceId: h.workspaceId, signingRequestId: id,
  ...(key === undefined ? {} : { idempotencyKey: key as IdempotencyKey }),
}, h.deps);

// ── The transition ───────────────────────────────────────────────────────────

describe("the state transition", () => {
  it("moves draft to sent and records sentAt", async () => {
    const h = await harness();
    const id = await requestWith(h, [{ email: "a@x.com" }]);

    const sent = await send(h, id);
    expect(sent.state).toBe("sent");
    expect(sent.sentAt).toBe(AT);
    expect(h.store.signingRequests[0]?.state).toBe("sent");
  });

  it("refuses a second send with a new key", async () => {
    // Not a retry — a deliberate second attempt. It must not re-invite anyone.
    const h = await harness();
    const id = await requestWith(h, [{ email: "a@x.com" }]);
    await send(h, id, "send-key-000001");

    await expect(send(h, id, "send-key-000002")).rejects
      .toBeInstanceOf(SigningRequestAlreadySentError);
    expect(h.store.signingAccessGrants).toHaveLength(1);
    expect(h.store.deliveryIntents).toHaveLength(1);
  });

  it("reports an unknown request as absent", async () => {
    const h = await harness();
    await expect(send(h, "sr_nope")).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// ── Snapshot-only ────────────────────────────────────────────────────────────

describe("send reads the snapshot and nothing mutable", () => {
  it("delivers to the address the request captured, not the contact's current one", async () => {
    const h = await harness();
    const recipient = await addRecipient(
      actor(OWNER), h.workspaceId, DOC,
      { source: "contact", contactId: CONTACT, type: "signer" }, h.recipientDeps);
    await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC,
      { expectedRevision: 1, fields: [field(recipient.recipientId)] }, h.prepDeps);
    const created = await createSigningRequest(
      { actor: actor(OWNER), workspaceId: h.workspaceId, documentId: DOC }, h.createDeps);

    // Everything mutable changes after creation and before send.
    const contact = h.store.contacts[0];
    if (contact === undefined) throw new Error("fixture");
    h.store.contacts[0] = { ...contact, name: "Changed", email: "changed@x.com" };
    await updateRecipient(
      actor(OWNER), h.workspaceId, DOC, recipient.recipientId,
      { name: "Also Changed", email: "also-changed@x.com" }, h.recipientDeps);
    const document = h.store.documents[0];
    if (document === undefined) throw new Error("fixture");
    h.store.documents[0] = { ...document, title: "Renamed Lease" };

    await send(h, created.signingRequestId);

    const intent = h.store.deliveryIntents[0];
    expect(intent?.recipientEmail).toBe("Maria.Santos@AyalaLand.com.ph");
    expect(intent?.recipientName).toBe("Maria Santos");
    expect(intent?.documentTitle).toBe("Office Lease");
  });

  it("survives the preparation field being deleted before send", async () => {
    const h = await harness();
    const id = await requestWith(h, [{ email: "a@x.com" }]);
    const revision = h.store.preparations[0]?.revision ?? 1;
    await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, { expectedRevision: revision, fields: [] },
      h.prepDeps);

    // The preparation now has no fields at all; the request still does.
    const sent = await send(h, id);
    expect(sent.state).toBe("sent");
  });
});

// ── Routing ──────────────────────────────────────────────────────────────────

describe("routing activation", () => {
  it("activates everyone when all share a routing order", async () => {
    const h = await harness();
    const id = await requestWith(h, [
      { email: "a@x.com" }, { email: "b@x.com" }, { email: "c@x.com" },
    ]);
    const sent = await send(h, id);

    expect(sent.activatedRecipientCount).toBe(3);
    expect(sent.waitingRecipientCount).toBe(0);
    expect(h.store.signingAccessGrants).toHaveLength(3);
    expect(h.store.deliveryIntents).toHaveLength(3);
  });

  it("activates only the earliest cohort when orders differ", async () => {
    const h = await harness();
    const id = await requestWith(h, [
      { email: "a@x.com", routingOrder: 1 },
      { email: "b@x.com", routingOrder: 2 },
      { email: "c@x.com", routingOrder: 3 },
    ]);
    const sent = await send(h, id);

    expect(sent.activatedRecipientCount).toBe(1);
    expect(sent.waitingRecipientCount).toBe(2);
    // The whole point of §47: a waiting recipient holds no long-lived secret.
    expect(h.store.signingAccessGrants).toHaveLength(1);
    expect(h.store.deliveryIntents).toHaveLength(1);
  });

  it("activates a mixed cohort together", async () => {
    const h = await harness();
    const id = await requestWith(h, [
      { email: "a@x.com", routingOrder: 1 },
      { email: "b@x.com", routingOrder: 1 },
      { email: "c@x.com", routingOrder: 2 },
    ]);
    const sent = await send(h, id);
    expect(sent.activatedRecipientCount).toBe(2);
    expect(h.store.signingAccessGrants).toHaveLength(2);
  });

  it("records a row for every recipient, waiting or active", async () => {
    const h = await harness();
    const id = await requestWith(h, [
      { email: "a@x.com", routingOrder: 1 }, { email: "b@x.com", routingOrder: 2 },
    ]);
    await send(h, id);

    expect(h.store.activations).toHaveLength(2);
    const states = h.store.activations.map(a => a.state).sort();
    expect(states).toEqual(["active", "waiting"]);
    expect(h.store.activations.find(a => a.state === "active")?.activatedAt).toBe(AT);
    expect(h.store.activations.find(a => a.state === "waiting")?.activatedAt).toBeNull();
  });

  it("takes the earliest cohort present, not the literal value 1", async () => {
    // Deleting the only step-1 recipient leaves 2 and 3, which BACKEND-31
    // permits. Assuming 1 would activate nobody.
    const h = await harness();
    const id = await requestWith(h, [
      { email: "a@x.com", routingOrder: 2 }, { email: "b@x.com", routingOrder: 3 },
    ]);
    const sent = await send(h, id);
    expect(sent.activatedRecipientCount).toBe(1);
  });

  it("activates a viewer but gives it no credential", async () => {
    // A viewer cannot hold fields, so a signing credential is not what it
    // needs. It is activated so a later command can find it (OD-135).
    const h = await harness();
    const id = await requestWith(h, [
      { email: "signer@x.com" }, { email: "watcher@x.com", type: "viewer" },
    ]);
    const sent = await send(h, id);

    expect(sent.activatedRecipientCount).toBe(2);
    expect(h.store.signingAccessGrants).toHaveLength(1);
    expect(h.store.deliveryIntents).toHaveLength(1);
    expect(h.store.deliveryIntents[0]?.recipientEmail).toBe("signer@x.com");
  });
});

// ── Credentials ──────────────────────────────────────────────────────────────

describe("signing access credentials", () => {
  it("persists a digest and never the raw credential", async () => {
    const h = await harness();
    const id = await requestWith(h, [{ email: "a@x.com" }]);
    await send(h, id);

    const raw = h.tokens.issued[0];
    if (raw === undefined) throw new Error("fixture");
    const grant = JSON.stringify(h.store.signingAccessGrants[0]);
    expect(grant).not.toContain(raw);
    expect(h.store.signingAccessGrants[0]?.credentialDigest)
      .toBe(h.tokens.digests.get(raw));
  });

  it("seals the raw credential into the delivery intent", async () => {
    const h = await harness();
    const id = await requestWith(h, [{ email: "a@x.com" }]);
    await send(h, id);

    const raw = h.tokens.issued[0];
    // Sealed, so an async renderer can recover it. This is the one place the
    // raw value survives the transaction, and it survives encrypted.
    expect(h.sealed).toEqual([raw]);
    expect(h.store.deliveryIntents[0]?.sealedCredential).toBe(`sealed:${String(raw)}`);
    expect(h.store.deliveryIntents[0]?.sealedKeyVersion).toBe("v1");
  });

  it("gives each recipient a different credential", async () => {
    const h = await harness();
    const id = await requestWith(h, [{ email: "a@x.com" }, { email: "b@x.com" }]);
    await send(h, id);

    const digests = h.store.signingAccessGrants.map(g => g.credentialDigest);
    expect(new Set(digests).size).toBe(2);
  });

  it("binds each grant to its own recipient", async () => {
    const h = await harness();
    const id = await requestWith(h, [{ email: "a@x.com" }, { email: "b@x.com" }]);
    await send(h, id);

    const recipientIds = h.store.signingRequestRecipients.map(r => String(r.recipientId));
    for (const grant of h.store.signingAccessGrants) {
      expect(recipientIds).toContain(String(grant.recipientId));
      expect(String(grant.signingRequestId)).toBe(id);
    }
    expect(new Set(h.store.signingAccessGrants.map(g => String(g.recipientId))).size).toBe(2);
  });

  it("sets an explicit expiry from the server clock", async () => {
    const h = await harness();
    const id = await requestWith(h, [{ email: "a@x.com" }]);
    await send(h, id);
    expect(h.store.signingAccessGrants[0]?.expiresAt).toBe(AT + LIFETIME);
  });

  it("never stores or returns a signing URL", async () => {
    const h = await harness();
    const id = await requestWith(h, [{ email: "a@x.com" }]);
    const sent = await send(h, id);

    const everything = JSON.stringify({
      sent,
      grants: h.store.signingAccessGrants,
      intents: h.store.deliveryIntents,
    });
    expect(everything).not.toContain("https://");
    expect(everything).not.toContain("/sign/");
  });
});

// ── Atomicity ────────────────────────────────────────────────────────────────

describe("atomicity", () => {
  it("leaves the request draft when the sealer has no key", async () => {
    // §234: no key means Send fails BEFORE the transition, never a plaintext
    // fallback and never a request marked sent with an unrenderable credential.
    const h = await harness({ sealerFails: true });
    const id = await requestWith(h, [{ email: "a@x.com" }]);

    await expect(send(h, id)).rejects.toThrow(/no key configured/);
    expect(h.store.signingRequests[0]?.state).toBe("draft");
    expect(h.store.signingAccessGrants).toHaveLength(0);
    expect(h.store.deliveryIntents).toHaveLength(0);
    expect(h.store.activations).toHaveLength(0);
  });

  it("rolls back every recipient when a later one fails", async () => {
    // Recipient 1 succeeds, recipient 2's seal throws. Nothing survives.
    const h = await harness();
    const id = await requestWith(h, [{ email: "a@x.com" }, { email: "b@x.com" }]);

    let calls = 0;
    const original = h.deps.sealer.seal;
    (h.deps.sealer as { seal: (p: string) => unknown }).seal = (plaintext: string) => {
      calls += 1;
      if (calls === 2) throw new Error("second recipient fails");
      return original(plaintext);
    };

    await expect(send(h, id)).rejects.toThrow(/second recipient fails/);
    expect(h.store.signingRequests[0]?.state).toBe("draft");
    expect(h.store.signingAccessGrants).toHaveLength(0);
    expect(h.store.deliveryIntents).toHaveLength(0);
  });

  it("refuses to send when the source artifact is gone", async () => {
    const h = await harness();
    const id = await requestWith(h, [{ email: "a@x.com" }]);
    h.store.artifacts.length = 0;

    await expect(send(h, id)).rejects.toBeInstanceOf(SigningRequestIntegrityError);
    expect(h.store.signingRequests[0]?.state).toBe("draft");
  });
});

// ── Idempotency ──────────────────────────────────────────────────────────────

describe("idempotency", () => {
  const KEY = "send-key-000001";

  it("replays the original result and mints nothing new", async () => {
    const h = await harness();
    const id = await requestWith(h, [{ email: "a@x.com" }]);

    const first = await send(h, id, KEY);
    const replay = await send(h, id, KEY);

    expect(replay.sentAt).toBe(first.sentAt);
    expect(replay.signingRequestId).toBe(first.signingRequestId);
    // The property that matters: no second credential, no second invitation.
    expect(h.store.signingAccessGrants).toHaveLength(1);
    expect(h.store.deliveryIntents).toHaveLength(1);
    expect(h.tokens.issued).toHaveLength(1);
  });

  it("sends without a key when one is not supplied", async () => {
    const h = await harness();
    const id = await requestWith(h, [{ email: "a@x.com" }]);
    const sent = await send(h, id);
    expect(sent.state).toBe("sent");
  });
});

// ── Eligibility ──────────────────────────────────────────────────────────────

describe("eligibility", () => {
  it("names indexes, never addresses", async () => {
    const h = await harness();
    const id = await requestWith(h, [{ email: "maria@ayalaland.com.ph" }]);
    // Corrupt the snapshot directly: an address the constraints would refuse.
    const recipient = h.store.signingRequestRecipients[0];
    if (recipient === undefined) throw new Error("fixture");
    h.store.signingRequestRecipients[0] = { ...recipient, email: "   " };

    const failure = await send(h, id).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SigningRequestNotSendableError);
    const text = (failure as SigningRequestNotSendableError).issues.join(" ");
    expect(text).toContain("recipients[0]");
    expect(text).not.toContain("ayalaland");
  });
});

// ── Authorization ────────────────────────────────────────────────────────────

describe("authorization", () => {
  it("refuses an auditor", async () => {
    const h = await harness();
    const id = await requestWith(h, [{ email: "a@x.com" }]);

    await expect(sendSigningRequest({
      actor: actor(AUDITOR), workspaceId: h.workspaceId, signingRequestId: id,
    }, h.deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(h.store.signingRequests[0]?.state).toBe("draft");
    expect(h.store.signingAccessGrants).toHaveLength(0);
  });

  it("refuses a member who was removed", async () => {
    const h = await harness();
    const id = await requestWith(h, [{ email: "a@x.com" }]);
    // The membership is read INSIDE the transaction, so removing it here is
    // the same as removing it a moment before the send committed.
    h.store.memberships.length = 0;

    await expect(send(h, id)).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(h.store.signingRequests[0]?.state).toBe("draft");
  });
});

// ── Side effects ─────────────────────────────────────────────────────────────

describe("send performs no ceremony and contacts no provider", () => {
  it("writes no evidence, no artifact and no seal", async () => {
    const h = await harness();
    const id = await requestWith(h, [{ email: "a@x.com" }]);
    const artifactsBefore = h.store.artifacts.length;
    await send(h, id);

    // BACKEND-43: send now records that it was sent and who became eligible.
    // It still claims NOTHING a recipient did — no view, no signature, no
    // delivery — which is what this test is really about.
    // Three: the harness CREATES the request before sending it, so
    // `transaction-created` is already there. Asserting the whole set rather
    // than only send's own is deliberate — it pins that send adds exactly two.
    expect(h.store.evidence.map(e => e.eventType).sort())
      .toEqual(["recipient-activated", "transaction-created", "transaction-sent"]);
    for (const forbidden of [
      "document-viewed", "signature-completed", "authentication-completed",
    ]) {
      expect(h.store.evidence.map(e => e.eventType)).not.toContain(forbidden);
    }
    expect(h.store.artifacts).toHaveLength(artifactsBefore);
    expect(h.store.seals).toHaveLength(0);
  });

  it("leaves the immutable snapshot untouched", async () => {
    const h = await harness();
    const id = await requestWith(h, [{ email: "a@x.com" }]);
    const before = JSON.stringify({
      recipients: h.store.signingRequestRecipients,
      fields: h.store.signingRequestFields,
    });
    await send(h, id);
    expect(JSON.stringify({
      recipients: h.store.signingRequestRecipients,
      fields: h.store.signingRequestFields,
    })).toBe(before);
  });

  it("records no viewed, signed or delivered state anywhere", async () => {
    const h = await harness();
    const id = await requestWith(h, [{ email: "a@x.com" }]);
    await send(h, id);

      // BACKEND-37 NARROWED THIS ASSERTION, and the narrowing is the point.
      //
      // It used to search a JSON dump for the SUBSTRING "signedAt". That
      // passed only because no column of that name existed; once the workflow
      // row gained one it failed while nothing had actually been recorded.
      // A key that is present and null is not a fact. So the check is now on
      // the VALUES: no recipient has signed, declined, or been delivered to.
    for (const activation of h.store.activations) {
      expect(activation.state).not.toBe("signed");
      expect(activation.state).not.toBe("declined");
      expect(activation.signedAt).toBeNull();
      expect(activation.submissionId).toBeNull();
      expect(activation.declinedAt).toBeNull();
    }
    const everything = JSON.stringify({
      grants: h.store.signingAccessGrants,
      intents: h.store.deliveryIntents,
    });
    for (const absent of [
      "viewedAt", "signedAt", "declinedAt", "authenticatedAt", "completedAt",
      "deliveredAt", "bouncedAt", "deliveryStatus",
    ]) {
      expect(everything, `records ${absent}`).not.toContain(absent);
    }
  });
});
