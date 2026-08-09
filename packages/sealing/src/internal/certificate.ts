// The completion certificate.
//
// A SEPARATE artifact, not a page appended to the document. Handoff §15 stores
// "original PDF + signed PDF + completion certificate + evidence log" as
// distinct things, and appending would change the signed document's page count
// — so the file people signed is no longer the file they received.
//
// What it is: a human-readable record of who acted, when, and against which
// bytes. What it is NOT: a cryptographic attestation. It carries no signature
// and asserts none. See SEAL_METADATA.md.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { CompletionEvidence } from "@lagda/application";
import type { Sha256Digest, VerificationId } from "@lagda/contracts";
import { PdfProcessingError } from "../errors/index.js";

// A4 portrait in PDF points, matching the frontend's stated page geometry
// ("A4 portrait (595x842 CSS px at 100% zoom)").
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;

const INK = rgb(0.07, 0.09, 0.13);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.87, 0.9);

export interface CertificateInput {
  readonly evidence: CompletionEvidence;
  readonly verificationId: VerificationId;
  readonly preparedDocumentHash: Sha256Digest;
  readonly sealedAt: string;
}

/**
 * Breaks a string so it fits a width, splitting mid-token when a token alone is
 * too long.
 *
 * The mid-token case is not hypothetical: a SHA-256 digest is one 64-character
 * token with no break opportunity, and word-wrapping alone would run it off the
 * page — invisible in a passing test that only asserts the text was drawn.
 */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";

  const flush = (): void => {
    if (line.length > 0) {
      lines.push(line);
      line = "";
    }
  };

  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    flush();
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      line = word;
      continue;
    }
    // Unbreakable token — split by character.
    let chunk = "";
    for (const char of word) {
      if (font.widthOfTextAtSize(chunk + char, size) > maxWidth) {
        lines.push(chunk);
        chunk = char;
      } else {
        chunk += char;
      }
    }
    line = chunk;
  }
  flush();
  return lines;
}

/**
 * Renders the certificate as a standalone PDF.
 *
 * Deterministic: every value comes from the input. Nothing here reads a clock,
 * so sealing the same request twice produces the same document.
 */
export async function renderCertificate(input: CertificateInput): Promise<Uint8Array> {
  const { evidence, verificationId, preparedDocumentHash, sealedAt } = input;

  try {
    const pdf = await PDFDocument.create();
    const body = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

    let page: PDFPage = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let cursor = PAGE_HEIGHT - MARGIN;
    const contentWidth = PAGE_WIDTH - MARGIN * 2;

    // Page breaks are handled, not assumed away. A transaction with thirty
    // participants would otherwise render its last rows below the page edge and
    // still return a structurally valid PDF.
    const ensureRoom = (needed: number): void => {
      if (cursor - needed < MARGIN) {
        page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        cursor = PAGE_HEIGHT - MARGIN;
      }
    };

    const write = (
      text: string,
      opts: { size: number; font: PDFFont; color?: typeof INK; gap?: number },
    ): void => {
      for (const line of wrap(text, opts.font, opts.size, contentWidth)) {
        ensureRoom(opts.size + 4);
        cursor -= opts.size + 2;
        page.drawText(line, {
          x: MARGIN, y: cursor, size: opts.size, font: opts.font,
          color: opts.color ?? INK,
        });
      }
      cursor -= opts.gap ?? 0;
    };

    const rule = (): void => {
      ensureRoom(12);
      cursor -= 8;
      page.drawLine({
        start: { x: MARGIN, y: cursor }, end: { x: PAGE_WIDTH - MARGIN, y: cursor },
        thickness: 0.75, color: RULE,
      });
      cursor -= 12;
    };

    write("Certificate of Completion", { size: 20, font: bold });
    write("LAGDA Electronic Signature", { size: 10, font: body, color: MUTED, gap: 6 });
    rule();

    write("Document", { size: 9, font: bold, color: MUTED });
    write(evidence.documentName, { size: 12, font: body, gap: 10 });

    write("Verification ID", { size: 9, font: bold, color: MUTED });
    write(verificationId, { size: 11, font: body, gap: 10 });

    write("Completed", { size: 9, font: bold, color: MUTED });
    write(evidence.completedAt, { size: 11, font: body, gap: 10 });

    write("Sealed", { size: 9, font: bold, color: MUTED });
    write(sealedAt, { size: 11, font: body, gap: 10 });

    // The PREPARED document's digest only. The sealed document's digest cannot
    // appear here: the certificate is an input to nothing, but printing a hash
    // of bytes that do not exist yet would be a value invented to fill a field.
    write("Prepared document SHA-256", { size: 9, font: bold, color: MUTED });
    write(preparedDocumentHash, { size: 10, font: body, gap: 10 });

    rule();
    write("Participants", { size: 12, font: bold, gap: 4 });

    for (const participant of evidence.participants) {
      write(participant.name, { size: 11, font: bold });
      write(`${participant.action} — ${participant.completedAt}`, {
        size: 10, font: body, color: MUTED, gap: 8,
      });
    }

    if (evidence.participants.length === 0) {
      write("No participant actions recorded.", { size: 10, font: body, color: MUTED, gap: 8 });
    }

    rule();
    // Stated plainly rather than implied. A certificate that stays silent about
    // what it proves invites the reader to assume more than it claims.
    write(
      "This certificate records the completion evidence held by LAGDA for the "
        + "document identified above. It is not a digital signature certificate "
        + "and does not itself attest to signer identity.",
      { size: 8, font: body, color: MUTED },
    );

    return await pdf.save();
  } catch (cause) {
    throw new PdfProcessingError("Failed to render the completion certificate.", cause);
  }
}
