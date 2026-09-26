// Signature submission wire contracts (BACKEND-36).
//
// ── One discriminated union, not one `value: any` ──────────────────────────
//
// §41 forbids a generic value. Each field type gets a member whose shape only
// makes sense for that type, so "a checkbox arrived as the string yes" is a
// schema failure rather than something a validator has to notice.
//
// The SERVER_DERIVED types - `date-signed`, `full-name`, `email`, and the
// outcome blocks `review-block` and `approval-block` (081) - have NO member at
// all. A client cannot express a value for them, which is stronger
// than rejecting one (§70, §71, §72).

import { Type, type Static } from "@sinclair/typebox";

/** Matches the four server-known styles in `TYPED_SIGNATURE_STYLES`. */
export const TYPED_SIGNATURE_STYLE_COUNT = 4;
export const TYPED_SIGNATURE_MAX_LENGTH = 200;

/** Generous headroom over the product's 420x120 canvas. */
export const RASTER_SIGNATURE_MAX_BYTES = 64 * 1024;
export const RASTER_SIGNATURE_MAX_DIMENSION = 512;
/** base64 inflates by 4/3; the transport bound is checked before decoding. */
export const RASTER_SIGNATURE_MAX_TRANSPORT_CHARS =
  Math.ceil((RASTER_SIGNATURE_MAX_BYTES * 4) / 3) + 128;

export const SIGNING_TEXT_MAX_LENGTH = 2_000;

/** A submission cannot carry more values than a request can have fields. */
export const SUBMISSION_MAX_FIELDS = 500;

// ── Signature representations ────────────────────────────────────────────────

/**
 * A typed signature: text plus an INDEX into a server-known style list.
 *
 * The client never names a font, a family or a stylesheet. There is nowhere to
 * put one, which is how §60 is satisfied — by the absence of a property rather
 * than by sanitising its contents.
 */
/**
 * How the signer produced this mark, as their client reports it.
 *
 * `applied-from-saved` is absent deliberately: the server decides that one,
 * because only the server knows whether it took bytes from a stored
 * signature. A client cannot claim it, which is what makes it worth trusting.
 *
 * The other values are an honest client's account of an honest act. Nothing
 * here can tell a drawn stroke from an uploaded image once both are PNGs, so
 * this is a record, not a control — and recording it is still better than the
 * status quo, where an uploaded image is filed as though it had been drawn.
 */
export const CAPTURE_PROVENANCE = ["typed-live", "drawn-live", "uploaded-live"] as const;

export const CaptureProvenanceSchema = Type.Union(
  CAPTURE_PROVENANCE.map(value => Type.Literal(value)),
  { title: "CaptureProvenance" },
);

export const TypedSignatureSchema = Type.Object({
  method: Type.Literal("typed"),
  /** Optional: a client that does not send it leaves the record blank. */
  provenance: Type.Optional(CaptureProvenanceSchema),
  text: Type.String({ minLength: 1, maxLength: TYPED_SIGNATURE_MAX_LENGTH }),
  styleIndex: Type.Integer({ minimum: 0, maximum: TYPED_SIGNATURE_STYLE_COUNT - 1 }),
}, { title: "TypedSignature", additionalProperties: false });

/**
 * A drawn signature: base64 PNG, decoded and validated server-side.
 *
 * `base64` carries the payload WITHOUT a data-URL prefix. The prefix is
 * transport formatting and proves nothing about content (§199), so the contract
 * refuses it outright rather than parsing it — a client that sends
 * `data:image/png;base64,…` gets a schema error instead of a silent strip.
 */
export const DrawnSignatureSchema = Type.Object({
  method: Type.Literal("drawn"),
  provenance: Type.Optional(CaptureProvenanceSchema),
  base64: Type.String({
    minLength: 16,
    maxLength: RASTER_SIGNATURE_MAX_TRANSPORT_CHARS,
    pattern: "^[A-Za-z0-9+/]+={0,2}$",
  }),
}, { title: "DrawnSignature", additionalProperties: false });

/**
 * "Use the mark you were handed."
 *
 * Carries no bytes and no text — only the instruction. The server already
 * holds what was prepared, bound to this session, and a client that could
 * supply the content could claim `applied-from-saved` for anything it liked.
 * The absence of a payload here is what makes that provenance value mean
 * something.
 */
export const SavedSignatureSchema = Type.Object({
  method: Type.Literal("saved"),
}, { title: "SavedSignature", additionalProperties: false });

export const SignatureRepresentationSchema = Type.Union(
  [TypedSignatureSchema, DrawnSignatureSchema, SavedSignatureSchema],
  { title: "SignatureRepresentation" },
);
export type SignatureRepresentationInput = Static<typeof SignatureRepresentationSchema>;

// ── Field values ─────────────────────────────────────────────────────────────

export const SignatureFieldValueSchema = Type.Object({
  fieldId: Type.String({ minLength: 1, maxLength: 64 }),
  kind: Type.Literal("signature"),
}, { title: "SignatureFieldValue", additionalProperties: false });

export const InitialsFieldValueSchema = Type.Object({
  fieldId: Type.String({ minLength: 1, maxLength: 64 }),
  kind: Type.Literal("initials"),
}, { title: "InitialsFieldValue", additionalProperties: false });

export const TextFieldValueSchema = Type.Object({
  fieldId: Type.String({ minLength: 1, maxLength: 64 }),
  kind: Type.Literal("text"),
  text: Type.String({ maxLength: SIGNING_TEXT_MAX_LENGTH }),
}, { title: "TextFieldValue", additionalProperties: false });

export const CheckboxFieldValueSchema = Type.Object({
  fieldId: Type.String({ minLength: 1, maxLength: 64 }),
  kind: Type.Literal("checkbox"),
  /** A real boolean. Not "yes", not 1, not "checked" (§75). */
  checked: Type.Boolean(),
}, { title: "CheckboxFieldValue", additionalProperties: false });

export const SubmittedFieldValueSchema = Type.Union([
  SignatureFieldValueSchema, InitialsFieldValueSchema,
  TextFieldValueSchema, CheckboxFieldValueSchema,
], { title: "SubmittedFieldValue" });
export type SubmittedFieldValueInput = Static<typeof SubmittedFieldValueSchema>;

// ── The request body ─────────────────────────────────────────────────────────

/**
 * Everything a client may send, and nothing else.
 *
 * Deliberately absent, and refused by `additionalProperties: false`:
 * `recipientId`, `workspaceId`, `signingRequestId`, `signedAt`, `acceptedAt`,
 * `authenticationMethod`, `consentAccepted`, `ip`, `userAgent`, field geometry,
 * `artifactId`, `requestState` (§193).
 *
 * Every one of those is either taken from the session, computed by the backend,
 * or already immutable in the snapshot.
 */
export const SubmitSigningBodySchema = Type.Object({
  fieldValues: Type.Array(SubmittedFieldValueSchema, {
    minItems: 0, maxItems: SUBMISSION_MAX_FIELDS,
  }),
  /** Required only when a signature field is being submitted. */
  signature: Type.Optional(SignatureRepresentationSchema),
  /** Required only when an initials field is being submitted. */
  initials: Type.Optional(SignatureRepresentationSchema),
}, { title: "SubmitSigning", additionalProperties: false });
export type SubmitSigningBody = Static<typeof SubmitSigningBodySchema>;

/**
 * What acceptance returns.
 *
 * A count and two identifiers. No values echoed, no signature data, no storage
 * reference, no evidence internals — and deliberately no claim that the request
 * is complete, because it is not (§144).
 */
export const SubmitSigningResponseSchema = Type.Object({
  submissionId: Type.String({ minLength: 1, maxLength: 64 }),
  acceptedAt: Type.String({ format: "date-time" }),
  acceptedFieldCount: Type.Integer({ minimum: 0 }),
  /** True for this recipient. Says nothing about the request as a whole. */
  recipientSubmissionAccepted: Type.Literal(true),
}, { title: "SubmitSigningResult", additionalProperties: false });
