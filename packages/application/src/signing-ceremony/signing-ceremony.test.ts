// The signing ceremony, tested with fakes.
//
// The claims that carry weight:
//
//   a ceremony is scoped to ONE request and ONE recipient, and neither comes
//   from the caller;
//
//   configuration comes from the immutable snapshot — mutating a contact, a
//   preparation field or the document's current artifact changes nothing;
//
//   entering is not viewing, viewing is not consenting, consenting is not
//   signing, and none of them advances routing;
//
//   consent is versioned, backend-timed, and converges under retry.

import { describe, it, expect } from "vitest";
import type { DocumentId, UserId, WorkspaceId } from "@lagda/contracts";
import { bootstrapSigningAccess, type SigningAccessDependencies } from "../signing-access/signing-access.js";
import {
  enterSigningCeremony, getSigningCeremony, getRecipientSigningDocument,
  acceptSigningConsent,
  SigningCeremonyUnavailableError, SigningDocumentUnavailableError,
  SigningConsentVersionMismatchError, SigningConsentNotRequiredError,
  type SigningCeremonyDependencies,
} from "./signing-ceremony.js";
import { RecipientSessionInvalidError } from "../signing-access/signing-access.js";
import type {
  ArtifactId, SigningRequestId, SigningRequestRecipientId, SigningRequestFieldId,
  SigningAccessGrantId, SigningAccessDigest,
  RecipientSessionDigest, RecipientCsrfDigest, SigningConsentId,
} from "../common/ports/index.js";
import type { Sha256Digest } from "@lagda/contracts";
import type {
  ObjectStorage, StorageObjectKey,
} from "../common/ports/storage.js";
import {
  FixedClock, SequentialRecipientSessionIds,
  FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";

const AT = Date.parse("2026-08-10T14:00:00.000Z");
const WS = "ws_1" as WorkspaceId;
const REQUEST = "sr_1" as SigningRequestId;
const OTHER_REQUEST = "sr_2" as SigningRequestId;
const RECIPIENT = "srr_1" as SigningRequestRecipientId;
const OTHER_RECIPIENT = "srr_2" as SigningRequestRecipientId;
const ARTIFACT = "art_1" as ArtifactId;
const CONSENT_VERSION = "v0-demonstration";

const RAW = "boot".padEnd(43, "x");
const OTHER_RAW = "othr".padEnd(43, "y");

const DIGEST_OF = (raw: string) =>
  raw.slice(0, 4).charCodeAt(0).toString(16).padStart(64, "b") as SigningAccessDigest;

function bootstrapTokens() {
  return {
    issue: () => ({ raw: RAW, digest: "b".repeat(64) as SigningAccessDigest }),
    digest: (submitted: string) =>
      /^[A-Za-z0-9_-]{43}$/.test(submitted) ? DIGEST_OF(submitted) : null,
  };
}

function sessionTokens() {
  let issued = 0;
  const of = (kind: string, raw: string) => `${kind}${raw.slice(0, 6)}`.padStart(64, "c");
  return {
    issue: () => {
      issued += 1;
      const rawToken = `sess${String(issued)}`.padEnd(43, "s");
      const rawCsrfToken = `csrf${String(issued)}`.padEnd(43, "r");
      return {
        rawToken,
        tokenDigest: of("t", rawToken) as RecipientSessionDigest,
        rawCsrfToken,
        csrfDigest: of("x", rawCsrfToken) as RecipientCsrfDigest,
      };
    },
    digestToken: (submitted: string) =>
      submitted.length === 43 ? (of("t", submitted) as RecipientSessionDigest) : null,
    digestCsrf: (submitted: string) =>
      submitted.length === 43 ? (of("x", submitted) as RecipientCsrfDigest) : null,
  };
}

/** Records what was asked of storage, so "exact artifact" is checkable. */
class RecordingStorage implements ObjectStorage {
  readonly requested: string[] = [];
  present = true;
  putObject = () => Promise.reject(new Error("not used"));
  headObject = () => Promise.resolve(null);
  deleteObject = () => Promise.resolve();
  getObject = (ref: { readonly key: string }) => {
    this.requested.push(ref.key);
    if (!this.present) return Promise.resolve(null);
    return Promise.resolve({
      ref: ref as never,
      sizeBytes: 12,
      mediaType: "application/pdf",
      stream: (async function* () {
        await Promise.resolve();
        yield new Uint8Array([37, 80, 68, 70]);
      })(),
    });
  };
}

interface Harness {
  readonly store: InMemoryStore;
  readonly accessDeps: SigningAccessDependencies;
  readonly deps: SigningCeremonyDependencies;
  readonly storage: RecordingStorage;
}

function harness(consentVersion = CONSENT_VERSION): Harness {
  const store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);
  const clock = new FixedClock(AT);
  const tokens = sessionTokens();
  const storage = new RecordingStorage();
  let consentSeq = 0;

  return {
    store, storage,
    accessDeps: {
      transactions, clock,
      bootstrapTokens: bootstrapTokens(),
      sessionTokens: tokens,
      ids: new SequentialRecipientSessionIds(),
      policy: { sessionLifetimeMs: 8 * 3_600_000 },
    },
    deps: {
      transactions, clock,
      sessionTokens: tokens,
      consentIds: {
        nextSigningConsentId: () => {
          consentSeq += 1;
          return `con_${String(consentSeq)}` as SigningConsentId;
        },
      },
      storage,
      policy: { consentVersion },
    },
  };
}

function seed(
  h: Harness,
  over: {
    raw?: string;
    signingRequestId?: SigningRequestId;
    recipientId?: SigningRequestRecipientId;
    state?: "draft" | "sent" | "cancelled" | "completed";
    activation?: "active" | "waiting" | "none";
    type?: "signer" | "viewer";
    sourceArtifactId?: ArtifactId;
    withArtifact?: boolean;
    fields?: readonly { id: string; page: number; y: number; x: number }[];
  } = {},
): void {
  const signingRequestId = over.signingRequestId ?? REQUEST;
  const recipientId = over.recipientId ?? RECIPIENT;

  h.store.signingRequests.push({
    signingRequestId, workspaceId: WS,
    documentId: "doc_1" as DocumentId,
    sourceArtifactId: over.sourceArtifactId ?? ARTIFACT,
    sourcePreparationId: "prep_1" as never,
    sourcePreparationRevision: 2,
    state: over.state ?? "sent",
    completionReadyAt: null, terminatedAt: null,
    completedAt: null,
    terminationReason: null, cancellationNote: null,
    documentTitle: "Office Lease",
    createdByUserId: "usr_owner" as UserId,
    createdAt: AT, updatedAt: AT,
  });
  h.store.signingRequestRecipients.push({
    recipientId, sourcePreparationRecipientId: null,
    name: "Maria Santos", email: "maria.santos@ayalaland.com.ph",
    normalizedEmail: "maria.santos@ayalaland.com.ph",
    organization: null, type: over.type ?? "signer", isRequired: true,
    orderIndex: 0, routingOrder: 1,
  });
  h.store.snapshotOwners.set(String(recipientId), signingRequestId);

  const activation = over.activation ?? "active";
  if (activation !== "none") {
    h.store.activations.push({
      recipientId, state: activation,
      activatedAt: activation === "active" ? AT : null,
      signingRequestId: String(signingRequestId),
      signedAt: null, submissionId: null,
      declinedAt: null, declineReason: null,
    });
  }
  h.store.signingAccessGrants.push({
    grantId: `sag_${String(h.store.signingAccessGrants.length + 1)}` as SigningAccessGrantId,
    workspaceId: WS, signingRequestId, recipientId,
    credentialDigest: DIGEST_OF(over.raw ?? RAW),
    createdAt: AT, expiresAt: AT + 14 * 24 * 3_600_000,
  });

  if (over.withArtifact !== false) {
    h.store.artifacts.push({
      artifactId: over.sourceArtifactId ?? ARTIFACT,
      workspaceId: WS, documentId: "doc_1" as DocumentId,
      artifactType: "original",
      storageReference: "artifacts/ws_1/art_1.pdf" as StorageObjectKey,
      mediaType: "application/pdf", sizeBytes: 12,
      digestAlgorithm: "sha-256", digest: "a".repeat(64) as Sha256Digest,
      pageCount: 4, rotatedPageCount: 0, createdAt: AT,
    });
  }

  for (const f of over.fields ?? [{ id: "srf_1", page: 1, y: 0.8, x: 0.1 }]) {
    h.store.signingRequestFields.push({
      fieldId: f.id as SigningRequestFieldId,
      sourcePreparationFieldId: null,
      type: "signature", pageNumber: f.page,
      x: f.x, y: f.y, width: 0.3, height: 0.06,
      required: true, label: "Signature", layer: 1,
      recipientId,
    });
    h.store.snapshotOwners.set(f.id, signingRequestId);
  }
}

/** Bootstraps and returns the raw session cookie value. */
async function session(h: Harness, raw = RAW): Promise<string> {
  const result = await bootstrapSigningAccess(raw, h.accessDeps);
  return result.credentials.rawSessionToken;
}

/**
 * A session that has also accepted the disclosure.
 *
 * A signer sees NEITHER the document NOR their fields until they consent -
 * that is the product's own step order and it is asserted directly under
 * "consent". Every test about what a signer can see once past that gate needs
 * to actually get past it.
 */
async function consented(h: Harness, raw = RAW): Promise<string> {
  const token = await session(h, raw);
  await acceptSigningConsent(token, { consentVersion: CONSENT_VERSION }, h.deps);
  return token;
}

// ── Access ───────────────────────────────────────────────────────────────────

describe("ceremony access", () => {
  it("a valid recipient session enters", async () => {
    const h = harness();
    seed(h);
    const view = await enterSigningCeremony(await session(h), h.deps);
    expect(view.request.signingRequestId).toBe(REQUEST);
    expect(view.recipient.recipientId).toBe(RECIPIENT);
    expect(view.access.mayEnter).toBe(true);
    expect(view.firstEnteredAt).toBe(AT);
  });

  it("refuses an unknown session cookie", async () => {
    const h = harness();
    seed(h);
    await expect(getSigningCeremony("nope".padEnd(43, "z"), h.deps))
      .rejects.toBeInstanceOf(RecipientSessionInvalidError);
  });

  it("refuses a malformed session cookie", async () => {
    const h = harness();
    seed(h);
    await expect(getSigningCeremony("short", h.deps))
      .rejects.toBeInstanceOf(RecipientSessionInvalidError);
  });

  it("refuses a request that is not sent", async () => {
    for (const state of ["draft", "cancelled", "completed"] as const) {
      const h = harness();
      seed(h, { state });
      const raw = await sessionForNonSignable(h, state);
      await expect(getSigningCeremony(raw, h.deps))
        .rejects.toBeInstanceOf(SigningCeremonyUnavailableError);
    }
  });

  it("refuses a recipient whose turn has not come", async () => {
    const h = harness();
    seed(h, { activation: "waiting" });
    // A waiting recipient should never have received a link, but BACKEND-33
    // not delivering one is not the same as the ceremony refusing entry.
    const raw = await sessionForNonSignable(h, "waiting");
    await expect(getSigningCeremony(raw, h.deps))
      .rejects.toBeInstanceOf(SigningCeremonyUnavailableError);
  });

  it("refuses when no activation row exists at all", async () => {
    const h = harness();
    seed(h, { activation: "none" });
    const raw = await sessionForNonSignable(h, "none");
    await expect(getSigningCeremony(raw, h.deps))
      .rejects.toBeInstanceOf(SigningCeremonyUnavailableError);
  });

  it("a session for one request cannot reach another", async () => {
    const h = harness();
    seed(h);
    seed(h, {
      raw: OTHER_RAW, signingRequestId: OTHER_REQUEST,
      recipientId: OTHER_RECIPIENT, fields: [{ id: "srf_9", page: 1, y: 0.5, x: 0.5 }],
    });

    const view = await getSigningCeremony(await consented(h, OTHER_RAW), h.deps);
    expect(view.request.signingRequestId).toBe(OTHER_REQUEST);
    expect(view.recipient.recipientId).toBe(OTHER_RECIPIENT);
    expect(view.fields.map(f => f.fieldId)).toEqual(["srf_9"]);
  });

  it("refuses a revoked session", async () => {
    const h = harness();
    seed(h);
    const raw = await session(h);
    const stored = h.store.recipientSessions[0];
    if (stored === undefined) throw new Error("no session");
    h.store.recipientSessions[0] = { ...stored, expiresAt: AT - 1 };
    await expect(getSigningCeremony(raw, h.deps))
      .rejects.toBeInstanceOf(RecipientSessionInvalidError);
  });
});

/**
 * A session for a request that is not currently enterable.
 *
 * Bootstrap itself refuses those, which is correct and also means the obvious
 * setup cannot produce the fixture. So the session is minted against a healthy
 * request and the state is broken afterwards — which is exactly the real
 * scenario worth testing: a session that outlived its request's signability.
 */
async function sessionForNonSignable(h: Harness, mutation: string): Promise<string> {
  const request = h.store.signingRequests[0];
  const activation = h.store.activations[0];
  if (request === undefined) throw new Error("no request");
  h.store.signingRequests[0] = { ...request, state: "sent" };
  if (activation !== undefined) h.store.activations[0] = { ...activation, state: "active" };
  else {
    h.store.activations.push({
      recipientId: RECIPIENT, state: "active", activatedAt: AT,
      signingRequestId: String(REQUEST),
      signedAt: null, submissionId: null,
      declinedAt: null, declineReason: null,
    });
  }

  const raw = await session(h);

  // Now put it back into the state under test.
  const seeded = h.store.signingRequests[0];
  if (seeded === undefined) throw new Error("no request");
  if (mutation === "waiting" || mutation === "none") {
    h.store.activations.length = 0;
    if (mutation === "waiting") {
      h.store.activations.push({
        recipientId: RECIPIENT, state: "waiting", activatedAt: null,
        signingRequestId: String(REQUEST),
        signedAt: null, submissionId: null,
        declinedAt: null, declineReason: null,
      });
    }
  } else {
    h.store.signingRequests[0] = { ...seeded, state: mutation as "draft" };
  }
  return raw;
}

// ── Snapshot independence ────────────────────────────────────────────────────

describe("snapshot independence", () => {
  it("a contact change after send cannot reach the ceremony", async () => {
    const h = harness();
    seed(h);
    const raw = await session(h);

    // Mutating and deleting every contact must be invisible: nothing in the
    // ceremony path reads the table, and the repository has no method for it.
    h.store.contacts.length = 0;

    const view = await getSigningCeremony(raw, h.deps);
    expect(view.recipient.name).toBe("Maria Santos");
    expect(view.recipient.email).toBe("maria.santos@ayalaland.com.ph");
  });

  it("preparation field changes after creation cannot reach the ceremony", async () => {
    const h = harness();
    seed(h);
    const raw = await consented(h);

    h.store.preparationFields.length = 0;
    h.store.preparations.length = 0;

    const view = await getSigningCeremony(raw, h.deps);
    expect(view.fields).toHaveLength(1);
    expect(view.fields[0]?.y).toBe(0.8);
  });

  it("a newer document artifact cannot change the ceremony's document", async () => {
    const h = harness();
    seed(h);
    const raw = await consented(h);

    // The document gains a newer artifact. The request froze `art_1`.
    h.store.artifacts.push({
      artifactId: "art_2" as ArtifactId,
      workspaceId: WS, documentId: "doc_1" as DocumentId,
      artifactType: "original",
      storageReference: "artifacts/ws_1/art_2.pdf" as StorageObjectKey,
      mediaType: "application/pdf", sizeBytes: 999,
      digestAlgorithm: "sha-256", digest: "f".repeat(64) as Sha256Digest,
      pageCount: 40, rotatedPageCount: 0, createdAt: AT + 1,
    });

    const view = await getSigningCeremony(raw, h.deps);
    expect(view.document?.sizeBytes).toBe(12);
    expect(view.document?.pageCount).toBe(4);

    await getRecipientSigningDocument(raw, h.deps);
    expect(h.storage.requested).toEqual(["artifacts/ws_1/art_1.pdf"]);
  });
});

// ── Fields ───────────────────────────────────────────────────────────────────

describe("fields", () => {
  it("returns only fields assigned to this recipient", async () => {
    const h = harness();
    seed(h);
    // Another recipient of the SAME request, with their own field.
    h.store.signingRequestRecipients.push({
      recipientId: OTHER_RECIPIENT, sourcePreparationRecipientId: null,
      name: "Juan Dela Cruz", email: "juan@example.ph",
      normalizedEmail: "juan@example.ph", organization: null,
      type: "signer", isRequired: true, orderIndex: 1, routingOrder: 2,
    });
    h.store.snapshotOwners.set(String(OTHER_RECIPIENT), REQUEST);
    h.store.signingRequestFields.push({
      fieldId: "srf_other" as SigningRequestFieldId,
      sourcePreparationFieldId: null, type: "signature",
      pageNumber: 1, x: 0.5, y: 0.9, width: 0.3, height: 0.06,
      required: true, label: "Juan Dela Cruz — Signature", layer: 1,
      recipientId: OTHER_RECIPIENT,
    });
    h.store.snapshotOwners.set("srf_other", REQUEST);

    const view = await getSigningCeremony(await consented(h), h.deps);
    expect(view.fields.map(f => f.fieldId)).toEqual(["srf_1"]);
    // The other signer's NAME travels in a sender-authored label. It must not
    // appear anywhere in the payload.
    expect(JSON.stringify(view)).not.toContain("Juan");
  });

  it("returns canonical geometry unchanged", async () => {
    const h = harness();
    seed(h);
    const view = await getSigningCeremony(await consented(h), h.deps);
    expect(view.fields[0]).toMatchObject({
      pageNumber: 1, x: 0.1, y: 0.8, width: 0.3, height: 0.06,
    });
  });

  it("orders fields by page, then down, then across", async () => {
    const h = harness();
    seed(h, {
      fields: [
        { id: "c", page: 2, y: 0.1, x: 0.1 },
        { id: "b", page: 1, y: 0.9, x: 0.1 },
        { id: "a", page: 1, y: 0.2, x: 0.5 },
      ],
    });
    const view = await getSigningCeremony(await consented(h), h.deps);
    expect(view.fields.map(f => f.fieldId)).toEqual(["a", "b", "c"]);
  });

  it("marks server-derived fields so a client cannot supply them", async () => {
    const h = harness();
    seed(h);
    h.store.signingRequestFields.push({
      fieldId: "srf_date" as SigningRequestFieldId,
      sourcePreparationFieldId: null, type: "date-signed",
      pageNumber: 1, x: 0.6, y: 0.8, width: 0.2, height: 0.04,
      required: true, label: "Date", layer: 1, recipientId: RECIPIENT,
    });
    h.store.snapshotOwners.set("srf_date", REQUEST);

    const view = await getSigningCeremony(await consented(h), h.deps);
    const date = view.fields.find(f => f.type === "date-signed");
    expect(date?.valueAuthority).toBe("SERVER_DERIVED");
    const signature = view.fields.find(f => f.type === "signature");
    expect(signature?.valueAuthority).toBe("RECIPIENT_SUPPLIED");
  });
});

// ── Entry semantics ──────────────────────────────────────────────────────────

describe("entry", () => {
  it("repeated entry does not move the first-entry time", async () => {
    const h = harness();
    seed(h);
    const raw = await session(h);

    const first = await enterSigningCeremony(raw, h.deps);
    h.deps.clock.now = () => AT + 60_000;
    const second = await enterSigningCeremony(raw, h.deps);

    expect(second.firstEnteredAt).toBe(first.firstEnteredAt);
    expect(h.store.ceremonyProgress).toHaveLength(1);
  });

  it("a pure read records nothing", async () => {
    const h = harness();
    seed(h);
    const raw = await session(h);
    await getSigningCeremony(raw, h.deps);
    expect(h.store.ceremonyProgress).toHaveLength(0);
  });

  it("bootstrapping alone records no ceremony entry", async () => {
    const h = harness();
    seed(h);
    await session(h);
    // BACKEND-34's exchange is what an email scanner could conceivably reach.
    // It must leave no ceremony trace.
    expect(h.store.ceremonyProgress).toHaveLength(0);
    expect(h.store.ceremonyConsents).toHaveLength(0);
  });

  it("a refused entry records nothing", async () => {
    const h = harness();
    seed(h);
    const raw = await sessionForNonSignable(h, "waiting");
    await expect(enterSigningCeremony(raw, h.deps)).rejects.toThrow();
    expect(h.store.ceremonyProgress).toHaveLength(0);
  });

  it("entering does not sign, consent, complete or advance routing", async () => {
    const h = harness();
    seed(h);
    await enterSigningCeremony(await session(h), h.deps);

    expect(h.store.ceremonyConsents).toHaveLength(0);
    expect(h.store.signingRequests[0]?.state).toBe("sent");
    // Routing untouched: still exactly one activation, still this recipient's.
    expect(h.store.activations).toHaveLength(1);
    expect(h.store.activations[0]?.recipientId).toBe(RECIPIENT);
    expect(h.store.evidence).toHaveLength(0);
    expect(h.store.seals).toHaveLength(0);
  });
});

// ── Consent ──────────────────────────────────────────────────────────────────

describe("consent", () => {
  it("a signer must consent before the document or fields appear", async () => {
    const h = harness();
    seed(h);
    const view = await enterSigningCeremony(await session(h), h.deps);
    expect(view.consent.required).toBe(true);
    expect(view.consent.accepted).toBe(false);
    expect(view.access.mayViewDocument).toBe(false);
    expect(view.document).toBeNull();
    expect(view.fields).toHaveLength(0);
  });

  it("a viewer needs no consent and sees the document immediately", async () => {
    const h = harness();
    seed(h, { type: "viewer", fields: [] });
    const view = await enterSigningCeremony(await session(h), h.deps);
    expect(view.consent.required).toBe(false);
    expect(view.access.mayViewDocument).toBe(true);
    expect(view.document).not.toBeNull();
    // A viewer may look, and may never submit.
    expect(view.access.mayProceedToInput).toBe(false);
  });

  it("accepting unlocks the document and the fields in one response", async () => {
    const h = harness();
    seed(h);
    const raw = await session(h);
    await enterSigningCeremony(raw, h.deps);

    const view = await acceptSigningConsent(
      raw, { consentVersion: CONSENT_VERSION }, h.deps);

    expect(view.consent.accepted).toBe(true);
    expect(view.consent.acceptedAt).toBe(AT);
    expect(view.consent.acceptedVersion).toBe(CONSENT_VERSION);
    expect(view.document).not.toBeNull();
    expect(view.fields).toHaveLength(1);
    expect(view.access.mayProceedToInput).toBe(true);
  });

  it("records the backend time, never a client's", async () => {
    const h = harness();
    seed(h);
    const raw = await session(h);
    await acceptSigningConsent(raw, { consentVersion: CONSENT_VERSION }, h.deps);
    expect(h.store.ceremonyConsents[0]?.acceptedAt).toBe(AT);
  });

  it("refuses a version the ceremony is not asking for", async () => {
    const h = harness();
    seed(h);
    const raw = await session(h);
    await expect(acceptSigningConsent(raw, { consentVersion: "v9" }, h.deps))
      .rejects.toBeInstanceOf(SigningConsentVersionMismatchError);
    expect(h.store.ceremonyConsents).toHaveLength(0);
  });

  it("refuses a recipient the disclosure does not apply to", async () => {
    const h = harness();
    seed(h, { type: "viewer", fields: [] });
    const raw = await session(h);
    await expect(acceptSigningConsent(raw, { consentVersion: CONSENT_VERSION }, h.deps))
      .rejects.toBeInstanceOf(SigningConsentNotRequiredError);
  });

  it("accepting twice converges on one record", async () => {
    const h = harness();
    seed(h);
    const raw = await session(h);
    await acceptSigningConsent(raw, { consentVersion: CONSENT_VERSION }, h.deps);
    await acceptSigningConsent(raw, { consentVersion: CONSENT_VERSION }, h.deps);
    expect(h.store.ceremonyConsents).toHaveLength(1);
  });

  it("concurrent acceptance produces exactly one record", async () => {
    const h = harness();
    seed(h);
    const raw = await session(h);
    await Promise.all([
      acceptSigningConsent(raw, { consentVersion: CONSENT_VERSION }, h.deps),
      acceptSigningConsent(raw, { consentVersion: CONSENT_VERSION }, h.deps),
    ]);
    expect(h.store.ceremonyConsents).toHaveLength(1);
  });

  it("a rotated version asks again rather than counting the old acceptance", async () => {
    const h = harness();
    seed(h);
    const raw = await session(h);
    await acceptSigningConsent(raw, { consentVersion: CONSENT_VERSION }, h.deps);

    // The disclosure changes. The old acceptance stays on record, and it is
    // not an acceptance of the NEW words.
    const rotated: SigningCeremonyDependencies = {
      ...h.deps, policy: { consentVersion: "v1" },
    };
    const view = await getSigningCeremony(raw, rotated);
    expect(view.consent.accepted).toBe(false);
    expect(view.consent.requiredVersion).toBe("v1");
    expect(h.store.ceremonyConsents).toHaveLength(1);
  });

  it("consenting does not sign or complete anything", async () => {
    const h = harness();
    seed(h);
    const raw = await session(h);
    await acceptSigningConsent(raw, { consentVersion: CONSENT_VERSION }, h.deps);
    expect(h.store.signingRequests[0]?.state).toBe("sent");
    expect(h.store.seals).toHaveLength(0);
    expect(h.store.evidence).toHaveLength(0);
  });
});

// ── Document ─────────────────────────────────────────────────────────────────

describe("document access", () => {
  it("streams the exact source artifact", async () => {
    const h = harness();
    seed(h, { type: "viewer", fields: [] });
    const result = await getRecipientSigningDocument(await session(h), h.deps);
    expect(result.mediaType).toBe("application/pdf");
    expect(h.storage.requested).toEqual(["artifacts/ws_1/art_1.pdf"]);
  });

  it("never exposes the storage key to the caller", async () => {
    const h = harness();
    seed(h, { type: "viewer", fields: [] });
    const result = await getRecipientSigningDocument(await session(h), h.deps);
    const shape = { ...result, stream: undefined };
    expect(JSON.stringify(shape)).not.toContain("artifacts/");
    expect(Object.keys(result)).toEqual(
      ["mediaType", "sizeBytes", "digest", "stream"]);
  });

  it("refuses a signer who has not consented", async () => {
    const h = harness();
    seed(h);
    await expect(getRecipientSigningDocument(await session(h), h.deps))
      .rejects.toBeInstanceOf(SigningCeremonyUnavailableError);
    expect(h.storage.requested).toHaveLength(0);
  });

  it("reports a dependency failure without changing the workflow", async () => {
    const h = harness();
    seed(h, { type: "viewer", fields: [] });
    h.storage.present = false;
    await expect(getRecipientSigningDocument(await session(h), h.deps))
      .rejects.toBeInstanceOf(SigningDocumentUnavailableError);
    // The request is untouched. Storage being down is not a state transition.
    expect(h.store.signingRequests[0]?.state).toBe("sent");
  });
});
