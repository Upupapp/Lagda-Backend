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
import type {
  DocumentId, UserId, WorkspaceId, IdempotencyKey } from "@lagda/contracts";
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
  SignatureImageValidator, TypedSignatureRenderability, TypedSignatureProblem,
} from "../common/ports/index.js";
import type { IdempotencyRecordId } from "../common/ports/idempotency.js";
import type { SubmittedValue } from "@lagda/core";
import {
  FixedClock, SequentialRecipientSessionIds,
  FakeTransactionManager, InMemoryStore,
  SequentialSigningWorkflowIds, SequentialSigningAccessIds,
  SequentialCompletionIds,
  fakeTemplateRegistry,
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

/**
 * Stands in for the renderer's renderability probe.
 *
 * An APPROXIMATION, deliberately: anything above Latin Extended-B is reported
 * as missing glyphs, and the Devanagari block is reported as a shaping failure
 * — close enough for these cases, and it keeps the unit tests free of a 1.9 MB
 * font and a real shaping pass.
 *
 * It is deliberately STRICTER than reality in one place: the real shaper only
 * runs for Devanagari when it LEADS the run, so `Maria नमस्ते` genuinely
 * renders while this fake would refuse it. No test here uses such a value, and
 * mirroring that quirk would be fitting a fake to an upstream accident.
 *
 * It is not the authority on agreement. That the SUBMISSION check and the
 * MERGE refuse exactly the same text is asserted in the sealing package,
 * against the real embedded face and the real merger — see
 * `signature-renderability.test.ts`. A fake cannot prove two real
 * implementations agree, and pretending otherwise here would be the more
 * dangerous kind of green test.
 */
function typedSignatures(): TypedSignatureRenderability {
  const DEVANAGARI_START = 0x0900;
  const DEVANAGARI_END = 0x097f;

  return {
    check(text: string): TypedSignatureProblem | null {
      const missing: number[] = [];
      const seen = new Set<number>();
      let shaping = false;

      for (const character of text) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined || codePoint <= 0x024f) continue;
        if (codePoint >= DEVANAGARI_START && codePoint <= DEVANAGARI_END) {
          // Every glyph present, and the real shaper still throws.
          shaping = true;
          continue;
        }
        if (seen.has(codePoint)) continue;
        seen.add(codePoint);
        missing.push(codePoint);
      }

      // Missing glyphs first, matching the real probe: it is the more specific
      // answer, and the only one that can name anything.
      if (missing.length > 0) return { reason: "missing-glyphs", codePoints: missing };
      return shaping ? { reason: "shaping-failed" } : null;
    },
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
      // BACKEND-43. The ceremony appends evidence on entry and consent.
      ids: { nextEvidenceEventId: () => next("ev") as never },
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
      workflowIds: new SequentialSigningWorkflowIds(),
      completionIds: new SequentialCompletionIds(),
      // The provisioning slice the post-commit advance needs. These tests seed
      // single-cohort requests, so nothing is ever provisioned through them -
      // they are present because the dependency is required, and a throwing
      // sealer would be a better assertion than an unused stub if that changed.
      workflowAccess: {
        ids: new SequentialSigningAccessIds(),
        tokens: {
          issue: () => ({ raw: "raw", digest: "d".repeat(64) as never }),
          digest: () => null,
        },
        sealer: { keyVersion: "v1", seal: (p: string) => p as never },
        links: { build: (raw: string) => `https://app.lagda.test/sign/${raw}` },
        templates: fakeTemplateRegistry,
        clock: { now: () => AT },
        policy: { bootstrapLifetimeMs: 7 * 24 * 3_600_000 },
      },
      ids: {
        nextRecipientSubmissionId: () => next("sub") as RecipientSubmissionId,
        nextSigningFieldValueId: () => next("val") as SigningFieldValueId,
        nextSigningRepresentationId: () => next("rep") as SigningRepresentationId,
        // BACKEND-43. The workflow application appends two evidence events in
        // this transaction; without a generator the append throws and rolls the
        // accepted submission back with it.
        nextEvidenceEventId: () => next("ev") as never,
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
      typedSignatures: typedSignatures(),
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
    completionReadyAt: null, terminatedAt: null,
    expiresAt: null,
    completedAt: null,
    terminationReason: null, cancellationNote: null,
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
    signedAt: null, submissionId: null,
    declinedAt: null, declineReason: null,
    approvedAt: null, skippedAt: null,
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
      staticValue: null,
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

// ── Typed-signature renderability ────────────────────────────────────────────
//
// The merge refuses text the signature face has no glyphs for, and that
// refusal is TERMINAL: `unrenderable-value` is classed terminal because
// retrying identical text fails identically. But the merge runs in the
// completion pipeline, after the signer has gone.
//
// Before this check existed, such a submission was ACCEPTED: the signer was
// told they were done, the completion run then failed permanently, the request
// never reached `completed`, and the sender was never notified. These tests
// pin the failure to submission time, where the signer can still act on it.

describe("typed signature renderability", () => {
  it("accepts text the renderer can draw", async () => {
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);

    await submit(h, token, [{ fieldId: "f_sig", kind: "signature" }],
      { signature: TYPED });

    expect(h.store.submissions).toHaveLength(1);
  });

  it("accepts diacritics, which an earlier renderer could not draw", async () => {
    // OD-163: Helvetica's WinAnsi range could not carry these, and a recipient
    // named Peñaflor could not have their document completed at all. The
    // embedded face fixed that, and this guards against a narrowing that would
    // quietly bring it back.
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);

    await submit(h, token, [{ fieldId: "f_sig", kind: "signature" }],
      { signature: { ...TYPED, text: "Peñaflor Ángeles" } });

    expect(h.store.submissions).toHaveLength(1);
  });

  it("REFUSES text the renderer cannot draw, at submission", async () => {
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);

    await expect(submit(h, token, [{ fieldId: "f_sig", kind: "signature" }],
      { signature: { ...TYPED, text: "田中太郎" } }))
      .rejects.toBeInstanceOf(SigningSubmissionInvalidError);
  });

  it("names the problem specifically rather than as a generic invalid value", async () => {
    // `field-value-invalid` would tell the signer nothing they could act on.
    // This is the one problem here with a concrete remedy — a different
    // spelling, or a drawn signature once that exists.
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);

    const failure = await submit(h, token, [{ fieldId: "f_sig", kind: "signature" }],
      { signature: { ...TYPED, text: "田中太郎" } }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SigningSubmissionInvalidError);
    expect((failure as SigningSubmissionInvalidError).problems.map(p => p.code))
      .toEqual(["signature-unrenderable"]);
  });

  it("surfaces the reason to the client, not just a refusal", async () => {
    // The envelope builder reads `details` off an application validation
    // error. Without this the ceremony receives "could not be accepted" and a
    // signer whose typed name cannot be drawn has no way to learn that drawing
    // it instead would work — which would leave Step 1A's hard block a dead
    // end for exactly the people it affects.
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);

    const failure = await submit(h, token, [{ fieldId: "f_sig", kind: "signature" }],
      { signature: { ...TYPED, text: "田中太郎" } })
      .catch((e: unknown) => e) as SigningSubmissionInvalidError;

    expect(failure.details).toHaveLength(1);
    const [detail] = failure.details;
    expect(detail?.field).toBe("signature");
    expect(detail?.code).toBe("signature-unrenderable");
    // The remedy has to be IN the message, because that string is what the
    // ceremony shows when it has nothing more specific to say.
    expect(detail?.message).toContain("draw or upload it instead");
  });

  it("never echoes the rejected text in the reason", async () => {
    // A detail that quoted the name would put signing content into logs and
    // error reporting, which is what §42 and §217 keep it out of.
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);

    const failure = await submit(h, token, [{ fieldId: "f_sig", kind: "signature" }],
      { signature: { ...TYPED, text: "田中太郎" } })
      .catch((e: unknown) => e) as SigningSubmissionInvalidError;

    expect(JSON.stringify(failure.details)).not.toContain("田中太郎");
    expect(failure.message).not.toContain("田中太郎");
  });

  it("refuses unrenderable INITIALS too, not only signatures", async () => {
    // Initials render in the same face and are merged by the same path, so a
    // check that covered only signatures would leave the identical hole open.
    const h = harness();
    seed(h, [{ id: "f_ini", type: "initials" }]);
    const token = await signerSession(h);

    const failure = await submit(h, token, [{ fieldId: "f_ini", kind: "initials" }],
      { initials: { ...TYPED, text: "田中" } }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SigningSubmissionInvalidError);
    expect((failure as SigningSubmissionInvalidError).problems.map(p => p.code))
      .toEqual(["signature-unrenderable"]);
  });

  it("REFUSES Devanagari, which has every glyph and still cannot be drawn", async () => {
    // The case that made a glyph-coverage check insufficient. `क` is fully
    // covered by the face; fontkit's Indic shaper throws inside
    // `widthOfTextAtSize`, and that failure maps to `sealer-unavailable` —
    // RETRYABLE — so before this check the completion run burned its whole
    // attempt budget looking like a transient sealer outage before dying.
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);

    const failure = await submit(h, token, [{ fieldId: "f_sig", kind: "signature" }],
      { signature: { ...TYPED, text: "क" } }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SigningSubmissionInvalidError);
    expect((failure as SigningSubmissionInvalidError).problems.map(p => p.code))
      .toEqual(["signature-unrenderable"]);
    expect(h.store.submissions).toHaveLength(0);
  });

  it("refuses an emoji read as ONE code point, not two surrogates", async () => {
    // An astral character is exactly what gets pasted into a name field. It
    // must be reported once rather than as two unpaired halves.
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);

    await expect(submit(h, token, [{ fieldId: "f_sig", kind: "signature" }],
      { signature: { ...TYPED, text: "Maria 🎉" } }))
      .rejects.toBeInstanceOf(SigningSubmissionInvalidError);
  });

  it("writes NOTHING — no submission, and no request advance", async () => {
    // THE property. The old behaviour committed a submission and advanced the
    // request, so a completion run was created and then failed terminally.
    // Nothing may be written at all.
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);

    await expect(submit(h, token, [{ fieldId: "f_sig", kind: "signature" }],
      { signature: { ...TYPED, text: "田中太郎" } })).rejects.toThrow();

    expect(h.store.submissions).toHaveLength(0);
    expect(h.store.signingRequests[0]?.state).not.toBe("completion-ready");
    expect(h.store.signingRequests[0]?.completionReadyAt).toBeNull();
  });

  it("never enqueues completion work for a refused submission", async () => {
    // The direct statement of "before a completion run is required": if the
    // scheduler is never called, no run exists to fail terminally later.
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);

    const enqueued: string[] = [];
    const completionScheduler = {
      enqueue: (definition: { type: string }) => {
        enqueued.push(definition.type);
        return Promise.resolve({ jobId: "job_1", type: definition.type as never });
      },
    };

    await expect(submitRecipientSigning({
      rawSessionToken: token,
      idempotencyKey: KEY,
      fieldValues: [{ fieldId: "f_sig", kind: "signature" }],
      signature: { ...TYPED, text: "田中太郎" },
    }, { ...h.deps, completionScheduler })).rejects.toThrow();

    expect(enqueued).toEqual([]);
  });

  it("checks the TRIMMED text, which is what gets stored and drawn", async () => {
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);

    await expect(submit(h, token, [{ fieldId: "f_sig", kind: "signature" }],
      { signature: { ...TYPED, text: "  田中  " } }))
      .rejects.toBeInstanceOf(SigningSubmissionInvalidError);
  });

  it("leaves DRAWN signatures untouched by the text check", async () => {
    // A raster carries no text and has no font-coverage problem — which is
    // precisely why it is the remedy this rejection should steer a signer
    // towards once the capture UI offers it.
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);

    await submit(h, token, [{ fieldId: "f_sig", kind: "signature" }],
      { signature: { method: "drawn", base64: VALID_PNG_B64 } });

    expect(h.store.submissions).toHaveLength(1);
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
  it("moves the signer's OWN state and nothing about anybody else", async () => {
    // BACKEND-37 REVERSED HALF OF THIS TEST, deliberately.
    //
    // It used to assert that submission moved no workflow state at all, which
    // was the intermediate state BACKEND-36 documented and this command exists
    // to close: an accepted signature with a workflow that said nothing had
    // happened. What must still hold is the SPLIT — the signer's own row moves
    // in their transaction, and nothing that belongs to another recipient does.
    const h = harness();
    seed(h, [{ id: "f_txt", type: "text" }]);
    const token = await signerSession(h);
    await submit(h, token, [{ fieldId: "f_txt", kind: "text", text: "x" }]);

    const activation = h.store.activations[0];
    expect(h.store.activations).toHaveLength(1);
    expect(activation?.recipientId).toBe(RECIPIENT);
    expect(activation?.state).toBe("signed");
    // THE timestamp, from the submission. Not a second clock reading.
    expect(activation?.signedAt).toBe(h.store.submissions[0]?.acceptedAt);
    expect(activation?.submissionId).toBe(h.store.submissions[0]?.submissionId);

    // Still no PDF, no seal, and no delivery: the single signer is the whole
    // cohort, so the advance had nobody to provision.
    expect(h.store.seals).toHaveLength(0);
    expect([...h.store.notificationDeliveries.values()]).toHaveLength(0);
  });

  it("makes a single-signer request completion-ready and NEVER completed", async () => {
    const h = harness();
    seed(h, [{ id: "f_txt", type: "text" }]);
    const token = await signerSession(h);
    await submit(h, token, [{ fieldId: "f_txt", kind: "text", text: "x" }]);

    // The distinction the whole command is built around: every required
    // obligation is satisfied, and the signed document does not exist.
    expect(h.store.signingRequests[0]?.state).toBe("completion-ready");
    expect(h.store.signingRequests[0]?.state).not.toBe("completed");
    expect(h.store.signingRequests[0]?.completionReadyAt).not.toBeNull();
  });

  it("Phase 1-B: enqueues real completion processing AND its reconciliation safety net when the run becomes completion-ready", async () => {
    const h = harness();
    seed(h, [{ id: "f_txt", type: "text" }]);
    const token = await signerSession(h);

    const enqueued: Array<{ type: string; payload: unknown; options?: unknown }> = [];
    const completionScheduler = {
      enqueue: (definition: { type: string }, payload: unknown, options?: unknown) => {
        enqueued.push({ type: definition.type, payload, options });
        return Promise.resolve({ jobId: "job_1", type: definition.type as never });
      },
    };

    await submitRecipientSigning(
      { rawSessionToken: token, idempotencyKey: KEY, fieldValues: [{ fieldId: "f_txt", kind: "text", text: "x" }] },
      { ...h.deps, completionScheduler },
    );

    expect(h.store.signingRequests[0]?.state).toBe("completion-ready");

    const process = enqueued.find(e => e.type === "completion.process");
    expect(process?.payload).toEqual({ workspaceId: WS, completionRunId: "crn_1" });

    const reconcile = enqueued.find(e => e.type === "completion.reconcile");
    expect(reconcile?.payload).toEqual({ workspaceId: WS });
    // Self-scheduled a few minutes out, deduplicated per workspace — never a
    // flood of reconcile jobs from concurrent submissions in the same
    // workspace, and never immediate (that would defeat the point of having
    // a separate, cheap immediate enqueue for the common case).
    expect(reconcile?.options).toMatchObject({
      startAfter: AT + 5 * 60_000,
      singletonKey: WS,
      singletonSeconds: 5 * 60,
    });
  });

  it("Phase 1-B: never throws when no completion scheduler is composed", async () => {
    // Absent means exactly what it means everywhere else in this codebase:
    // the deployment has nowhere to enqueue completion processing — not a
    // reason to fail a signature that already committed.
    const h = harness();
    seed(h, [{ id: "f_txt", type: "text" }]);
    const token = await signerSession(h);

    await expect(submit(h, token, [{ fieldId: "f_txt", kind: "text", text: "x" }]))
      .resolves.toBeDefined();
    expect(h.store.signingRequests[0]?.state).toBe("completion-ready");
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

// ── Which bytes the signature is about ───────────────────────────────────────
//
// `submission-accepted` now carries the artifact id and digest of the document
// the recipient was served. These tests exist because "the field is populated"
// is not the property that matters — the recorded digest has to be the digest
// of the bytes THAT RECIPIENT actually saw, and there are two realistic ways
// for those to diverge:
//
//   * the event records the document's CURRENT artifact rather than the
//     request's frozen one, so a document edited after sending re-labels a
//     signature that was made against the older bytes;
//   * the event records a hard-coded or defaulted digest that happens to look
//     plausible.
//
// A test that only checked for presence would pass under both.

describe("submission-accepted records the bytes that were signed", () => {
  const payloadOf = (h: ReturnType<typeof harness>) => {
    const event = h.store.evidence.find(
      e => e.eventType === "submission-accepted");
    return event?.details?.payload as
      { artifactId?: string; digest?: string } | undefined;
  };

  it("records the artifact the ceremony served, digest and all", async () => {
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);
    await submit(h, token, [{ fieldId: "f_sig", kind: "signature" }],
      { signature: TYPED });

    // Asserted against the SEEDED artifact, not against whatever the event
    // happens to contain.
    const seeded = h.store.artifacts.find(a => a.artifactId === "art_1");
    expect(seeded).toBeDefined();

    expect(payloadOf(h)).toEqual({
      artifactId: "art_1",
      digest: String(seeded!.digest),
    });
  });

  it("records the request's FROZEN artifact, not the document's newest", async () => {
    // The decisive case. A newer artifact on the same document must not change
    // what a signature already made against the frozen bytes says it was made
    // against. This is what separates "reads the request" from "reads the
    // document", and only the first is defensible.
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);

    h.store.artifacts.push({
      artifactId: "art_NEWER" as ArtifactId, workspaceId: WS,
      documentId: "doc_1" as DocumentId, artifactType: "original",
      storageReference: "artifacts/ws_1/art_NEWER.pdf" as never,
      mediaType: "application/pdf", sizeBytes: 999,
      digestAlgorithm: "sha-256", digest: "b".repeat(64) as never,
      pageCount: 9, rotatedPageCount: 0, createdAt: AT + 1_000,
    });

    await submit(h, token, [{ fieldId: "f_sig", kind: "signature" }],
      { signature: TYPED });

    const payload = payloadOf(h);
    expect(payload?.artifactId).toBe("art_1");
    expect(payload?.digest).toBe("a".repeat(64));
    expect(payload?.digest).not.toBe("b".repeat(64));
  });

  it("carries a digest of the real length, not a placeholder", async () => {
    // Guards against a default or truncated value looking like a real one.
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);
    await submit(h, token, [{ fieldId: "f_sig", kind: "signature" }],
      { signature: TYPED });

    const digest = payloadOf(h)?.digest;
    expect(digest).toBeDefined();
    expect(digest).toHaveLength(64);
  });

  it("does NOT duplicate the reference onto signature-completed", async () => {
    // Deliberate: that event shares this one's submission source, so a reader
    // reaches the payload through the join it is already making. Pinned so the
    // omission reads as a decision rather than an oversight.
    const h = harness();
    seed(h, [{ id: "f_sig", type: "signature" }]);
    const token = await signerSession(h);
    await submit(h, token, [{ fieldId: "f_sig", kind: "signature" }],
      { signature: TYPED });

    const signed = h.store.evidence.find(
      e => e.eventType === "signature-completed");
    expect(signed).toBeDefined();
    expect(signed?.details ?? null).toBeNull();
  });
});
