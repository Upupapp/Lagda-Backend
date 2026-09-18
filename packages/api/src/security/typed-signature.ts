// Typed-signature renderability, bound to the real renderer.
//
// ── The gap this closes ────────────────────────────────────────────────────
//
// `@lagda/sealing` refuses to draw text its embedded face has no glyphs for,
// because an embedded font does not throw on an uncovered character the way a
// standard font does — it draws nothing and returns a valid PDF. Refusing is
// the only alternative to completing a document with a blank signature.
//
// That refusal happens during the MERGE, inside the completion pipeline, and
// `unrenderable-value` is classed terminal: the run fails permanently and no
// retry can change the answer. Which is correct there, and far too late. The
// signer closed the tab minutes earlier believing they had signed; the sender
// is never notified, because the request never completes.
//
// So submission asks the same question first, and this adapter is what makes
// "the same question" literal.
//
// ── Why this delegates instead of listing characters ───────────────────────
//
// A charset written out here would be a SECOND definition of what the renderer
// can draw. It would agree on the day it was written and drift the first time
// a face is swapped or a subset is introduced — silently, because nothing
// would fail: submission would accept text the merge then refuses, which is
// precisely the bug being fixed, restored by the fix's own implementation.
//
// `signatureTextProblem` is the renderer's own probe over the renderer's own
// embedded bytes, exported in the bound form, so there is no face parameter to
// get wrong.
//
// ── Why it is not a coverage check ─────────────────────────────────────────
//
// It was, briefly, and that was not enough. Glyph coverage and renderability
// are different questions, measured against the vendored face:
//
//   田中 / 🎉 / محمد   no glyphs        layout() SUCCEEDS with .notdef glyphs
//   क / नमस्ते          every glyph      layout() THROWS
//
// So coverage alone accepts Devanagari the merge refuses, and layout alone
// accepts CJK that renders as blank boxes. The sealing probe asks both halves;
// this adapter simply passes the question along.
//
// ── No side effects ────────────────────────────────────────────────────────
//
// The probe shapes text in memory against an already-parsed face. It embeds
// nothing, constructs no `PDFDocument`, writes nothing, and touches no
// database, queue or artifact. It is a validation call and nothing else.

import { signatureTextProblem } from "@lagda/sealing";
import type {
  TypedSignatureRenderability, TypedSignatureProblem,
} from "@lagda/application";

/**
 * @remarks Stateless. The sealing package caches the parsed face internally,
 * so repeated calls neither re-read nor re-parse the font file.
 */
export function createTypedSignatureRenderability(): TypedSignatureRenderability {
  return {
    check(text: string): TypedSignatureProblem | null {
      return signatureTextProblem(text);
    },
  };
}
