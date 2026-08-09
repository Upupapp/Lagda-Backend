// PDF fixtures for tests in OTHER packages.
//
// Exported from here because INV-001 confines pdf-lib to this package, and a
// test that needs a genuine PDF is not an exemption from that — the lint rule
// caught exactly this and the fix was to move the helper rather than widen the
// ban.

import { PDFDocument } from "pdf-lib";

/**
 * A real, structurally valid PDF with the requested page count.
 *
 * `pages` must be at least 1: pdf-lib adds a default A4 page when saving a
 * document that has none, so asking for 0 silently produces a one-page file.
 *
 * Dates are pinned so the bytes are deterministic across runs — pdf-lib stamps
 * the creation and modification dates from the system clock otherwise, which
 * made a sealing test intermittently fail across a one-second boundary.
 */
export async function buildTestPdf(pages = 1): Promise<Uint8Array> {
  if (pages < 1) {
    throw new RangeError(
      "buildTestPdf requires at least one page; pdf-lib adds a default page "
      + "when saving an empty document, so 0 would quietly produce 1.",
    );
  }
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) pdf.addPage([612, 792]);
  pdf.setCreationDate(new Date(0));
  pdf.setModificationDate(new Date(0));
  return pdf.save();
}

/**
 * A PDF with arbitrary bytes appended after `%%EOF`.
 *
 * Trailing data is legal in PDF and a real parser still reads the document, so
 * this produces a file that is structurally valid AND contains an exact byte
 * pattern — the combination a malware-scanning test needs.
 */
export async function buildTestPdfWithTrailingBytes(
  trailing: string, pages = 1,
): Promise<Uint8Array> {
  const base = await buildTestPdf(pages);
  const suffix = new TextEncoder().encode(`\n%${trailing}\n`);
  const out = new Uint8Array(base.byteLength + suffix.byteLength);
  out.set(base, 0);
  out.set(suffix, base.byteLength);
  return out;
}
