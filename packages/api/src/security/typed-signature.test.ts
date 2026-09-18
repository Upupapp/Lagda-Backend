// The composition-root adapter for typed-signature renderability.
//
// Small, and worth existing for one reason: it proves the adapter DELEGATES.
// The whole point of the port is that submission and the merge share one
// definition of what the face can draw — an adapter that reimplemented the
// rule, however faithfully, would put the drift back the day a face changed.
//
// So these assertions are about real glyph coverage from the real embedded
// font, not about a stub.

import { describe, it, expect } from "vitest";
import { createTypedSignatureRenderability } from "./typed-signature.js";

const renderability = createTypedSignatureRenderability();

describe("delegating to the renderer's own coverage", () => {
  it("accepts ordinary Latin text", () => {
    expect(renderability.uncoveredCodePoints("Maria Santos")).toEqual([]);
  });

  it("accepts the two cases the embedded face was adopted for", () => {
    // OD-163: Helvetica's WinAnsi range could not carry these. And the
    // `latin`/`latin-ext` subsets are disjoint — neither has both ñ and ₱,
    // which a Philippine document needs together.
    expect(renderability.uncoveredCodePoints("Peñaflor Ángeles")).toEqual([]);
    expect(renderability.uncoveredCodePoints("₱1,250.00")).toEqual([]);
  });

  it("reports the code points it cannot draw", () => {
    expect(renderability.uncoveredCodePoints("田中"))
      .toEqual(["田".codePointAt(0), "中".codePointAt(0)]);
  });

  it("never throws on input it cannot render", () => {
    // Unrenderable text is an expected input on this path, not a fault. A
    // throw here would surface as a 500 rather than as a submission problem
    // the signer can act on.
    expect(() => renderability.uncoveredCodePoints("田中 🎉 محمد")).not.toThrow();
  });

  it("does not report control characters", () => {
    expect(renderability.uncoveredCodePoints("Maria\r\nSantos")).toEqual([]);
  });
});
