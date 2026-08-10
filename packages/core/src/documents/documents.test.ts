// Document domain rules. Pure functions, nothing mocked.

import { describe, it, expect } from "vitest";
import {
  validateDocumentTitle, titleFromFilename, DOCUMENT_TITLE_MAX_LENGTH,
} from "./index.js";

describe("validateDocumentTitle", () => {
  it("trims the outside and preserves the inside", () => {
    expect(validateDocumentTitle("  Deed of Sale  —  Lot 42  "))
      .toEqual({ ok: true, value: "Deed of Sale  —  Lot 42" });
  });

  it("rejects empty and whitespace-only", () => {
    for (const raw of ["", "   ", "\t"]) {
      expect(validateDocumentTitle(raw)).toEqual({ ok: false, reason: "empty" });
    }
  });

  it("accepts the titles LAGDA's own customers write", () => {
    for (const title of [
      "Retainer Agreement — Mabini Business Services",
      "Kasunduan sa Paupahan",
      "株式会社トヨタ 業務委託契約書",
      "Contrato de Arrendamiento (Peñafrancia)",
    ]) {
      expect(validateDocumentTitle(title)).toEqual({ ok: true, value: title });
    }
  });

  it("rejects control and format characters", () => {
    // The RTL override matters more here than anywhere else in LAGDA: a title
    // is what a signer is told they are signing.
    for (const title of [
      "Lease\u0000Agreement", "Lease\nAgreement",
      "Lease\u202eAgreement", "Lease\u200bAgreement",
    ]) {
      expect(validateDocumentTitle(title))
        .toEqual({ ok: false, reason: "control-characters" });
    }
  });

  it("reports control characters BEFORE length", () => {
    const hostile = "\u0000".repeat(DOCUMENT_TITLE_MAX_LENGTH + 50);
    expect(validateDocumentTitle(hostile))
      .toEqual({ ok: false, reason: "control-characters" });
  });

  it("counts CODE POINTS, not UTF-16 units", () => {
    expect(validateDocumentTitle("契".repeat(DOCUMENT_TITLE_MAX_LENGTH)).ok).toBe(true);
    expect(validateDocumentTitle("😀".repeat(DOCUMENT_TITLE_MAX_LENGTH)).ok).toBe(true);
    expect(validateDocumentTitle("😀".repeat(DOCUMENT_TITLE_MAX_LENGTH + 1)))
      .toEqual({ ok: false, reason: "too-long" });
  });

  it("accepts exactly the maximum and rejects one more", () => {
    expect(validateDocumentTitle("a".repeat(DOCUMENT_TITLE_MAX_LENGTH)).ok).toBe(true);
    expect(validateDocumentTitle("a".repeat(DOCUMENT_TITLE_MAX_LENGTH + 1)))
      .toEqual({ ok: false, reason: "too-long" });
  });
});

describe("titleFromFilename", () => {
  it("strips a single trailing extension", () => {
    expect(titleFromFilename("lease-v4-final.pdf")).toBe("lease-v4-final");
    expect(titleFromFilename("Deed of Sale.PDF")).toBe("Deed of Sale");
  });

  it("does NOT prettify", () => {
    // Turning underscores into spaces and title-casing are guesses that make
    // `SPA_2026_v3` worse. The user can rename.
    expect(titleFromFilename("SPA_2026_v3.pdf")).toBe("SPA_2026_v3");
    expect(titleFromFilename("retainer-agreement.pdf")).toBe("retainer-agreement");
  });

  it("keeps interior dots", () => {
    expect(titleFromFilename("v1.2.contract.pdf")).toBe("v1.2.contract");
  });

  it("returns null when there is nothing usable", () => {
    expect(titleFromFilename(null)).toBeNull();
    expect(titleFromFilename(".pdf")).toBeNull();
    expect(titleFromFilename("   ")).toBeNull();
  });

  it("returns null rather than repairing a hostile filename", () => {
    // Silently sanitizing untrusted display text into something that passes is
    // how a crafted name reaches a signer's screen looking legitimate.
    expect(titleFromFilename("lease\u202egnp.pdf")).toBeNull();
    expect(titleFromFilename("a\u0000b.pdf")).toBeNull();
  });

  it("returns null for a filename longer than a title may be", () => {
    expect(titleFromFilename(`${"a".repeat(400)}.pdf`)).toBeNull();
  });
});
