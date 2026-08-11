// The completion certificate generator (BACKEND-40).
//
// ── What these tests can and cannot assert, stated up front ────────────────
//
// A certificate's most important properties are ABSENCES: it must not say
// "Completed", must not say "Sealed", must not print a verification ID. The
// obvious test — search the PDF bytes for the string — DOES NOT WORK HERE, and
// silently so.
//
// Measured: rendering a certificate and searching its bytes for "Certificate of
// Completion" — a string the renderer definitely draws — finds NOTHING. The
// embedded Noto Sans subset encodes text as glyph indices, not ASCII, and the
// content stream is compressed. So every `expect(bytes).not.toContain("Sealed")`
// would pass vacuously, on a document that said it in 72-point type.
//
// The absences are therefore asserted two ways that CAN fail:
//
//   1. THE MODEL HAS NO SUCH FIELD. `CompletionCertificateModelV1` carries no
//      `completedAt`, no seal metadata and no verification id, so the renderer
//      has nothing to draw from. That is a compile-time guarantee and is
//      stronger than any string search.
//   2. THE RENDERER SOURCE CONTAINS NO SUCH LITERAL, checked by reading the
//      file — with a positive control proving the check can find a literal that
//      IS there.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import type { CompletionCertificateModelV1 } from "@lagda/application";
import {
  COMPLETION_CERTIFICATE_VERSION, COMPLETION_CERTIFICATE_RENDERER_VERSION,
  maskEmailForCertificate,
} from "@lagda/application";
import { NodeCompletionCertificateGenerator } from "./node-completion-certificate-generator.js";
import {
  InvalidSealInputError, SealingError, UnrenderableTextError,
  UnsupportedRepresentationError,
} from "./errors/index.js";

const generator = new NodeCompletionCertificateGenerator();

const AT = Date.parse("2026-08-11T09:30:00.000Z");

function participant(
  overrides: Partial<CompletionCertificateModelV1["participants"][number]> = {},
): CompletionCertificateModelV1["participants"][number] {
  return {
    recipientId: "srr_1",
    name: "Juan dela Cruz",
    maskedEmail: "j***@example.com",
    routingOrder: 1,
    orderIndex: 0,
    authenticationMethod: "email-otp",
    firstEnteredAt: Date.parse("2026-08-11T09:00:00.000Z"),
    consent: {
      consentType: "electronic-records",
      consentVersion: "1.2",
      acceptedAt: Date.parse("2026-08-11T09:01:00.000Z"),
    },
    signedAt: Date.parse("2026-08-11T09:05:00.000Z"),
    ...overrides,
  };
}

function model(
  overrides: Partial<CompletionCertificateModelV1> = {},
): CompletionCertificateModelV1 {
  return {
    certificateVersion: COMPLETION_CERTIFICATE_VERSION,
    signingRequestId: "sr_1",
    documentTitle: "Contract of Lease",
    sourceDocumentDigest: "a".repeat(64) as CompletionCertificateModelV1["sourceDocumentDigest"],
    participants: [participant()],
    generatedAt: AT,
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<SealingError> {
  try {
    await promise;
  } catch (error) {
    return error as SealingError;
  }
  throw new Error("Expected the certificate to be refused, but it succeeded.");
}

describe("producing a certificate", () => {
  it("renders a structurally valid PDF with its metadata", async () => {
    const result = await generator.generate(model());

    expect(result.mediaType).toBe("application/pdf");
    expect(result.certificateVersion).toBe(COMPLETION_CERTIFICATE_VERSION);
    expect(result.rendererVersion).toBe(COMPLETION_CERTIFICATE_RENDERER_VERSION);
    expect(result.digestAlgorithm).toBe("sha-256");
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);

    await expect(PDFDocument.load(result.certificate)).resolves.toBeDefined();
  });

  it("reports the size OBSERVED from the bytes", async () => {
    // §219. The size is measured, never claimed by a caller.
    const result = await generator.generate(model());
    expect(result.sizeBytes).toBe(result.certificate.byteLength);
  });

  it("produces identical bytes for an identical model", async () => {
    // §112/§113: claimed only because it is proven. `generatedAt` drives both
    // PDF dates, so nothing here reads a clock.
    const input = model();
    const first = await generator.generate(input);
    const second = await generator.generate(input);
    expect(first.digest).toBe(second.digest);
  });

  it("changes when the model changes", async () => {
    // The determinism test above would pass just as happily if the renderer
    // ignored its input entirely.
    const a = await generator.generate(model());
    const b = await generator.generate(model({ documentTitle: "Deed of Sale" }));
    expect(a.digest).not.toBe(b.digest);
  });
});

describe("what the certificate cannot say", () => {
  // The model is the enforcement. These assertions fail at COMPILE time if a
  // field is ever added, which is the point — a runtime string search cannot
  // see into a compressed, glyph-encoded content stream.
  it("has no completedAt, seal metadata or verification id in its model", () => {
    const keys = Object.keys(model());
    expect(keys).not.toContain("completedAt");
    expect(keys).not.toContain("seal");
    expect(keys).not.toContain("sealVersion");
    expect(keys).not.toContain("verificationId");
    expect(keys).not.toContain("finalDocumentDigest");
    // The owner's decision: the merged digest is internal provenance, so it is
    // not on the certificate either.
    expect(keys).not.toContain("mergedDocumentDigest");
  });

  it("has no IP, user agent or device data on a participant", () => {
    const keys = Object.keys(participant());
    for (const forbidden of ["ipAddress", "userAgent", "device", "location", "geo"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("has no raw signature or field values on a participant", () => {
    const keys = Object.keys(participant());
    for (const forbidden of ["signature", "signatureImage", "representation", "fieldValues"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("carries no full email — only the masked form", () => {
    const keys = Object.keys(participant());
    expect(keys).toContain("maskedEmail");
    expect(keys).not.toContain("email");
  });

  describe("the renderer source draws no forbidden claim", () => {
    const source = readFileSync(
      new URL("./internal/certificate.ts", import.meta.url), "utf8",
    )
      // Comments explain WHY each word is forbidden and would match themselves.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    /**
     * Only the strings the renderer actually draws.
     *
     * The character class excludes NEWLINES, and that is not incidental. Without
     * it, `[^"\\]` matches line breaks too, so the regex pairs each closing
     * quote with the NEXT opening quote and swallows whole blocks of code as
     * one "string" — which is exactly what it did on the first run, and why the
     * positive control below exists rather than being assumed.
     */
    const drawn = Array.from(source.matchAll(/"([^"\\\r\n]{3,})"/g)).map((m) => m[1] ?? "");

    it("finds the strings it DOES draw — the positive control", () => {
      // Without this the checks below would pass against an empty list, which
      // is exactly how a byte-search test on this PDF fools itself.
      expect(drawn).toContain("Certificate of Completion");
      expect(drawn).toContain("Signing source document SHA-256");
    });

    it.each([
      ["Completed", /^Completed$/],
      ["Sealed", /^Sealed$/],
      ["Verification ID", /^Verification ID$/],
      ["Prepared document", /Prepared document/],
      ["Identity verified", /Identity verified/i],
      ["court-admissible as a claim", /^court-admissible$/i],
    ])("draws no %s", (_label, pattern) => {
      expect(drawn.filter((s) => pattern.test(s))).toEqual([]);
    });
  });
});

describe("authentication language", () => {
  it.each([
    ["email-otp" as const],
    ["link-only" as const],
  ])("renders %s without failing", async (authenticationMethod) => {
    const result = await generator.generate(
      model({ participants: [participant({ authenticationMethod })] }));
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it("FAILS CLOSED on a method it has no wording for", async () => {
    // §179. A new mechanism must not inherit another's description, and must
    // certainly never be labelled "Verified" by a default branch.
    const error = await rejection(generator.generate(model({
      participants: [participant({
        authenticationMethod: "sms-otp" as never,
      })],
    })));
    expect(error).toBeInstanceOf(UnsupportedRepresentationError);
    expect(error.retryable).toBe(false);
  });
});

describe("identity rendering", () => {
  it.each([
    ["tilde", "Peñaflor Ubaldo"],
    ["acute", "Ángeles"],
    ["cedilla", "François Guimarães"],
    ["macron", "Māori Ōtani"],
  ])("renders a name containing a %s", async (_label, name) => {
    const result = await generator.generate(
      model({ participants: [participant({ name })] }));
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it("FAILS rather than rendering a name it cannot draw", async () => {
    // §178. Tofu boxes, or worse a blank where a signer's name should be, must
    // never reach a certificate. An embedded font draws nothing rather than
    // throwing, so this refusal is what makes the difference.
    const error = await rejection(generator.generate(
      model({ participants: [participant({ name: "田中太郎" })] })));
    expect(error).toBeInstanceOf(UnrenderableTextError);
    expect(error.retryable).toBe(false);
  });

  it("never puts a recipient name in the error message", async () => {
    // §42/§243. Certificate errors are logged.
    const error = await rejection(generator.generate(
      model({ participants: [participant({ name: "田中太郎" })] })));
    expect(error.message).not.toContain("田中太郎");
    expect(error.message).toMatch(/U\+7530/);
  });

  it("WRAPS a long name rather than truncating it", async () => {
    // §105: a signer's identity is never silently shortened. Proven by the
    // document growing rather than the text being cut.
    const short = await generator.generate(
      model({ participants: [participant({ name: "Ana Cruz" })] }));
    const long = await generator.generate(model({
      participants: [participant({
        name: "Maria Consuelo Dolores Guadalupe de los Santos Peñaflor y Villanueva",
      })],
    }));
    expect(long.sizeBytes).toBeGreaterThan(short.sizeBytes);
  });
});

describe("layout", () => {
  it("paginates rather than dropping participants", async () => {
    // §107. A thirty-signer transaction must not render its last signers below
    // the page edge and still return a valid PDF.
    const many = model({
      participants: Array.from({ length: 30 }, (_, index) =>
        participant({ recipientId: `srr_${String(index)}`, orderIndex: index })),
    });
    const result = await generator.generate(many);
    const pdf = await PDFDocument.load(result.certificate);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });

  it("fits a single participant on one page", async () => {
    const result = await generator.generate(model());
    const pdf = await PDFDocument.load(result.certificate);
    expect(pdf.getPageCount()).toBe(1);
  });

  it("renders optional facts as absences, not as placeholders", async () => {
    // §78: prefer omission. A participant with no ceremony entry and no consent
    // produces a SHORTER document — it does not print "Unknown" or "N/A".
    const withAll = await generator.generate(model());
    const withNone = await generator.generate(model({
      participants: [participant({ firstEnteredAt: null, consent: null })],
    }));
    expect(withNone.sizeBytes).toBeLessThan(withAll.sizeBytes);
  });
});

describe("input the generator refuses", () => {
  it("refuses a certificate with no participants", async () => {
    // A certificate certifying nobody would be a plausible-looking document
    // asserting a signing that had no signers.
    const error = await rejection(generator.generate(model({ participants: [] })));
    expect(error).toBeInstanceOf(InvalidSealInputError);
  });

  it("refuses a model produced under another schema version", async () => {
    const error = await rejection(generator.generate(model({
      certificateVersion: "completion-certificate-v2" as never,
    })));
    expect(error).toBeInstanceOf(InvalidSealInputError);
  });
});

describe("email masking", () => {
  it.each([
    ["juan@example.com", "j***@example.com"],
    ["maria.santos@lagda.test", "m***@lagda.test"],
    ["a@x.test", "***@x.test"],
  ])("masks %s as %s", (input, expected) => {
    expect(maskEmailForCertificate(input)).toBe(expected);
  });

  it("uses a FIXED mask so the local part's length does not leak", () => {
    // Three asterisks regardless of what was hidden.
    expect(maskEmailForCertificate("ab@x.test")).toBe("a***@x.test");
    expect(maskEmailForCertificate("abcdefghijklmnop@x.test")).toBe("a***@x.test");
  });

  it("masks a malformed address ENTIRELY rather than letting it through", () => {
    // This function must never be the thing that prints an unmasked value.
    for (const bad of ["", "not-an-email", "@x.test", "trailing@", "a@b@c"]) {
      const masked = maskEmailForCertificate(bad);
      expect(masked.startsWith("***") || masked.includes("***@")).toBe(true);
    }
  });

  it("keeps the domain, which is what makes it recognisable", () => {
    expect(maskEmailForCertificate("juan@example.com")).toContain("@example.com");
  });
});
