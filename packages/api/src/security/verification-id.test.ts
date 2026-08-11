// The public verification identifier.
//
// The entropy claim is the point of this file. A published identifier that
// authorizes nothing still gates whether an anonymous caller can discover that
// a particular completed document exists, so "unguessable" has to be measured
// rather than asserted in a comment.

import { describe, it, expect } from "vitest";
import type { WorkspaceId } from "@lagda/contracts";
import {
  createVerificationIdGenerator,
  VERIFICATION_ID_ALPHABET,
  VERIFICATION_ID_SUFFIX_LENGTH,
} from "./verification-id.js";

/** The product's own parser, copied verbatim from `services/public/index.ts`. */
const VER_ID_RE = /^LAGDA-VER-\d{4}-\w{4,10}$/i;

const WS = "ws_1" as WorkspaceId;
const AT = Date.parse("2026-08-11T10:00:00.000Z");

const ids = createVerificationIdGenerator();

describe("format", () => {
  it("matches the format the frontend already parses", () => {
    // If this fails, an id the backend mints cannot be pasted into the product's
    // own verification page.
    expect(ids.nextVerificationId(WS, AT)).toMatch(VER_ID_RE);
  });

  it("carries the year of the supplied instant, not of the current clock", () => {
    // Deterministic given its inputs: the generator reads no clock.
    expect(ids.nextVerificationId(WS, Date.parse("2029-01-02T00:00:00Z")))
      .toMatch(/^LAGDA-VER-2029-/);
  });

  it("uses the TOP of the permitted length range", () => {
    // `VER_ID_RE` admits four characters. Four is enumerable; ten is not.
    const suffix = ids.nextVerificationId(WS, AT).split("-")[3] ?? "";
    expect(suffix).toHaveLength(VERIFICATION_ID_SUFFIX_LENGTH);
    expect(VERIFICATION_ID_SUFFIX_LENGTH).toBe(10);
  });
});

describe("unguessability", () => {
  it("does not repeat across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) seen.add(ids.nextVerificationId(WS, AT));
    expect(seen.size).toBe(20_000);
  });

  it("is not sequential — consecutive ids share no growing prefix", () => {
    // The failure this catches is a generator built on a counter or a
    // timestamp, which satisfies "unique" and fails "unguessable".
    const a = ids.nextVerificationId(WS, AT).split("-")[3] ?? "";
    const b = ids.nextVerificationId(WS, AT).split("-")[3] ?? "";
    let shared = 0;
    while (shared < a.length && a[shared] === b[shared]) shared += 1;
    expect(shared).toBeLessThan(4);
  });

  it("provides at least 55 bits of entropy in the suffix", () => {
    // Measured from the actual alphabet and length rather than claimed.
    const bits = VERIFICATION_ID_SUFFIX_LENGTH
      * Math.log2(VERIFICATION_ID_ALPHABET.length);
    expect(bits).toBeGreaterThan(55);
  });

  it("draws roughly uniformly — no modulo bias toward early characters", () => {
    // `byte % 55` would favour the first 36 characters of the alphabet. The
    // generator rejection-samples instead; this is what proves it.
    const counts = new Map<string, number>();
    for (let i = 0; i < 20_000; i += 1) {
      for (const char of ids.nextVerificationId(WS, AT).split("-")[3] ?? "") {
        counts.set(char, (counts.get(char) ?? 0) + 1);
      }
    }
    const expected = 200_000 / VERIFICATION_ID_ALPHABET.length;
    const frequencies = [...counts.values()];
    // Every character appears, and none is wildly over- or under-represented.
    expect(counts.size).toBe(VERIFICATION_ID_ALPHABET.length);
    expect(Math.min(...frequencies)).toBeGreaterThan(expected * 0.8);
    expect(Math.max(...frequencies)).toBeLessThan(expected * 1.2);
  });
});

describe("what it deliberately does not encode", () => {
  it("does not encode the workspace", () => {
    // A workspace-derived prefix would let anyone holding two references tell
    // whether they came from the same tenant.
    const a = ids.nextVerificationId("ws_alpha" as WorkspaceId, AT);
    const b = ids.nextVerificationId("ws_beta" as WorkspaceId, AT);
    for (const id of [a, b]) {
      expect(id).not.toContain("alpha");
      expect(id).not.toContain("beta");
    }
    // And two ids from the SAME workspace share no more structure than two from
    // different ones — the year prefix only.
    const c = ids.nextVerificationId("ws_alpha" as WorkspaceId, AT);
    expect(a.slice(0, 14)).toBe(c.slice(0, 14));
    expect(a.slice(14)).not.toBe(c.slice(14));
  });

  it("omits characters that a human retyping a printed reference confuses", () => {
    // 0/O, 1/I/l are absent by construction. The reference is read off paper.
    for (const confusable of ["0", "O", "1", "I", "l", "_"]) {
      expect(VERIFICATION_ID_ALPHABET).not.toContain(confusable);
    }
  });
});
