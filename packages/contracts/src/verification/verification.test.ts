// Runtime schema behaviour for the verification contracts (§47).
//
// These test the things a type cannot: what the validator ACCEPTS and REJECTS at
// the trust boundary. Verification is unauthenticated, so a schema that quietly
// accepts a malformed digest or an unexpected property is a real defect.

import { describe, it, expect } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  PublicVerificationResponseSchema,
  AuthenticatedVerificationResponseSchema,
  VerificationLookupRequestSchema,
  VerificationRecordStatusSchema,
  FileComparisonResultSchema,
  VERIFICATION_RECORD_STATUSES,
  FILE_COMPARISON_RESULTS,
} from "./index.js";

const DIGEST = "a".repeat(64);

describe("verification status contracts", () => {
  it("accepts every canonical record status", () => {
    for (const status of VERIFICATION_RECORD_STATUSES) {
      expect(Value.Check(VerificationRecordStatusSchema, status), status).toBe(true);
    }
  });

  it("rejects a status that is not canonical", () => {
    // The near-synonyms found across the frontend: "complete" vs "completed",
    // "cancelled" vs "voided". None of them are verification record statuses,
    // and the schema is what stops one drifting in.
    for (const wrong of ["complete", "completed", "voided", "valid", "VERIFIED", ""]) {
      expect(Value.Check(VerificationRecordStatusSchema, wrong), wrong).toBe(false);
    }
  });

  it("accepts every canonical file comparison result", () => {
    for (const result of FILE_COMPARISON_RESULTS) {
      expect(Value.Check(FileComparisonResultSchema, result), result).toBe(true);
    }
  });

  it("rejects the frontend's demonstration-only comparison values", () => {
    // `transaction-detail.ts` declares match-demo / mismatch-demo. Those are
    // demonstration artifacts and must never appear on an API.
    for (const demo of ["match-demo", "mismatch-demo", "not-checked"]) {
      expect(Value.Check(FileComparisonResultSchema, demo), demo).toBe(false);
    }
  });
});

describe("PublicVerificationResponse", () => {
  it("accepts a minimal not-found result", () => {
    // A mistyped identifier is an ordinary outcome of a public lookup form, so
    // the response must be valid with nothing but the status.
    expect(
      Value.Check(PublicVerificationResponseSchema, {
        verificationId: "ver_123",
        status: "not-found",
      }),
    ).toBe(true);
  });

  it("accepts a complete verified result", () => {
    expect(
      Value.Check(PublicVerificationResponseSchema, {
        verificationId: "ver_123",
        status: "verified",
        signedDocumentHash: DIGEST,
        completedAt: "2026-08-09T04:15:30.000Z",
        participantCount: 3,
        issuerName: "Northbridge Legal",
        fileComparison: "match",
      }),
    ).toBe(true);
  });

  it("rejects a malformed digest", () => {
    for (const bad of [
      "A".repeat(64),        // uppercase hex
      "a".repeat(63),        // too short
      "a".repeat(65),        // too long
      `${"a".repeat(60)}zzzz`, // non-hex
      "",
    ]) {
      expect(
        Value.Check(PublicVerificationResponseSchema, {
          verificationId: "ver_123",
          status: "verified",
          signedDocumentHash: bad,
        }),
        `digest ${JSON.stringify(bad.slice(0, 12))}`,
      ).toBe(false);
    }
  });

  it("rejects a timestamp that is not UTC or not RFC 3339", () => {
    // The contract says UTC with a trailing Z. An offset encoding would let two
    // spellings of the same instant travel under one type.
    for (const bad of [
      "2026-08-09T04:15:30+08:00", // offset rather than Z
      "2026-08-09 04:15:30Z",      // space instead of T
      "2026-08-09",                // date only
      "09/08/2026",
      "not-a-date",
    ]) {
      expect(
        Value.Check(PublicVerificationResponseSchema, {
          verificationId: "ver_123",
          status: "verified",
          completedAt: bad,
        }),
        bad,
      ).toBe(false);
    }
  });

  it("accepts a UTC timestamp with or without fractional seconds", () => {
    for (const good of ["2026-08-09T04:15:30Z", "2026-08-09T04:15:30.000Z"]) {
      expect(
        Value.Check(PublicVerificationResponseSchema, {
          verificationId: "ver_123",
          status: "verified",
          completedAt: good,
        }),
        good,
      ).toBe(true);
    }
  });

  it("rejects a negative participant count", () => {
    expect(
      Value.Check(PublicVerificationResponseSchema, {
        verificationId: "ver_123",
        status: "verified",
        participantCount: -1,
      }),
    ).toBe(false);
  });

  it("REFUSES fields that belong only to the authenticated response", () => {
    // The central guarantee of splitting the two responses. If this passed, the
    // public endpoint could leak the owning workspace by structural accident.
    for (const leak of [
      { issuerWorkspaceId: "ws_1" },
      { transactionId: "txn_1" },
      { originalDocumentHash: DIGEST },
    ]) {
      expect(
        Value.Check(PublicVerificationResponseSchema, {
          verificationId: "ver_123",
          status: "verified",
          ...leak,
        }),
        Object.keys(leak)[0],
      ).toBe(false);
    }
  });
});

describe("AuthenticatedVerificationResponse", () => {
  it("accepts the public fields plus owner context", () => {
    expect(
      Value.Check(AuthenticatedVerificationResponseSchema, {
        verificationId: "ver_123",
        status: "verified",
        signedDocumentHash: DIGEST,
        issuerWorkspaceId: "ws_1",
        transactionId: "txn_1",
        originalDocumentHash: "b".repeat(64),
      }),
    ).toBe(true);
  });

  it("requires the owning workspace", () => {
    // Without it there is nothing to authorize the response against.
    expect(
      Value.Check(AuthenticatedVerificationResponseSchema, {
        verificationId: "ver_123",
        status: "verified",
      }),
    ).toBe(false);
  });
});

describe("VerificationLookupRequest", () => {
  it("accepts an identifier alone", () => {
    expect(
      Value.Check(VerificationLookupRequestSchema, { verificationId: "ver_123" }),
    ).toBe(true);
  });

  it("rejects unknown properties", () => {
    // Documented policy: requests REJECT unknown fields. Silently ignoring one
    // on a security-sensitive lookup hides a client defect.
    expect(
      Value.Check(VerificationLookupRequestSchema, {
        verificationId: "ver_123",
        workspaceId: "ws_1",
      }),
    ).toBe(false);
  });

  it("rejects a missing identifier", () => {
    expect(Value.Check(VerificationLookupRequestSchema, {})).toBe(false);
  });
});

describe("JSON serialization", () => {
  it("round-trips without custom transport handling", () => {
    // §132: contracts must not depend on non-JSON-safe values. Branded IDs are
    // strings and timestamps are strings, so a round trip is lossless — no
    // Date, BigInt, Map, Set or Buffer anywhere in the shape.
    const response = {
      verificationId: "ver_123",
      status: "verified" as const,
      signedDocumentHash: DIGEST,
      completedAt: "2026-08-09T04:15:30.000Z",
      participantCount: 2,
    };
    const roundTripped: unknown = JSON.parse(JSON.stringify(response));
    expect(roundTripped).toEqual(response);
    expect(Value.Check(PublicVerificationResponseSchema, roundTripped)).toBe(true);
  });
});
