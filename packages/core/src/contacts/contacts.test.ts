// Contact domain rules.
//
// Pure functions, so every case here is an input and an expected output with
// nothing mocked and no clock.

import { describe, it, expect, expectTypeOf } from "vitest";
import {
  validateContactName, validateOptionalContactText, validateContactEmail,
  deriveContactState, isContactEditable,
  CONTACT_NAME_MAX_LENGTH, CONTACT_PHONE_MAX_LENGTH,
  type ContactEmailKey,
} from "./index.js";
import { hasEmailSyntax, MAX_EMAIL_LENGTH } from "../common/index.js";

describe("validateContactName", () => {
  it("trims the outside and preserves the inside", () => {
    expect(validateContactName("  Reyes  &  Co.  "))
      .toEqual({ ok: true, value: "Reyes  &  Co." });
  });

  it("rejects an empty or whitespace-only name", () => {
    for (const raw of ["", "   ", "\t\t"]) {
      expect(validateContactName(raw)).toEqual({ ok: false, reason: "empty" });
    }
  });

  it("accepts names LAGDA's own customers have", () => {
    // An ASCII allowlist would reject every one of these. Philippine legal
    // practice is full of Spanish surnames, and its counterparties include
    // Japanese and Chinese corporate entities.
    for (const name of [
      "José Ramírez", "Ñoño Dela Cruz", "株式会社トヨタ",
      "Ma. Concepción Reyes-Villanueva", "O'Brien & Sons",
      "ᜃᜓᜋᜓᜐ᜔ᜆ", "Иванов",
    ]) {
      expect(validateContactName(name)).toEqual({ ok: true, value: name });
    }
  });

  it("rejects control and format characters", () => {
    for (const name of [
      "Maria\u0000Santos", "Maria\nSantos", "Maria\rSantos",
      "Maria\u200bSantos", "Maria\u202eSantos", "Maria\u0007Santos",
    ]) {
      expect(validateContactName(name))
        .toEqual({ ok: false, reason: "control-characters" });
    }
  });

  it("reports control characters BEFORE length", () => {
    // A long string full of NULs has two problems, and the interesting one is
    // the NULs. Reporting "too-long" would send someone to shorten it.
    const hostile = "\u0000".repeat(CONTACT_NAME_MAX_LENGTH + 50);
    expect(validateContactName(hostile))
      .toEqual({ ok: false, reason: "control-characters" });
  });

  it("counts CODE POINTS, not UTF-16 units", () => {
    // Every one of these is a surrogate pair: `.length` would say 400 and
    // reject a name that is 200 characters as anyone would count them.
    const emoji = "😀".repeat(CONTACT_NAME_MAX_LENGTH);
    expect(validateContactName(emoji).ok).toBe(true);
    expect(validateContactName("😀".repeat(CONTACT_NAME_MAX_LENGTH + 1)))
      .toEqual({ ok: false, reason: "too-long" });
  });

  it("accepts exactly the maximum and rejects one more", () => {
    expect(validateContactName("a".repeat(CONTACT_NAME_MAX_LENGTH)).ok).toBe(true);
    expect(validateContactName("a".repeat(CONTACT_NAME_MAX_LENGTH + 1)))
      .toEqual({ ok: false, reason: "too-long" });
  });

  it("measures AFTER trimming", () => {
    const padded = `  ${"a".repeat(CONTACT_NAME_MAX_LENGTH)}  `;
    expect(validateContactName(padded).ok).toBe(true);
  });
});

describe("validateOptionalContactText", () => {
  it("treats null, undefined and blank alike as absent", () => {
    for (const raw of [null, undefined, "", "   "]) {
      expect(validateOptionalContactText(raw, CONTACT_PHONE_MAX_LENGTH))
        .toEqual({ ok: true, value: null });
    }
  });

  it("accepts every way a Philippine number gets written", () => {
    // Free text, not E.164. Nothing in LAGDA dials a contact, so normalising
    // would lose the extension and the landline formatting for no benefit.
    for (const phone of [
      "0917 123 4567", "+63 917 123 4567", "(02) 8123 4567 loc. 210",
      "63-917-1234567", "8123-4567",
    ]) {
      expect(validateOptionalContactText(phone, CONTACT_PHONE_MAX_LENGTH))
        .toEqual({ ok: true, value: phone });
    }
  });

  it("trims and enforces the supplied limit", () => {
    expect(validateOptionalContactText("  Ayala Land  ", 200))
      .toEqual({ ok: true, value: "Ayala Land" });
    expect(validateOptionalContactText("x".repeat(201), 200))
      .toEqual({ ok: false, reason: "too-long" });
  });

  it("rejects control characters", () => {
    expect(validateOptionalContactText("Ayala\u0000Land", 200))
      .toEqual({ ok: false, reason: "control-characters" });
  });
});

describe("validateContactEmail", () => {
  it("returns the typed address AND a folded key", () => {
    const result = validateContactEmail("  Maria.Santos@AyalaLand.com.ph  ");
    expect(result).toEqual({
      ok: true,
      display: "Maria.Santos@AyalaLand.com.ph",
      key: "maria.santos@ayalaland.com.ph",
    });
  });

  it("does NOT strip dots or plus-tags", () => {
    // Both rewrites would merge mailboxes different people may control. In an
    // authentication system that is an account-takeover primitive; in an
    // address book it reports two real contacts as one.
    expect(validateContactEmail("john.smith@gmail.com"))
      .toMatchObject({ key: "john.smith@gmail.com" });
    expect(validateContactEmail("billing+ph@acme.com"))
      .toMatchObject({ key: "billing+ph@acme.com" });
  });

  it("rejects empty, over-long and malformed addresses", () => {
    expect(validateContactEmail("   ")).toEqual({ ok: false, reason: "empty" });
    expect(validateContactEmail(`${"a".repeat(MAX_EMAIL_LENGTH)}@x.com`))
      .toEqual({ ok: false, reason: "too-long" });
    for (const raw of ["nope", "a@b", "a b@c.com", "@example.com", "a@@b.com"]) {
      expect(validateContactEmail(raw)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("uses the SAME syntax rule as account identity", () => {
    // One definition, in `@lagda/core/common`. Before BACKEND-28 the pattern
    // was private to `email-identity.ts`, and the alternative here was a second
    // copy that agrees until one of them is edited.
    for (const raw of ["ok@example.com", "nope", "a@b"]) {
      const domain = validateContactEmail(raw);
      expect(domain.ok).toBe(hasEmailSyntax(raw));
    }
  });

  it("produces a key that is NOT assignable to an account identity", () => {
    const result = validateContactEmail("maria@example.com");
    if (!result.ok) throw new Error("fixture");
    // The compile-time guarantee, asserted at compile time. `ContactEmailKey`
    // and `NormalizedEmail` are mutually unassignable brands, which is what
    // makes `findUserByNormalizedEmail(contact.emailKey)` a type error rather
    // than a code-review note.
    expectTypeOf(result.key).toEqualTypeOf<ContactEmailKey>();
    expectTypeOf<ContactEmailKey>().not.toEqualTypeOf<string & {
      readonly __brand: "NormalizedEmail";
    }>();
  });
});

describe("contact state", () => {
  it("derives from archivedAt alone", () => {
    expect(deriveContactState(null)).toBe("active");
    expect(deriveContactState(0)).toBe("archived");
    expect(deriveContactState(Date.parse("2026-08-10T00:00:00Z"))).toBe("archived");
  });

  it("treats epoch zero as archived, not as absent", () => {
    // The trap a `!archivedAt` check would fall into. 1970 is a legitimate
    // timestamp and a falsy number.
    expect(deriveContactState(0)).toBe("archived");
    expect(isContactEditable(0)).toBe(false);
  });

  it("makes only active contacts editable", () => {
    expect(isContactEditable(null)).toBe(true);
    expect(isContactEditable(Date.now())).toBe(false);
  });
});
