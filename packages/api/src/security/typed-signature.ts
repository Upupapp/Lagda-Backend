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
// `uncoveredSignatureCodePoints` is the renderer's own coverage function over
// the renderer's own embedded bytes, and it is exported in the bound form, so
// there is no face parameter to get wrong.

import { uncoveredSignatureCodePoints } from "@lagda/sealing";
import type { TypedSignatureRenderability } from "@lagda/application";

/**
 * @remarks Stateless. The sealing package caches the parsed face internally,
 * so repeated calls do not re-read or re-parse the font file.
 */
export function createTypedSignatureRenderability(): TypedSignatureRenderability {
  return {
    uncoveredCodePoints(text: string): readonly number[] {
      return uncoveredSignatureCodePoints(text);
    },
  };
}
