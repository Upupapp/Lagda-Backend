// Recipient use cases, tested with fakes.
//
// The claims that carry weight, in the order they matter:
//
//   a recipient is a SNAPSHOT — editing or deleting the contact it came from
//   changes nothing about it, and editing it changes nothing about the contact;
//
//   one delivery address, one recipient per document;
//
//   a recipient with placed fields cannot be deleted or demoted out from under
//   them;
//
//   a field can only name a recipient of its own preparation.

import { describe, it, expect } from "vitest";
import type {
  ContactId, DocumentId, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import {
  listRecipients, addRecipient, updateRecipient, removeRecipient, reorderRecipients,
  DuplicateRecipientError, RecipientHasFieldsError,
  type RecipientDependencies,
} from "./recipients.js";
import {
  saveDocumentPreparation, type PreparationDependencies,
} from "../preparation/preparation.js";
import { CreateWorkspace } from "../workspaces/create-workspace.js";
import {
  ApplicationValidationError, ResourceNotFoundError,
} from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import type { ArtifactId } from "../common/ports/index.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialPreparationIds, SequentialRecipientIds,
  FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

const AT = Date.parse("2026-08-10T14:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const AUDITOR = "usr_auditor" as UserId;
const DOC = "doc_1" as DocumentId;
const OTHER_DOC = "doc_2" as DocumentId;
const CONTACT = "con_1" as ContactId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

interface Harness {
  readonly store: InMemoryStore;
  readonly deps: RecipientDependencies;
  readonly prep: PreparationDependencies;
  readonly workspaceId: WorkspaceId;
}

const DIGEST = "b".repeat(64);

/**
 * A workspace with two documents, each with accepted bytes, and one contact.
 *
 * Two documents because half of what this file proves is that a recipient of
 * one is invisible to — and unusable by — the other.
 */
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

  store.memberships.push({
    memberId: "mem_auditor" as WorkspaceMemberId,
    workspaceId: created.workspaceId,
    userId: AUDITOR, role: "auditor", createdAt: AT + 1000,
  });

  for (const [documentId, title] of [[DOC, "Office Lease"], [OTHER_DOC, "Supply Deal"]] as const) {
    store.documents.push({
      documentId, workspaceId: created.workspaceId, title,
      originalFilename: `${documentId}.pdf`,
      createdByUserId: OWNER, createdAt: AT, updatedAt: AT,
    });
    store.artifacts.push({
      artifactId: `art_${documentId}` as ArtifactId,
      workspaceId: created.workspaceId,
      documentId,
      artifactType: "original",
      storageReference: "ws/doc/art" as never,
      mediaType: "application/pdf",
      sizeBytes: 204_800,
      digestAlgorithm: "sha-256",
      digest: DIGEST as never,
      pageCount: 5,
      rotatedPageCount: 0,
      createdAt: AT + 2000,
    });
  }

  store.contacts.push({
    contactId: CONTACT,
    workspaceId: created.workspaceId,
    name: "Maria Santos",
    email: "Maria.Santos@AyalaLand.com.ph",
    emailKey: "maria.santos@ayalaland.com.ph" as never,
    phone: null,
    organization: "Ayala Land",
    title: "General Counsel",
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
  });

  // Both generators, behind one object. Spreading the instances would drop
  // their methods - these are class prototypes, not plain objects.
  const recipientIds = new SequentialRecipientIds();
  const preparationIds = new SequentialPreparationIds();
  const combined = {
    nextRecipientId: () => recipientIds.nextRecipientId(),
    nextPreparationId: () => preparationIds.nextPreparationId(),
    nextPreparationFieldId: () => preparationIds.nextPreparationFieldId(),
  };
  return {
    store,
    workspaceId: created.workspaceId,
    deps: { transactions, clock, ids: combined },
    prep: { transactions, clock, ids: combined },
  };
}

const manual = (over: Record<string, unknown> = {}) => ({
  source: "manual" as const,
  name: "Juan dela Cruz",
  email: "juan@example.com",
  type: "signer" as const,
  ...over,
});

// ── Creation ─────────────────────────────────────────────────────────────────

describe("addRecipient", () => {
  it("creates a recipient from typed details", async () => {
    const h = await harness();
    const recipient = await addRecipient(
      actor(OWNER), h.workspaceId, DOC, manual(), h.deps);

    expect(recipient.name).toBe("Juan dela Cruz");
    expect(recipient.email).toBe("juan@example.com");
    expect(recipient.type).toBe("signer");
    // Typed by hand, so there is no provenance to record.
    expect(recipient.sourceContactId).toBeNull();
    // Defaults: everyone waits, everyone in parallel.
    expect(recipient.isRequired).toBe(true);
    expect(recipient.routingOrder).toBe(1);
    expect(recipient.orderIndex).toBe(0);
  });

  it("creates the preparation lazily, so a never-prepared document accepts one", async () => {
    const h = await harness();
    expect(h.store.preparations).toHaveLength(0);
    await addRecipient(actor(OWNER), h.workspaceId, DOC, manual(), h.deps);
    expect(h.store.preparations).toHaveLength(1);
  });

  it("copies a contact's details rather than referencing them", async () => {
    const h = await harness();
    const recipient = await addRecipient(
      actor(OWNER), h.workspaceId, DOC,
      { source: "contact", contactId: CONTACT, type: "signer" }, h.deps);

    expect(recipient.name).toBe("Maria Santos");
    // The DISPLAY address, with its original casing. An invitation goes here.
    expect(recipient.email).toBe("Maria.Santos@AyalaLand.com.ph");
    expect(recipient.organization).toBe("Ayala Land");
    // Provenance, not a reference.
    expect(recipient.sourceContactId).toBe(CONTACT);
  });

  it("does not copy the contact's title", async () => {
    // The contact has one; a recipient has no such column. A snapshot copies
    // what a recipient IS, not everything the source happened to hold.
    const h = await harness();
    const recipient = await addRecipient(
      actor(OWNER), h.workspaceId, DOC,
      { source: "contact", contactId: CONTACT, type: "signer" }, h.deps);
    expect(Object.keys(recipient)).not.toContain("title");
  });

  it("reports an unknown contact as absent", async () => {
    const h = await harness();
    await expect(addRecipient(
      actor(OWNER), h.workspaceId, DOC,
      { source: "contact", contactId: "con_nope", type: "signer" }, h.deps,
    )).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("appends, so order is creation order", async () => {
    const h = await harness();
    await addRecipient(actor(OWNER), h.workspaceId, DOC, manual({ email: "a@x.com" }), h.deps);
    await addRecipient(actor(OWNER), h.workspaceId, DOC, manual({ email: "b@x.com" }), h.deps);
    const listed = await listRecipients(actor(OWNER), h.workspaceId, DOC, h.deps);
    expect(listed.map(r => r.orderIndex)).toEqual([0, 1]);
    expect(listed.map(r => r.email)).toEqual(["a@x.com", "b@x.com"]);
  });

  it("refuses a name of control characters", async () => {
    const h = await harness();
    await expect(addRecipient(
      actor(OWNER), h.workspaceId, DOC, manual({ name: "Maria‮Santos" }), h.deps,
    )).rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("accepts a name outside ASCII", async () => {
    // The product's own signers. A validator that refused these would exclude
    // a large share of them.
    const h = await harness();
    const recipient = await addRecipient(
      actor(OWNER), h.workspaceId, DOC, manual({ name: "Ñoño dela Cruz" }), h.deps);
    expect(recipient.name).toBe("Ñoño dela Cruz");
  });

  it("refuses a malformed email", async () => {
    const h = await harness();
    await expect(addRecipient(
      actor(OWNER), h.workspaceId, DOC, manual({ email: "not-an-address" }), h.deps,
    )).rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("stops at the recipient ceiling", async () => {
    const h = await harness();
    for (let i = 0; i < 50; i += 1) {
      await addRecipient(
        actor(OWNER), h.workspaceId, DOC, manual({ email: `p${String(i)}@x.com` }), h.deps);
    }
    await expect(addRecipient(
      actor(OWNER), h.workspaceId, DOC, manual({ email: "one-too-many@x.com" }), h.deps,
    )).rejects.toBeInstanceOf(ApplicationValidationError);
  });
});

// ── The snapshot ─────────────────────────────────────────────────────────────

describe("a recipient is a snapshot, not a contact reference", () => {
  it("does not change when the contact is edited", async () => {
    const h = await harness();
    const recipient = await addRecipient(
      actor(OWNER), h.workspaceId, DOC,
      { source: "contact", contactId: CONTACT, type: "signer" }, h.deps);

    // The contact changes jobs. Written directly, because the point is that
    // NOTHING propagates — including a change this module never saw.
    const contact = h.store.contacts[0];
    if (contact === undefined) throw new Error("fixture");
    h.store.contacts[0] = {
      ...contact,
      name: "Maria Santos-Reyes",
      email: "maria@newfirm.ph",
      organization: "New Firm",
    };

    const [after] = await listRecipients(actor(OWNER), h.workspaceId, DOC, h.deps);
    expect(after?.name).toBe("Maria Santos");
    expect(after?.email).toBe("Maria.Santos@AyalaLand.com.ph");
    expect(after?.organization).toBe("Ayala Land");
    expect(after?.recipientId).toBe(recipient.recipientId);
  });

  it("survives the contact being deleted, losing only its provenance", async () => {
    const h = await harness();
    await addRecipient(
      actor(OWNER), h.workspaceId, DOC,
      { source: "contact", contactId: CONTACT, type: "signer" }, h.deps);

    // ON DELETE SET NULL, performed here as the database would.
    h.store.contacts = [];
    const stored = h.store.recipients[0];
    if (stored === undefined) throw new Error("fixture");
    h.store.recipients[0] = { ...stored, sourceContactId: null };

    const [after] = await listRecipients(actor(OWNER), h.workspaceId, DOC, h.deps);
    // The identity is intact. Only the pointer back is gone.
    expect(after?.name).toBe("Maria Santos");
    expect(after?.email).toBe("Maria.Santos@AyalaLand.com.ph");
    expect(after?.sourceContactId).toBeNull();
  });

  it("does not change the contact when the recipient is edited", async () => {
    const h = await harness();
    const recipient = await addRecipient(
      actor(OWNER), h.workspaceId, DOC,
      { source: "contact", contactId: CONTACT, type: "signer" }, h.deps);

    await updateRecipient(
      actor(OWNER), h.workspaceId, DOC, recipient.recipientId,
      { name: "Maria S. Santos", email: "maria.santos@ayalaland.ph" }, h.deps);

    const contact = h.store.contacts[0];
    expect(contact?.name).toBe("Maria Santos");
    expect(contact?.email).toBe("Maria.Santos@AyalaLand.com.ph");
    expect(contact?.updatedAt).toBe(AT);
  });

  it("creates no contact when a recipient is typed by hand", async () => {
    // The inverse leak: adding a participant must not quietly grow the address
    // book with everyone a sender has ever emailed.
    const h = await harness();
    await addRecipient(actor(OWNER), h.workspaceId, DOC, manual(), h.deps);
    expect(h.store.contacts).toHaveLength(1);
    expect(h.store.contacts[0]?.contactId).toBe(CONTACT);
  });
});

// ── Duplicates ───────────────────────────────────────────────────────────────

describe("one delivery address, one recipient", () => {
  it("refuses a second recipient with the same address", async () => {
    const h = await harness();
    await addRecipient(actor(OWNER), h.workspaceId, DOC, manual(), h.deps);
    await expect(addRecipient(
      actor(OWNER), h.workspaceId, DOC, manual({ name: "Someone Else" }), h.deps,
    )).rejects.toBeInstanceOf(DuplicateRecipientError);
  });

  it("compares case-insensitively", async () => {
    const h = await harness();
    await addRecipient(actor(OWNER), h.workspaceId, DOC, manual({ email: "juan@x.com" }), h.deps);
    await expect(addRecipient(
      actor(OWNER), h.workspaceId, DOC, manual({ email: "JUAN@X.COM" }), h.deps,
    )).rejects.toBeInstanceOf(DuplicateRecipientError);
  });

  it("treats a plus tag as a different address", async () => {
    // No plus-tag stripping (§22). Two mailboxes different people may read.
    const h = await harness();
    await addRecipient(actor(OWNER), h.workspaceId, DOC, manual({ email: "juan@x.com" }), h.deps);
    const second = await addRecipient(
      actor(OWNER), h.workspaceId, DOC, manual({ email: "juan+lease@x.com" }), h.deps);
    expect(second.email).toBe("juan+lease@x.com");
  });

  it("permits the same address on a different document", async () => {
    // The rule is preparation-local. One person signs many contracts.
    const h = await harness();
    await addRecipient(actor(OWNER), h.workspaceId, DOC, manual(), h.deps);
    const other = await addRecipient(actor(OWNER), h.workspaceId, OTHER_DOC, manual(), h.deps);
    expect(other.email).toBe("juan@example.com");
  });

  it("refuses an edit onto another recipient's address", async () => {
    // Otherwise the rule is bypassed by adding then renaming.
    const h = await harness();
    await addRecipient(actor(OWNER), h.workspaceId, DOC, manual({ email: "a@x.com" }), h.deps);
    const second = await addRecipient(
      actor(OWNER), h.workspaceId, DOC, manual({ email: "b@x.com" }), h.deps);

    await expect(updateRecipient(
      actor(OWNER), h.workspaceId, DOC, second.recipientId, { email: "A@X.com" }, h.deps,
    )).rejects.toBeInstanceOf(DuplicateRecipientError);
  });

  it("permits an edit that keeps the same address", async () => {
    // The duplicate check must exclude the row being edited, or correcting a
    // name would be refused for clashing with itself.
    const h = await harness();
    const recipient = await addRecipient(
      actor(OWNER), h.workspaceId, DOC, manual({ email: "a@x.com" }), h.deps);
    const updated = await updateRecipient(
      actor(OWNER), h.workspaceId, DOC, recipient.recipientId,
      { name: "Juan D. Cruz", email: "a@x.com" }, h.deps);
    expect(updated.name).toBe("Juan D. Cruz");
  });

  it("names no address in the duplicate error", async () => {
    // The one place an error would echo a participant's contact details back.
    const h = await harness();
    await addRecipient(actor(OWNER), h.workspaceId, DOC, manual(), h.deps);
    const failure = await addRecipient(actor(OWNER), h.workspaceId, DOC, manual(), h.deps)
      .catch((error: unknown) => error);
    expect(String((failure as Error).message)).not.toContain("juan@example.com");
  });
});

// ── Update ───────────────────────────────────────────────────────────────────

describe("updateRecipient", () => {
  it("clears an organization with an explicit null and leaves it alone when absent", async () => {
    const h = await harness();
    const recipient = await addRecipient(
      actor(OWNER), h.workspaceId, DOC, manual({ organization: "Cruz Holdings" }), h.deps);

    const untouched = await updateRecipient(
      actor(OWNER), h.workspaceId, DOC, recipient.recipientId, { name: "Juan C." }, h.deps);
    expect(untouched.organization).toBe("Cruz Holdings");

    const cleared = await updateRecipient(
      actor(OWNER), h.workspaceId, DOC, recipient.recipientId, { organization: null }, h.deps);
    expect(cleared.organization).toBeNull();
  });

  it("reports a recipient of another document as absent", async () => {
    const h = await harness();
    const mine = await addRecipient(actor(OWNER), h.workspaceId, OTHER_DOC, manual(), h.deps);
    // A real id, in the same workspace, reached through the wrong document.
    await expect(updateRecipient(
      actor(OWNER), h.workspaceId, DOC, mine.recipientId, { name: "Nope" }, h.deps,
    )).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("does not accept a routing order below 1", async () => {
    const h = await harness();
    const recipient = await addRecipient(actor(OWNER), h.workspaceId, DOC, manual(), h.deps);
    await expect(updateRecipient(
      actor(OWNER), h.workspaceId, DOC, recipient.recipientId, { routingOrder: 0 }, h.deps,
    )).rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("allows two recipients to share a routing order", async () => {
    // Equal values mean parallel within a step (§38). Not a conflict.
    const h = await harness();
    const a = await addRecipient(actor(OWNER), h.workspaceId, DOC, manual({ email: "a@x.com" }), h.deps);
    const b = await addRecipient(actor(OWNER), h.workspaceId, DOC, manual({ email: "b@x.com" }), h.deps);
    await updateRecipient(actor(OWNER), h.workspaceId, DOC, a.recipientId, { routingOrder: 2 }, h.deps);
    const second = await updateRecipient(
      actor(OWNER), h.workspaceId, DOC, b.recipientId, { routingOrder: 2 }, h.deps);
    expect(second.routingOrder).toBe(2);
  });
});

// ── Field assignment ─────────────────────────────────────────────────────────

describe("field assignment", () => {
  const signatureField = (recipientId: string | null) => ({
    type: "signature" as const,
    pageNumber: 1,
    rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
    required: true,
    label: "Signature",
    layer: 0,
    recipientId,
  });

  it("accepts a recipient of this preparation", async () => {
    const h = await harness();
    const recipient = await addRecipient(actor(OWNER), h.workspaceId, DOC, manual(), h.deps);
    const view = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC,
      { expectedRevision: 1, fields: [signatureField(recipient.recipientId)] }, h.prep);
    expect(view.fields[0]?.recipientId).toBe(recipient.recipientId);
  });

  it("refuses a recipient of another document", async () => {
    // The check that tenant isolation cannot make: both rows are in ONE
    // workspace, and only the parent predicate separates them (§122).
    const h = await harness();
    await addRecipient(actor(OWNER), h.workspaceId, DOC, manual({ email: "a@x.com" }), h.deps);
    const elsewhere = await addRecipient(
      actor(OWNER), h.workspaceId, OTHER_DOC, manual({ email: "b@x.com" }), h.deps);

    await expect(saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC,
      { expectedRevision: 1, fields: [signatureField(elsewhere.recipientId)] }, h.prep,
    )).rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("refuses a viewer", async () => {
    const h = await harness();
    const viewer = await addRecipient(
      actor(OWNER), h.workspaceId, DOC, manual({ type: "viewer" }), h.deps);
    await expect(saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC,
      { expectedRevision: 1, fields: [signatureField(viewer.recipientId)] }, h.prep,
    )).rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("refuses a carbon-copy recipient", async () => {
    const h = await harness();
    const cc = await addRecipient(
      actor(OWNER), h.workspaceId, DOC, manual({ type: "carbon-copy" }), h.deps);
    await expect(saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC,
      { expectedRevision: 1, fields: [signatureField(cc.recipientId)] }, h.prep,
    )).rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("accepts an approver", async () => {
    const h = await harness();
    const approver = await addRecipient(
      actor(OWNER), h.workspaceId, DOC, manual({ type: "approver" }), h.deps);
    const view = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC,
      { expectedRevision: 1, fields: [signatureField(approver.recipientId)] }, h.prep);
    expect(view.fields[0]?.recipientId).toBe(approver.recipientId);
  });
});

// ── Delete ───────────────────────────────────────────────────────────────────

describe("removeRecipient", () => {
  it("removes an unassigned recipient", async () => {
    const h = await harness();
    const recipient = await addRecipient(actor(OWNER), h.workspaceId, DOC, manual(), h.deps);
    await removeRecipient(actor(OWNER), h.workspaceId, DOC, recipient.recipientId, h.deps);
    expect(await listRecipients(actor(OWNER), h.workspaceId, DOC, h.deps)).toHaveLength(0);
  });

  it("refuses while fields are assigned, and keeps them", async () => {
    const h = await harness();
    const recipient = await addRecipient(actor(OWNER), h.workspaceId, DOC, manual(), h.deps);
    await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, {
        expectedRevision: 1,
        fields: [{
          type: "signature", pageNumber: 1,
          rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
          required: true, label: "Signature", layer: 0,
          recipientId: recipient.recipientId,
        }],
      }, h.prep);

    const failure = await removeRecipient(
      actor(OWNER), h.workspaceId, DOC, recipient.recipientId, h.deps,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RecipientHasFieldsError);
    expect((failure as RecipientHasFieldsError).assignedFields).toBe(1);
    // The placed work is untouched — no silent cascade.
    expect(h.store.preparationFields).toHaveLength(1);
  });

  it("refuses demoting an assigned recipient to a viewer", async () => {
    const h = await harness();
    const recipient = await addRecipient(actor(OWNER), h.workspaceId, DOC, manual(), h.deps);
    await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, {
        expectedRevision: 1,
        fields: [{
          type: "signature", pageNumber: 1,
          rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
          required: true, label: "Signature", layer: 0,
          recipientId: recipient.recipientId,
        }],
      }, h.prep);

    await expect(updateRecipient(
      actor(OWNER), h.workspaceId, DOC, recipient.recipientId, { type: "viewer" }, h.deps,
    )).rejects.toBeInstanceOf(RecipientHasFieldsError);
  });

  it("renumbers the remaining recipients densely", async () => {
    const h = await harness();
    const ids: string[] = [];
    for (const email of ["a@x.com", "b@x.com", "c@x.com"]) {
      ids.push((await addRecipient(
        actor(OWNER), h.workspaceId, DOC, manual({ email }), h.deps)).recipientId);
    }
    await removeRecipient(actor(OWNER), h.workspaceId, DOC, ids[1] as string, h.deps);

    const remaining = await listRecipients(actor(OWNER), h.workspaceId, DOC, h.deps);
    expect(remaining.map(r => r.orderIndex)).toEqual([0, 1]);
    expect(remaining.map(r => r.email)).toEqual(["a@x.com", "c@x.com"]);
  });
});

// ── Reorder ──────────────────────────────────────────────────────────────────

describe("reorderRecipients", () => {
  const three = async (h: Harness): Promise<string[]> => {
    const ids: string[] = [];
    for (const email of ["a@x.com", "b@x.com", "c@x.com"]) {
      ids.push((await addRecipient(
        actor(OWNER), h.workspaceId, DOC, manual({ email }), h.deps)).recipientId);
    }
    return ids;
  };

  it("applies the given order", async () => {
    const h = await harness();
    const [a, b, c] = await three(h);
    const ordered = await reorderRecipients(
      actor(OWNER), h.workspaceId, DOC, [c as string, a as string, b as string], h.deps);
    expect(ordered.map(r => r.email)).toEqual(["c@x.com", "a@x.com", "b@x.com"]);
    expect(ordered.map(r => r.orderIndex)).toEqual([0, 1, 2]);
  });

  it("refuses a partial list", async () => {
    const h = await harness();
    const [a] = await three(h);
    await expect(reorderRecipients(
      actor(OWNER), h.workspaceId, DOC, [a as string], h.deps,
    )).rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("refuses a repeated id", async () => {
    const h = await harness();
    const [a, b] = await three(h);
    await expect(reorderRecipients(
      actor(OWNER), h.workspaceId, DOC, [a as string, a as string, b as string], h.deps,
    )).rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("refuses an id from another document", async () => {
    const h = await harness();
    const [a, b, c] = await three(h);
    const elsewhere = await addRecipient(
      actor(OWNER), h.workspaceId, OTHER_DOC, manual({ email: "z@x.com" }), h.deps);
    await expect(reorderRecipients(
      actor(OWNER), h.workspaceId, DOC,
      [a as string, b as string, c as string, elsewhere.recipientId], h.deps,
    )).rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("leaves routing order alone", async () => {
    // Reordering a list for readability must not rewrite the signing sequence.
    const h = await harness();
    const [a, b, c] = await three(h);
    await updateRecipient(actor(OWNER), h.workspaceId, DOC, a as string, { routingOrder: 3 }, h.deps);
    const ordered = await reorderRecipients(
      actor(OWNER), h.workspaceId, DOC, [c as string, a as string, b as string], h.deps);
    expect(ordered.find(r => r.recipientId === a)?.routingOrder).toBe(3);
  });
});

// ── Authorization and tenancy ────────────────────────────────────────────────

describe("authorization", () => {
  it("refuses an auditor", async () => {
    // A hidden 404, not a 403 - the backend's standing answer for a capability
    // the caller lacks. "This is not yours" and "you may not do that here" are
    // deliberately one response.
    const h = await harness();
    await expect(addRecipient(
      actor(AUDITOR), h.workspaceId, DOC, manual(), h.deps,
    )).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("lets an auditor read", async () => {
    const h = await harness();
    await addRecipient(actor(OWNER), h.workspaceId, DOC, manual(), h.deps);
    expect(await listRecipients(actor(AUDITOR), h.workspaceId, DOC, h.deps)).toHaveLength(1);
  });

  it("reports a non-member's workspace as absent", async () => {
    const h = await harness();
    await expect(listRecipients(
      actor("usr_stranger" as UserId), h.workspaceId, DOC, h.deps,
    )).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("creates nothing when authorization fails", async () => {
    const h = await harness();
    await addRecipient(actor(OWNER), h.workspaceId, DOC, manual(), h.deps);
    const before = h.store.recipients.length;
    await expect(addRecipient(
      actor(AUDITOR), h.workspaceId, DOC, manual({ email: "z@x.com" }), h.deps,
    )).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(h.store.recipients).toHaveLength(before);
  });
});

// ── Read ─────────────────────────────────────────────────────────────────────

describe("listRecipients", () => {
  it("returns an empty list for a never-prepared document, and writes nothing", async () => {
    const h = await harness();
    expect(await listRecipients(actor(OWNER), h.workspaceId, DOC, h.deps)).toEqual([]);
    // A read that wrote would leave a preparation behind every opened document.
    expect(h.store.preparations).toHaveLength(0);
  });

  it("reports an unknown document as absent rather than empty", async () => {
    const h = await harness();
    await expect(listRecipients(
      actor(OWNER), h.workspaceId, "doc_nope" as DocumentId, h.deps,
    )).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("exposes no comparison key, no account link and no ceremony state", async () => {
    const h = await harness();
    await addRecipient(actor(OWNER), h.workspaceId, DOC, manual(), h.deps);
    const [recipient] = await listRecipients(actor(OWNER), h.workspaceId, DOC, h.deps);
    const serialized = JSON.stringify(recipient);

    for (const absent of [
      // Internal. A client that had it would compare it to a user's address.
      "emailKey", "normalizedEmail",
      // An identity claim LAGDA has not made and cannot support.
      "userId", "isRegisteredUser", "emailVerified", "verifiedAt",
      "accessToken", "authenticatedAt",
      // Ceremony state that does not exist.
      "signedAt", "viewedAt", "declinedAt", "emailSentAt",
      // Tenancy is the URL, not a field to read off a record.
      "workspaceId", "preparationId",
    ]) {
      expect(serialized, `exposes ${absent}`).not.toContain(absent);
    }
  });
});
