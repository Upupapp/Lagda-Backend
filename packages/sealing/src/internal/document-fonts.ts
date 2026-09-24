// Typefaces for AUTHORED documents — the flowing-content engine.
//
// ── A second module, not an extension of fonts.ts ──────────────────────────
//
// `fonts.ts` renders typed signatures and the completion certificate: one
// family (Noto Sans), three faces, and a glyph-coverage contract that
// `merge.ts` depends on not changing shape. This module renders admin-typed
// document PROSE across five families a person picks from a ribbon. Folding
// the two together would mean every signature-rendering call site now reads
// a family it never asked for, for a feature it has nothing to do with. Two
// small, single-purpose modules are safer than one that serves both.
//
// The MACHINERY is deliberately identical, because it is already correct:
// lazy per-face embedding, `subset: false` (a subset TrueType with no cmap
// renders garbled outside pdf.js — see fonts.ts's own header for the
// production incident this fixed), and glyph-coverage refusal rather than a
// silently blank word. Reproducing a fix is not duplication; NOT reproducing
// it would reintroduce a bug this codebase already paid to find.
//
// ── Five families, one per ribbon choice ────────────────────────────────────
//
// Not the named commercial faces — Times New Roman, Georgia, Calibri are not
// redistributable — but their OFL-licensed, metric-compatible open-source
// counterparts, the same substitution LibreOffice and Google Docs make:
//
//   ribbon label          face            why
//   "Times New Roman"     Tinos           the legal-document default
//   "Georgia"              PT Serif        a screen-readable formal serif
//   "Helvetica"             Noto Sans       reuses fonts.ts's own vendored
//                                           file directly — one fewer face
//                                           to vendor, and it is already the
//                                           most broadly Unicode-covering
//                                           face in this codebase
//   "Calibri"               Carlito         metric-compatible Calibri clone
//   "Courier New"           Cousine         metric-compatible Courier clone

import { readFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import type { PDFDocument, PDFFont } from "pdf-lib";
import { TypefaceUnavailableError, UnrenderableTextError } from "../errors/index.js";

export type DocumentFontFamily = "times" | "georgia" | "helvetica" | "calibri" | "courier";
export const DOCUMENT_FONT_FAMILIES: readonly DocumentFontFamily[] =
  ["times", "georgia", "helvetica", "calibri", "courier"];

/**
 * No combined bold-italic face, matching `fonts.ts`'s own three-face-per-
 * family shape. A run marked both bold AND italic draws in `bold` — bold
 * carries more of a legal document's emphasis than italic does, so it is
 * the one kept when only one can be honoured.
 */
export type DocumentFontStyle = "regular" | "bold" | "italic";

function resolveStyle(bold: boolean, italic: boolean): DocumentFontStyle {
  if (bold) return "bold";
  if (italic) return "italic";
  return "regular";
}

const FAMILY_FILES: Readonly<Record<DocumentFontFamily, Readonly<Record<DocumentFontStyle, string>>>> =
  Object.freeze({
    times: Object.freeze({
      regular: "../../assets/fonts/tinos/Tinos-Regular.ttf",
      bold: "../../assets/fonts/tinos/Tinos-Bold.ttf",
      italic: "../../assets/fonts/tinos/Tinos-Italic.ttf",
    }),
    georgia: Object.freeze({
      regular: "../../assets/fonts/pt-serif/PTSerif-Regular.ttf",
      bold: "../../assets/fonts/pt-serif/PTSerif-Bold.ttf",
      italic: "../../assets/fonts/pt-serif/PTSerif-Italic.ttf",
    }),
    // The SAME files fonts.ts embeds for signatures — not a copy. One face
    // vendored once, used by both renderers.
    helvetica: Object.freeze({
      regular: "../../assets/fonts/NotoSans-Regular.ttf",
      bold: "../../assets/fonts/NotoSans-Bold.ttf",
      italic: "../../assets/fonts/NotoSans-Italic.ttf",
    }),
    calibri: Object.freeze({
      regular: "../../assets/fonts/carlito/Carlito-Regular.ttf",
      bold: "../../assets/fonts/carlito/Carlito-Bold.ttf",
      italic: "../../assets/fonts/carlito/Carlito-Italic.ttf",
    }),
    courier: Object.freeze({
      regular: "../../assets/fonts/cousine/Cousine-Regular.ttf",
      bold: "../../assets/fonts/cousine/Cousine-Bold.ttf",
      italic: "../../assets/fonts/cousine/Cousine-Italic.ttf",
    }),
  });

type FaceKey = `${DocumentFontFamily}:${DocumentFontStyle}`;
const key = (family: DocumentFontFamily, style: DocumentFontStyle): FaceKey => `${family}:${style}`;

const fileCache = new Map<FaceKey, Uint8Array>();
const coverageCache = new Map<FaceKey, ParsedFace>();

interface ParsedFace {
  hasGlyphForCodePoint(cp: number): boolean;
}

function faceBytes(family: DocumentFontFamily, style: DocumentFontStyle): Uint8Array {
  const k = key(family, style);
  const cached = fileCache.get(k);
  if (cached !== undefined) return cached;

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(new URL(FAMILY_FILES[family][style], import.meta.url));
  } catch (cause) {
    // An installation fault, not a document fault — identical failure for
    // every document, so RETRYABLE rather than blamed on the one at hand.
    throw new TypefaceUnavailableError(
      `The ${family} ${style} typeface could not be loaded.`, cause);
  }
  fileCache.set(k, bytes);
  return bytes;
}

function coverage(family: DocumentFontFamily, style: DocumentFontStyle): ParsedFace {
  const k = key(family, style);
  const cached = coverageCache.get(k);
  if (cached !== undefined) return cached;
  const parsed = fontkit.create(faceBytes(family, style)) as ParsedFace;
  coverageCache.set(k, parsed);
  return parsed;
}

/**
 * Every code point the face cannot draw, in first-seen order. Identical
 * logic to `fonts.ts`'s own — kept as a second small function rather than
 * shared, for the same reason the module is separate (see header).
 */
export function uncoveredDocumentCodePoints(
  text: string, family: DocumentFontFamily, style: DocumentFontStyle,
): readonly number[] {
  const face = coverage(family, style);
  const missing: number[] = [];
  const seen = new Set<number>();

  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint < 0x20 || codePoint === 0x7f) continue;
    if (seen.has(codePoint)) continue;
    seen.add(codePoint);
    if (!face.hasGlyphForCodePoint(codePoint)) missing.push(codePoint);
  }
  return missing;
}

/**
 * Refuses text this family/style cannot draw — the SAME refuse-don't-guess
 * posture `fonts.ts` established. An admin choosing Courier for a name that
 * needs a glyph Courier lacks gets a fixable error naming the code points
 * (never the text — S42), not a document with a blank word in it.
 */
export function assertDocumentTextRenderable(
  text: string, family: DocumentFontFamily, bold: boolean, italic: boolean,
): void {
  const style = resolveStyle(bold, italic);
  const missing = uncoveredDocumentCodePoints(text, family, style);
  if (missing.length === 0) return;

  const listed = missing.slice(0, 8)
    .map(cp => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`)
    .join(", ");
  const suffix = missing.length > 8 ? `, and ${String(missing.length - 8)} more` : "";

  throw new UnrenderableTextError(
    `The ${family} typeface has no glyph for ${listed}${suffix}. `
    + "Try a different font for this text, such as Helvetica, which covers the widest range.",
  );
}

export interface EmbeddedDocumentFonts {
  /** Embeds on first use per (family, style) pair, then returns the same `PDFFont`. */
  face(family: DocumentFontFamily, bold: boolean, italic: boolean): Promise<PDFFont>;
}

export function embedDocumentFonts(pdf: PDFDocument): EmbeddedDocumentFonts {
  pdf.registerFontkit(fontkit);
  const embedded = new Map<FaceKey, Promise<PDFFont>>();

  return {
    face(family: DocumentFontFamily, bold: boolean, italic: boolean): Promise<PDFFont> {
      const style = resolveStyle(bold, italic);
      const k = key(family, style);
      const existing = embedded.get(k);
      if (existing !== undefined) return existing;

      // `subset: false` — see fonts.ts's header for the incident this
      // avoids. Load-bearing here for the identical reason.
      const pending = pdf.embedFont(faceBytes(family, style), { subset: false });
      embedded.set(k, pending);
      return pending;
    },
  };
}
