// Behaviour of the sealing adapter.
//
// These tests assert on the BYTES the sealer returns, not on whether pdf-lib
// was called. A test that mocks the PDF library and checks it was invoked
// passes just as happily when the output is unopenable.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { SealRequest, SealableField } from "@lagda/application";
import type {
  WorkspaceId, TransactionId, DocumentId, VerificationId,
} from "@lagda/contracts";
import { NodeDocumentSealer } from "./node-document-sealer.js";
import {
  InvalidPdfError, InvalidSealInputError, InvalidFieldPlacementError,
  UnsupportedPdfError, SealingError,
} from "./errors/index.js";
import { sha256 } from "./internal/digest.js";
import { toPdfRect } from "./internal/fields.js";

async function makePdf(pageCount = 2): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i += 1) {
    const page = pdf.addPage([595.28, 841.89]);
    page.drawText(`Page ${String(i + 1)}`, { x: 50, y: 780, size: 12, font });
  }
  return pdf.save();
}

const FIELD: SealableField = {
  type: "signature",
  pageNumber: 1,
  rect: { x: 0.1, y: 0.7, width: 0.3, height: 0.06 },
  value: "Juan dela Cruz",
};

async function makeRequest(overrides: Partial<SealRequest> = {}): Promise<SealRequest> {
  return {
    workspaceId: "ws_1" as WorkspaceId,
    transactionId: "tx_1" as TransactionId,
    documentId: "doc_1" as DocumentId,
    preparedDocument: await makePdf(),
    fields: [FIELD],
    evidence: {
      documentName: "Contract of Lease.pdf",
      completedAt: "2026-08-08T04:15:00Z",
      participants: [
        { name: "Juan dela Cruz", action: "Signed", completedAt: "2026-08-08T04:14:12Z" },
        { name: "Maria Santos", action: "Received a copy", completedAt: "2026-08-08T04:15:00Z" },
      ],
    },
    verificationId: "LAGDA-WS1-20260808-7F3A2C" as VerificationId,
    sealedAt: "2026-08-08T04:15:01Z",
    ...overrides,
  };
}

describe("sha256", () => {
  it("matches the published vector for the empty input", () => {
    // The canonical SHA-256 of zero bytes. If encoding or algorithm selection
    // ever drifts, this fails before any document does.
    expect(sha256(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it('matches the published vector for "abc"', () => {
    expect(sha256(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("produces lowercase hex of exactly 64 characters", () => {
    expect(sha256(new TextEncoder().encode("LAGDA"))).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("toPdfRect", () => {
  // The Y-axis flip is the single highest-risk line in this package: getting it
  // wrong produces a valid PDF with the signature in the wrong place, which no
  // structural assertion catches.
  it("keeps X unchanged and inverts Y", () => {
    const box = toPdfRect({ x: 0.25, y: 0.1, width: 0.5, height: 0.2 }, 600, 800);
    expect(box.x).toBeCloseTo(150);
    expect(box.width).toBeCloseTo(300);
    expect(box.height).toBeCloseTo(160);
    // y=0.1 from the TOP, height 0.2 → the top edge is 80pt down from 800 (720),
    // and the bottom edge sits 160pt below that.
    expect(box.y).toBeCloseTo(560);
  });

  it("places a field at the top of the page near the top in PDF space", () => {
    const box = toPdfRect({ x: 0, y: 0, width: 1, height: 0.1 }, 600, 800);
    expect(box.y).toBeCloseTo(720);
  });

  it("places a field at the bottom of the page at the PDF origin", () => {
    const box = toPdfRect({ x: 0, y: 0.9, width: 1, height: 0.1 }, 600, 800);
    expect(box.y).toBeCloseTo(0);
  });
});

describe("NodeDocumentSealer.seal", () => {
  const sealer = new NodeDocumentSealer();

  it("hashes the prepared document exactly as received", async () => {
    const request = await makeRequest();
    const result = await sealer.seal(request);

    const expected = createHash("sha256").update(request.preparedDocument).digest("hex");
    expect(result.preparedDocumentHash).toBe(expected);
  });

  it("returns a signed hash equal to the digest of the returned bytes", async () => {
    // §97. If the hash were taken before serialization, this comparison would
    // fail — which is exactly the bug it exists to catch.
    const result = await sealer.seal(await makeRequest());
    const actual = createHash("sha256").update(result.sealedDocument).digest("hex");
    expect(result.signedDocumentHash).toBe(actual);
  });

  it("produces a sealed document that differs from the prepared one", async () => {
    const request = await makeRequest();
    const result = await sealer.seal(request);
    expect(result.signedDocumentHash).not.toBe(result.preparedDocumentHash);
  });

  it("does not mutate the caller's buffer", async () => {
    const request = await makeRequest();
    const before = Uint8Array.from(request.preparedDocument);

    const result = await sealer.seal(request);

    expect(Array.from(request.preparedDocument)).toEqual(Array.from(before));
    // And the recorded digest still describes the caller's bytes.
    expect(result.preparedDocumentHash).toBe(sha256(before));
  });

  it("returns a sealed document that re-parses as a PDF with the same page count", async () => {
    // "It returned bytes" is not evidence. Only re-opening the output proves it
    // is a document rather than a plausible-looking buffer.
    const result = await sealer.seal(await makeRequest());
    const reopened = await PDFDocument.load(result.sealedDocument);
    expect(reopened.getPageCount()).toBe(2);
  });

  it("returns a completion certificate that re-parses as its own PDF", async () => {
    const result = await sealer.seal(await makeRequest());
    const certificate = await PDFDocument.load(result.completionCertificate);
    expect(certificate.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("keeps the certificate separate from the sealed document", async () => {
    // Handoff §15 stores three artifacts. If the certificate were appended, the
    // sealed document's page count would have grown past the source's.
    const result = await sealer.seal(await makeRequest());
    expect(result.sealedDocument).not.toEqual(result.completionCertificate);
    const reopened = await PDFDocument.load(result.sealedDocument);
    expect(reopened.getPageCount()).toBe(2);
  });

  it("echoes the verification ID rather than generating one", async () => {
    const request = await makeRequest();
    const result = await sealer.seal(request);
    expect(result.verificationId).toBe(request.verificationId);
  });

  it("records seal metadata exactly", async () => {
    const result = await sealer.seal(await makeRequest());
    expect(result.seal).toEqual({
      sealScheme: "hash-evidence",
      sealVersion: 1,
      digestAlgorithm: "sha-256",
    });
  });

  it("is deterministic for identical input", async () => {
    // No clock, no randomness inside the sealer. pdf-lib stamps no creation
    // date of its own here, so the same request yields the same bytes.
    const prepared = await makePdf();
    const a = await sealer.seal(await makeRequest({ preparedDocument: prepared }));
    const b = await sealer.seal(await makeRequest({ preparedDocument: prepared }));
    expect(a.signedDocumentHash).toBe(b.signedDocumentHash);
  });

  it("renders every supported field type", async () => {
    const fields: SealableField[] = [
      { type: "signature", pageNumber: 1, rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 }, value: "Ana Reyes" },
      { type: "initials", pageNumber: 1, rect: { x: 0.5, y: 0.1, width: 0.1, height: 0.05 }, value: "AR" },
      { type: "text", pageNumber: 2, rect: { x: 0.1, y: 0.2, width: 0.4, height: 0.04 }, value: "Quezon City" },
      { type: "date", pageNumber: 2, rect: { x: 0.6, y: 0.2, width: 0.25, height: 0.04 }, value: "2026-08-08" },
      { type: "checkbox", pageNumber: 2, rect: { x: 0.1, y: 0.3, width: 0.03, height: 0.03 }, value: "true" },
    ];
    const result = await sealer.seal(await makeRequest({ fields }));
    await expect(PDFDocument.load(result.sealedDocument)).resolves.toBeDefined();
  });

  it("seals a document with no fields", async () => {
    // A recipient whose only action is receiving a copy leaves no fields. The
    // document must still seal, and still hash.
    const result = await sealer.seal(await makeRequest({ fields: [] }));
    expect(result.signedDocumentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("NodeDocumentSealer failures", () => {
  const sealer = new NodeDocumentSealer();

  it("rejects a field on a page that does not exist", async () => {
    const fields: SealableField[] = [{ ...FIELD, pageNumber: 9 }];
    await expect(sealer.seal(await makeRequest({ fields }))).rejects.toBeInstanceOf(
      InvalidFieldPlacementError,
    );
  });

  it("rejects page number zero, which would be a 0-based caller", async () => {
    const fields: SealableField[] = [{ ...FIELD, pageNumber: 0 }];
    await expect(sealer.seal(await makeRequest({ fields }))).rejects.toBeInstanceOf(
      InvalidFieldPlacementError,
    );
  });

  it("rejects a field extending past the page edge rather than clipping it", async () => {
    const fields: SealableField[] = [
      { ...FIELD, rect: { x: 0.9, y: 0.1, width: 0.3, height: 0.05 } },
    ];
    await expect(sealer.seal(await makeRequest({ fields }))).rejects.toBeInstanceOf(
      InvalidFieldPlacementError,
    );
  });

  it("rejects a zero-area field", async () => {
    const fields: SealableField[] = [
      { ...FIELD, rect: { x: 0.1, y: 0.1, width: 0, height: 0.05 } },
    ];
    await expect(sealer.seal(await makeRequest({ fields }))).rejects.toBeInstanceOf(
      InvalidFieldPlacementError,
    );
  });

  it("rejects non-finite geometry", async () => {
    const fields: SealableField[] = [
      { ...FIELD, rect: { x: Number.NaN, y: 0.1, width: 0.1, height: 0.05 } },
    ];
    await expect(sealer.seal(await makeRequest({ fields }))).rejects.toBeInstanceOf(
      InvalidFieldPlacementError,
    );
  });

  it("rejects bytes that are not a PDF", async () => {
    const preparedDocument = new TextEncoder().encode("this is not a pdf");
    await expect(sealer.seal(await makeRequest({ preparedDocument }))).rejects.toBeInstanceOf(
      InvalidPdfError,
    );
  });

  it("rejects an empty document", async () => {
    const preparedDocument = new Uint8Array(0);
    await expect(sealer.seal(await makeRequest({ preparedDocument }))).rejects.toBeInstanceOf(
      InvalidSealInputError,
    );
  });

  it("rejects a truncated PDF that starts with the right header", async () => {
    // The magic-byte check alone would let this through. Parsing is what
    // actually decides, and the failure still arrives as a LAGDA error.
    const full = await makePdf();
    const preparedDocument = full.slice(0, 40);
    await expect(sealer.seal(await makeRequest({ preparedDocument }))).rejects.toBeInstanceOf(
      SealingError,
    );
  });

  it("never leaks a pdf-lib error type to the caller", async () => {
    const preparedDocument = new TextEncoder().encode("%PDF-1.7 garbage");
    const error = await sealer.seal(await makeRequest({ preparedDocument })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SealingError);
    // The library's own error is preserved as `cause` for logs, but the type a
    // caller branches on is ours.
    expect(String((error as SealingError).constructor.name)).toMatch(
      /^(InvalidPdfError|UnsupportedPdfError)$/,
    );
  });

  it("classifies failures as retryable or not", async () => {
    const preparedDocument = new TextEncoder().encode("not a pdf");
    // Narrowed rather than asserted: `.catch()` widens the result to
    // `SealResult | SealingError`, and casting past that hid a type error from
    // `npm run typecheck` for a whole command.
    const outcome: unknown = await sealer
      .seal(await makeRequest({ preparedDocument }))
      .catch((e: unknown) => e);

    expect(outcome).toBeInstanceOf(SealingError);
    // A malformed document will be malformed on every retry. Marking it
    // retryable would have the completion pipeline loop over a permanent fault.
    expect((outcome as SealingError).retryable).toBe(false);
  });

  it("exposes a stable machine-readable code on every error", () => {
    const codes = [
      new InvalidPdfError("x").code,
      new UnsupportedPdfError("x").code,
      new InvalidFieldPlacementError("x").code,
      new InvalidSealInputError("x").code,
    ];
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[a-z_]+$/);
  });
});
