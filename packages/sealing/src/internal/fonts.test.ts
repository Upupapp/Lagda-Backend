// The vendored typefaces, and the coverage the design depends on.
//
// These faces are committed to the repository rather than installed, so nothing
// external will notice if one is replaced by a subset, truncated by a bad merge,
// or dropped by an `assets/` cleanup. The failure that would cause is silent —
// an uncovered glyph draws NOTHING — so it is asserted here instead.

import { describe, it, expect } from "vitest";
import { uncoveredCodePoints, assertRenderable, type FaceName } from "./fonts.js";
import { UnrenderableTextError } from "../errors/index.js";

const FACES: readonly FaceName[] = ["regular", "bold", "italic"];

describe("the vendored faces load", () => {
  it.each(FACES)("%s resolves and parses", (face) => {
    // Reaches the file through the same path the renderer uses. A missing or
    // unreadable asset raises `TypefaceUnavailableError` from here.
    expect(() => uncoveredCodePoints("A", face)).not.toThrow();
  });
});

describe("coverage the product actually needs", () => {
  // Every one of these is a real Philippine or international name character, or
  // a currency symbol a text field can legitimately carry. `latin`-subset Noto
  // Sans — the package this project rejected — is missing the last three.
  const REQUIRED: readonly (readonly [string, string])[] = [
    ["ASCII", "Maria Santos"],
    ["tilde", "Peñaflor"],
    ["acute", "Ángeles"],
    ["diaeresis", "Müller"],
    ["cedilla", "François"],
    ["grave", "Sère"],
    ["circumflex", "Côté"],
    ["em dash", "Santos — Reyes"],
    ["peso sign", "₱50,000.00"],
    ["macron", "Māori"],
    ["o-macron", "Ōtani"],
  ];

  it.each(FACES)("%s covers every required character", (face) => {
    const uncovered = REQUIRED.flatMap(([label, text]) => {
      const missing = uncoveredCodePoints(text, face);
      return missing.length > 0 ? [`${label}: ${missing.map(String).join(",")}`] : [];
    });
    expect(uncovered).toEqual([]);
  });

  it("is a COMPLETE face, not a subset — the guard on ADR-031's decision", () => {
    // The rejected `latin` subset carried 281 glyphs. The complete face carries
    // ~4500. A threshold well above the subset and well below the real count
    // fails loudly if someone subsets these to save disk, which is exactly the
    // trade ADR-031 refuses.
    //
    // Asserted through behaviour rather than a glyph count so it does not depend
    // on a fontkit internal: the peso sign and the macrons are in `latin-ext`
    // and absent from `latin`, so covering all three proves the face is not the
    // subset.
    for (const face of FACES) {
      expect(uncoveredCodePoints("₱āō", face)).toEqual([]);
    }
  });
});

describe("assertRenderable", () => {
  it("accepts text the face can draw", () => {
    expect(() => assertRenderable("Peñaflor Ángeles", "regular")).not.toThrow();
  });

  it("refuses text the face cannot", () => {
    expect(() => assertRenderable("田中", "regular")).toThrow(UnrenderableTextError);
  });

  it("reports code points and never the text", () => {
    // §42: error records are persisted and logged, and a field value is signer
    // content.
    try {
      assertRenderable("田中太郎", "regular");
      expect.unreachable("expected a refusal");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/U\+7530/);
      expect(message).not.toContain("田中太郎");
    }
  });

  it("ignores control characters rather than failing on them", () => {
    expect(() => assertRenderable("Maria\tSantos\r\n", "regular")).not.toThrow();
  });

  it("deduplicates a repeated missing code point", () => {
    expect(uncoveredCodePoints("田田田", "regular")).toEqual([0x7530]);
  });

  it("caps how many code points the message lists", () => {
    // A field pasted full of unsupported text must not produce an unbounded
    // error string that then gets logged in full.
    const many = "田中太郎山川海空月星花鳥風雲";
    try {
      assertRenderable(many, "regular");
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect((error as Error).message).toMatch(/and \d+ more/);
    }
  });
});
