// Signature submission ports (BACKEND-36).

import type { WorkspaceId } from "@lagda/contracts";
import type { PreparationFieldType } from "@lagda/contracts";
import type {
  SigningRequestId, SigningRequestRecipientId, SigningRequestFieldId,
} from "./signing-requests.js";
import type {
  RecipientSigningSessionId, RecipientAuthenticationMethod,
} from "./signing-sessions.js";
import type { SigningConsentId } from "./signing-ceremony.js";

export type RecipientSubmissionId = string & { readonly __brand: "RecipientSubmissionId" };
export type SigningFieldValueId = string & { readonly __brand: "SigningFieldValueId" };
export type SigningRepresentationId =
  string & { readonly __brand: "SigningRepresentationId" };

export type RepresentationPurpose = "signature" | "initials";
export type RepresentationType = "TYPED_SIGNATURE_V1" | "RASTER_SIGNATURE_V1";

// ── Records ──────────────────────────────────────────────────────────────────

/** An accepted signing act. Read back on replay, never rewritten. */
export interface AcceptedSubmissionRecord {
  readonly submissionId: RecipientSubmissionId;
  /** THE authoritative signing instant. BACKEND-37 must reuse it. */
  readonly acceptedAt: number;
  readonly acceptedFieldCount: number;
}

export interface NewSigningRepresentation {
  readonly representationId: SigningRepresentationId;
  readonly purpose: RepresentationPurpose;
  readonly representationType: RepresentationType;
  readonly typedText: string | null;
  readonly typedStyleIndex: number | null;
  /** DECODED bytes. Never a data URL, never base64. */
  readonly rasterBytes: Buffer | null;
  readonly rasterMediaType: string | null;
  readonly rasterWidth: number | null;
  readonly rasterHeight: number | null;
  /** SHA-256 over the bytes AS STORED, computed here, never claimed. */
  readonly digest: string;
}

export interface NewSigningFieldValue {
  readonly valueId: SigningFieldValueId;
  readonly fieldId: SigningRequestFieldId;
  readonly fieldType: PreparationFieldType;
  readonly valueKind: "text" | "boolean" | "instant" | "representation";
  readonly valueSource: "RECIPIENT_PROVIDED" | "SERVER_DERIVED";
  readonly textValue: string | null;
  readonly booleanValue: boolean | null;
  readonly instantValue: number | null;
  readonly representationId: SigningRepresentationId | null;
}

/** Everything one signing act writes, in one statement group. */
export interface NewRecipientSubmission {
  readonly submissionId: RecipientSubmissionId;
  readonly acceptedAt: number;
  readonly signingSessionId: RecipientSigningSessionId;
  readonly authenticationMethod: RecipientAuthenticationMethod;
  readonly consentId: SigningConsentId | null;
  readonly representations: readonly NewSigningRepresentation[];
  readonly values: readonly NewSigningFieldValue[];
}

// ── The repository ───────────────────────────────────────────────────────────

/**
 * Submission persistence, bound to the ceremony's workspace, request and
 * recipient.
 *
 * ── No update, no delete, and no method that could ─────────────────────────
 *
 * §186 asks that `updateFieldValue` and `deleteFieldValue` not be exposed to
 * ordinary application code. They are not declared at all, so there is nothing
 * to expose — and the runtime role holds no UPDATE or DELETE privilege on any
 * of the three tables either. Two layers, neither relying on the other.
 */
export interface RecipientSubmissionRepository {
  /** The accepted submission for THIS recipient, if one exists. */
  findAccepted(): Promise<AcceptedSubmissionRecord | null>;
  /**
   * Writes the submission, its representations and its values.
   *
   * One call, so there is no interleaving in which a submission exists without
   * its values (§135). A unique violation on the one-per-recipient constraint
   * surfaces as a conflict rather than an overwrite.
   */
  create(submission: NewRecipientSubmission): Promise<void>;
}

export interface RecipientSubmissionIdGenerator {
  nextRecipientSubmissionId(): RecipientSubmissionId;
  nextSigningFieldValueId(): SigningFieldValueId;
  nextSigningRepresentationId(): SigningRepresentationId;
}

// ── Signature image validation ───────────────────────────────────────────────

export interface ValidatedRasterSignature {
  readonly bytes: Buffer;
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
  readonly digest: string;
}

/**
 * Decodes and validates a drawn signature.
 *
 * A PORT rather than a helper, because it reads magic bytes and parses an image
 * header — infrastructure knowledge the application layer should not carry, and
 * the seam where a future format lands.
 *
 * Returns `null` for anything it cannot prove is a bounded raster image. It
 * never throws on hostile input, because hostile input is the expected case.
 */
export interface SignatureImageValidator {
  validate(base64: string): ValidatedRasterSignature | null;
  /**
   * SHA-256 over a canonical typed payload.
   *
   * Here rather than in the use case so `node:crypto` stays out of the
   * application layer - the same seam every other digest in this codebase
   * uses, and the one the sealing architecture guard enumerates.
   */
  digestCanonical(value: string): string;
}

// ── Typed-signature renderability ────────────────────────────────────────────

/**
 * Why the renderer cannot draw a typed value.
 *
 * Two reasons, because there are two independent failure modes and neither
 * check finds both:
 *
 *   `missing-glyphs`  the face has no glyph for some character. It can name
 *                     them, as CODE POINTS — never the characters, and never
 *                     the text, because the value is the signer's name and
 *                     must not reach a log or a persisted error (§42, §217).
 *
 *   `shaping-failed`  every glyph is present and the renderer still cannot
 *                     lay the text out. Nothing useful can be named: the
 *                     failure is in the shaper, not in any one character.
 */
export type TypedSignatureProblem =
  | { readonly reason: "missing-glyphs"; readonly codePoints: readonly number[] }
  | { readonly reason: "shaping-failed" };

/**
 * Answers whether the document renderer can actually draw a typed signature.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * The merge refuses text it cannot draw, and the signer is long gone by the
 * time it does: the merge runs in the completion pipeline, after the tab is
 * closed. Without this check the submission is accepted, the completion run
 * then fails, the request never reaches `completed`, and neither the signer
 * nor the sender is told. Both failure modes end there — a missing glyph fails
 * terminally, a shaping failure retries the whole attempt budget first — so
 * both are refused here instead.
 *
 * ── Why a port ────────────────────────────────────────────────────────────
 *
 * Renderability is a property of the embedded typeface and the shaper that
 * lays it out, both of which live in the sealing package. The application
 * layer must not import it (the architecture guard asserts so), and must not
 * carry a hand-written charset either: two definitions that agree today would
 * diverge the first time a face changes, silently restoring the gap. The
 * composition root binds this to the renderer's own probe, so there is exactly
 * one definition.
 */
export interface TypedSignatureRenderability {
  /**
   * The reason the renderer cannot draw this text, or `null` when it can.
   *
   * RENDERABILITY, not glyph coverage. Coverage alone is not the same
   * question: text can have every glyph and still fail to lay out, and the
   * adapter is responsible for asking both halves.
   *
   * Never throws. Unrenderable text is an expected input here, not a fault —
   * a throw would surface as a 500 instead of a problem the signer can act on.
   */
  check(text: string): TypedSignatureProblem | null;
}

export interface SubmissionWorkspaceScope {
  readonly workspaceId: WorkspaceId;
  readonly signingRequestId: SigningRequestId;
  readonly recipientId: SigningRequestRecipientId;
}
