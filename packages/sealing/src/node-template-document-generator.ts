// The Node implementation of the template-document-generation seam (066).
//
// Renders a template's authored content — blocks of text on blank A4 pages —
// into a standalone PDF. It never touches storage, never reads a clock (the
// timestamp is supplied, matching `FieldMerger`/`CompletionCertificateGenerator`),
// and never sees a database row. Persisting the result as an artifact and
// attaching it to a template are the USE CASE's job, not this adapter's.

import { PDFDocument, type PDFPage } from "pdf-lib";
import type {
  TemplateDocumentGenerator,
  GenerateTemplateDocumentRequest,
  GenerateTemplateDocumentResult,
} from "@lagda/application";
import { sha256 } from "./internal/digest.js";
import { embedFaces } from "./internal/fonts.js";
import { drawTemplateContent } from "./internal/template-content.js";
import { InvalidSealInputError, SealingError, PdfProcessingError } from "./errors/index.js";

// A4 portrait in PDF points — the same constants `certificate.ts` uses, so a
// generated document and its eventual completion certificate share one page
// geometry rather than two independently-chosen ones.
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;

export class NodeTemplateDocumentGenerator implements TemplateDocumentGenerator {
  async generate(
    request: GenerateTemplateDocumentRequest,
  ): Promise<GenerateTemplateDocumentResult> {
    if (request.pageCount < 1) {
      throw new InvalidSealInputError("A generated document must have at least one page.");
    }

    const bytes = await this.render(request);

    return {
      bytes,
      digest: sha256(bytes),
      pageCount: request.pageCount,
    };
  }

  private async render(request: GenerateTemplateDocumentRequest): Promise<Uint8Array> {
    try {
      const pdf = await PDFDocument.create();
      const faces = embedFaces(pdf);
      const regular = await faces.face("regular");
      const bold = await faces.face("bold");

      // Pinned from the caller, so two renders of the same blocks are
      // byte-identical — pdf-lib stamps both from the system clock otherwise.
      const generated = new Date(request.generatedAt);
      pdf.setCreationDate(generated);
      pdf.setModificationDate(generated);

      const pages: PDFPage[] = [];
      for (let i = 0; i < request.pageCount; i += 1) {
        pages.push(pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]));
      }

      drawTemplateContent(pdf, pages, faces, regular, bold, request.blocks);

      return await pdf.save();
    } catch (cause) {
      // A geometry or coverage refusal is already LAGDA-owned, specific and
      // TERMINAL — rewrapping it would lose which block could not be rendered
      // and flip it retryable, so a template that can never generate would be
      // retried forever.
      if (cause instanceof SealingError) throw cause;
      // Never carries block text — see template-content.ts's own header.
      throw new PdfProcessingError("Failed to render the template's document.", cause);
    }
  }
}
