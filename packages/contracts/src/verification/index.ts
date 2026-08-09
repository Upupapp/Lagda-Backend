// Document verification contracts.
//
// Verification is LAGDA's most exposed boundary: `GET /verify/:verificationId`
// is unauthenticated, so anyone holding an identifier sees whatever this
// contract permits. It is extracted first for that reason, and because the
// handoff specifies it precisely enough to extract without guessing.
//
// TWO CONFLICTS WITH THE FRONTEND MODEL, both resolved in favour of the handoff
// per the §127 source hierarchy. Both are recorded in
// CONTRACT_EXTRACTION_REPORT.md.
//
//  1. The frontend's `VerificationRecord` carries NO hashes, although the
//     handoff defines verification as hash comparison and names
//     `documentHash` / `signedDocumentHash` explicitly. The frontend also
//     exposes `fileMatchStatus` for comparing an uploaded file — with nothing
//     specified to compare against. The hashes are restored here.
//
//  2. The frontend puts public and authenticated fields in ONE interface,
//     separated by a `publiclyVerifiable` boolean. The handoff specifies two
//     endpoints with different exposure. One shape guarded by a boolean is a
//     leak waiting to happen — the boolean has to be checked correctly at every
//     call site, forever. Two types cannot leak into each other.

import { Type, type Static } from "@sinclair/typebox";
import { TimestampSchema, Sha256DigestSchema, NonNegativeIntSchema } from "../common/index.js";
import { VerificationIdSchema, WorkspaceIdSchema, TransactionIdSchema } from "../ids/index.js";

// ── Record status ────────────────────────────────────────────────────────────

/**
 * Whether a verification record exists and what state it describes.
 *
 * `not-found` is a first-class outcome rather than an error: a mistyped
 * identifier is an ordinary result of a public lookup form, not an exception.
 */
export const VerificationRecordStatusSchema = Type.Union(
  [
    Type.Literal("verified"),
    Type.Literal("not-found"),
    Type.Literal("revoked"),
    Type.Literal("expired"),
  ],
  {
    title: "VerificationRecordStatus",
    description: "State of the verification record itself, not of any uploaded file.",
  },
);
export type VerificationRecordStatus = Static<typeof VerificationRecordStatusSchema>;

/** Canonical serialized values. Changing one of these is an API change (§13). */
export const VERIFICATION_RECORD_STATUSES = [
  "verified", "not-found", "revoked", "expired",
] as const;

// ── File comparison ──────────────────────────────────────────────────────────

/**
 * Result of comparing a user-supplied file against a stored digest.
 *
 * The frontend declares `FileMatchStatus` TWICE with different vocabularies —
 * `transaction-detail.ts` uses `not-checked / match-demo / mismatch-demo /
 * unavailable`, and `verification.ts` uses a nine-value set. The `-demo`
 * suffixes are frontend demonstration artifacts and must never reach an API.
 *
 * This keeps the richer vocabulary's distinctions but drops the demo values and
 * collapses the several "we could not read your file" cases into one, since the
 * caller's remedy is identical for all of them.
 */
export const FileComparisonResultSchema = Type.Union(
  [
    Type.Literal("not-compared"),
    Type.Literal("match"),
    Type.Literal("mismatch"),
    Type.Literal("file-unreadable"),
    Type.Literal("comparison-unavailable"),
  ],
  { title: "FileComparisonResult" },
);
export type FileComparisonResult = Static<typeof FileComparisonResultSchema>;

export const FILE_COMPARISON_RESULTS = [
  "not-compared", "match", "mismatch", "file-unreadable", "comparison-unavailable",
] as const;

// ── Public response ──────────────────────────────────────────────────────────

/**
 * `GET /verify/:verificationId` — UNAUTHENTICATED.
 *
 * Everything here is visible to anyone holding an identifier, so the shape is
 * deliberately thin. Deliberately absent: the owning workspace's ID, the
 * associated transaction ID, participant names or emails, document contents,
 * storage keys, and evidence detail. A workspace *name* is included because a
 * verifier needs to know who issued the document; the workspace *ID* is not,
 * because it addresses records.
 *
 * `signedDocumentHash` is published on purpose — it is what makes independent
 * verification possible: a holder can hash their copy and compare without
 * trusting this response.
 */
export const PublicVerificationResponseSchema = Type.Object(
  {
    verificationId: VerificationIdSchema,
    status: VerificationRecordStatusSchema,

    /** Present only when `status` is `verified`. */
    signedDocumentHash: Type.Optional(Sha256DigestSchema),
    completedAt: Type.Optional(TimestampSchema),
    participantCount: Type.Optional(NonNegativeIntSchema),
    /** Display name of the issuing workspace. Never its ID. */
    issuerName: Type.Optional(Type.String({ minLength: 1 })),

    /** Set when the caller supplied a file to compare. */
    fileComparison: Type.Optional(FileComparisonResultSchema),
  },
  {
    title: "PublicVerificationResponse",
    description: "Safe public fields only. Contains no private content.",
    additionalProperties: false,
  },
);
export type PublicVerificationResponse = Static<typeof PublicVerificationResponseSchema>;

// ── Authenticated response ───────────────────────────────────────────────────

/**
 * `GET /api/verify/:verificationId` — authenticated, and authorized to the
 * owning workspace.
 *
 * Extends the public shape with the context an owner legitimately needs. It is
 * a separate type rather than optional fields on the public one, so a handler
 * cannot return this where the public shape is expected.
 *
 * `originalDocumentHash` appears here and NOT publicly: it is the digest of the
 * pre-signature upload, which would let a public caller test guesses about the
 * source document.
 */
export const AuthenticatedVerificationResponseSchema = Type.Composite(
  [
    PublicVerificationResponseSchema,
    Type.Object({
      issuerWorkspaceId: WorkspaceIdSchema,
      transactionId: Type.Optional(TransactionIdSchema),
      originalDocumentHash: Type.Optional(Sha256DigestSchema),
    }),
  ],
  { title: "AuthenticatedVerificationResponse", additionalProperties: false },
);
export type AuthenticatedVerificationResponse =
  Static<typeof AuthenticatedVerificationResponseSchema>;

// ── Request ──────────────────────────────────────────────────────────────────

/**
 * Lookup input. The file itself is never in JSON — the caller hashes locally and
 * sends the digest, so verification needs no upload and the document never
 * leaves the holder's machine.
 */
export const VerificationLookupRequestSchema = Type.Object(
  {
    verificationId: VerificationIdSchema,
    /** Optional client-computed digest to compare against the record. */
    fileDigest: Type.Optional(Sha256DigestSchema),
  },
  {
    title: "VerificationLookupRequest",
    // Unknown properties are REJECTED on requests. On a security-sensitive
    // lookup, silently ignoring an unexpected field hides a client defect.
    additionalProperties: false,
  },
);
export type VerificationLookupRequest = Static<typeof VerificationLookupRequestSchema>;
