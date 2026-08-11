// PDF fixtures for tests in OTHER packages.
//
// Exported from here because INV-001 confines pdf-lib to this package, and a
// test that needs a genuine PDF is not an exemption from that — the lint rule
// caught exactly this and the fix was to move the helper rather than widen the
// ban.

import { PDFDocument } from "pdf-lib";
import { deflateSync } from "node:zlib";

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

const PNG_CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (PNG_CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * A REAL PNG, not a stub with a PNG-looking header.
 *
 * A drawn signature is the one field value that is binary, and the renderer
 * embeds it through `pdf-lib`'s decoder. A fixture of arbitrary bytes with a
 * `\x89PNG` prefix would be rejected by that decoder, so a test using one could
 * only ever prove the failure path — the successful embed would be untestable
 * and the drawn-signature renderer would have no positive coverage at all.
 *
 * Opaque near-black RGBA, which is what a signature canvas actually produces.
 */
export function buildTestSignaturePng(width = 8, height = 4): Uint8Array {
  if (width < 1 || height < 1) {
    throw new RangeError("buildTestSignaturePng requires positive dimensions.");
  }

  // One filter byte per scanline, then RGBA pixels.
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const offset = y * stride + 1 + x * 4;
      raw[offset] = 20;
      raw[offset + 1] = 24;
      raw[offset + 2] = 33;
      raw[offset + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA

  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", deflateSync(raw)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
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
