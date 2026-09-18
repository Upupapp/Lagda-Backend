// The embedded typeface.
//
// ── Why an embedded font, and why this is a correctness fix ────────────────
//
// Until BACKEND-39 this package drew every value in `StandardFonts.Helvetica`,
// which is WinAnsi-encoded. pdf-lib THROWS on a character outside that range
// rather than substituting one, so a recipient whose name carries a mark
// outside WinAnsi — Peñaflor, Ángeles — could not have their document
// completed at all. §146 requires diacritics to work. OD-163.
//
// ── The trap that replaced it, and why the coverage check exists ───────────
//
// Swapping Helvetica for a SUBSET font converts a loud failure into a silent
// one. Measured before this module was written: `@fontsource/noto-sans`'s
// `latin` subset is 281 glyphs, and drawing "田中太郎" with it throws NOTHING —
// it renders an empty page. A recipient would receive a document with a blank
// signature and the pipeline would report success, which is the one failure
// §22 and §178 say must never be reachable.
//
// So a missing glyph is REFUSED here rather than drawn. `assertRenderable` is
// not defensive decoration; it is the thing that keeps "the font changed" from
// meaning "signatures silently stopped appearing".
//
// ── Why the full face rather than a subset ─────────────────────────────────
//
// Also measured: fontsource's `latin` and `latin-ext` subsets are DISJOINT.
// `latin` carries ñ and not ₱; `latin-ext` carries ₱ and not ñ. One `PDFFont`
// embeds one file, so no combination of them covers a Philippine document that
// contains both a name and a peso amount. These faces are the complete Noto
// Sans (4503 glyphs), which covers both.
//
// ── Determinism ────────────────────────────────────────────────────────────
//
// The bytes come from a pinned package version, never from a font installed on
// whatever machine happens to run this. A host-resolved font would make the
// same document hash differently on a developer's box, in CI, and in a
// container that ships no fonts at all — and the sealed document's SHA-256 is
// its identity.

import { readFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import type { PDFDocument, PDFFont } from "pdf-lib";
import { TypefaceUnavailableError, UnrenderableTextError } from "../errors/index.js";

/**
 * The three faces, and only three.
 *
 * `italic` renders typed signatures and initials — it replaces
 * `HelveticaOblique`, which carried the same WinAnsi limitation. `bold` is the
 * certificate's headings. A fourth face would be a fourth 630 KB embed for a
 * distinction nothing in the product makes.
 */
export type FaceName = "regular" | "bold" | "italic";

/**
 * VENDORED, in `packages/sealing/assets/fonts/`.
 *
 * These were an npm dependency (`@expo-google-fonts/noto-sans`) first. That
 * package ships eighteen faces to deliver the three used here — 14 MB in
 * `node_modules` and in every deploy image — so the faces are committed
 * instead: 1.9 MB, and the only bytes present are the ones that get embedded.
 *
 * **The full faces, not a subset.** Subsetting would cut ~1.4 MB and would
 * reintroduce precisely the failure `assertRenderable` exists to catch: a
 * subset silently loses glyphs, and a lost glyph renders as nothing rather than
 * throwing. Trading a measured 1.4 MB for an unmeasured correctness risk is the
 * wrong side of that bargain — see ADR-031, and note that the `latin` subset
 * this project rejected was missing ₱ in a Philippine product.
 *
 * Licensed under the SIL Open Font License 1.1; `OFL.txt` sits beside them,
 * which is what the licence requires when the fonts are redistributed.
 *
 * Resolved relative to THIS MODULE rather than to the process's working
 * directory, so it does not matter where the server is started from. The path
 * is identical from `src/internal/` and from `dist/internal/` — both are two
 * levels below the package root.
 */
const FACE_FILES: Readonly<Record<FaceName, string>> = Object.freeze({
  regular: "../../assets/fonts/NotoSans-Regular.ttf",
  bold: "../../assets/fonts/NotoSans-Bold.ttf",
  italic: "../../assets/fonts/NotoSans-Italic.ttf",
});

/**
 * Face bytes, read once per process.
 *
 * Three faces at ~630 KB each. Re-reading them per sealed document would be
 * 1.9 MB of file I/O per completion for bytes that cannot change while the
 * process lives.
 */
const fileCache = new Map<FaceName, Uint8Array>();

/**
 * Parsed faces, kept for coverage and shaping queries. Parsing is the
 * expensive half, and a renderability probe must not repeat it per call.
 */
const coverageCache = new Map<FaceName, ParsedFace>();

function faceBytes(name: FaceName): Uint8Array {
  const cached = fileCache.get(name);
  if (cached !== undefined) return cached;

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(new URL(FACE_FILES[name], import.meta.url));
  } catch (cause) {
    // A missing font file is an installation fault, not a document fault. It
    // fails the same way for every document, so it must not be reported as a
    // problem with the one being sealed — and it must stay RETRYABLE, or a bad
    // deploy permanently fails every request in flight.
    throw new TypefaceUnavailableError(
      `The ${name} typeface could not be loaded.`,
      cause,
    );
  }
  fileCache.set(name, bytes);
  return bytes;
}

/**
 * The parsed face, as fontkit sees it.
 *
 * `layout` is typed alongside `hasGlyphForCodePoint` because renderability
 * needs BOTH and they answer different questions — see `signatureTextProblem`.
 * It is the same object pdf-lib builds internally from the same bytes, so
 * asking it here and asking it during a merge cannot disagree.
 */
interface ParsedFace {
  hasGlyphForCodePoint(cp: number): boolean;
  layout(text: string): { readonly glyphs: readonly unknown[] };
}

function coverage(name: FaceName): ParsedFace {
  const cached = coverageCache.get(name);
  if (cached !== undefined) return cached;
  const parsed = fontkit.create(faceBytes(name)) as ParsedFace;
  coverageCache.set(name, parsed);
  return parsed;
}

/**
 * The face every typed signature and initials value renders in.
 *
 * A single exported constant rather than a literal repeated per call site,
 * because the failure this prevents is subtle: a caller that checks coverage
 * against `regular` while the merger draws in `italic` would accept text the
 * merger then refuses — which is exactly the bug the submission-time check was
 * added to close. `faceFor` in `internal/merge.ts` reads this, so the renderer
 * and any pre-flight check cannot disagree about WHICH face without changing
 * one shared value.
 */
export const SIGNATURE_FACE: FaceName = "italic";

/**
 * Why the SIGNATURE face cannot render this text, or `null` when it can.
 *
 * ── Two failure modes, and neither check finds both ────────────────────────
 *
 * Measured against the vendored face:
 *
 *   text    glyphs present?   layout()
 *   ----    ---------------   --------------------------------------------
 *   田中     no                succeeds — returns .notdef glyphs
 *   🎉      no                succeeds — returns .notdef glyphs
 *   محمد    no                succeeds — returns .notdef glyphs
 *   क       YES               THROWS
 *   नमस्ते     YES               THROWS
 *
 * So a coverage check alone accepts Devanagari that the merge then refuses,
 * and a layout check alone accepts CJK that renders as blank boxes. Actual
 * renderability is the conjunction, which is why this function exists and why
 * the coverage-only export it replaced was not sufficient.
 *
 * ── Why layout is the authoritative half ───────────────────────────────────
 *
 * `widthOfTextAtSize`, which the merge calls to fit a value to its box, is
 * `font.layout(text)` plus a sum of advance widths. Calling the same `layout`
 * on the same parsed face is therefore not an approximation of what the merge
 * does — it is the same operation, minus the arithmetic.
 *
 * The Devanagari throw is not a font defect. The face declares Indic shaping
 * features, so fontkit routes the text to its Indic shaper, which is
 * Babel-transpiled with generators and references a `regeneratorRuntime` that
 * `@pdf-lib/fontkit` never bundles. It is an upstream packaging bug; until it
 * is fixed the merge genuinely cannot draw those scripts, and submission must
 * say so rather than accept work that will fail later.
 *
 * ── No side effects ────────────────────────────────────────────────────────
 *
 * Nothing is embedded, no `PDFDocument` is constructed, nothing is written.
 * `layout` computes a glyph run in memory over a face this module has already
 * parsed and cached, so the probe costs one shaping pass and touches nothing
 * outside this process.
 *
 * Bound to `SIGNATURE_FACE`; there is no face parameter to get wrong.
 */
export type SignatureTextProblem =
  | { readonly reason: "missing-glyphs"; readonly codePoints: readonly number[] }
  | { readonly reason: "shaping-failed" };

export function signatureTextProblem(text: string): SignatureTextProblem | null {
  // Coverage FIRST. It is the more specific answer — it can name the offending
  // code points, which a shaping failure cannot — and layout would otherwise
  // mask missing glyphs by succeeding with .notdef.
  const missing = uncoveredCodePoints(text, SIGNATURE_FACE);
  if (missing.length > 0) return { reason: "missing-glyphs", codePoints: missing };

  try {
    coverage(SIGNATURE_FACE).layout(text);
  } catch {
    // Deliberately swallowed. The cause is an upstream shaper fault whose
    // message is neither stable nor useful to a signer, and rethrowing it
    // would turn a submission problem into a 500. What matters is the answer:
    // the merge cannot draw this.
    return { reason: "shaping-failed" };
  }
  return null;
}

/**
 * Every code point the face cannot draw, in first-seen order.
 *
 * Iterating the string directly (not by index) so an astral character — an
 * emoji, which is exactly the kind of thing pasted into a text field — is read
 * as ONE code point rather than as two unpaired surrogates that would both be
 * reported missing.
 */
export function uncoveredCodePoints(text: string, name: FaceName): readonly number[] {
  const face = coverage(name);
  const missing: number[] = [];
  const seen = new Set<number>();

  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;

    // Control characters are not drawn and have no glyph by definition.
    // Reporting them would fail documents over a stray carriage return.
    if (codePoint < 0x20 || codePoint === 0x7f) continue;

    if (seen.has(codePoint)) continue;
    seen.add(codePoint);

    if (!face.hasGlyphForCodePoint(codePoint)) missing.push(codePoint);
  }
  return missing;
}

/**
 * Refuses text the face cannot draw.
 *
 * The message names the code points and NEVER the text. A field value is the
 * signer's content — a name, an address, a contract term — and §42 keeps that
 * out of error records, which are persisted and logged.
 */
export function assertRenderable(text: string, name: FaceName): void {
  const missing = uncoveredCodePoints(text, name);
  if (missing.length === 0) return;

  const listed = missing
    .slice(0, 8)
    .map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`)
    .join(", ");
  const suffix = missing.length > 8 ? `, and ${String(missing.length - 8)} more` : "";

  throw new UnrenderableTextError(
    `The ${name} typeface has no glyph for ${listed}${suffix}. ` +
      "Rendering would silently produce a blank value.",
  );
}

/**
 * The faces embedded into ONE document.
 *
 * Embedding is lazy and per face: a document with only text fields carries no
 * italic subset, and one with no certificate carries no bold. Embedding all
 * three eagerly would add two unused font objects to every sealed PDF.
 */
export interface EmbeddedFaces {
  /** Embeds on first use, then returns the same `PDFFont`. */
  face(name: FaceName): Promise<PDFFont>;
  /** Refuses text this face cannot draw. Never includes the text in its message. */
  assertRenderable(text: string, name: FaceName): void;
}

export function embedFaces(pdf: PDFDocument): EmbeddedFaces {
  // Registering twice is harmless, and registering here rather than at every
  // call site is what stops one renderer from forgetting.
  pdf.registerFontkit(fontkit);

  const embedded = new Map<FaceName, Promise<PDFFont>>();

  return {
    face(name: FaceName): Promise<PDFFont> {
      const existing = embedded.get(name);
      if (existing !== undefined) return existing;

      // `subset: true` writes only the glyphs actually drawn. Without it each
      // face adds ~630 KB to every document, so a three-face seal would carry
      // 1.9 MB of typeface for a handful of characters.
      const pending = pdf.embedFont(faceBytes(name), { subset: true });
      embedded.set(name, pending);
      return pending;
    },
    assertRenderable,
  };
}
