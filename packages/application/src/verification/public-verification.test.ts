// Public document verification (BACKEND-42).
//
// Most of these assert an ABSENCE or a refusal. A public, unauthenticated,
// indexable endpoint is the one place where a field that "seems harmless"
// cannot be taken back once search engines have it.

import { describe, it, expect, vi } from "vitest";
import type { Sha256Digest, VerificationId } from "@lagda/contracts";
import type { PublicVerificationProjection } from "../common/ports/index.js";
import {
  getPublicVerification, compareUploadedFile, parseVerificationId,
  PUBLIC_VERIFICATION_SCHEMA_VERSION,
} from "./public-verification.js";

const ID = "LAGDA-VER-2026-A7bK9mQ2xZ" as VerificationId;
const FINAL_DIGEST = "d".repeat(64) as Sha256Digest;
const ORIGINAL_DIGEST = "a".repeat(64) as Sha256Digest;
const AT = Date.parse("2026-08-11T10:00:00.000Z");

function record(
  overrides: Partial<PublicVerificationProjection> = {},
): PublicVerificationProjection {
  return {
    verificationId: ID,
    completedAt: AT,
    participantCount: 2,
    signedDocumentHash: FINAL_DIGEST,
    originalDocumentHash: ORIGINAL_DIGEST,
    digestAlgorithm: "sha-256",
    sealScheme: "hash-evidence",
    sealVersion: 1,
    ...overrides,
  };
}

const deps = (found: PublicVerificationProjection | null) => ({
  lookup: { findByVerificationId: vi.fn(() => Promise.resolve(found)) },
});

describe("parsing a verification reference", () => {
  it("accepts the canonical form", () => {
    expect(parseVerificationId("LAGDA-VER-2026-A7bK9mQ2xZ")).toBe(ID);
  });

  it("trims surrounding whitespace from a paste", () => {
    expect(parseVerificationId("  LAGDA-VER-2026-A7bK9mQ2xZ\n")).toBe(ID);
  });

  it("REFUSES a short suffix the frontend regex would accept", () => {
    // The product's `VER_ID_RE` permits four characters — roughly 8 million
    // values, enumerable at any plausible rate limit. LAGDA mints ten, nothing
    // ever minted fewer, so requiring the full length costs nothing and stops a
    // short reference resolving even if some future code path takes the
    // frontend's lower bound.
    expect(parseVerificationId("LAGDA-VER-2026-A7bK")).toBeNull();
    expect(parseVerificationId("LAGDA-VER-2026-A7bK9mQ2")).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["wrong prefix", "LAGDA-VERIFY-2026-A7bK9mQ2xZ"],
    ["no year", "LAGDA-VER-A7bK9mQ2xZ"],
    ["too long", "LAGDA-VER-2026-A7bK9mQ2xZzz"],
    ["underscore", "LAGDA-VER-2026-A7bK9mQ2x_"],
    ["sql-ish", "LAGDA-VER-2026-' OR 1=1 --"],
  ])("refuses %s", (_label, raw) => {
    expect(parseVerificationId(raw)).toBeNull();
  });

  it("does NOT lowercase — the alphabet is case-sensitive", () => {
    // Normalizing case would map two distinct references onto one.
    expect(parseVerificationId("lagda-ver-2026-a7bk9mq2xz")).toBeNull();
  });

  it("refuses before the database is touched", async () => {
    const d = deps(record());
    await getPublicVerification("nonsense", d);
    expect(d.lookup.findByVerificationId).not.toHaveBeenCalled();
  });
});

describe("the public view", () => {
  it("returns the completed outcome with the authoritative digest", async () => {
    const result = await getPublicVerification(ID, deps(record()));

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") throw new Error("unreachable");
    expect(result.view.finalDocument.digest).toBe(FINAL_DIGEST);
    expect(result.view.finalDocument.digestAlgorithm).toBe("sha-256");
    expect(result.view.completedAt).toBe(AT);
    expect(result.view.participantCount).toBe(2);
    expect(result.view.schemaVersion).toBe(PUBLIC_VERIFICATION_SCHEMA_VERSION);
  });

  it("publishes the SIGNED digest, not the original", async () => {
    // A holder hashes the completed file. `originalDocumentHash` is the
    // pre-signature upload and would never match, so publishing it as the
    // comparison value would make every honest check fail.
    const result = await getPublicVerification(ID, deps(record()));
    if (result.outcome !== "completed") throw new Error("unreachable");
    expect(result.view.finalDocument.digest).not.toBe(ORIGINAL_DIGEST);
  });

  it("carries the seal scheme, version and a plain-language description", async () => {
    const result = await getPublicVerification(ID, deps(record()));
    if (result.outcome !== "completed") throw new Error("unreachable");
    expect(result.view.seal.scheme).toBe("hash-evidence");
    expect(result.view.seal.version).toBe(1);
    expect(result.view.seal.description).toContain("SHA-256");
  });

  it("says what the seal is NOT", async () => {
    const result = await getPublicVerification(ID, deps(record()));
    if (result.outcome !== "completed") throw new Error("unreachable");
    expect(result.view.seal.description)
      .toContain("not a digital signature certificate");
    expect(result.view.seal.description).toContain("does not verify signer identity");
  });

  it.each([
    "PAdES", "X.509", "PKI", "PNPKI", "RFC 3161", "timestamp authority",
    "HSM", "notaris", "notarized", "legally binding", "identity verified",
  ])("never claims %s", async (claim) => {
    const result = await getPublicVerification(ID, deps(record()));
    if (result.outcome !== "completed") throw new Error("unreachable");
    expect(result.view.seal.description.toLowerCase())
      .not.toContain(claim.toLowerCase());
  });
});

describe("what the public view must never carry", () => {
  it("exposes no internal identifiers or storage metadata", async () => {
    const result = await getPublicVerification(ID, deps(record()));
    if (result.outcome !== "completed") throw new Error("unreachable");

    // Serialized, because a nested field is exactly what a shape assertion
    // misses and a public endpoint cannot take back.
    const wire = JSON.stringify(result.view);
    for (const forbidden of [
      "workspace", "signingRequest", "documentId", "artifact", "completionRun",
      "sealId", "storage", "bucket", "key",
    ]) {
      expect(wire.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("exposes no signer PII", async () => {
    const result = await getPublicVerification(ID, deps(record()));
    if (result.outcome !== "completed") throw new Error("unreachable");

    // The seal DESCRIPTION is excluded, and the reason is worth stating: it is
    // static approved copy that legitimately contains the word "signature" — in
    // the sentence saying the seal is NOT a digital signature certificate. A
    // sweep over the whole blob flagged that disclaimer as a leak.
    //
    // Excluding it is only safe because the description is a constant, asserted
    // verbatim by the tests above; it can never carry a signer's data.
    const { seal, ...rest } = result.view;
    const wire = JSON.stringify({
      ...rest, seal: { ...seal, description: undefined },
    }).toLowerCase();

    for (const forbidden of [
      "name", "email", "@", "ipaddress", "useragent", "signature", "consent",
    ]) {
      expect(wire).not.toContain(forbidden);
    }
    // Only the COUNT of participants is public — how many acted, never who.
    expect(result.view.participantCount).toBe(2);
  });

  it("carries only the eight expected top-level shapes", async () => {
    // A structural allowlist, so a field added upstream cannot ride along
    // unnoticed into a public response.
    const result = await getPublicVerification(ID, deps(record()));
    if (result.outcome !== "completed") throw new Error("unreachable");
    expect(Object.keys(result.view).sort()).toEqual([
      "completedAt", "finalDocument", "participantCount", "schemaVersion",
      "seal", "verificationId",
    ]);
  });
});

describe("not-found collapses every failing case", () => {
  it("reports not-found for an unknown reference", async () => {
    expect((await getPublicVerification(ID, deps(null))).outcome).toBe("not-found");
  });

  it("reports not-found identically for malformed and unknown", async () => {
    // §19/§106. A caller able to tell "no such reference" from "exists but is
    // not completed" has an oracle for other people's documents.
    const unknown = await getPublicVerification(ID, deps(null));
    const malformed = await getPublicVerification("LAGDA-VER-2026-xx", deps(null));
    expect(malformed).toEqual(unknown);
  });

  it("says nothing about WHY", async () => {
    const result = await getPublicVerification(ID, deps(null));
    expect(Object.keys(result)).toEqual(["outcome"]);
  });
});

describe("file comparison", () => {
  it("matches when the uploaded digest equals the authoritative one", async () => {
    const result = await compareUploadedFile(
      { rawVerificationId: ID, uploadedDigest: FINAL_DIGEST }, deps(record()));

    expect(result).toEqual({
      outcome: "compared",
      matches: true,
      digestAlgorithm: "sha-256",
      authoritativeDigest: FINAL_DIGEST,
      uploadedDigest: FINAL_DIGEST,
    });
  });

  it("does NOT match on a single differing byte", async () => {
    const oneOff = ("d".repeat(63) + "e") as Sha256Digest;
    const result = await compareUploadedFile(
      { rawVerificationId: ID, uploadedDigest: oneOff }, deps(record()));

    expect(result.outcome).toBe("compared");
    if (result.outcome !== "compared") throw new Error("unreachable");
    expect(result.matches).toBe(false);
  });

  it("treats a mismatch as a SUCCESSFUL comparison", async () => {
    // §168. The operation worked; the bytes differ. A re-saved PDF is the
    // commonest cause and is not evidence of anything.
    const result = await compareUploadedFile(
      { rawVerificationId: ID, uploadedDigest: "f".repeat(64) as Sha256Digest },
      deps(record()));
    expect(result.outcome).toBe("compared");
  });

  it("does not match against the ORIGINAL digest", async () => {
    // Uploading the pre-signature file must not verify as the completed one.
    const result = await compareUploadedFile(
      { rawVerificationId: ID, uploadedDigest: ORIGINAL_DIGEST }, deps(record()));
    if (result.outcome !== "compared") throw new Error("unreachable");
    expect(result.matches).toBe(false);
  });

  it("reports not-found for an unknown reference without comparing", async () => {
    const result = await compareUploadedFile(
      { rawVerificationId: ID, uploadedDigest: FINAL_DIGEST }, deps(null));
    expect(result).toEqual({ outcome: "not-found" });
  });

  it("refuses a malformed reference before the database is touched", async () => {
    const d = deps(record());
    await compareUploadedFile(
      { rawVerificationId: "short", uploadedDigest: FINAL_DIGEST }, d);
    expect(d.lookup.findByVerificationId).not.toHaveBeenCalled();
  });
});
