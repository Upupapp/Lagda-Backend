// The Node implementation of the flowing-document-generation seam (070,
// replacing 066's fixed-canvas `NodeTemplateDocumentGenerator`).
//
// This is thin on purpose: `flow-layout.ts` does every real decision (where
// a line breaks, where a page breaks, where an anchor lands), taking only a
// `measure` function as input. This file's whole job is to BE that function
// — backed by real embedded fonts — and to turn the resulting draw
// operations into actual `page.drawText` calls. Persisting the result as an
// artifact and attaching it to a template are the USE CASE's job, not this
// adapter's, same as 066's version.

import { PDFDocument, rgb, type PDFPage } from "pdf-lib";
import type {
  FlowDocumentGenerator, GenerateFlowDocumentRequest, GenerateFlowDocumentResult,
} from "@lagda/application";
import { sha256 } from "./internal/digest.js";
import { embedDocumentFonts, assertDocumentTextRenderable } from "./internal/document-fonts.js";
import {
  layoutFlowDocument, collectFlowDocumentStyles, PAGE_WIDTH, PAGE_HEIGHT,
  type RunStyle, type MeasureFn,
} from "./internal/flow-layout.js";
import { SealingError, PdfProcessingError } from "./errors/index.js";

/** Body ink. Not pure black — the same softened tone 066's renderer used,
 *  so authored prose reads the way the rest of this product's PDF output
 *  already does. */
const INK = rgb(0.07, 0.09, 0.13);
/** The bracketed placeholder a `variableRef`/`fieldAnchor` token draws in —
 *  visibly a slot to fill, not the document's own prose. */
const PLACEHOLDER_INK = rgb(0.4, 0.45, 0.52);

export class NodeFlowDocumentGenerator implements FlowDocumentGenerator {
  async generate(request: GenerateFlowDocumentRequest): Promise<GenerateFlowDocumentResult> {
    try {
      const pdf = await PDFDocument.create();
      const fonts = embedDocumentFonts(pdf);

      // Pinned from the caller, so two renders of the same content are
      // byte-identical — pdf-lib stamps both from the system clock otherwise.
      const generated = new Date(request.generatedAt);
      pdf.setCreationDate(generated);
      pdf.setModificationDate(generated);

      // ── Pass 1: measure only, no drawing yet ──────────────────────────────
      //
      // The layout engine needs real widths to decide where lines break
      // BEFORE any page exists to draw on. Every style used anywhere in the
      // document is pre-checked for glyph coverage here too, so a name with
      // an unsupported character is refused before a single page is added —
      // never a half-rendered document.
      const measure: MeasureFn = (text, style) => {
        assertDocumentTextRenderable(text, style.family, style.bold, style.italic);
        return this.measured.get(this.styleKey(style))!.widthOfTextAtSize(text, style.size);
      };

      // Embeds every (family, bold, italic) combination the document
      // actually uses, once, before layout runs — `measure` above assumes
      // `this.measured` is already populated for any style it is asked
      // about.
      await this.preEmbed(request, fonts);

      const layout = layoutFlowDocument(request.content, measure);

      // ── Pass 2: real pages, real drawing ──────────────────────────────────
      const pages: PDFPage[] = [];
      for (let i = 0; i < layout.pageCount; i += 1) {
        pages.push(pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]));
      }

      for (const op of layout.drawOps) {
        const page = pages[op.page];
        if (page === undefined) continue; // defensive; layout never emits an out-of-range page
        const font = this.measured.get(this.styleKey(op.style))!;
        const color = op.placeholder ? PLACEHOLDER_INK : INK;
        page.drawText(op.text, { x: op.x, y: op.y, size: op.style.size, font, color });
        if (op.underline) {
          const width = font.widthOfTextAtSize(op.text, op.style.size);
          page.drawLine({
            start: { x: op.x, y: op.y - 2 }, end: { x: op.x + width, y: op.y - 2 },
            thickness: 0.75, color,
          });
        }
      }

      const bytes = await pdf.save();
      return {
        bytes,
        digest: sha256(bytes),
        pageCount: layout.pageCount,
        resolvedAnchors: layout.resolvedAnchors.map(a => ({
          fieldType: a.anchor.fieldType,
          ...(a.anchor.slotId === undefined ? {} : { slotId: a.anchor.slotId }),
          ...(a.anchor.variableKey === undefined ? {} : { variableKey: a.anchor.variableKey }),
          required: a.anchor.required,
          label: a.anchor.label,
          pageNumber: a.pageNumber,
          rect: a.rect,
        })),
      };
    } catch (cause) {
      // A coverage refusal or an overflow is already LAGDA-owned, specific
      // and TERMINAL — rewrapping it would lose which run could not be
      // rendered and flip it retryable, so a document that can never
      // generate would be retried forever.
      if (cause instanceof SealingError) throw cause;
      // Never carries document text — the same reason 066's renderer never
      // logged block text.
      throw new PdfProcessingError("Failed to render the document.", cause);
    }
  }

  /** One embedded `PDFFont` per (family, bold, italic) combination, filled
   *  by `preEmbed` before layout runs and read by `measure`/drawing after.
   *  Per-instance, not module-level: a fresh generator per call keeps two
   *  concurrent generations from sharing (and racing on) this cache. */
  private readonly measured = new Map<string, Awaited<ReturnType<ReturnType<typeof embedDocumentFonts>["face"]>>>();

  private styleKey(style: RunStyle): string {
    return `${style.family}:${style.bold ? "b" : ""}${style.italic ? "i" : ""}`;
  }

  /** Embeds every (family, bold, italic) combination the document actually
   *  uses, once each — mirrors `embedFaces`' own lazy-per-face posture, just
   *  resolved up front instead of on first draw, because `measure` (pass 1)
   *  needs the font object before any drawing happens. The style discovery
   *  itself lives in `flow-layout.ts`'s `collectFlowDocumentStyles`, shared
   *  rather than re-walked here, so there is one place that knows how a
   *  style is derived from a document. */
  private async preEmbed(
    request: GenerateFlowDocumentRequest, fonts: ReturnType<typeof embedDocumentFonts>,
  ): Promise<void> {
    for (const style of collectFlowDocumentStyles(request.content)) {
      const font = await fonts.face(style.family, style.bold, style.italic);
      this.measured.set(this.styleKey({ ...style, size: 0 }), font);
    }
  }
}
