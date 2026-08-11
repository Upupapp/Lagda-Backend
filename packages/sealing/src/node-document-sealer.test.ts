// Behaviour of the sealing adapter.
//
// These tests assert on the BYTES the sealer returns, not on whether pdf-lib
// was called. A test that mocks the PDF library and checks it was invoked
// passes just as happily when the output is unopenable.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { SealRequest } from "@lagda/application";
import type {
  WorkspaceId, TransactionId, DocumentId, VerificationId,
} from "@lagda/contracts";
import { NodeDocumentSealer } from "./node-document-sealer.js";
import {
  InvalidPdfError, InvalidSealInputError, InvalidFieldPlacementError,
  UnsupportedPdfError, SealingError,
} from "./errors/index.js";
import { sha256 } from "./internal/digest.js";
import { toPdfRect } from "./internal/geometry.js";

async function makePdf(pageCount = 2): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i += 1) {
    const page = pdf.addPage([595.28, 841.89]);
    page.drawText(`Page ${String(i + 1)}`, { x: 50, y: 780, size: 12, font });
  }
  return pdf.save();
}

/** A stand-in certificate. ONE page, so composition is countable. */
async function makeCertificatePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595.28, 841.89]);
  page.drawText("Certificate", { x: 50, y: 780, size: 12, font });
  pdf.setCreationDate(new Date(0));
  pdf.setModificationDate(new Date(0));
  return pdf.save();
}

async function makeRequest(overrides: Partial<SealRequest> = {}): Promise<SealRequest> {
  return {
    workspaceId: "ws_1" as WorkspaceId,
    transactionId: "tx_1" as TransactionId,
    documentId: "doc_1" as DocumentId,
    mergedDocument: await makePdf(),
    completionCertificate: await makeCertificatePdf(),
    completionRunId: "crn_1",
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

    const expected = createHash("sha256").update(request.mergedDocument).digest("hex");
    expect(result.mergedDocumentHash).toBe(expected);
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
    expect(result.signedDocumentHash).not.toBe(result.mergedDocumentHash);
  });

  it("does not mutate the caller's buffer", async () => {
    const request = await makeRequest();
    const before = Uint8Array.from(request.mergedDocument);

    const result = await sealer.seal(request);

    expect(Array.from(request.mergedDocument)).toEqual(Array.from(before));
    // And the recorded digest still describes the caller's bytes.
    expect(result.mergedDocumentHash).toBe(sha256(before));
  });

  it("returns a sealed document that re-parses as a PDF", async () => {
    // "It returned bytes" is not evidence. Only re-opening the output proves it
    // is a document rather than a plausible-looking buffer.
    //
    // This asserted an UNCHANGED page count until BACKEND-41. It was right then
    // — nothing was composed — and asserting it now would forbid the
    // composition the command exists to add. The page count is asserted
    // exactly, with a positive control, in the composition tests below.
    const result = await sealer.seal(await makeRequest());
    const reopened = await PDFDocument.load(result.sealedDocument);
    expect(reopened.getPageCount()).toBeGreaterThan(0);
  });

  it("returns NO certificate — OD-167", async () => {
    // The twin of OD-162. `seal()` used to render the certificate too; the
    // CERTIFICATE step owns it now, and a `seal()` that still produced one
    // would hand completion two certificates with no way to tell which was
    // authoritative.
    const result = await sealer.seal(await makeRequest());
    expect("completionCertificate" in result).toBe(false);
  });

  it("APPENDS the certificate — signed pages first, certificate last", async () => {
    // BACKEND-41's composition (§17, §18). The merged fixture is 2 pages and
    // the certificate is 1, so the final document must be 3.
    const result = await sealer.seal(await makeRequest());
    const reopened = await PDFDocument.load(result.sealedDocument);
    expect(reopened.getPageCount()).toBe(3);
  });

  it("appends the certificate ONCE per seal", async () => {
    // §124/§125. Sealing twice from the same inputs must not accumulate pages —
    // each call composes from the originals rather than from its own output.
    const request = await makeRequest();
    const first = await sealer.seal(request);
    const second = await sealer.seal(request);
    expect((await PDFDocument.load(first.sealedDocument)).getPageCount()).toBe(3);
    expect((await PDFDocument.load(second.sealedDocument)).getPageCount()).toBe(3);
  });

  it("grows with a longer certificate, proving the pages are really copied", async () => {
    // The positive control for the count above: a page count of 3 could also be
    // produced by ignoring the certificate and adding a blank page.
    const threePage = await PDFDocument.create();
    for (let i = 0; i < 3; i += 1) threePage.addPage([595.28, 841.89]);
    threePage.setCreationDate(new Date(0));
    threePage.setModificationDate(new Date(0));

    const result = await sealer.seal(await makeRequest({
      completionCertificate: await threePage.save(),
    }));
    expect((await PDFDocument.load(result.sealedDocument)).getPageCount()).toBe(5);
  });

  it("refuses a certificate that is not a PDF", async () => {
    await expect(sealer.seal(await makeRequest({
      completionCertificate: new TextEncoder().encode("not a pdf"),
    }))).rejects.toBeInstanceOf(InvalidPdfError);
  });

  it("refuses an empty certificate", async () => {
    await expect(sealer.seal(await makeRequest({
      completionCertificate: new Uint8Array(0),
    }))).rejects.toBeInstanceOf(InvalidSealInputError);
  });

  it("refuses a certificate with no pages", async () => {
    // Would seal silently and produce a final document simply lacking its
    // completion record.
    await expect(sealer.seal(await makeRequest({
      completionCertificate: new TextEncoder().encode("%PDF-1.7\n%%EOF\n"),
    }))).rejects.toBeInstanceOf(InvalidPdfError);
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
    const a = await sealer.seal(await makeRequest({ mergedDocument: prepared }));
    const b = await sealer.seal(await makeRequest({ mergedDocument: prepared }));
    expect(a.signedDocumentHash).toBe(b.signedDocumentHash);
  });

  it("does NOT render fields — OD-162", async () => {
    // The assertion that keeps the double-render from coming back.
    //
    // `seal()` used to merge field values. The `field-merge` step does that now
    // and hands this method the merged candidate, so sealing must add no marks
    // of its own. If someone reinstates the merge, sealing an EMPTY document and
    // sealing it again after a real merge would stop being distinguishable in
    // the way this test measures — and every value in a completed document would
    // be drawn twice, one over the other, which reads as a font-weight bug.
    //
    // Measured as a byte delta rather than by rendering a field and looking for
    // it: `seal()` no longer accepts fields at all, so there is nothing to pass.
    // What CAN be shown is that sealing is a function of the document alone.
    const document = await makePdf();
    const first = await sealer.seal(await makeRequest({ mergedDocument: document }));
    const second = await sealer.seal(await makeRequest({ mergedDocument: document }));

    expect(first.signedDocumentHash).toBe(second.signedDocumentHash);
    // And the sealer adds no marks of its own: it no longer draws ANY text, so
    // the sealed bytes stay close to the document it was handed.
    expect(first.sealedDocument.length).toBeLessThan(document.length * 2);
  });

  it("seals a document that carries no values at all", async () => {
    // A recipient whose only action is receiving a copy leaves no fields, so the
    // merged candidate is byte-identical to the source. It must still seal, and
    // still hash.
    const result = await sealer.seal(await makeRequest());
    expect(result.signedDocumentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("NodeDocumentSealer failures", () => {
  const sealer = new NodeDocumentSealer();

  it("rejects bytes that are not a PDF", async () => {
    const mergedDocument = new TextEncoder().encode("this is not a pdf");
    await expect(sealer.seal(await makeRequest({ mergedDocument }))).rejects.toBeInstanceOf(
      InvalidPdfError,
    );
  });

  it("rejects an empty document", async () => {
    const mergedDocument = new Uint8Array(0);
    await expect(sealer.seal(await makeRequest({ mergedDocument }))).rejects.toBeInstanceOf(
      InvalidSealInputError,
    );
  });

  it("rejects a truncated PDF that starts with the right header", async () => {
    // The magic-byte check alone would let this through. Parsing is what
    // actually decides, and the failure still arrives as a LAGDA error.
    const full = await makePdf();
    const mergedDocument = full.slice(0, 40);
    await expect(sealer.seal(await makeRequest({ mergedDocument }))).rejects.toBeInstanceOf(
      SealingError,
    );
  });

  it("never leaks a pdf-lib error type to the caller", async () => {
    const mergedDocument = new TextEncoder().encode("%PDF-1.7 garbage");
    const error = await sealer.seal(await makeRequest({ mergedDocument })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SealingError);
    // The library's own error is preserved as `cause` for logs, but the type a
    // caller branches on is ours.
    expect(String((error as SealingError).constructor.name)).toMatch(
      /^(InvalidPdfError|UnsupportedPdfError)$/,
    );
  });

  it("classifies failures as retryable or not", async () => {
    const mergedDocument = new TextEncoder().encode("not a pdf");
    // Narrowed rather than asserted: `.catch()` widens the result to
    // `SealResult | SealingError`, and casting past that hid a type error from
    // `npm run typecheck` for a whole command.
    const outcome: unknown = await sealer
      .seal(await makeRequest({ mergedDocument }))
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
