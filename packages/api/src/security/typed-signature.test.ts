// The composition-root adapter for typed-signature renderability.
//
// Small, and worth existing for one reason: it proves the adapter DELEGATES.
// The whole point of the port is that submission and the merge share one
// definition of what the renderer can draw — an adapter that reimplemented the
// rule, however faithfully, would put the drift back the day a face changed.
//
// So these assertions run against the real embedded font and the real shaper,
// not a stub.

import { describe, it, expect } from "vitest";
import { createTypedSignatureRenderability } from "./typed-signature.js";

const renderability = createTypedSignatureRenderability();

describe("text the renderer can draw", () => {
  it("accepts ordinary Latin text", () => {
    expect(renderability.check("Maria Santos")).toBeNull();
  });

  it("accepts the two cases the embedded face was adopted for", () => {
    // OD-163: Helvetica's WinAnsi range could not carry these. And the
    // `latin`/`latin-ext` subsets are disjoint — neither has both ñ and ₱,
    // which a Philippine document needs together.
    expect(renderability.check("Peñaflor Ángeles")).toBeNull();
    expect(renderability.check("₱1,250.00")).toBeNull();
  });

  it("accepts Cyrillic, which the full face does cover", () => {
    expect(renderability.check("Мария Иванова")).toBeNull();
  });
});

describe("text the renderer cannot draw", () => {
  it("reports missing glyphs as code points", () => {
    // Code points, never the characters and never the text: the value is the
    // signer's name and must not reach a log or a persisted error.
    expect(renderability.check("田中")).toEqual({
      reason: "missing-glyphs",
      codePoints: ["田".codePointAt(0), "中".codePointAt(0)],
    });
  });

  it("reports an emoji as ONE code point, not two surrogates", () => {
    expect(renderability.check("Maria 🎉")).toEqual({
      reason: "missing-glyphs",
      codePoints: [0x1f389],
    });
  });

  it("reports Arabic as missing glyphs", () => {
    expect(renderability.check("محمد")?.reason).toBe("missing-glyphs");
  });

  it("reports Devanagari as a SHAPING failure, not a missing glyph", () => {
    // THE case that made a coverage-only check insufficient. Every glyph is
    // present — the shaper is what fails — so a check that counted glyphs
    // would accept this and let the merge fail later.
    expect(renderability.check("क")).toEqual({ reason: "shaping-failed" });
    expect(renderability.check("नमस्ते")).toEqual({ reason: "shaping-failed" });
  });

  it("never throws on input it cannot render", () => {
    // Unrenderable text is an expected input on this path, not a fault. A
    // throw here would surface as a 500 rather than as a submission problem
    // the signer can act on — and the Devanagari case throws a ReferenceError
    // from inside the shaper, which is exactly what must not escape.
    expect(() => renderability.check("田中 🎉 محمد नमस्ते")).not.toThrow();
  });
});

describe("what it tolerates", () => {
  it("does not report control characters", () => {
    expect(renderability.check("Maria\r\nSantos")).toBeNull();
  });

  it("accepts empty text", () => {
    // Emptiness is rejected earlier, by the use case. This port has no opinion
    // about it and must not invent one.
    expect(renderability.check("")).toBeNull();
  });
});
