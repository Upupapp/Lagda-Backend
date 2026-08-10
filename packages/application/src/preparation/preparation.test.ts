// Preparation use cases, tested with fakes.
//
// The claims that carry weight: a layout save never touches the original
// artifact, a stale tab cannot erase another's work, and a rotated document is
// refused rather than silently misplaced.

import { describe, it, expect } from "vitest";
import type {
  DocumentId, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import {
  getDocumentPreparation, saveDocumentPreparation,
  PreparationRevisionConflictError, RotatedDocumentError, DocumentNotReadyError,
  type PreparationDependencies, type FieldInput,
} from "./preparation.js";
import { CreateWorkspace } from "../workspaces/create-workspace.js";
import {
  ApplicationValidationError, ResourceNotFoundError,
} from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import type { ArtifactId } from "../common/ports/index.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialPreparationIds, FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

const AT = Date.parse("2026-08-10T14:00:00.000Z");
const OWNER = "usr_owner" as UserId;
const SENDER = "usr_sender" as UserId;
const REVIEWER = "usr_reviewer" as UserId;
const AUDITOR = "usr_auditor" as UserId;
const MEMBER = "usr_member" as UserId;
const DOC = "doc_1" as DocumentId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

interface Harness {
  readonly store: InMemoryStore;
  readonly transactions: FakeTransactionManager;
  readonly deps: PreparationDependencies;
  readonly workspaceId: WorkspaceId;
}

const DIGEST = "b".repeat(64);

async function harness(
  over: { pageCount?: number; rotatedPageCount?: number | undefined; withSource?: boolean } = {},
): Promise<Harness> {
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

  for (const [key, userId, role] of [
    ["sender", SENDER, "sender"],
    ["reviewer", REVIEWER, "reviewer"],
    ["auditor", AUDITOR, "auditor"],
    ["member", MEMBER, "member"],
  ] as const) {
    store.memberships.push({
      memberId: `mem_${key}` as WorkspaceMemberId,
      workspaceId: created.workspaceId,
      userId, role, createdAt: AT + 1000,
    });
  }

  store.documents.push({
    documentId: DOC,
    workspaceId: created.workspaceId,
    title: "Office Lease",
    originalFilename: "lease.pdf",
    createdByUserId: OWNER,
    createdAt: AT,
    updatedAt: AT,
  });

  if (over.withSource !== false) {
    store.artifacts.push({
      artifactId: "art_original" as ArtifactId,
      workspaceId: created.workspaceId,
      documentId: DOC,
      artifactType: "original",
      storageReference: "ws/doc/art" as never,
      mediaType: "application/pdf",
      sizeBytes: 204_800,
      digestAlgorithm: "sha-256",
      digest: DIGEST as never,
      pageCount: over.pageCount ?? 5,
      ...("rotatedPageCount" in over
        ? (over.rotatedPageCount === undefined ? {} : { rotatedPageCount: over.rotatedPageCount })
        : { rotatedPageCount: 0 }),
      createdAt: AT + 2000,
    });
  }

  return {
    store, transactions, workspaceId: created.workspaceId,
    deps: { transactions, clock, ids: new SequentialPreparationIds() },
  };
}

const field = (over: Partial<FieldInput> = {}): FieldInput => ({
  type: "signature",
  pageNumber: 1,
  rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
  required: true,
  label: "Landlord signature",
  layer: 0,
  ...over,
});

// ── Identity and the original ────────────────────────────────────────────────

describe("preparation never touches the original artifact", () => {
  it("a layout save changes no artifact at all", async () => {
    const h = await harness();
    const before = JSON.stringify(h.store.artifacts);

    await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC,
      { expectedRevision: 0, fields: [field(), field({ pageNumber: 3 })] }, h.deps);

    // The whole artifact array, byte for byte. No new artifact, no changed
    // digest, no changed storage reference.
    expect(JSON.stringify(h.store.artifacts)).toBe(before);
    expect(h.store.artifacts).toHaveLength(1);
  });

  it("targets the EXACT source artifact", async () => {
    const h = await harness();
    await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, { expectedRevision: 0, fields: [field()] }, h.deps);

    expect(h.store.preparations[0]?.sourceArtifactId).toBe("art_original");
  });

  it("creates no prepared artifact — the model is metadata-only", async () => {
    const h = await harness();
    await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, { expectedRevision: 0, fields: [field()] }, h.deps);
    expect(h.store.artifacts.map(a => a.artifactType)).toEqual(["original"]);
  });

  it("never exposes the source artifact or a storage reference", async () => {
    const h = await harness();
    const view = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, { expectedRevision: 0, fields: [field()] }, h.deps);
    const serialized = JSON.stringify(view);
    for (const leaked of ["artifactId", "art_original", "storageReference", DIGEST]) {
      expect(serialized, `leaked ${leaked}`).not.toContain(leaked);
    }
  });
});

// ── Reading ──────────────────────────────────────────────────────────────────

describe("getDocumentPreparation", () => {
  it("returns an empty layout at revision 0 before anything is saved", async () => {
    const h = await harness();
    const view = await getDocumentPreparation(actor(OWNER), h.workspaceId, DOC, h.deps);

    expect(view).toMatchObject({
      revision: 0, state: "editable", fields: [], pageCount: 5,
    });
    // And no row was created just because someone looked.
    expect(h.store.preparations).toHaveLength(0);
  });

  it("REFUSES a document with no uploaded bytes", async () => {
    const h = await harness({ withSource: false });
    await expect(getDocumentPreparation(actor(OWNER), h.workspaceId, DOC, h.deps))
      .rejects.toBeInstanceOf(DocumentNotReadyError);
  });

  it("REFUSES a rotated document", async () => {
    const h = await harness({ rotatedPageCount: 2 });
    await expect(getDocumentPreparation(actor(OWNER), h.workspaceId, DOC, h.deps))
      .rejects.toBeInstanceOf(RotatedDocumentError);
  });

  it("REFUSES an artifact whose rotation was never inspected", async () => {
    // Unknown is not assumed-unrotated.
    const h = await harness({ rotatedPageCount: undefined });
    await expect(getDocumentPreparation(actor(OWNER), h.workspaceId, DOC, h.deps))
      .rejects.toBeInstanceOf(RotatedDocumentError);
  });

  it("REFUSES an unknown document with the hidden 404", async () => {
    const h = await harness();
    await expect(getDocumentPreparation(
      actor(OWNER), h.workspaceId, "doc_nope" as DocumentId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// ── Saving ───────────────────────────────────────────────────────────────────

describe("saveDocumentPreparation", () => {
  it("creates the preparation lazily on first save", async () => {
    const h = await harness();
    const view = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, { expectedRevision: 0, fields: [field()] }, h.deps);

    expect(h.store.preparations).toHaveLength(1);
    expect(view.revision).toBe(2);
    expect(view.fields).toHaveLength(1);
  });

  it("assigns opaque server-generated field ids", async () => {
    const h = await harness();
    const view = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC,
      { expectedRevision: 0, fields: [field(), field({ pageNumber: 2 })] }, h.deps);

    const ids = view.fields.map(f => f.fieldId);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^pf_/);
  });

  it("PRESERVES a field id across a move", async () => {
    const h = await harness();
    const first = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, { expectedRevision: 0, fields: [field()] }, h.deps);
    const fieldId = first.fields[0]?.fieldId;
    if (fieldId === undefined) throw new Error("fixture");

    const moved = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, {
        expectedRevision: first.revision,
        fields: [field({ fieldId, rect: { x: 0.5, y: 0.5, width: 0.2, height: 0.05 } })],
      }, h.deps);

    // Same identity, new geometry (§29).
    expect(moved.fields[0]?.fieldId).toBe(fieldId);
    expect(moved.fields[0]?.rect.x).toBe(0.5);
  });

  it("REJECTS a field id that is not already ours", async () => {
    // Adopting an unknown id would let a caller choose row identifiers.
    const h = await harness();
    const failure = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC,
      { expectedRevision: 0, fields: [field({ fieldId: "pf_someone_elses" })] }, h.deps)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplicationValidationError);
    expect((failure as ApplicationValidationError).issues)
      .toContain("fields[0].fieldId: unknown");
  });

  it("clears the layout when given an empty array", async () => {
    const h = await harness();
    const first = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, { expectedRevision: 0, fields: [field()] }, h.deps);

    const cleared = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC,
      { expectedRevision: first.revision, fields: [] }, h.deps);
    expect(cleared.fields).toEqual([]);
  });

  it("forces a signature field to be required", async () => {
    const h = await harness();
    const view = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC,
      { expectedRevision: 0, fields: [field({ type: "signature", required: false })] },
      h.deps);
    expect(view.fields[0]?.required).toBe(true);
  });

  it("honours the required flag for a text field", async () => {
    const h = await harness();
    const view = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC,
      { expectedRevision: 0, fields: [field({ type: "text", required: false })] }, h.deps);
    expect(view.fields[0]?.required).toBe(false);
  });

  it("rounds coordinates once, deterministically", async () => {
    const h = await harness();
    const view = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, {
        expectedRevision: 0,
        fields: [field({ rect: { x: 0.31415926535, y: 0.2, width: 0.3, height: 0.05 } })],
      }, h.deps);
    expect(view.fields[0]?.rect.x).toBe(0.314159);
  });

  it("returns fields in deterministic order: page, layer, id", async () => {
    const h = await harness();
    const view = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, {
        expectedRevision: 0,
        fields: [
          field({ pageNumber: 3, layer: 0, label: "c" }),
          field({ pageNumber: 1, layer: 5, label: "b" }),
          field({ pageNumber: 1, layer: 0, label: "a" }),
        ],
      }, h.deps);
    expect(view.fields.map(f => f.label)).toEqual(["a", "b", "c"]);
  });

  it("stores the participant slot, or null when unassigned", async () => {
    const h = await harness();
    const view = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, {
        expectedRevision: 0,
        fields: [
          field({ participantSlot: "P1", label: "a", layer: 0 }),
          field({ label: "b", layer: 1 }),
        ],
      }, h.deps);
    // Unassigned fields are permitted while a layout is being built (§114).
    expect(view.fields.map(f => f.participantSlot)).toEqual(["P1", null]);
  });
});

// ── Validation ───────────────────────────────────────────────────────────────

describe("layout validation", () => {
  it("reports every problem at once, naming indexes not labels", async () => {
    const h = await harness();
    const failure = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, {
        expectedRevision: 0,
        fields: [
          field({ pageNumber: 99 }),
          field({ rect: { x: 0.95, y: 0.1, width: 0.2, height: 0.1 } }),
          field({ label: "x".repeat(400) }),
        ],
      }, h.deps).catch((error: unknown) => error) as ApplicationValidationError;

    expect(failure).toBeInstanceOf(ApplicationValidationError);
    expect(failure.issues).toEqual(expect.arrayContaining([
      "fields[0].pageNumber: must be between 1 and 5",
      "fields[1].rect: out-of-bounds",
      "fields[2].label: too-long",
    ]));
    // A label names a party to the agreement, so it is never echoed.
    expect(failure.issues.join(" ")).not.toContain("Landlord");
  });

  it("writes NOTHING when any field is invalid", async () => {
    const h = await harness();
    const good = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, { expectedRevision: 0, fields: [field()] }, h.deps);

    await expect(saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, {
        expectedRevision: good.revision,
        fields: [field({ label: "kept" }), field({ pageNumber: 0 })],
      }, h.deps)).rejects.toBeInstanceOf(ApplicationValidationError);

    // The previous layout survives entirely (§247).
    const after = await getDocumentPreparation(actor(OWNER), h.workspaceId, DOC, h.deps);
    expect(after.fields).toHaveLength(1);
    expect(after.revision).toBe(good.revision);
  });

  it("REJECTS page 0 and a page past the end", async () => {
    const h = await harness({ pageCount: 3 });
    for (const pageNumber of [0, 4, -1]) {
      await expect(saveDocumentPreparation(
        actor(OWNER), h.workspaceId, DOC,
        { expectedRevision: 0, fields: [field({ pageNumber })] }, h.deps))
        .rejects.toBeInstanceOf(ApplicationValidationError);
    }
  });

  it("REJECTS zero-size and out-of-page geometry", async () => {
    const h = await harness();
    for (const rect of [
      { x: 0.1, y: 0.1, width: 0, height: 0.1 },
      { x: 0.1, y: 0.1, width: 0.1, height: 0 },
      { x: 0.98, y: 0.1, width: 0.1, height: 0.1 },
      { x: -0.1, y: 0.1, width: 0.1, height: 0.1 },
    ]) {
      await expect(saveDocumentPreparation(
        actor(OWNER), h.workspaceId, DOC,
        { expectedRevision: 0, fields: [field({ rect })] }, h.deps))
        .rejects.toBeInstanceOf(ApplicationValidationError);
    }
  });

  it("REJECTS a layout beyond the field ceiling", async () => {
    const h = await harness();
    const many = Array.from({ length: 501 }, (_, index) =>
      field({ label: `f${String(index)}` }));
    await expect(saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, { expectedRevision: 0, fields: many }, h.deps))
      .rejects.toBeInstanceOf(ApplicationValidationError);
  });

  it("REFUSES to save onto a rotated document", async () => {
    const h = await harness({ rotatedPageCount: 1 });
    await expect(saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, { expectedRevision: 0, fields: [field()] }, h.deps))
      .rejects.toBeInstanceOf(RotatedDocumentError);
    expect(h.store.preparations).toHaveLength(0);
  });
});

// ── Concurrency ──────────────────────────────────────────────────────────────

describe("concurrency", () => {
  it("REFUSES a stale revision rather than erasing newer work", async () => {
    const h = await harness();
    const first = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC,
      { expectedRevision: 0, fields: [field({ label: "tab one" })] }, h.deps);

    // A second tab saves, moving the revision on.
    await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC,
      { expectedRevision: first.revision, fields: [field({ label: "tab two" })] }, h.deps);

    // The first tab, still holding the old revision, is refused.
    await expect(saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC,
      { expectedRevision: first.revision, fields: [field({ label: "stale" })] }, h.deps))
      .rejects.toBeInstanceOf(PreparationRevisionConflictError);

    const current = await getDocumentPreparation(actor(OWNER), h.workspaceId, DOC, h.deps);
    expect(current.fields[0]?.label).toBe("tab two");
  });

  it("advances the revision on every save", async () => {
    const h = await harness();
    let revision = 0;
    for (let i = 0; i < 3; i += 1) {
      const view = await saveDocumentPreparation(
        actor(OWNER), h.workspaceId, DOC,
        { expectedRevision: revision, fields: [field()] }, h.deps);
      expect(view.revision).toBeGreaterThan(revision);
      revision = view.revision;
    }
  });

  it("REFUSES a second first-save that raced with the first", async () => {
    // Both tabs loaded a document with no preparation, so both send
    // `expectedRevision: 0`. The first creates and saves; the second finds the
    // preparation already there and its 0 no longer matches — which is right,
    // because committing it would erase fields the first tab already saved.
    const h = await harness();
    await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC,
      { expectedRevision: 0, fields: [field({ label: "first" })] }, h.deps);

    await expect(saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC,
      { expectedRevision: 0, fields: [field({ label: "second" })] }, h.deps))
      .rejects.toBeInstanceOf(PreparationRevisionConflictError);

    const current = await getDocumentPreparation(actor(OWNER), h.workspaceId, DOC, h.deps);
    expect(current.fields[0]?.label).toBe("first");
  });

  // TRUE simultaneity is asserted against PostgreSQL, not here: the fake rolls
  // back by restoring a whole-store snapshot, so a losing transaction would
  // also discard the winner's committed writes. See the integration suite.
});

// ── Authorization ────────────────────────────────────────────────────────────

describe("capability enforcement", () => {
  it("lets owner and sender save", async () => {
    for (const userId of [OWNER, SENDER]) {
      const h = await harness();
      await expect(saveDocumentPreparation(
        actor(userId), h.workspaceId, DOC, { expectedRevision: 0, fields: [field()] },
        h.deps)).resolves.toMatchObject({ revision: 2 });
    }
  });

  it("lets reviewer and auditor READ the layout but not change it", async () => {
    for (const userId of [REVIEWER, AUDITOR]) {
      const h = await harness();
      await saveDocumentPreparation(
        actor(OWNER), h.workspaceId, DOC, { expectedRevision: 0, fields: [field()] },
        h.deps);

      // Reading a layout is part of reading the document.
      await expect(getDocumentPreparation(actor(userId), h.workspaceId, DOC, h.deps))
        .resolves.toMatchObject({ state: "editable" });

      await expect(saveDocumentPreparation(
        actor(userId), h.workspaceId, DOC, { expectedRevision: 2, fields: [] }, h.deps))
        .rejects.toBeInstanceOf(ResourceNotFoundError);

      const after = await getDocumentPreparation(actor(OWNER), h.workspaceId, DOC, h.deps);
      expect(after.fields).toHaveLength(1);
    }
  });

  it("REFUSES member entirely", async () => {
    const h = await harness();
    await expect(getDocumentPreparation(actor(MEMBER), h.workspaceId, DOC, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("re-reads the actor's role INSIDE the transaction", async () => {
    const h = await harness();
    const index = h.store.memberships.findIndex(m => m.userId === SENDER);
    const existing = h.store.memberships[index];
    if (existing === undefined) throw new Error("fixture");
    h.store.memberships[index] = { ...existing, role: "auditor" };

    await expect(saveDocumentPreparation(
      actor(SENDER), h.workspaceId, DOC, { expectedRevision: 0, fields: [field()] },
      h.deps)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// ── Tenancy ──────────────────────────────────────────────────────────────────
//
// Cross-tenant isolation is asserted in the INTEGRATION suite, against real RLS
// and the runtime database role. A fake version would need two workspaces in
// one store to prove anything, and would still only be testing the fake's own
// scoping rather than the policy that protects production.

// ── Boundaries ───────────────────────────────────────────────────────────────

describe("preparation is not a signing request", () => {
  it("exposes no signing state and no submitted value", async () => {
    const h = await harness();
    const view = await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, { expectedRevision: 0, fields: [field()] }, h.deps);

    const serialized = JSON.stringify(view);
    for (const absent of [
      "sentAt", "expiresAt", "completedAt", "signedAt", "declinedAt",
      "recipientId", "signatureValue", "submittedValue",
      // `"value"` as a property name. `signature` alone is a legitimate field
      // TYPE in this response, so matching the bare word would fail on correct
      // output — the same detector-versus-intent trap BACKEND-29 recorded.
      '"value"',
    ]) {
      expect(serialized, `exposes ${absent}`).not.toContain(absent);
    }
    // The only state it has.
    expect(view.state).toBe("editable");
  });

  it("writes no signing evidence", async () => {
    const h = await harness();
    await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, { expectedRevision: 0, fields: [field()] }, h.deps);
    // Dragging a field is not an event in a signing transaction (§267).
    expect(h.store.evidence).toHaveLength(0);
  });

  it("creates no contact, invitation or membership", async () => {
    const h = await harness();
    const before = [...h.store.memberships];
    await saveDocumentPreparation(
      actor(OWNER), h.workspaceId, DOC, { expectedRevision: 0, fields: [field()] }, h.deps);
    expect(h.store.memberships).toEqual(before);
    expect(h.store.contacts).toHaveLength(0);
    expect(h.store.invitations).toHaveLength(0);
  });
});
