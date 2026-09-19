// Every embedded face must carry the tables real viewers insist on.
//
// ── The bug this exists to stop returning ──────────────────────────────────
//
// Fonts were embedded with `subset: true`, the obvious economy: write only the
// glyphs actually drawn instead of ~630 KB of face. It produced completion
// certificates that most people could not read. Reported from production, the
// appended certificate page rendered "Certificate of Completion" as
// "C    of Co     o" — text present, most glyphs missing.
//
// ── Why nothing caught it ──────────────────────────────────────────────────
//
// Because by every structural measure the file was CORRECT. Measured on the
// subset build:
//
//   content stream asked for 49 distinct CIDs, max 49
//   embedded subset held 50 glyphs, 49 of them with outlines
//   CIDs out of range: 0
//   font program byte-identical before and after `copyPages`
//
// Nothing was truncated, nothing was mis-numbered, nothing was lost in the
// seal. pdf.js renders that file perfectly — which is why LAGDA's own in-app
// viewer never showed a problem, and why the defect only surfaced once a
// DOWNLOAD button put the bytes in front of an ordinary PDF reader.
//
// What the subset omitted was tables a CIDFontType2 with identity mapping does
// not strictly need:
//
//   SUBSET TABLES: glyf head hhea hmtx loca maxp prep
//
// No `cmap`, `name`, `post` or `OS/2`. PDFium (Chrome, Edge) and Quartz
// (macOS Preview) consult the embedded TrueType's `cmap` anyway, decline a
// font that has none, and substitute one — against which the CIDs mean
// nothing. Hence a few coincidentally-correct glyphs and blanks everywhere
// else.
//
// ── What this test asserts, and why in this shape ──────────────────────────
//
// The structural checks above all PASSED on the broken build, so none of them
// is the regression test. The property that actually distinguishes a file
// every viewer can read is the presence of those tables, so that is what is
// pinned here — directly, by parsing the embedded font program.
//
// A signed document is read in whatever the recipient happens to have. The
// ~630 KB per face is the right side of that trade; the reverse judgement was
// made when only file size was visible.

import { describe, it, expect } from "vitest";
import { PDFDocument, PDFName, PDFDict, PDFRawStream } from "pdf-lib";
import { inflateSync } from "node:zlib";
import { NodeCompletionCertificateGenerator } from "./node-completion-certificate-generator.js";
import { NodeFieldMerger } from "./node-field-merger.js";
import { buildTestPdf } from "./testing/fixtures.js";
import type { MergeableField } from "@lagda/application";
import {
  COMPLETION_CERTIFICATE_VERSION,
  type CompletionCertificateModelV1,
} from "@lagda/application";

const AT = Date.parse("2026-09-20T09:00:00.000Z");

/**
 * Tables a TrueType font must carry to load in a mainstream viewer.
 *
 * `cmap` is the one that broke; the others travel with it and their absence
 * means the same subsetting path has come back.
 */
const REQUIRED_TABLES = ["cmap", "name", "post", "OS/2"] as const;

/** The tables of every embedded font program in a PDF, keyed by font name. */
async function embeddedFontTables(
  bytes: Uint8Array,
): Promise<Map<string, string[]>> {
  const pdf = await PDFDocument.load(bytes);
  const byFont = new Map<string, string[]>();

  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    if (object.get(PDFName.of("Type"))?.toString() !== "/FontDescriptor") continue;

    const ref = object.get(PDFName.of("FontFile2"));
    if (ref === undefined) continue;
    const stream = pdf.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;

    // The font program is Flate-encoded inside the PDF; reading it raw finds
    // no table directory at all.
    let font: Buffer;
    try { font = inflateSync(Buffer.from(stream.contents)); }
    catch { font = Buffer.from(stream.contents); }

    const tableCount = font.readUInt16BE(4);
    const tags: string[] = [];
    for (let i = 0; i < tableCount; i++) {
      tags.push(font.subarray(12 + i * 16, 12 + i * 16 + 4).toString("latin1"));
    }
    byFont.set(object.get(PDFName.of("FontName"))?.toString() ?? "?", tags);
  }
  return byFont;
}

const certificateModel = (): CompletionCertificateModelV1 => ({
  certificateVersion: COMPLETION_CERTIFICATE_VERSION,
  signingRequestId: "sr_1",
  documentTitle: "Contract of Lease",
  // Branded. The cast is load-bearing despite a file-scoped lint run
  // claiming otherwise — `npm run typecheck` rejects it without one.
  sourceDocumentDigest: "a".repeat(64) as never,
  participants: [{
    recipientId: "srr_1" as never,
    name: "Juan dela Cruz",
    maskedEmail: "j***@example.com",
    routingOrder: 1,
    orderIndex: 0,
    authenticationMethod: "email-otp",
    firstEnteredAt: AT,
    consent: {
      consentType: "electronic-records",
      consentVersion: "1.2",
      acceptedAt: AT,
    },
    signedAt: AT,
  }] as never,
  generatedAt: AT,
});

describe("the completion certificate's fonts", () => {
  it("embeds every table a mainstream viewer needs", async () => {
    const generator = new NodeCompletionCertificateGenerator();
    const result = await generator.generate(certificateModel());

    const fonts = await embeddedFontTables(result.certificate);
    expect(fonts.size).toBeGreaterThan(0);

    for (const [name, tables] of fonts) {
      for (const required of REQUIRED_TABLES) {
        expect(tables, `${name} is missing ${required}`).toContain(required);
      }
    }
  });

  it("embeds the whole face, not the glyphs it happened to draw", async () => {
    // The direct statement of the fix. A subset of a few dozen glyphs is what
    // produced an unreadable certificate; the full face is ~300 KB compressed.
    const generator = new NodeCompletionCertificateGenerator();
    const result = await generator.generate(certificateModel());

    const pdf = await PDFDocument.load(result.certificate);
    let largest = 0;
    for (const [, object] of pdf.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFDict)) continue;
      if (object.get(PDFName.of("Type"))?.toString() !== "/FontDescriptor") continue;
      const ref = object.get(PDFName.of("FontFile2"));
      if (ref === undefined) continue;
      const stream = pdf.context.lookup(ref);
      if (stream instanceof PDFRawStream) {
        largest = Math.max(largest, stream.contents.length);
      }
    }
    // A subset of this certificate's text was ~3 KB. Anything near that size
    // means subsetting is back.
    expect(largest).toBeGreaterThan(100_000);
  });
});

describe("the merged document's fonts", () => {
  it("embeds every table a mainstream viewer needs", async () => {
    // The same faces draw typed signatures onto the document itself. A
    // certificate nobody can read is bad; a SIGNATURE nobody can see is worse,
    // and both came from the same embed call.
    const merger = new NodeFieldMerger();
    const field: MergeableField = {
      fieldId: "field-1",
      pageNumber: 1,
      rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
      value: {
        kind: "signature",
        representation: { kind: "typed", text: "Maria Santos", styleIndex: 0 },
      },
    };

    const merged = await merger.mergeFields({
      sourceDocument: await buildTestPdf(1),
      fields: [field],
      mergedAt: new Date(AT).toISOString(),
    });

    const fonts = await embeddedFontTables(merged.mergedDocument);
    expect(fonts.size).toBeGreaterThan(0);

    for (const [name, tables] of fonts) {
      for (const required of REQUIRED_TABLES) {
        expect(tables, `${name} is missing ${required}`).toContain(required);
      }
    }
  });
});
