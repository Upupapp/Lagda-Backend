// The Node implementation of the sealing seam.
//
// This is the ONLY class in the backend that touches a PDF library. Everything
// else knows `DocumentSealer`. When a Java or .NET signing service replaces it,
// a `RemoteDocumentSealer` implements the same interface and no caller changes
// — see REMOTE_SIGNER_MIGRATION.md for what that swap actually costs.

import { PDFDocument } from "pdf-lib";
import type {
  DocumentSealer,
  SealRequest,
  SealResult,
  SealMetadata,
} from "@lagda/application";
import { sha256 } from "./internal/digest.js";
import {
  InvalidPdfError,
  InvalidSealInputError,
  PdfProcessingError,
  UnsupportedPdfError,
} from "./errors/index.js";

/**
 * How this implementation seals. Constant, not derived.
 *
 * `sealVersion` is the version of the PROCEDURE. It changes only when a change
 * alters how already-sealed artifacts must be interpreted — not when this file
 * is edited, and not when the package version bumps.
 */
const SEAL_METADATA: SealMetadata = {
  sealScheme: "hash-evidence",
  sealVersion: 1,
  digestAlgorithm: "sha-256",
};

/** Every PDF begins with this signature. */
const PDF_MAGIC = "%PDF-";

function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (bytes[i] !== PDF_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

export class NodeDocumentSealer implements DocumentSealer {
  async seal(request: SealRequest): Promise<SealResult> {
    const { mergedDocument, completionCertificate, sealedAt } = request;

    if (mergedDocument.length === 0) {
      throw new InvalidSealInputError("The merged document is empty.");
    }
    if (!looksLikePdf(mergedDocument)) {
      throw new InvalidPdfError("The merged document is not a PDF.");
    }
    if (completionCertificate.length === 0) {
      throw new InvalidSealInputError("The completion certificate is empty.");
    }
    if (!looksLikePdf(completionCertificate)) {
      throw new InvalidPdfError("The completion certificate is not a PDF.");
    }

    // §97: hash the INPUT before anything can touch it, and the OUTPUT after
    // every byte-changing step. Two artifacts, two digests, named for what they
    // identify. One ambiguous `hash` is how a verification page ends up
    // comparing against the wrong file.
    const mergedDocumentHash = sha256(mergedDocument);
    // Hashed here for the same reason, and returned so the caller can check it
    // against the certificate artifact's recorded digest.
    const completionCertificateHash = sha256(completionCertificate);

    // §96, in order: load → compose → serialize → hash.
    //
    // NO FIELD MERGING and NO CERTIFICATE RENDERING. OD-162 and OD-167: the
    // field-merge and certificate steps produce those, and this method receives
    // both as finished bytes. Producing either again would duplicate it.
    const pdf = await this.load(mergedDocument);

    // ── The composition ────────────────────────────────────────────────────
    //
    // Signed pages first, certificate pages last (§18). One downloadable file
    // that carries its own completion record, which is what a recipient asked
    // for a copy would otherwise have to assemble themselves.
    //
    // Page-level work lives HERE, inside the sealing package, and is reached
    // through a semantic `completionCertificate` input rather than an
    // `appendPages()` method on the port — §21 and §22. A remote signer
    // implementing this seam receives two documents and a instruction to seal
    // them as one; it is never told how to manipulate pages.
    await this.appendCertificate(pdf, completionCertificate);

    // Pin the document's modification date to the SUPPLIED `sealedAt`.
    //
    // pdf-lib stamps it from the system clock on save, which made the output
    // non-deterministic across a one-second boundary — the determinism test
    // failed intermittently, which is worse than failing consistently. The
    // value is already in the request, so this removes a hidden clock read
    // rather than adding a workaround.
    const sealedAtDate = new Date(sealedAt);
    if (!Number.isNaN(sealedAtDate.getTime())) {
      pdf.setModificationDate(sealedAtDate);
    }

    const sealedDocument = await this.serialize(pdf);

    return {
      sealedDocument,
      mergedDocumentHash,
      completionCertificateHash,
      // Computed from the exact bytes returned above — not from an intermediate
      // buffer, and not before serialization.
      signedDocumentHash: sha256(sealedDocument),
      seal: SEAL_METADATA,
    };
  }

  private async load(bytes: Uint8Array): Promise<PDFDocument> {
    let pdf: PDFDocument;
    try {
      // A copy, so the caller's buffer is never mutated. pdf-lib may retain and
      // write through the array it is given; the caller still needs those bytes
      // to match `preparedDocumentHash`.
      pdf = await PDFDocument.load(Uint8Array.from(bytes), {
        // Loud rather than lenient: silently repairing a damaged document would
        // produce a "sealed" artifact whose relationship to the original is
        // unknown.
        ignoreEncryption: false,
        throwOnInvalidObject: true,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/encrypt/i.test(message)) {
        throw new UnsupportedPdfError(
          "The document is encrypted and cannot be sealed.",
          cause,
        );
      }
      throw new InvalidPdfError("The prepared document could not be parsed.", cause);
    }

    // pdf-lib's loader is TOLERANT: bytes that begin with `%PDF-` followed by
    // nothing usable parse without complaint into a document with no pages, and
    // `throwOnInvalidObject` does not change that. The failure then surfaces
    // much later — during font embedding — as a generic processing error marked
    // RETRYABLE, so the completion pipeline would retry a permanently malformed
    // file forever. Rejecting it here classifies it correctly at the source.
    //
    // The count itself is read defensively: on a document whose catalog never
    // materialized, `getPageCount()` throws a raw `TypeError` from inside the
    // library, and an unguarded call here would let a pdf-lib error escape the
    // seam — the exact leak INV-008 forbids.
    let pageCount: number;
    try {
      pageCount = pdf.getPageCount();
    } catch (cause) {
      throw new InvalidPdfError("The prepared document has no readable page tree.", cause);
    }
    if (pageCount === 0) {
      throw new InvalidPdfError("The prepared document contains no pages.");
    }

    return pdf;
  }

  /**
   * Appends the certificate's pages to the end of the signed document.
   *
   * `copyPages` rather than a page reference: the certificate is a separate
   * document, and copying brings its resources — the embedded font subset above
   * all — into the final file. A reference would produce a PDF whose last pages
   * render blank everywhere except the machine that made it.
   *
   * Idempotency is NOT handled here and must not be. §124 forbids appending the
   * certificate twice on retry, and the control for that is the FINAL_SEAL step
   * accepting exactly one output — not this method trying to detect whether it
   * has run before, which it cannot do reliably and which would silently mask a
   * genuine double-composition bug.
   */
  private async appendCertificate(
    pdf: PDFDocument,
    certificate: Uint8Array,
  ): Promise<void> {
    let source: PDFDocument;
    try {
      source = await PDFDocument.load(Uint8Array.from(certificate), {
        ignoreEncryption: false,
        throwOnInvalidObject: true,
      });
    } catch (cause) {
      throw new InvalidPdfError("The completion certificate could not be parsed.", cause);
    }

    let pageCount: number;
    try {
      pageCount = source.getPageCount();
    } catch (cause) {
      throw new InvalidPdfError(
        "The completion certificate has no readable page tree.", cause);
    }
    if (pageCount === 0) {
      // A certificate with no pages would seal silently and produce a final
      // document that simply lacks its completion record.
      throw new InvalidPdfError("The completion certificate contains no pages.");
    }

    try {
      const copied = await pdf.copyPages(source, source.getPageIndices());
      for (const page of copied) pdf.addPage(page);
    } catch (cause) {
      throw new PdfProcessingError(
        "Failed to append the completion certificate.", cause);
    }
  }

  private async serialize(pdf: PDFDocument): Promise<Uint8Array> {
    try {
      return await pdf.save();
    } catch (cause) {
      throw new PdfProcessingError("Failed to serialize the sealed document.", cause);
    }
  }
}
