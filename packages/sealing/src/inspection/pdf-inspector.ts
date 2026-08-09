// Document inspection.
//
// ── Why this lives in @lagda/sealing ───────────────────────────────────────
//
// INV-001 confines every PDF library to this package. Structural PDF validation
// needs a PDF parser, so the choice was: add a SECOND PDF library somewhere
// else, or expose a narrow inspection capability from the package that already
// owns one. A second parser would mean two libraries with the same CVE surface
// in two places, and would make INV-001 a rule with an exception rather than a
// rule.
//
// This is inspection ONLY. It never seals, never rewrites and never returns a
// pdf-lib object. `DocumentSealer.seal()` is deliberately not used to test
// whether a PDF is valid (§36): sealing embeds fonts and fields and produces new
// bytes, so using it as a validator would be both far more expensive and a
// different question from the one being asked.

import { PDFDocument } from "pdf-lib";
import { fileTypeFromBuffer } from "file-type";
import type {
  DocumentInspector, InspectionResult, SupportedMediaType,
} from "@lagda/application";

/**
 * A technical ceiling on parsing effort, not a commercial limit.
 *
 * A few hundred kilobytes can declare an enormous page tree. This bounds what
 * later field placement and rendering are asked to handle (§121). The product's
 * own page limit, if one ever exists, belongs to the plan layer.
 */
const MAX_INSPECTABLE_PAGES = 2_000;

const PDF: SupportedMediaType = "application/pdf";

export function createPdfInspector(): DocumentInspector {
  return {
    async inspect(bytes: Uint8Array): Promise<InspectionResult> {
      // ── 1. What IS this, by content? ─────────────────────────────────────
      //
      // A maintained signature detector rather than a hand-rolled
      // `startsWith("%PDF-")`, which would accept an HTML file whose first line
      // happens to be a PDF header and would say nothing about what the file
      // actually is (§117). This is what makes "document.pdf containing HTML"
      // and "a DOCX declared as application/pdf" both nameable rejections
      // rather than mysterious parse failures.
      let detected: string | undefined;
      try {
        const result = await fileTypeFromBuffer(bytes);
        detected = result?.mime;
      } catch {
        return { outcome: "rejected", failure: "inspection-failed", detail: "type detection failed" };
      }

      if (detected !== PDF) {
        return {
          outcome: "rejected",
          failure: "unsupported-type",
          // The DETECTED type, never the client's claim or the filename. Safe
          // to report: it is LAGDA's own determination about structure.
          detail: detected ?? "unrecognised",
        };
      }

      // ── 2. Is it structurally usable? ────────────────────────────────────
      //
      // Detection proves the header. It does not prove the file parses, that
      // the page tree exists, or that anyone can sign it. A polyglot begins
      // with a valid PDF signature and is exactly why this second stage exists
      // (§33).
      let document: PDFDocument;
      try {
        document = await PDFDocument.load(bytes, {
          // `false` so an encrypted PDF THROWS instead of being silently
          // accepted as an unreadable document that fails later in preparation
          // (§37). The throw is caught below and classified.
          ignoreEncryption: false,
          // Do not repair. Silently fixing a malformed file would change the
          // bytes LAGDA hashed, and the accepted artifact must be exactly what
          // was uploaded (§176).
          updateMetadata: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/encrypt/i.test(message)) {
          // Classified by the ONE library behaviour that has no structured
          // signal: pdf-lib reports encryption only through its message. The
          // string never escapes - a stable LAGDA failure code does (§38).
          return { outcome: "rejected", failure: "encrypted", detail: "encrypted pdf" };
        }
        return { outcome: "rejected", failure: "malformed", detail: "unparseable pdf" };
      }

      let pageCount: number;
      try {
        // Guarded separately: a document with no page tree throws a raw
        // TypeError here rather than at load, the same trap BACKEND-09 hit.
        pageCount = document.getPageCount();
      } catch {
        return { outcome: "rejected", failure: "malformed", detail: "no page tree" };
      }

      if (pageCount === 0) {
        return { outcome: "rejected", failure: "malformed", detail: "no pages" };
      }
      if (pageCount > MAX_INSPECTABLE_PAGES) {
        return { outcome: "rejected", failure: "too-many-pages", detail: "page limit" };
      }

      // ── 3. Page geometry, which the product actually needs ───────────────
      //
      // Handoff §7 requires pageCount and page dimensions for field placement.
      // Collected here because the document is already parsed; nothing else is
      // kept "in case it is useful".
      const pageSizes: { width: number; height: number }[] = [];
      try {
        for (const page of document.getPages()) {
          const { width, height } = page.getSize();
          if (!Number.isFinite(width) || !Number.isFinite(height)
            || width <= 0 || height <= 0) {
            // Field placement divides by these. A zero or negative page is not
            // something later code should discover (§41).
            return { outcome: "rejected", failure: "malformed", detail: "invalid page size" };
          }
          pageSizes.push({ width, height });
        }
      } catch {
        return { outcome: "rejected", failure: "malformed", detail: "unreadable pages" };
      }

      return {
        outcome: "ok",
        detectedMediaType: PDF,
        pageCount,
        pageSizes,
      };
    },
  };
}
