// Authoritative signature submission, tested with fakes.
//
// The claims that carry weight:
//
//   a recipient may submit only fields assigned to them;
//   server-owned values come from the backend, never the client;
//   the same key replays, a different payload conflicts, a new key after
//   acceptance is refused;
//   nothing partial is ever committed;
//   nothing about the workflow moves.

import { describe, it, expect } from "vitest";
import type { DocumentId, UserId, WorkspaceId, IdempotencyKey } from "@lagda/contracts";
import { bootstrapSigningAccess, type SigningAccessDependencies } from "../signing-access/signing-access.js";
import { acceptSigningConsent, type SigningCeremonyDependencies } from "../signing-ceremony/signing-ceremony.js";
import {
  submitRecipientSigning,
  SigningSubmissionInvalidError, RecipientAlreadySubmittedError,
  SigningNotPermittedError, SigningConsentRequiredError,
  SigningIdempotencyConflictError,
  type SigningSubmissionDependencies,
} from "./signing-submission.js";
import type {
  ArtifactId, SigningRequestId, SigningRequestRecipientId, SigningRequestFieldId,
  SigningAccessGrantId, SigningAccessDigest, SigningConsentId,
  RecipientSessionDigest, RecipientCsrfDigest,
  RecipientSubmissionId, SigningFieldValueId, SigningRepresentationId,
  SignatureImageValidator,
} from "../common/ports/index.js";
import type { IdempotencyRecordId } from "../common/ports/idempotency.js";
import type { SubmittedValue } from "@lagda/core";
import {
  FixedClock, SequentialRecipientSessionIds,
  FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";

const AT = Date.parse("2026-08-10T14:00:00.000Z");
const WS = "ws_1" as WorkspaceId;
const REQUEST = "sr_1" as SigningRequestId;
const RECIPIENT = "srr_1" as SigningRequestRecipientId;
const OTHER_RECIPIENT = "srr_2" as SigningRequestRecipientId;
const CONSENT_VERSION = "v0-demonstration";
const RAW = "boot".padEnd(43, "x");
const KEY = "key-0001" as IdempotencyKey;

const DIGEST_OF = (raw: string) =>
  raw.slice(0, 4).charCodeAt(0).toString(16).padStart(64, "b") as SigningAccessDigest;

function sessionTokens() {
  let issued = 0;
  const of = (kind: string, raw: string) => `${kind}${raw.slice(0, 6)}`.padStart(64, "c");
  return {
    issue: () => {
      issued += 1;
      const rawToken = `sess${String(issued)}`.padEnd(43, "s");
      const rawCsrfToken = `csrf${String(issued)}`.padEnd(43, "r");
      return {
        rawToken, tokenDigest: of("t", rawToken) as RecipientSessionDigest,
        rawCsrfToken, csrfDigest: of("x", rawCsrfToken) as RecipientCsrfDigest,
      };
    },
    digestToken: (s: string) =>
      s.length === 43 ? (of("t", s) as RecipientSessionDigest) : null,
    digestCsrf: (s: string) =>
      s.length === 43 ? (of("x", s) as RecipientCsrfDigest) : null,
  };
}

/**
 * A validator that accepts one known payload.
 *
 * Real PNG parsing is the API adapter's job and is tested there. What this
 * suite needs is the SEAM: that a rejected image produces no submission, and
 * that an accepted one carries a server-computed digest.
 */
const VALID_PNG_B64 = "iVBORw0KGgoAAAANSUhEUg";
function imageValidator(): SignatureImageValidator {
  return {
    validate: (base64: string) => base64 === VALID_PNG_B64 ? {
      bytes: Buffer.from([0x89, 0x50]), mediaType: "image/png",
      width: 420, height: 120, digest: "d".repeat(64),
    } : null,
    digestCanonical: (value: string) =>
      String(value.length).padStart(64, "e"),
  };
}

interface Harness {
  readonly store: InMemoryStore;
  readonly accessDeps: SigningAccessDependencies;
  readonly ceremonyDeps: SigningCeremonyDependencies;
  readonly deps: SigningSubmissionDependencies;
}

function harness(): Harness {
  const store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);
  const clock = new FixedClock(AT);
  const tokens = sessionTokens();
  let n = 0;
  const next = (prefix: string) => { n += 1; return `${prefix}_${String(n)}`; };

  const accessDeps: SigningAccessDependencies = {
    transactions, clock,
    bootstrapTokens: {
      issue: () => ({ raw: RAW, digest: "b".repeat(64) as SigningAccessDigest }),
      digest: (s: string) => /^[A-Za-z0-9_-]{43}$/.test(s) ? DIGEST_OF(s) : null,
    },
    sessionTokens: tokens,
    ids: new SequentialRecipientSessionIds(),
    policy: { sessionLifetimeMs: 8 * 3_600_000 },
  };

  return {
    store, accessDeps,
    ceremonyDeps: {
      transactions, clock, sessionTokens: tokens,
      consentIds: { nextSigningConsentId: () => next("con") as SigningConsentId },
      storage: {
        putObject: () => Promise.reject(new Error("unused")),
        getObject: () => Promise.resolve(null),
        headObject: () => Promise.resolve(null),
        deleteObject: () => Promise.resolve(),
      },
      policy: { consentVersion: CONSENT_VERSION },
    },
    deps: {
      transactions, clock, sessionTokens: tokens,
      ids: {
        nextRecipientSubmissionId: () => next("sub") as RecipientSubmissionId,
        nextSigningFieldValueId: () => next("val") as SigningFieldValueId,
        nextSigningRepresentationId: () => next("rep") as SigningRepresentationId,
      },
      idempotencyKeys: {
        digestKey: (k: string) => `k${k}`.padStart(64, "0") as never,
        fingerprint: (canonical: string) =>
          `f${String(canonical.length)}:${canonical.slice(-40)}` as never,
      },
      idempotencyIds: {
        nextIdempotencyRecordId: (): IdempotencyRecordId =>
          next("idm") as IdempotencyRecordId,
      },
      signatureImages: imageValidator(),
      policy: {
        consentVersion: CONSENT_VERSION,
        idempotencyRetentionMs: 24 * 3_600_000,
      },
    },
  };
}

interface FieldSpec {
  readonly id: string;
  readonly type: "signature" | "initials" | "text" | "checkbox"
    | "date-signed" | "full-name" | "email";
  readonly required?: boolean;
  readonly recipientId?: SigningRequestRecipientId;
}

function seed(h: Harness, fields: readonly FieldSpec[], over: {
  state?: "sent" | "cancelled";
  type?: "signer" | "viewer";
} = {}): void {
  h.store.signingRequests.push({
    signingRequestId: REQUEST, workspaceId: WS,
    documentId: "doc_1" as DocumentId, sourceArtifactId: "art_1" as ArtifactId,
    sourcePreparationId: "prep_1" as never, sourcePreparationRevision: 1,
    state: over.state ?? "sent", documentTitle: "Office Lease",
    createdByUserId: "usr_1" as UserId, createdAt: AT, updatedAt: AT,
  });
  h.store.signingRequestRecipients.push({
    recipientId: RECIPIENT, sourcePreparationRecipientId: null,
    name: "Maria Santos", email: "maria.santos@ayalaland.com.ph",
    normalizedEmail: "maria.santos@ayalaland.com.ph", organization: "Ayala",
    type: over.type ?? "signer", isRequired: true, orderIndex: 0, routingOrder: 1,
  });
  h.store.snapshotOwners.set(String(RECIPIENT), REQUEST);
  h.store.activations.push({
    recipientId: RECIPIENT, state: "active", activatedAt: AT,
    signingRequestId: String(REQUEST),
  });
  h.store.artifacts.push({
    artifactId: "art_1" as ArtifactId, workspaceId: WS,
    documentId: "doc_1" as DocumentId, artifactType: "original",
    storageReference: "artifacts/ws_1/art_1.pdf" as never,
    mediaType: "application/pdf", sizeBytes: 12,
    digestAlgorithm: "sha-256", digest: "a".repeat(64) as never,
    pageCount: 4, rotatedPageCount: 0, createdAt: AT,
  });
  h.store.signingAccessGrants.push({
    grantId: "sag_1" as SigningAccessGrantId, workspaceId: WS,
    signingRequestId: REQUEST, recipientId: RECIPIENT,
    credentialDigest: DIGEST_OF(RAW),
    createdAt: AT, expiresAt: AT + 14 * 24 * 3_600_000,
  });

  for (const f of fields) {
    h.store.signingRequestFields.push({
      fieldId: f.id as SigningRequestFieldId, sourcePreparationFieldId: null,
      type: f.type, pageNumber: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.05,
      required: f.required ?? true, label: "Field", layer: 1,
      recipientId: f.recipientId ?? RECIPIENT,
    });
    h.store.snapshotOwners.set(f.id, REQUEST);
  }
}

/** A bootstrapped, consented session — the state a signer is in at Finish. */
async function signerSession(h: Harness): Promise<string> {
  const result = await bootstrapSigningAccess(RAW, h.accessDeps);
  const token = result.credentials.rawSessionToken;
  await acceptSigningConsent(token, { consentVersion: CONSENT_VERSION }, h.ceremonyDeps);
  return token;
}

const submit = (
  h: Harness, token: string, fieldValues: readonly SubmittedValue[],
  over: Partial<Parameters<typeof submitRecipientSigning>[0]> = {},
) => submitRecipientSigning({
  rawSessionToken: token, idempotencyKey: KEY, fieldValues, ...over,
}, h.deps);

const TYPED = { method: "typed" as const, text: "Maria Santos", styleIndex: 0 };

// ── Acceptance ───────────────────────────────────────────────────────────────

describe("accepting a submission", () => {
  it("commits one submission and the expected values", async () => {
    const h = harness();
    seed(h, [
      { id: "f_sig", type: "signature" },
      { id: "f_txt", type: "text" },
      { id: "f_chk", type: "checkbox" },
    ]);
    const token = await signerSession(h);

    const result = await submit(h, token, [
      { fieldId: "f_sig", kind: "signature" },
      { fieldId: "f_txt", kind: "text", text: "  Unit 21B  " },
      { fieldId: "f_chk", kind: "checkbox", checked: true },
    ], { signature: TYPED });

    expect(result.acceptedAt).toBe(AT);
    expect(result.replayed).toBe(false);
    expect(h.store.submissions).toHaveLength(1);
    const stored = h.store.submissions[0];
    expect(stored?.values).toHaveLength(3);
    // Ends trimmed, middle intact.
    const text = stored?.values.find(v => v.fieldId === "f_txt");
    expect(text?.textValue).toBe("Unit 21B");
  });

  it("stores one representation and references it from every signature field", async () => {
    const h = harness();
    seed(h, [
      { id: "f_sig1", type: "signature" },
      { id: "f_sig2", type: "signature" },
    ]);
    const token = await signerSession(h);
    await submit(h, token, [
      { fieldId: "f_sig1", kind: "signature" },
      { fieldId: "f_sig2", kind: "signature" },
    ], { signature: TYPED });

    const stored = h.store.submissions[0];
    expect(stored?.representations).toHaveLength(1);
    const ids = stored?.values.map(v => v.representationId);
    expect(new Set(ids).size).toBe(1);
  });

  it("accepts a drawn signature and records a server-computed digest", async () => {
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);
    await submit(h, token, [{ fieldId: "f_sig", kind: "signature" }],
      { signature: { method: "drawn", base64: VALID_PNG_B64 } });

    const rep = h.store.submissions[0]?.representations[0];
    expect(rep?.representationType).toBe("RASTER_SIGNATURE_V1");
    expect(rep?.digest).toBe("d".repeat(64));
    expect(rep?.rasterWidth).toBe(420);
  });

  it("refuses a drawn signature the validator rejects", async () => {
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);
    await expect(submit(h, token, [{ fieldId: "f_sig", kind: "signature" }],
      { signature: { method: "drawn", base64: "not-an-image" } }))
      .rejects.toBeInstanceOf(SigningSubmissionInvalidError);
    expect(h.store.submissions).toHaveLength(0);
  });
});

// ── Server-owned values ──────────────────────────────────────────────────────

describe("server-owned fields", () => {
  it("derives date-signed from the submission instant", async () => {
    const h = harness();
    seed(h, [{ id: "f_date", type: "date-signed" }]);
    const token = await signerSession(h);
    await submit(h, token, []);

    const value = h.store.submissions[0]?.values[0];
    expect(value?.valueSource).toBe("SERVER_DERIVED");
    expect(value?.instantValue).toBe(AT);
  });

  it("derives name and email from the immutable snapshot", async () => {
    const h = harness();
    seed(h, [{ id: "f_name", type: "full-name" }, { id: "f_mail", type: "email" }]);
    const token = await signerSession(h);
    await submit(h, token, []);

    const values = h.store.submissions[0]?.values ?? [];
    expect(values.find(v => v.fieldId === "f_name")?.textValue).toBe("Maria Santos");
    expect(values.find(v => v.fieldId === "f_mail")?.textValue)
      .toBe("maria.santos@ayalaland.com.ph");
    expect(values.every(v => v.valueSource === "SERVER_DERIVED")).toBe(true);
  });

  it("has no contract member a client could use to spoof them", async () => {
    const h = harness();
    seed(h, [{ id: "f_date", type: "date-signed" }]);
    const token = await signerSession(h);
    // The only kinds a client can express are signature, initials, text and
    // checkbox. Sending `text` for a date-signed field is a type mismatch, and
    // the value is derived regardless.
    await expect(submit(h, token, [
      { fieldId: "f_date", kind: "text", text: "1999-01-01" },
    ])).rejects.toBeInstanceOf(SigningSubmissionInvalidError);
    expect(h.store.submissions).toHaveLength(0);
  });
});

// ── Field ownership ──────────────────────────────────────────────────────────

describe("field ownership", () => {
  it("rejects another recipient's field", async () => {
    const h = harness();
    seed(h, [
      { id: "f_mine", type: "text" },
      { id: "f_theirs", type: "text", recipientId: OTHER_RECIPIENT },
    ]);
    const token = await signerSession(h);
    await expect(submit(h, token, [
      { fieldId: "f_mine", kind: "text", text: "ok" },
      { fieldId: "f_theirs", kind: "text", text: "not mine" },
    ])).rejects.toBeInstanceOf(SigningSubmissionInvalidError);
    expect(h.store.submissions).toHaveLength(0);
  });

  it("rejects an unknown field id", async () => {
    const h = harness();
    seed(h, [{ id: "f_txt", type: "text" }]);
    const token = await signerSession(h);
    await expect(submit(h, token, [
      { fieldId: "f_txt", kind: "text", text: "ok" },
      { fieldId: "f_invented", kind: "text", text: "x" },
    ])).rejects.toBeInstanceOf(SigningSubmissionInvalidError);
  });

  it("rejects the same field twice in one payload", async () => {
    const h = harness();
    seed(h, [{ id: "f_txt", type: "text" }]);
    const token = await signerSession(h);
    await expect(submit(h, token, [
      { fieldId: "f_txt", kind: "text", text: "first" },
      { fieldId: "f_txt", kind: "text", text: "second" },
    ])).rejects.toBeInstanceOf(SigningSubmissionInvalidError);
  });

  it("rejects a value whose kind does not match the field type", async () => {
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);
    await expect(submit(h, token, [
      { fieldId: "f_sig", kind: "text", text: "Maria" },
    ])).rejects.toBeInstanceOf(SigningSubmissionInvalidError);
  });
});

// ── Required and optional ────────────────────────────────────────────────────

describe("required coverage", () => {
  it("rejects the whole submission when a required field is missing", async () => {
    const h = harness();
    seed(h, [
      { id: "f_a", type: "text" },
      { id: "f_b", type: "text" },
    ]);
    const token = await signerSession(h);
    await expect(submit(h, token, [{ fieldId: "f_a", kind: "text", text: "only a" }]))
      .rejects.toBeInstanceOf(SigningSubmissionInvalidError);
    // NO partial values. §83, §136.
    expect(h.store.submissions).toHaveLength(0);
  });

  it("accepts an omitted optional field and writes no row for it", async () => {
    const h = harness();
    seed(h, [
      { id: "f_req", type: "text" },
      { id: "f_opt", type: "text", required: false },
    ]);
    const token = await signerSession(h);
    await submit(h, token, [{ fieldId: "f_req", kind: "text", text: "here" }]);

    const values = h.store.submissions[0]?.values ?? [];
    expect(values).toHaveLength(1);
    expect(values[0]?.fieldId).toBe("f_req");
  });

  it("refuses a required checkbox that is false", async () => {
    const h = harness();
    seed(h, [{ id: "f_chk", type: "checkbox" }]);
    const token = await signerSession(h);
    await expect(submit(h, token, [
      { fieldId: "f_chk", kind: "checkbox", checked: false },
    ])).rejects.toBeInstanceOf(SigningSubmissionInvalidError);
  });

  it("refuses a signature field with no adopted signature", async () => {
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);
    await expect(submit(h, token, [{ fieldId: "f_sig", kind: "signature" }]))
      .rejects.toBeInstanceOf(SigningSubmissionInvalidError);
  });
});

// ── Eligibility ──────────────────────────────────────────────────────────────

describe("eligibility at commit time", () => {
  it("refuses when the request is no longer signable", async () => {
    const h = harness();
    seed(h, [{ id: "f_txt", type: "text" }]);
    const token = await signerSession(h);

    const request = h.store.signingRequests[0];
    if (request === undefined) throw new Error("no request");
    h.store.signingRequests[0] = { ...request, state: "cancelled" };

    await expect(submit(h, token, [{ fieldId: "f_txt", kind: "text", text: "x" }]))
      .rejects.toBeInstanceOf(SigningNotPermittedError);
    expect(h.store.submissions).toHaveLength(0);
  });

  it("refuses when routing has moved on", async () => {
    const h = harness();
    seed(h, [{ id: "f_txt", type: "text" }]);
    const token = await signerSession(h);
    const activation = h.store.activations[0];
    if (activation === undefined) throw new Error("no activation");
    h.store.activations[0] = { ...activation, state: "waiting", activatedAt: null };

    await expect(submit(h, token, [{ fieldId: "f_txt", kind: "text", text: "x" }]))
      .rejects.toBeInstanceOf(SigningNotPermittedError);
  });

  it("refuses when consent has not been accepted", async () => {
    const h = harness();
    seed(h, [{ id: "f_txt", type: "text" }]);
    // Bootstrapped but NOT consented.
    const result = await bootstrapSigningAccess(RAW, h.accessDeps);
    await expect(submit(h, result.credentials.rawSessionToken, [
      { fieldId: "f_txt", kind: "text", text: "x" },
    ])).rejects.toBeInstanceOf(SigningConsentRequiredError);
  });

  it("refuses an expired session", async () => {
    const h = harness();
    seed(h, [{ id: "f_txt", type: "text" }]);
    const token = await signerSession(h);
    const stored = h.store.recipientSessions[0];
    if (stored === undefined) throw new Error("no session");
    h.store.recipientSessions[0] = { ...stored, expiresAt: AT - 1 };

    await expect(submit(h, token, [{ fieldId: "f_txt", kind: "text", text: "x" }]))
      .rejects.toThrow();
    expect(h.store.submissions).toHaveLength(0);
  });
});

// ── Idempotency ──────────────────────────────────────────────────────────────

describe("idempotency", () => {
  const values: readonly SubmittedValue[] = [
    { fieldId: "f_txt", kind: "text", text: "Unit 21B" },
  ];

  it("replays the original result for the same key and payload", async () => {
    const h = harness();
    seed(h, [{ id: "f_txt", type: "text" }]);
    const token = await signerSession(h);

    const first = await submit(h, token, values);
    h.deps.clock.now = () => AT + 90_000;
    const second = await submit(h, token, values);

    expect(second.submissionId).toBe(first.submissionId);
    expect(second.acceptedAt).toBe(first.acceptedAt);
    expect(second.replayed).toBe(true);
    expect(h.store.submissions).toHaveLength(1);
    expect(h.store.submissions[0]?.values).toHaveLength(1);
  });

  it("conflicts when the same key carries different values", async () => {
    const h = harness();
    seed(h, [{ id: "f_txt", type: "text" }]);
    const token = await signerSession(h);
    await submit(h, token, values);

    await expect(submit(h, token, [
      { fieldId: "f_txt", kind: "text", text: "Unit 99Z" },
    ])).rejects.toBeInstanceOf(SigningIdempotencyConflictError);
    expect(h.store.submissions[0]?.values[0]?.textValue).toBe("Unit 21B");
  });

  it("does not conflict when only the array ORDER differs", async () => {
    const h = harness();
    seed(h, [{ id: "f_a", type: "text" }, { id: "f_b", type: "text" }]);
    const token = await signerSession(h);
    const a: SubmittedValue = { fieldId: "f_a", kind: "text", text: "A" };
    const b: SubmittedValue = { fieldId: "f_b", kind: "text", text: "B" };

    const first = await submit(h, token, [a, b]);
    const replay = await submit(h, token, [b, a]);
    expect(replay.submissionId).toBe(first.submissionId);
    expect(replay.replayed).toBe(true);
  });

  it("refuses a NEW key after an accepted submission", async () => {
    const h = harness();
    seed(h, [{ id: "f_txt", type: "text" }]);
    const token = await signerSession(h);
    await submit(h, token, values);

    await expect(submitRecipientSigning({
      rawSessionToken: token,
      idempotencyKey: "key-0002" as IdempotencyKey,
      fieldValues: values,
    }, h.deps)).rejects.toBeInstanceOf(RecipientAlreadySubmittedError);
    expect(h.store.submissions).toHaveLength(1);
  });
});

// ── Concurrency ──────────────────────────────────────────────────────────────

describe("concurrency", () => {
  it("accepts exactly one of two conflicting submissions", async () => {
    const h = harness();
    seed(h, [{ id: "f_txt", type: "text" }]);
    const token = await signerSession(h);

    const results = await Promise.allSettled([
      submitRecipientSigning({
        rawSessionToken: token, idempotencyKey: "k-a" as IdempotencyKey,
        fieldValues: [{ fieldId: "f_txt", kind: "text", text: "device one" }],
      }, h.deps),
      submitRecipientSigning({
        rawSessionToken: token, idempotencyKey: "k-b" as IdempotencyKey,
        fieldValues: [{ fieldId: "f_txt", kind: "text", text: "device two" }],
      }, h.deps),
    ]);

    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(h.store.submissions).toHaveLength(1);
  });
});

// ── Boundaries ───────────────────────────────────────────────────────────────

describe("what submission does NOT do", () => {
  it("moves no workflow state and advances no routing", async () => {
    const h = harness();
    seed(h, [{ id: "f_txt", type: "text" }]);
    const token = await signerSession(h);
    await submit(h, token, [{ fieldId: "f_txt", kind: "text", text: "x" }]);

    expect(h.store.signingRequests[0]?.state).toBe("sent");
    expect(h.store.activations).toHaveLength(1);
    expect(h.store.activations[0]?.recipientId).toBe(RECIPIENT);
    expect(h.store.seals).toHaveLength(0);
    expect(h.store.deliveryIntents).toHaveLength(0);
  });

  it("is unaffected by contact and preparation mutation", async () => {
    const h = harness();
    seed(h, [{ id: "f_name", type: "full-name" }]);
    const token = await signerSession(h);

    h.store.contacts.length = 0;
    h.store.preparationFields.length = 0;
    h.store.preparations.length = 0;

    await submit(h, token, []);
    expect(h.store.submissions[0]?.values[0]?.textValue).toBe("Maria Santos");
  });

  it("uses one backend instant for the whole act", async () => {
    const h = harness();
    seed(h, [
      { id: "f_date", type: "date-signed" },
      { id: "f_txt", type: "text" },
    ]);
    const token = await signerSession(h);
    const result = await submit(h, token, [
      { fieldId: "f_txt", kind: "text", text: "x" },
    ]);

    const date = h.store.submissions[0]?.values.find(v => v.fieldId === "f_date");
    expect(result.acceptedAt).toBe(AT);
    expect(date?.instantValue).toBe(AT);
    expect(h.store.submissions[0]?.acceptedAt).toBe(AT);
  });
});
