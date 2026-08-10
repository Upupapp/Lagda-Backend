// Recipient domain rules.
//
// Pure functions, so these are the cheapest place to pin the decisions that
// would otherwise only be visible three layers up: which fold the duplicate
// rule uses, which participant types may hold fields, and what "order" means.

import { describe, it, expect } from "vitest";
import {
  validateRecipientName, validateRecipientOrganization, validateRecipientEmail,
  canHoldFields, fieldRequiresRecipient, normalizeOrder, isValidRoutingOrder,
  RECIPIENT_TYPES, RECIPIENT_NAME_MAX_LENGTH,
} from "./index.js";
import { PREPARATION_FIELD_TYPES } from "@lagda/contracts";

// ── Names ────────────────────────────────────────────────────────────────────

describe("validateRecipientName", () => {
  it("trims the outside and keeps the inside", () => {
    // Interior spacing belongs to whoever typed it. A person's name is the last
    // place to apply a normalizer's opinion.
    const result = validateRecipientName("  Juan  dela Cruz  ");
    expect(result).toEqual({ ok: true, value: "Juan  dela Cruz" });
  });

  it("accepts names outside ASCII", () => {
    // This product's own signers. §19 forbids ASCII-only validation, and it
    // would exclude a large share of them.
    for (const name of ["José Ramírez", "株式会社トヨタ", "Ñoño Dela Cruz", "ᜃᜓᜎᜌ᜔"]) {
      expect(validateRecipientName(name), name).toMatchObject({ ok: true });
    }
  });

  it("refuses a bidirectional override", () => {
    // A name is what a signer is told they are, and what a completion
    // certificate will carry. An override can make one name render as another
    // on the single screen where that is legally material.
    expect(validateRecipientName("Maria‮Santos"))
      .toEqual({ ok: false, reason: "control-characters" });
  });

  it("refuses a zero-width joiner used as a name", () => {
    expect(validateRecipientName("‍")).toMatchObject({ ok: false });
  });

  it("refuses blank", () => {
    expect(validateRecipientName("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("counts length in code points, not UTF-16 units", () => {
    // A name in Han or an emoji-bearing name is not charged double.
    const name = "字".repeat(RECIPIENT_NAME_MAX_LENGTH);
    expect(validateRecipientName(name)).toMatchObject({ ok: true });
    expect(validateRecipientName(`${name}字`)).toEqual({ ok: false, reason: "too-long" });
  });
});

// ── Organization ─────────────────────────────────────────────────────────────

describe("validateRecipientOrganization", () => {
  it("folds absent, null and blank to one representation", () => {
    // One representation of absent, so no reader has to handle two.
    for (const input of [null, undefined, "", "   "]) {
      expect(validateRecipientOrganization(input)).toEqual({ ok: true, value: null });
    }
  });

  it("keeps a real value", () => {
    expect(validateRecipientOrganization(" Ayala Land "))
      .toEqual({ ok: true, value: "Ayala Land" });
  });
});

// ── Email ────────────────────────────────────────────────────────────────────

describe("validateRecipientEmail", () => {
  it("preserves the display address and folds the key separately", () => {
    // The display address is where mail actually goes. Rewriting it to satisfy
    // a comparison would be changing a delivery destination (§23).
    const result = validateRecipientEmail("  Maria.Santos@AyalaLand.com.PH ");
    expect(result).toMatchObject({
      ok: true,
      display: "Maria.Santos@AyalaLand.com.PH",
      key: "maria.santos@ayalaland.com.ph",
    });
  });

  it("does NOT strip dots or plus tags", () => {
    // Both merge mailboxes different people may control. Here that would
    // silently refuse a second legitimate recipient as a duplicate (§22).
    const dotted = validateRecipientEmail("j.dela.cruz@example.com");
    const plain = validateRecipientEmail("jdelacruz@example.com");
    expect(dotted).toMatchObject({ ok: true });
    expect(plain).toMatchObject({ ok: true });
    expect(dotted.ok && plain.ok && dotted.key === plain.key).toBe(false);

    const tagged = validateRecipientEmail("juan+lease@example.com");
    const bare = validateRecipientEmail("juan@example.com");
    expect(tagged.ok && bare.ok && tagged.key === bare.key).toBe(false);
  });

  it("folds with a fixed locale", () => {
    // A key that changes with the server's locale is a key that finds
    // different duplicates on different machines. Turkish dotless I is the
    // classic case: a locale-sensitive fold maps "I" to "ı".
    const result = validateRecipientEmail("ISTANBUL@example.com");
    expect(result).toMatchObject({ ok: true, key: "istanbul@example.com" });
  });

  it("refuses malformed input", () => {
    for (const bad of ["", "   ", "no-at-sign", "@example.com", "a@", "a b@example.com"]) {
      expect(validateRecipientEmail(bad), bad).toMatchObject({ ok: false });
    }
  });
});

// ── Field eligibility ────────────────────────────────────────────────────────

describe("canHoldFields", () => {
  it("refuses viewer and carbon-copy", () => {
    // `FIELD_ELIGIBLE_ROLES` in the product lists neither for ANY field type,
    // and the role descriptions say why: both "do not block completion". A
    // viewer with a required signature would be a participant the workflow
    // simultaneously waits for and does not.
    expect(canHoldFields("viewer")).toBe(false);
    expect(canHoldFields("carbon-copy")).toBe(false);
  });

  it("permits the other four", () => {
    for (const type of RECIPIENT_TYPES) {
      if (type === "viewer" || type === "carbon-copy") continue;
      expect(canHoldFields(type), type).toBe(true);
    }
  });

  it("covers every declared type, so a new one cannot be forgotten", () => {
    // A total function over the union. If a seventh type is added, this still
    // passes — but `RECIPIENT_TYPES.length` below fails, which is the reminder.
    expect(RECIPIENT_TYPES.filter(canHoldFields)).toHaveLength(4);
    expect(RECIPIENT_TYPES).toHaveLength(6);
  });
});

describe("fieldRequiresRecipient", () => {
  it("is true for every implemented field type", () => {
    // All nine ask a PARTICIPANT for something — `sender-text` was deferred
    // precisely because it is sender-filled. Declared as a function rather
    // than assumed, because this is where the answer changes when one arrives.
    for (const type of PREPARATION_FIELD_TYPES) {
      expect(fieldRequiresRecipient(type), type).toBe(true);
    }
  });
});

// ── Ordering ─────────────────────────────────────────────────────────────────

describe("normalizeOrder", () => {
  it("produces a dense 0-based sequence in the order given", () => {
    expect(normalizeOrder(["c", "a", "b"])).toEqual([
      { item: "c", orderIndex: 0 },
      { item: "a", orderIndex: 1 },
      { item: "b", orderIndex: 2 },
    ]);
  });

  it("leaves no gaps, so there is one representation of an order", () => {
    // Sparse numbering (10, 20, 30) would sort correctly and drift apart with
    // every deletion until the numbers stopped meaning anything. Gaps would be
    // worth it if reordering were a single-row update; it is not.
    const numbered = normalizeOrder([1, 2, 3, 4]).map(entry => entry.orderIndex);
    expect(numbered).toEqual([0, 1, 2, 3]);
  });

  it("handles an empty list", () => {
    expect(normalizeOrder([])).toEqual([]);
  });
});

describe("isValidRoutingOrder", () => {
  it("accepts positive integers", () => {
    for (const value of [1, 2, 99]) expect(isValidRoutingOrder(value), String(value)).toBe(true);
  });

  it("refuses zero, negatives and non-integers", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isValidRoutingOrder(value), String(value)).toBe(false);
    }
  });

  it("says nothing about contiguity", () => {
    // Deleting the only recipient at step 2 leaves 1 and 3. Refusing to save
    // that would block ordinary editing to enforce tidiness; what a gap means
    // for the ceremony is BACKEND-37's question (§38).
    expect([1, 3].every(isValidRoutingOrder)).toBe(true);
  });
});
