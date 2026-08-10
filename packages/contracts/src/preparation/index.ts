// The document preparation contract.
//
// ── Preparation is authoring state ─────────────────────────────────────────
//
// It says WHAT will be asked for and WHERE. It is not the document, and it is
// emphatically not a signing request: there is no `sentAt`, no `expiresAt`, no
// signing status, no recipient authentication and no submitted value anywhere
// in this file. BACKEND-32 owns all of those.
//
// ── The coordinate model is not defined here ───────────────────────────────
//
// It was fixed by BACKEND-09 and documented in
// `docs/backend/sealing/PDF_COORDINATE_MODEL.md`: normalized 0–1, top-left
// origin, `y` to the field's TOP edge, 1-based page numbers. This file reuses
// it. A second coordinate model is the defect that puts a signature in the
// wrong half of a page while every test still passes.

import { Type, type Static } from "@sinclair/typebox";
import { DocumentIdSchema } from "../ids/index.js";

// ── Field types ──────────────────────────────────────────────────────────────

/**
 * The nine field types preparation persists.
 *
 * ── Where the list comes from ──────────────────────────────────────────────
 *
 * The product's editor offers thirteen. The sealer can RENDER five. A field a
 * sender can place but the signed PDF can never show is a promise the system
 * cannot keep, so the list is the intersection plus the four that are
 * unambiguously text once rendered:
 *
 *   renderable directly   signature · initials · date-signed · text · checkbox
 *   render AS text        full-name · email · title · company
 *
 * The four in the second row are kept SEPARATE rather than collapsed into
 * `text` because they ask the signer for different things — "your full legal
 * name" is not "any text" — and a later command that wants to prefill an email
 * from the recipient snapshot needs to know which is which. `renderTypeFor` in
 * `@lagda/core/preparation` is the one place the mapping lives.
 *
 * ── Deliberately absent ────────────────────────────────────────────────────
 *
 *   radio-group     needs option sets and group semantics, has no renderer,
 *                   and is the one type behind a paid plan tier
 *   multiline-text  no multiline renderer exists
 *   acknowledgment  no renderer exists
 *   sender-text     sender-filled content, which carries different authority
 *                   and audit semantics from anything a signer supplies
 *
 * Each is recorded with its reason in PREPARATION_PRODUCT_INVENTORY.md. Adding
 * one means adding a renderer in the same command.
 */
export const PREPARATION_FIELD_TYPES = [
  "signature",
  "initials",
  "date-signed",
  "text",
  "checkbox",
  "full-name",
  "email",
  "title",
  "company",
] as const;

export type PreparationFieldType = (typeof PREPARATION_FIELD_TYPES)[number];

export const PreparationFieldTypeSchema = Type.Union(
  PREPARATION_FIELD_TYPES.map(type => Type.Literal(type)),
  {
    title: "PreparationFieldType",
    description: "What the field asks for. Closed set; unknown types are refused.",
  },
);

// ── Limits ───────────────────────────────────────────────────────────────────

/** Bounded because a label is displayed and stored, and it names a party. */
export const PREPARATION_FIELD_LABEL_MAX_LENGTH = 200;

/**
 * A technical ceiling, not a plan entitlement (§180).
 *
 * 500 fields is far beyond any realistic contract — a 50-page agreement with
 * ten fields a page — and low enough that a malformed or hostile layout cannot
 * make one request write unbounded rows. Stated as operational safety so nobody
 * mistakes it for a pricing tier.
 */
export const PREPARATION_MAX_FIELDS = 500;

/**
 * The recipient id length, matching `recipient_id varchar(64)`.
 *
 * Replaced `PREPARATION_PARTICIPANT_SLOT_MAX_LENGTH` in BACKEND-31. The slot it
 * bounded was an editor-local label; this bounds a server-generated id.
 */
export const PREPARATION_RECIPIENT_ID_MAX_LENGTH = 64;

// ── Geometry ─────────────────────────────────────────────────────────────────

/**
 * A field rectangle, normalized 0–1 against the page.
 *
 * **Origin is TOP-LEFT** and `y` is the distance down to the field's TOP edge —
 * matching `NormalizedFieldRect` in the sealing port, which is the same shape
 * for the same reason.
 *
 * Bounds are expressed in the schema (`0 ≤ x ≤ 1`) and completed in the domain
 * (`x + width ≤ 1`), because a schema cannot relate two properties. NaN and
 * Infinity fail both.
 *
 * Normalization is what makes bounds checking possible without page dimensions:
 * the page is 1 wide and 1 tall by definition.
 */
export const PreparationRectSchema = Type.Object(
  {
    /** 0–1 from the LEFT edge. */
    x: Type.Number({ minimum: 0, maximum: 1 }),
    /** 0–1 from the TOP edge, to the field's TOP. */
    y: Type.Number({ minimum: 0, maximum: 1 }),
    /** 0–1 of page width. Must be > 0; the domain enforces the strict bound. */
    width: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
    height: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
  },
  { title: "PreparationRect", additionalProperties: false },
);
export type PreparationRect = Static<typeof PreparationRectSchema>;

// ── The wire shape ───────────────────────────────────────────────────────────

/**
 * A placed field.
 *
 * ── No value, ever ─────────────────────────────────────────────────────────
 *
 * There is no `value`, no `signatureImage`, no `signedAt`. Preparation records
 * the REQUIREMENT; what a signer actually supplies belongs to the ceremony and
 * to a different table in a different command. `SealableField` has a `value`
 * and this does not, and the difference is the point.
 */
export const PreparationFieldSchema = Type.Object(
  {
    fieldId: Type.String({ minLength: 1, maxLength: 64 }),
    type: PreparationFieldTypeSchema,
    /** **1-based.** Page 0 is refused rather than read as page 1. */
    pageNumber: Type.Integer({ minimum: 1 }),
    rect: PreparationRectSchema,
    required: Type.Boolean(),
    label: Type.String({ maxLength: PREPARATION_FIELD_LABEL_MAX_LENGTH }),
    /** z-order; higher draws on top. The editor's `layer`. */
    layer: Type.Integer({ minimum: 0 }),
    /**
     * The recipient expected to complete this field.
     *
     * BACKEND-30 carried an editor-local slot label here ("P1", "P2") that
     * nothing dereferenced. BACKEND-31 replaced it with a real reference: a
     * `recipientId` belonging to THIS preparation, checked by the use case
     * against the preparation's own recipients and, independently, by a
     * three-column foreign key.
     *
     * Still a plain string on the wire. The brand is a compile-time device and
     * JSON has no branded types — what makes a wrong value unusable is the
     * constraint, not the schema.
     *
     * `null` means unassigned, which the editor permits while a layout is being
     * built. Readiness for sending is what will require it (§227).
     */
    recipientId: Type.Union([
      Type.String({ minLength: 1, maxLength: PREPARATION_RECIPIENT_ID_MAX_LENGTH }),
      Type.Null(),
    ]),
  },
  { title: "PreparationField", additionalProperties: false },
);
export type PreparationField = Static<typeof PreparationFieldSchema>;

/**
 * A preparation's state.
 *
 * Two values, derived from `locked_at`. **No signing statuses** — `sent`,
 * `completed`, `declined` and `expired` belong to a signing request, and a
 * document may back more than one.
 *
 * `locked` is unreachable in BACKEND-30: nothing sets the timestamp. The state
 * is published because the freeze seam is real and BACKEND-32 will use it, and
 * because every mutation already conditions on it. PREPARATION_STATE_MACHINE.md.
 */
export const PREPARATION_STATES = ["editable", "locked"] as const;
export type PreparationState = (typeof PREPARATION_STATES)[number];

export const PreparationStateSchema = Type.Union(
  PREPARATION_STATES.map(state => Type.Literal(state)),
  { title: "PreparationState" },
);

export const DocumentPreparationSchema = Type.Object(
  {
    preparationId: Type.String({ minLength: 1, maxLength: 64 }),
    documentId: DocumentIdSchema,
    /**
     * The pages the source artifact has, from the upload inspection.
     *
     * Included so the editor can bound its own page navigation without a second
     * request. Server-observed; a client cannot set it and it is not accepted on
     * any request.
     */
    pageCount: Type.Integer({ minimum: 1 }),
    state: PreparationStateSchema,
    /** Concurrency metadata. Never authorization — see the port. */
    revision: Type.Integer({ minimum: 1 }),
    fields: Type.Array(PreparationFieldSchema),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
  },
  {
    title: "DocumentPreparation",
    additionalProperties: false,
    description:
      "Authoring state for a document: what will be asked for and where. "
      + "Not a signing request.",
  },
);
export type DocumentPreparation = Static<typeof DocumentPreparationSchema>;

// Absent on purpose: `workspaceId` (it is the URL path), `sourceArtifactId` and
// any storage reference or digest (internal — BACKEND-29 established that a
// storage key is a capability), `lockedAt` as a raw timestamp (the derived
// `state` is what a client should branch on), and every signing-request field.
