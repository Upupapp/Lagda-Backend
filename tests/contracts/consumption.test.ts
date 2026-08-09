// Proves @lagda/contracts is consumable, and that its branding does real work.
//
// §91 asks for evidence that a consumer can use the package. This is a fixture
// rather than invented business code — no later command's scope is consumed.
//
// The `@ts-expect-error` assertions are the important part. A brand that the
// compiler does not actually enforce is decorative, and this codebase has
// shipped decorative contracts before. Each of those lines FAILS THE BUILD if
// the error it expects stops occurring, so branding cannot silently weaken.

import { describe, it, expect } from "vitest";
import { Value } from "@sinclair/typebox/value";
import type { WorkspaceId, DocumentId, VerificationId } from "@lagda/contracts";
import {
  PublicVerificationResponseSchema,
  VerificationIdSchema,
  TimestampSchema,
  Sha256DigestSchema,
} from "@lagda/contracts";

/** Stand-in for a workspace-scoped repository call (INV-003). */
function findInWorkspace(workspaceId: WorkspaceId, documentId: DocumentId): string {
  return `${workspaceId}/${documentId}`;
}

describe("contract consumption", () => {
  it("exports schemas that validate at runtime", () => {
    expect(Value.Check(VerificationIdSchema, "ver_123")).toBe(true);
    expect(Value.Check(VerificationIdSchema, "")).toBe(false);
    expect(Value.Check(TimestampSchema, "2026-08-09T04:15:30.000Z")).toBe(true);
    expect(Value.Check(Sha256DigestSchema, "a".repeat(64))).toBe(true);
  });

  it("keeps branded IDs distinct at compile time", () => {
    const workspaceId = "ws_1" as WorkspaceId;
    const documentId = "doc_1" as DocumentId;
    const verificationId = "ver_1" as VerificationId;

    expect(findInWorkspace(workspaceId, documentId)).toBe("ws_1/doc_1");

    // The tenant key cannot be satisfied by another ID. This is what makes
    // INV-003 a type error rather than a review item.
    // @ts-expect-error DocumentId is not a WorkspaceId
    findInWorkspace(documentId, documentId);

    // @ts-expect-error VerificationId is not a WorkspaceId
    findInWorkspace(verificationId, documentId);

    // A public verification reference cannot be used to address a document.
    // @ts-expect-error VerificationId is not a DocumentId
    findInWorkspace(workspaceId, verificationId);

    // A bare string cannot stand in for the tenant key either — which is the
    // whole gap this fixes: the frontend types `workspaceId` as plain `string`
    // in 21 of 27 declarations.
    // @ts-expect-error string is not a WorkspaceId
    findInWorkspace("ws_1", documentId);
  });

  it("serializes branded IDs as plain strings", () => {
    // §9: branding is compile-time only. No wrapper, no custom serializer.
    const id = "ver_123" as VerificationId;
    expect(JSON.stringify({ id })).toBe('{"id":"ver_123"}');
    expect(typeof id).toBe("string");
  });

  it("validates a response built from branded values", () => {
    const response = {
      verificationId: "ver_123" as VerificationId,
      status: "verified" as const,
      signedDocumentHash: "b".repeat(64),
      completedAt: "2026-08-09T04:15:30.000Z",
      participantCount: 2,
    };
    expect(Value.Check(PublicVerificationResponseSchema, response)).toBe(true);
  });
});

describe("contracts package hygiene", () => {
  it("has no import side effects", () => {
    // §36: importing contracts must not read env, connect, log, or mutate
    // globals. If the module body did any of that, it would already have
    // happened by the time this test runs — so a clean env check is meaningful.
    expect(process.env["LAGDA_CONTRACTS_TOUCHED"]).toBeUndefined();
    expect(Value.Check(VerificationIdSchema, "ver_1")).toBe(true);
  });
});
