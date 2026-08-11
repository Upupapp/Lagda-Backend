// The Node implementation of the field-merge seam.
//
// The completion pipeline's `field-merge` step calls this and nothing else. It
// produces the `merged-candidate` artifact: the source document with every
// accepted value rendered onto it, NOT sealed and NOT final — §8 and §81 both
// forbid calling it final.
//
// It never invokes `DocumentSealer`. That separation is the whole reason
// migration 026 reversed the step ledger; see the vocabulary comment in
// `@lagda/contracts`.

import { PDFDocument } from "pdf-lib";
import type {
  FieldMerger, MergeFieldsRequest, MergeFieldsResult,
} from "@lagda/application";
import { sha256 } from "./internal/digest.js";
import { mergeFields, serialize } from "./internal/merge.js";
import {
  InvalidPdfError,
  InvalidSealInputError,
  PdfProcessingError,
  SealingError,
  UnsupportedPdfError,
} from "./errors/index.js";

/** Every PDF begins with this signature. */
const PDF_MAGIC = "%PDF-";

function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (bytes[i] !== PDF_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

export class NodeFieldMerger implements FieldMerger {
  async mergeFields(request: MergeFieldsRequest): Promise<MergeFieldsResult> {
    const { sourceDocument, fields, mergedAt } = request;

    if (sourceDocument.length === 0) {
      throw new InvalidSealInputError("The source document is empty.");
    }
    if (!looksLikePdf(sourceDocument)) {
      throw new InvalidPdfError("The source document is not a PDF.");
    }

    // §97: hash the INPUT before anything can touch it, and the OUTPUT after
    // every byte-changing step. Two digests, named for what they identify. One
    // ambiguous `hash` is how a verification page compares against the wrong
    // file.
    //
    // This digest is also what lets the step prove it merged onto the bytes the
    // signing request froze, rather than onto whatever storage returned.
    const sourceDocumentHash = sha256(sourceDocument);

    const pdf = await this.load(sourceDocument);
    const renderedFieldCount = await this.render(pdf, fields);

    // Pin the modification date to the SUPPLIED `mergedAt`.
    //
    // pdf-lib stamps it from the system clock on save, which makes output
    // non-deterministic across a one-second boundary — a determinism test that
    // fails intermittently is worse than one that fails consistently. The value
    // is already in the request, so this removes a hidden clock read rather
    // than adding a workaround.
    const mergedAtDate = new Date(mergedAt);
    if (!Number.isNaN(mergedAtDate.getTime())) {
      pdf.setModificationDate(mergedAtDate);
    }

    const mergedDocument = await serialize(pdf);

    return {
      mergedDocument,
      sourceDocumentHash,
      // Computed from the exact bytes returned above — not from an intermediate
      // buffer, and not before serialization.
      mergedDocumentHash: sha256(mergedDocument),
      renderedFieldCount,
    };
  }

  private async load(bytes: Uint8Array): Promise<PDFDocument> {
    let pdf: PDFDocument;
    try {
      // A copy, so the caller's buffer is never mutated. pdf-lib may retain and
      // write through the array it is given, and the caller still needs those
      // bytes to match `sourceDocumentHash`.
      pdf = await PDFDocument.load(Uint8Array.from(bytes), {
        // Loud rather than lenient: silently repairing a damaged document would
        // produce a merged candidate whose relationship to the original is
        // unknown.
        ignoreEncryption: false,
        throwOnInvalidObject: true,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/encrypt/i.test(message)) {
        throw new UnsupportedPdfError(
          "The source document is encrypted and cannot be merged.",
          cause,
        );
      }
      throw new InvalidPdfError("The source document could not be parsed.", cause);
    }

    // pdf-lib's loader is TOLERANT: bytes beginning with `%PDF-` followed by
    // nothing usable parse without complaint into a document with no pages, and
    // `throwOnInvalidObject` does not change that. The failure would then
    // surface much later — during font embedding — as a generic processing
    // error marked RETRYABLE, so the completion pipeline would retry a
    // permanently malformed file forever.
    //
    // Read defensively: on a document whose catalog never materialized,
    // `getPageCount()` throws a raw `TypeError` from inside the library, and an
    // unguarded call would let a pdf-lib error escape the seam — the exact leak
    // INV-008 forbids.
    let pageCount: number;
    try {
      pageCount = pdf.getPageCount();
    } catch (cause) {
      throw new InvalidPdfError("The source document has no readable page tree.", cause);
    }
    if (pageCount === 0) {
      throw new InvalidPdfError("The source document contains no pages.");
    }

    return pdf;
  }

  private async render(
    pdf: PDFDocument,
    fields: MergeFieldsRequest["fields"],
  ): Promise<number> {
    try {
      return await mergeFields(pdf, fields);
    } catch (cause) {
      // Placement, coverage and representation errors are already LAGDA-owned
      // and specific; rewrapping them as a generic processing failure would
      // lose which field was wrong AND flip a terminal failure into a retryable
      // one, so the pipeline would retry a document that can never render.
      if (cause instanceof SealingError) throw cause;
      throw new PdfProcessingError("Failed to render merged fields.", cause);
    }
  }
}
