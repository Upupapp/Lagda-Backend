// The reusable workflow template contract (migration 058).
//
// ── A template names ROLES, never people ──────────────────────────────────
//
// That is the whole reason it is reusable, and it is why nothing here carries
// a name, an email address, a contact id or a recipient id. A slot says "a
// Client Signer signs at step 2"; WHO that is, is decided when the template is
// applied to a document.
//
// ── Applying a template COPIES it ────────────────────────────────────────
//
// A draft built from a template holds its own participants and routing from
// that moment on. Nothing downstream stores a template id as a live pointer,
// so editing a template cannot re-route a document somebody already prepared.
// Migration 058's header states the same rule from the schema's side.

import { Type, type Static } from "@sinclair/typebox";
import { RecipientTypeSchema } from "../recipients/index.js";
import {
  PreparationFieldTypeSchema, PreparationRectSchema,
  PREPARATION_FIELD_LABEL_MAX_LENGTH, PREPARATION_MAX_FIELDS,
} from "../preparation/index.js";

// ── Routing mode ─────────────────────────────────────────────────────────────

/**
 * The named routing shape, stored rather than inferred.
 *
 * The real signing request persists only a `routing_order` integer per
 * recipient, where equal values mean parallel. That is enough to EXECUTE a
 * routing but not enough to recover the admin's INTENT: "two people share
 * step 1" cannot distinguish parallel from approval-based. The preparation
 * flow re-infers a mode on reload today and can only ever guess `sequential`
 * or `mixed` — a template must not inherit that loss, so the mode is a column.
 *
 * Same four values the frontend's `RoutingMode` already uses.
 */
export const WORKFLOW_ROUTING_MODES = [
  "parallel",
  "sequential",
  "mixed",
  /**
   * An approver or reviewer step completes before later signing steps begin.
   *
   * ── What this does and does not claim ──────────────────────────────────
   *
   * It is ORDERING. The workflow engine advances on `routing_order`; this
   * value puts approver and reviewer steps first. What an approver DOES is
   * the recipient type's business, not the routing mode's: since 069 an
   * approver approves or skips (never declines) and is recorded as `approved`
   * or `skipped`. So "approval-based" means "the approvers go first, then the
   * signers" — any wording shown to a user must say that, and nothing more.
   */
  "approval-based",
] as const;
export type WorkflowRoutingMode = (typeof WORKFLOW_ROUTING_MODES)[number];

export const WorkflowRoutingModeSchema = Type.Union(
  WORKFLOW_ROUTING_MODES.map(mode => Type.Literal(mode)),
  {
    title: "WorkflowRoutingMode",
    description: "The named routing shape a template applies to a draft.",
  },
);

// ── Authentication default ───────────────────────────────────────────────────

/**
 * The auth method a slot SUGGESTS, and the limit of what that means.
 *
 * Stored as a template default — a preference the preparation flow may offer —
 * and never as an enforcement claim. Nothing server-side verifies an OTP or an
 * identity document today, which is why the preparation flow itself forces
 * every value except `none` to be unavailable when a real backend is
 * configured (`isAuthMethodAvailableForParticipant`). A template that stored
 * `sms-otp` and caused the product to imply an SMS challenge nobody sends
 * would be exactly the security promise that function exists to refuse.
 *
 * Kept in the contract anyway, rather than reduced to `none`: the vocabulary
 * is the product's, the admin's intent is worth preserving for the day the
 * challenge exists, and the apply path decides what is currently offerable.
 */
export const WORKFLOW_SLOT_AUTH_METHODS = [
  "none", "email-otp", "sms-otp", "knowledge-based", "id-verification",
] as const;
export type WorkflowSlotAuthMethod = (typeof WORKFLOW_SLOT_AUTH_METHODS)[number];

export const WorkflowSlotAuthMethodSchema = Type.Union(
  WORKFLOW_SLOT_AUTH_METHODS.map(method => Type.Literal(method)),
  { title: "WorkflowSlotAuthMethod" },
);

// ── Role resolution (061) ───────────────────────────────────────────────────

/**
 * How a slot's PERSON is found automatically, instead of being typed by
 * hand every time the template is used.
 *
 * One mode today: "whoever currently holds this TITLE in this organization
 * unit" — "the Department Head of Records," resolved at apply time rather
 * than pinned to whoever holds that title when the template is authored. A
 * slot with no `resolution` is unchanged from 058: the sender types a name
 * and email, exactly as before this existed.
 *
 * A discriminated union of one variant rather than a bare object, so a
 * second resolution strategy (by workspace role, say) can be added later
 * without a breaking change to this one.
 */
export const WorkflowRoleResolutionSchema = Type.Object(
  {
    mode: Type.Literal("unit-title"),
    unitId: Type.String({ minLength: 1, maxLength: 64 }),
    title: Type.String({ minLength: 1, maxLength: 120 }),
  },
  {
    title: "WorkflowRoleResolution",
    additionalProperties: false,
    description: "Resolves a slot to whoever currently holds a title in an organization unit.",
  },
);
export type WorkflowRoleResolution = Static<typeof WorkflowRoleResolutionSchema>;

// ── Role slot ────────────────────────────────────────────────────────────────

/**
 * One participant-shaped hole in the template.
 *
 * `routingStep` is 1-based and matches the recipient's `routingOrder` when the
 * template is applied — EQUAL VALUES MEAN PARALLEL, the same rule the real
 * schema documents. Two slots at step 1 act together; step 2 begins when step
 * 1 is done.
 *
 * `required` mirrors the recipient's `isRequired`. It is authored rather than
 * derived from the role because a template may legitimately want an optional
 * reviewer, and the preparation flow's own derivation
 * (`PREP_ROLE_IS_BLOCKING[role]`) is a default for hand-entry, not a law.
 */
export const WorkflowRoleSlotSchema = Type.Object(
  {
    /**
     * 060. Stable across an edit that does not touch this slot — a role
     * renamed or reordered keeps its id, which is what lets a field placed
     * "for the HR Approver" stay attached to the HR Approver after the
     * template is edited. Server-assigned; see `WorkflowRoleSlotWriteSchema`
     * for how a write may (or may not) supply one.
     */
    slotId: Type.String({ minLength: 1, maxLength: 64 }),
    /** What the admin calls this hole: "Client Signer", "HR Approver". */
    label: Type.String({ minLength: 1, maxLength: 120 }),
    role: RecipientTypeSchema,
    required: Type.Boolean(),
    /** 1-based. Equal values across slots mean parallel. */
    routingStep: Type.Integer({ minimum: 1, maximum: 100 }),
    defaultAuthMethod: WorkflowSlotAuthMethodSchema,
    /** 061. Absent means manual — the sender types a name and email at
     *  apply time, exactly as every slot worked before this existed. */
    resolution: Type.Optional(WorkflowRoleResolutionSchema),
  },
  {
    title: "WorkflowRoleSlot",
    additionalProperties: false,
    description: "A named role placeholder, not a person.",
  },
);
export type WorkflowRoleSlot = Static<typeof WorkflowRoleSlotSchema>;

/**
 * The write shape of a slot. `slotId` is OPTIONAL here and required above —
 * the one difference between the two schemas, and the reason they are two
 * schemas rather than one.
 *
 * Omitted (a new slot, or a client that has not been taught to round-trip
 * the id yet): the server mints one. Supplied: honoured only if it already
 * names a slot on THIS template (the use case checks this, the same way
 * `FieldInput.fieldId` in preparation is honoured only if it already
 * belongs to the caller's own preparation) — an unrecognised id is treated
 * as a new slot rather than rejected, so a client is never forced to know
 * which ids are "real" before it can save.
 */
export const WorkflowRoleSlotWriteSchema = Type.Object(
  {
    slotId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    label: Type.String({ minLength: 1, maxLength: 120 }),
    role: RecipientTypeSchema,
    required: Type.Boolean(),
    routingStep: Type.Integer({ minimum: 1, maximum: 100 }),
    defaultAuthMethod: WorkflowSlotAuthMethodSchema,
    resolution: Type.Optional(WorkflowRoleResolutionSchema),
  },
  {
    title: "WorkflowRoleSlotWrite",
    additionalProperties: false,
    description: "A named role placeholder, not a person. slotId is optional here only.",
  },
);
export type WorkflowRoleSlotWriteInput = Static<typeof WorkflowRoleSlotWriteSchema>;

// ── Completion notification settings ────────────────────────────────────────

/**
 * What the template asks to happen when the document is fully signed.
 *
 * ── Only one flag, deliberately ────────────────────────────────────────────
 *
 * The frontend's `PrepCompletionSettings` carries five booleans. Four of them
 * describe behaviour the backend does not have: `carbon-copy` recipients
 * receive nothing at all today (the type is declared and inert), participant
 * completion copies have no producer, and participant download and
 * verification-record creation are not driven from a preparation setting.
 *
 * Persisting them would store four switches that silently do nothing, and a
 * stored setting is worse than a missing one — the next reader believes it.
 * `notifySenderOnComplete` is here because it is REAL: a `signing-completed`
 * notification to the sender exists, with a producer and a template.
 *
 * The column is JSONB rather than a boolean so the others can be added by the
 * change that makes them true, without a migration.
 */
export const WorkflowCompletionSettingsSchema = Type.Object(
  {
    /**
     * Email the sender when every required signature is in.
     *
     * The message links to the documents list, not to a per-document route
     * (no such route exists), and carries no attachment.
     */
    notifySenderOnComplete: Type.Boolean(),
  },
  {
    title: "WorkflowCompletionSettings",
    additionalProperties: false,
    description: "Completion behaviour the backend actually performs.",
  },
);
export type WorkflowCompletionSettings = Static<typeof WorkflowCompletionSettingsSchema>;

// ── Variables (063) ──────────────────────────────────────────────────────────
//
// A named value a SENDER supplies once, at apply time, rather than typing the
// same text into an invitation or a field on every use — "Client Name",
// "Effective Date". Declared here as DEFINITIONS only: what a variable is
// called and what kind of value it expects. Nothing here connects a variable
// to a field, a preparation, or a rendered document — that is deliberately a
// later piece of work, tracked as a known gap rather than half-built. A
// defined-but-unconnected variable is the same honest state the frontend's
// wizard already discloses to a sender today.
//
// `key` is the stable identifier a future field-binding or `{{token}}` would
// reference — normalized (lowercase, ASCII, underscores) so it can appear in
// a token without escaping, and unique per template the same way `name` is
// unique per workspace (checked by the application, not a database
// constraint, matching `role_slots`' own id story).

export const WORKFLOW_TEMPLATE_VARIABLE_TYPES = [
  "short-text",
  "multiline-text",
  "date",
  "number",
  "yes-no",
] as const;

export type WorkflowTemplateVariableType = (typeof WORKFLOW_TEMPLATE_VARIABLE_TYPES)[number];

export const WorkflowTemplateVariableTypeSchema = Type.Union(
  WORKFLOW_TEMPLATE_VARIABLE_TYPES.map(type => Type.Literal(type)),
  { title: "WorkflowTemplateVariableType" },
);

/** The key's length bound. Short — it names a slot in a token, not a
 *  sentence. */
export const WORKFLOW_TEMPLATE_VARIABLE_KEY_MAX_LENGTH = 64;
export const WORKFLOW_TEMPLATE_VARIABLE_LABEL_MAX_LENGTH = 200;

export const WorkflowTemplateVariableSchema = Type.Object(
  {
    /** Lowercase ASCII letters, digits and underscores; must start with a
     *  letter. Checked by the application (§ validateVariables), not by this
     *  pattern alone — a regex error message is a poor substitute for one
     *  that names what a key may contain. */
    key: Type.String({ minLength: 1, maxLength: WORKFLOW_TEMPLATE_VARIABLE_KEY_MAX_LENGTH }),
    label: Type.String({ minLength: 1, maxLength: WORKFLOW_TEMPLATE_VARIABLE_LABEL_MAX_LENGTH }),
    type: WorkflowTemplateVariableTypeSchema,
    required: Type.Boolean(),
  },
  { title: "WorkflowTemplateVariable", additionalProperties: false },
);
export type WorkflowTemplateVariable = Static<typeof WorkflowTemplateVariableSchema>;

// ── Authored content (065/066, replaced) ───────────────────────────────────
//
// A template's SOURCE DOCUMENT no longer has to be an upload. The FIRST shape
// this took (066) was a fixed-rectangle canvas — the same normalized 0-1 box
// every field placement uses, one plain-text string per box. It worked, and
// it was also not a document editor: nothing knew a paragraph came after
// another one, lengthening a sentence did not push anything down, and an
// admin who typed one word too many got a save refused at 4pm with no
// warning while they were typing. That is a LAYOUT TOOL, not the Word
// alternative this was asked to be.
//
// This is the replacement: a FLOWING document — an ordered tree of blocks,
// each carrying runs of styled inline content, the same model every real
// word processor uses. Content no longer OWNS a page or a rectangle; where
// it lands is computed by the layout engine at generate time
// (`packages/sealing/src/internal/flow-layout.ts`), the same way a page
// break in Word is a consequence of what came before it, not a decision the
// author makes about coordinates.
//
// ── Fields are still placed the OLD way — reused, not replaced ─────────────
//
// `workflow_template_fields` (060/064) does not change: a signature, a date,
// a role's field is still one row with a page number and a rectangle. What
// changes is WHO computes that rectangle. `fieldAnchor`, below, is an INLINE
// node inside the flowing text — "the Employer signs here" is typed into the
// sentence it belongs to, not dragged onto a separate canvas afterward — and
// `POST .../generate-document`'s response resolves each anchor's position
// once the layout engine has actually placed it, which the caller then
// writes through the SAME `PUT .../fields` endpoint 060 already built. A
// field this template ends up with is indistinguishable from one placed the
// old way — same table, same shape, same downstream consumers (apply,
// preparation, signing) — only the AUTHORING experience is new.
//
// ── Generating the PDF is still a separate step ─────────────────────────────
//
// `POST .../generate-document` remains the seam between "what was typed" and
// "the bytes that resulted." A template with authored content and one with
// an uploaded document still look identical once attached — `documentId` and
// `sourceArtifactId` are set either way, and nothing downstream can tell the
// two apart or needs to.

/** How deep an ordered list may nest — "1." / "1.1." / "1.1.1." and no
 *  further. A fourth level is where clause numbering stops reading as a
 *  contract and starts reading as an outline nobody signs. */
export const FLOW_DOCUMENT_MAX_LIST_DEPTH = 3;

/** Total blocks (paragraphs, headings, list items at every depth, page
 *  breaks) a document may hold, and total inline runs within one block.
 *  Bounds that make a pathological document a 422 at save time rather than
 *  a multi-minute render or an unbounded PDF at generate time. */
export const FLOW_DOCUMENT_MAX_BLOCKS = 2000;
export const FLOW_DOCUMENT_MAX_RUNS_PER_BLOCK = 400;
export const FLOW_DOCUMENT_RUN_TEXT_MAX_LENGTH = 4000;

export const DocumentFontFamilySchema = Type.Union(
  [
    Type.Literal("times"), Type.Literal("georgia"), Type.Literal("helvetica"),
    Type.Literal("calibri"), Type.Literal("courier"),
  ],
  { title: "DocumentFontFamily" },
);
export type DocumentFontFamily = Static<typeof DocumentFontFamilySchema>;

export const DocumentBlockAlignSchema = Type.Union(
  [Type.Literal("left"), Type.Literal("center"), Type.Literal("right"), Type.Literal("justify")],
  { title: "DocumentBlockAlign" },
);
export type DocumentBlockAlign = Static<typeof DocumentBlockAlignSchema>;

/**
 * A style applied to a RUN of text, not a block. Two runs in the same
 * paragraph can carry different marks — "the **Employer** shall pay" bolds
 * one word without bolding the sentence — which a per-block `bold: boolean`
 * (066's shape) could never express.
 */
export const DocumentTextMarkSchema = Type.Union(
  [
    Type.Object({ kind: Type.Literal("bold") }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("italic") }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("underline") }, { additionalProperties: false }),
    Type.Object({
      kind: Type.Literal("fontFamily"), family: DocumentFontFamilySchema,
    }, { additionalProperties: false }),
    Type.Object({
      kind: Type.Literal("fontSize"),
      /** Points. */
      size: Type.Integer({ minimum: 6, maximum: 72 }),
    }, { additionalProperties: false }),
  ],
  { title: "DocumentTextMark" },
);
export type DocumentTextMark = Static<typeof DocumentTextMarkSchema>;

export const DocumentTextRunSchema = Type.Object(
  {
    kind: Type.Literal("text"),
    text: Type.String({ minLength: 1, maxLength: FLOW_DOCUMENT_RUN_TEXT_MAX_LENGTH }),
    marks: Type.Optional(Type.Array(DocumentTextMarkSchema, { maxItems: 8 })),
  },
  { title: "DocumentTextRun", additionalProperties: false },
);
export type DocumentTextRun = Static<typeof DocumentTextRunSchema>;

/**
 * A dropped-in reference to `variables[].key` — "insert variable" from the
 * ribbon. Renders as its own label ("[Employee Name]") until a value is
 * bound; does NOT substitute text in place (that would mean re-rendering the
 * PDF per use, a different feature). `label` is a presentational SNAPSHOT
 * taken at insert time, so a variable renamed later does not retroactively
 * relabel every document that already reference it.
 */
export const DocumentVariableRunSchema = Type.Object(
  {
    kind: Type.Literal("variable"),
    key: Type.String({ minLength: 1, maxLength: WORKFLOW_TEMPLATE_VARIABLE_KEY_MAX_LENGTH }),
    label: Type.String({ minLength: 1, maxLength: PREPARATION_FIELD_LABEL_MAX_LENGTH }),
  },
  { title: "DocumentVariableRun", additionalProperties: false },
);
export type DocumentVariableRun = Static<typeof DocumentVariableRunSchema>;

/**
 * A dropped-in signature/initials/date placement — "insert signature" from
 * the ribbon, typed inline ("Signed: [Employer Signature]") rather than
 * dragged onto a separate canvas. EXACTLY ONE of `slotId` / `variableKey`,
 * mirroring `WorkflowTemplateFieldInputSchema`'s own rule, because this
 * anchor's whole purpose is to become a row in that same table once the
 * layout engine resolves where it landed.
 */
export const DocumentFieldAnchorRunSchema = Type.Object(
  {
    kind: Type.Literal("fieldAnchor"),
    fieldType: PreparationFieldTypeSchema,
    slotId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    variableKey: Type.Optional(
      Type.String({ minLength: 1, maxLength: WORKFLOW_TEMPLATE_VARIABLE_KEY_MAX_LENGTH }),
    ),
    required: Type.Boolean(),
    label: Type.String({ minLength: 1, maxLength: PREPARATION_FIELD_LABEL_MAX_LENGTH }),
  },
  { title: "DocumentFieldAnchorRun", additionalProperties: false },
);
export type DocumentFieldAnchorRun = Static<typeof DocumentFieldAnchorRunSchema>;

/** One paragraph's content: plain runs, variable references, field anchors,
 *  in reading order. */
export const DocumentInlineContentSchema = Type.Array(
  Type.Union([DocumentTextRunSchema, DocumentVariableRunSchema, DocumentFieldAnchorRunSchema]),
  { maxItems: FLOW_DOCUMENT_MAX_RUNS_PER_BLOCK },
);
export type DocumentInlineContent = Static<typeof DocumentInlineContentSchema>;

export const DocumentHeadingLevelSchema = Type.Union(
  [Type.Literal(1), Type.Literal(2), Type.Literal(3)], { title: "DocumentHeadingLevel" });
export type DocumentHeadingLevel = Static<typeof DocumentHeadingLevelSchema>;

export const DocumentParagraphSchema = Type.Object(
  {
    kind: Type.Literal("paragraph"),
    align: Type.Optional(DocumentBlockAlignSchema),
    content: DocumentInlineContentSchema,
  },
  { title: "DocumentParagraph", additionalProperties: false },
);
export type DocumentParagraph = Static<typeof DocumentParagraphSchema>;

export const DocumentHeadingSchema = Type.Object(
  {
    kind: Type.Literal("heading"),
    level: DocumentHeadingLevelSchema,
    align: Type.Optional(DocumentBlockAlignSchema),
    content: DocumentInlineContentSchema,
  },
  { title: "DocumentHeading", additionalProperties: false },
);
export type DocumentHeading = Static<typeof DocumentHeadingSchema>;

/** Forces the next block onto a new page — a signature page, an annex,
 *  starting clean. An atom: no content of its own. */
export const DocumentPageBreakSchema = Type.Object(
  { kind: Type.Literal("pageBreak") },
  { title: "DocumentPageBreak", additionalProperties: false },
);
export type DocumentPageBreak = Static<typeof DocumentPageBreakSchema>;

/**
 * Numbered clauses — "1.", "1.1.", "1.1.1." — via NESTING rather than a
 * stored number: an ordered list's own list items may each contain a further
 * ordered list (bounded by `FLOW_DOCUMENT_MAX_LIST_DEPTH`), and the layout
 * engine computes each item's label from its position in that tree at
 * render time. The same reason numbers are never stored in Word's own list
 * model: inserting a clause 2 must renumber everything after it, and a
 * computed label cannot go stale the way a stored one could.
 *
 * ── UNROLLED, not `Type.Recursive` ───────────────────────────────────────
 *
 * A genuinely recursive TypeBox schema compiles fine for AJV validation but
 * overflows the stack when Fastify's response serializer (fast-json-
 * stringify) tries to compile it — a known limitation of generating a
 * serializer for a self-referencing schema, hit and confirmed while wiring
 * this route. `FLOW_DOCUMENT_MAX_LIST_DEPTH` already bounds nesting to
 * three levels, so the fix is to WRITE three levels explicitly rather than
 * express them recursively — provably terminating, and safe for both AJV
 * and fast-json-stringify by construction. The three levels are identical
 * in shape; only the deepest omits a further nested list, matching the max
 * depth.
 */
const DocumentListItemLevel3Schema = Type.Object(
  {
    kind: Type.Literal("listItem"),
    /** At max depth, a list item holds paragraphs only — no further nesting. */
    content: Type.Array(DocumentParagraphSchema, { minItems: 1, maxItems: 50 }),
  },
  { title: "DocumentListItemLevel3", additionalProperties: false },
);
const DocumentOrderedListLevel3Schema = Type.Object(
  {
    kind: Type.Literal("orderedList"),
    content: Type.Array(DocumentListItemLevel3Schema, { minItems: 1, maxItems: 200 }),
  },
  { title: "DocumentOrderedListLevel3", additionalProperties: false },
);

const DocumentListItemLevel2Schema = Type.Object(
  {
    kind: Type.Literal("listItem"),
    content: Type.Array(
      Type.Union([DocumentParagraphSchema, DocumentOrderedListLevel3Schema]),
      { minItems: 1, maxItems: 50 },
    ),
  },
  { title: "DocumentListItemLevel2", additionalProperties: false },
);
const DocumentOrderedListLevel2Schema = Type.Object(
  {
    kind: Type.Literal("orderedList"),
    content: Type.Array(DocumentListItemLevel2Schema, { minItems: 1, maxItems: 200 }),
  },
  { title: "DocumentOrderedListLevel2", additionalProperties: false },
);

const DocumentListItemLevel1Schema = Type.Object(
  {
    kind: Type.Literal("listItem"),
    content: Type.Array(
      Type.Union([DocumentParagraphSchema, DocumentOrderedListLevel2Schema]),
      { minItems: 1, maxItems: 50 },
    ),
  },
  { title: "DocumentListItemLevel1", additionalProperties: false },
);

/** The top-level ordered list every `DocumentBlock` union references — three
 *  levels deep, matching `FLOW_DOCUMENT_MAX_LIST_DEPTH`. */
export const DocumentOrderedListSchema = Type.Object(
  {
    kind: Type.Literal("orderedList"),
    content: Type.Array(DocumentListItemLevel1Schema, { minItems: 1, maxItems: 200 }),
  },
  { title: "DocumentOrderedList", additionalProperties: false },
);
export type DocumentOrderedList = Static<typeof DocumentOrderedListSchema>;

export const DocumentBlockSchema = Type.Union(
  [DocumentParagraphSchema, DocumentHeadingSchema, DocumentOrderedListSchema, DocumentPageBreakSchema],
  { title: "DocumentBlock" },
);
export type DocumentBlock = Static<typeof DocumentBlockSchema>;

/** The whole authored document — top-level blocks in reading order. */
export const FlowDocumentSchema = Type.Object(
  {
    kind: Type.Literal("flowDocument"),
    content: Type.Array(DocumentBlockSchema, { maxItems: FLOW_DOCUMENT_MAX_BLOCKS }),
  },
  { title: "FlowDocument", additionalProperties: false },
);
export type FlowDocument = Static<typeof FlowDocumentSchema>;

/** An empty document — the state a brand-new template's content starts in. */
export const EMPTY_FLOW_DOCUMENT: FlowDocument = { kind: "flowDocument", content: [] };

// ── The template ─────────────────────────────────────────────────────────────

export const WorkflowTemplateSchema = Type.Object(
  {
    workflowTemplateId: Type.String({ minLength: 1, maxLength: 64 }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    routingMode: WorkflowRoutingModeSchema,
    /** Ordered. At least one — a template that routes nobody is not one. */
    roleSlots: Type.Array(WorkflowRoleSlotSchema, { minItems: 1, maxItems: 50 }),
    completionSettings: WorkflowCompletionSettingsSchema,
    /** 063. Empty for a template that declares none — the ordinary case. */
    variables: Type.Array(WorkflowTemplateVariableSchema, { maxItems: 50 }),
    /**
     * 059. `null` until a document is attached via the dedicated
     * document endpoint — never through this object's own write path, so a
     * PUT to name/routing/slots cannot silently detach it as a side effect.
     * Both present or both null, matching the storage CHECK constraint.
     */
    documentId: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 64 })]),
    sourceArtifactId: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 64 })]),
    /** 071. The authored flowing document — empty content for an uploaded
     *  document, or for a template with no document at all. */
    content: FlowDocumentSchema,
    /** How many pages the LAST generate produced, computed by the layout
     *  engine — not admin-declared the way 066's `pageCount` was. 0 before
     *  the first generate. */
    contentPageCount: Type.Integer({ minimum: 0 }),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
  },
  {
    title: "WorkflowTemplate",
    additionalProperties: false,
    description:
      "A reusable workflow shape: named role slots and a routing mode, "
      + "optionally attached to one document. Holds no people and no bytes "
      + "of its own — the document, when attached, is an ordinary document, "
      + "either uploaded through the ordinary path or GENERATED from this "
      + "template's own authored content, only referenced here.",
  },
);
export type WorkflowTemplateView = Static<typeof WorkflowTemplateSchema>;

/**
 * The body of `POST .../workflow-templates/:id/generate-document`.
 *
 * Authors the template's OWN document rather than naming an uploaded one —
 * the alternative to `WorkflowTemplateDocumentInputSchema`. Every call
 * REPLACES the whole document and regenerates the PDF, the same
 * "whole-layout replace" contract `WorkflowTemplateFieldsWriteSchema` already
 * uses, and for the same reason: authoring is a document, not an
 * accumulation of patches.
 *
 * No `pageCount` — 066's shape asked the admin to declare one, because a
 * fixed-box canvas needed to know how many boxes-worth of blank page existed
 * before any were drawn. A flowing document has no such thing to declare:
 * how many pages result is what the layout engine computes from how much
 * content there is, and is reported back, not asked for.
 */
export const WorkflowTemplateGenerateDocumentInputSchema = Type.Object(
  { content: FlowDocumentSchema },
  { title: "WorkflowTemplateGenerateDocumentInput", additionalProperties: false },
);
export type WorkflowTemplateGenerateDocumentInput =
  Static<typeof WorkflowTemplateGenerateDocumentInputSchema>;

/**
 * One `fieldAnchor` run, resolved to where the layout engine actually placed
 * it — returned alongside the generated document so the caller can write it
 * straight through to `PUT .../fields` (`WorkflowTemplateFieldInputSchema`),
 * which is the SAME shape as this one plus `fieldId`/`pageNumber`/`rect`.
 *
 * Ephemeral: not persisted under this name anywhere. The field row it
 * becomes, once written, is indistinguishable from one placed the old way.
 */
export const ResolvedFieldAnchorSchema = Type.Object(
  {
    fieldType: PreparationFieldTypeSchema,
    slotId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    variableKey: Type.Optional(
      Type.String({ minLength: 1, maxLength: WORKFLOW_TEMPLATE_VARIABLE_KEY_MAX_LENGTH }),
    ),
    required: Type.Boolean(),
    label: Type.String({ minLength: 1, maxLength: PREPARATION_FIELD_LABEL_MAX_LENGTH }),
    pageNumber: Type.Integer({ minimum: 1 }),
    rect: PreparationRectSchema,
  },
  { title: "ResolvedFieldAnchor", additionalProperties: false },
);
export type ResolvedFieldAnchor = Static<typeof ResolvedFieldAnchorSchema>;

export const WorkflowTemplateGenerateDocumentResultSchema = Type.Object(
  {
    template: WorkflowTemplateSchema,
    /** In DOCUMENT ORDER — the same order the caller's anchors were typed
     *  in, so a caller zipping this against its own local anchor list never
     *  has to match by content. */
    resolvedAnchors: Type.Array(ResolvedFieldAnchorSchema, { maxItems: PREPARATION_MAX_FIELDS }),
  },
  { title: "WorkflowTemplateGenerateDocumentResult", additionalProperties: false },
);
export type WorkflowTemplateGenerateDocumentResult =
  Static<typeof WorkflowTemplateGenerateDocumentResultSchema>;

/**
 * The body of `PUT .../workflow-templates/:id/document`.
 *
 * Names an ALREADY-uploaded document and artifact — obtained through the
 * ordinary document-create-then-upload path — rather than carrying a file.
 * This endpoint attaches a reference; it does not upload anything.
 */
export const WorkflowTemplateDocumentInputSchema = Type.Object(
  {
    documentId: Type.String({ minLength: 1, maxLength: 64 }),
    artifactId: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { title: "WorkflowTemplateDocumentInput", additionalProperties: false },
);
export type WorkflowTemplateDocumentInput = Static<typeof WorkflowTemplateDocumentInputSchema>;

/**
 * The write body. Closed, and carrying no identity or timestamp.
 *
 * `workflowTemplateId`, `createdAt`, `updatedAt` and `createdBy` are all
 * server-decided. A client that could supply an id could overwrite another
 * template by naming it; one that could supply `createdBy` could attribute its
 * own template to a colleague.
 */
export const WorkflowTemplateWriteSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    routingMode: WorkflowRoutingModeSchema,
    roleSlots: Type.Array(WorkflowRoleSlotWriteSchema, { minItems: 1, maxItems: 50 }),
    completionSettings: WorkflowCompletionSettingsSchema,
    variables: Type.Array(WorkflowTemplateVariableSchema, { maxItems: 50 }),
  },
  { title: "WorkflowTemplateWrite", additionalProperties: false },
);
export type WorkflowTemplateWrite = Static<typeof WorkflowTemplateWriteSchema>;

export const WorkflowTemplateListSchema = Type.Object(
  { items: Type.Array(WorkflowTemplateSchema) },
  { title: "WorkflowTemplateList", additionalProperties: false },
);

// ── Field placements (060) ──────────────────────────────────────────────────
//
// A template's geometry, PER ROLE SLOT rather than per person — the same
// relationship `roleSlots` has to a real template's recipients. Reuses
// preparation's field-type vocabulary and rectangle shape verbatim
// (`PreparationFieldTypeSchema`, `PreparationRectSchema`): a template field
// and a real preparation field describe the same nine renderable things in
// the same normalized 0–1 space, and a second vocabulary here would be a
// second place for the two to drift.
//
// Stored and read through their OWN endpoint
// (`/workflow-templates/:id/fields`), not embedded in `WorkflowTemplateSchema`
// — the same choice `document_preparations`/`preparation_fields` already
// made for a real document, for the same reason: most callers that want a
// template (the list page, the routing tab) have no use for its geometry,
// and embedding it would make every template read pay for a field fetch it
// does not need.

export const WorkflowTemplateFieldSchema = Type.Object(
  {
    fieldId: Type.String({ minLength: 1, maxLength: 64 }),
    /**
     * Which role signs this field — one of the template's OWN
     * `roleSlots[].slotId` values, checked at write time.
     *
     * NULL when the field is filled from a VARIABLE instead. Exactly one of
     * `slotId` and `variableKey` is set on any field (064).
     */
    slotId: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    /** 064. Which VARIABLE fills this field — one of the template's own
     *  `variables[].key` values. Null when a role signs it instead. */
    variableKey: Type.Union([
      Type.String({ minLength: 1, maxLength: WORKFLOW_TEMPLATE_VARIABLE_KEY_MAX_LENGTH }),
      Type.Null(),
    ]),
    type: PreparationFieldTypeSchema,
    /** 1-based, against the template's attached document. */
    pageNumber: Type.Integer({ minimum: 1 }),
    rect: PreparationRectSchema,
    required: Type.Boolean(),
    label: Type.String({ maxLength: PREPARATION_FIELD_LABEL_MAX_LENGTH }),
    layer: Type.Integer({ minimum: 0 }),
  },
  { title: "WorkflowTemplateField", additionalProperties: false },
);
export type WorkflowTemplateField = Static<typeof WorkflowTemplateFieldSchema>;

/** `fieldId` optional, the same reason `slotId` is optional on a slot write
 *  and `FieldInput.fieldId` is optional in preparation: omitted for a new
 *  field, honoured only if it already names a field on this template. */
export const WorkflowTemplateFieldInputSchema = Type.Object(
  {
    fieldId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    /** EXACTLY ONE of `slotId` / `variableKey`. Both optional in the schema
     *  because a union of two object shapes reads worse in the generated
     *  OpenAPI than one object with a documented rule; the use case rejects
     *  both-set and neither-set with a named error, and a CHECK constraint
     *  refuses anything that slips past it. */
    slotId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    /** 064. One of the template's own `variables[].key` values. */
    variableKey: Type.Optional(
      Type.String({ minLength: 1, maxLength: WORKFLOW_TEMPLATE_VARIABLE_KEY_MAX_LENGTH }),
    ),
    type: PreparationFieldTypeSchema,
    pageNumber: Type.Integer({ minimum: 1 }),
    rect: PreparationRectSchema,
    required: Type.Boolean(),
    label: Type.String({ maxLength: PREPARATION_FIELD_LABEL_MAX_LENGTH }),
    layer: Type.Integer({ minimum: 0 }),
  },
  { title: "WorkflowTemplateFieldInput", additionalProperties: false },
);
export type WorkflowTemplateFieldInput = Static<typeof WorkflowTemplateFieldInputSchema>;

/** Whole-layout replace, exactly like `SaveLayoutInput` in preparation —
 *  one atomic write rather than per-field endpoints, for the same
 *  drag-and-drop-autosave reason preparation's header states. No
 *  `expectedRevision` here: a template's field layout is authored by one
 *  admin at a time in practice, and this is authoring metadata with no
 *  concurrent-signer audience the way a live preparation has. */
export const WorkflowTemplateFieldsWriteSchema = Type.Object(
  { fields: Type.Array(WorkflowTemplateFieldInputSchema, { maxItems: PREPARATION_MAX_FIELDS }) },
  { title: "WorkflowTemplateFieldsWrite", additionalProperties: false },
);
export type WorkflowTemplateFieldsWrite = Static<typeof WorkflowTemplateFieldsWriteSchema>;

export const WorkflowTemplateFieldListSchema = Type.Object(
  { items: Type.Array(WorkflowTemplateFieldSchema) },
  { title: "WorkflowTemplateFieldList", additionalProperties: false },
);
export type WorkflowTemplateFieldList = Static<typeof WorkflowTemplateFieldListSchema>;

// ── The apply-time read ─────────────────────────────────────────────────────
//
// What a caller needs to COPY when a sender applies a template: the routing
// shape, the slots, the completion settings, the document pair (059), and the
// field geometry (060) — all in one read, from one transaction, so a caller
// cannot observe the slots and the fields at two different moments. No
// `workflowTemplateId`: a caller that received this has everything it needs
// to build a draft and nothing that would let it store a live pointer back to
// the template (see `resolveTemplateForApply`'s own header).

export const WorkflowTemplateApplicationSchema = Type.Object(
  {
    routingMode: WorkflowRoutingModeSchema,
    roleSlots: Type.Array(WorkflowRoleSlotSchema, { minItems: 1, maxItems: 50 }),
    completionSettings: WorkflowCompletionSettingsSchema,
    documentId: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 64 })]),
    sourceArtifactId: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 64 })]),
    fields: Type.Array(WorkflowTemplateFieldSchema),
    /** 063. Definitions only — nothing here yet resolves a value for any of
     *  these; see WorkflowTemplateVariableSchema's own header. */
    variables: Type.Array(WorkflowTemplateVariableSchema, { maxItems: 50 }),
  },
  {
    title: "WorkflowTemplateApplication",
    additionalProperties: false,
    description:
      "A snapshot of a template's shape, taken at the moment a sender applies "
      + "it. Not a live reference — later edits to the template cannot reach "
      + "anything built from this read.",
  },
);
export type WorkflowTemplateApplicationView = Static<typeof WorkflowTemplateApplicationSchema>;

// ── Resolved role assignments (061) ─────────────────────────────────────────
//
// The APPLY-time read: for every slot, what `resolution` produces right now.
// Three states, not a nullable person, because "no resolution configured"
// and "resolution configured but nobody currently holds the title" call for
// different UI — the first is ordinary (type a name), the second is a gap
// worth flagging (the Department Head slot is empty) before the sender
// finds out by launching the workflow.

export const WORKFLOW_ROLE_ASSIGNMENT_STATUSES = ["manual", "resolved", "unresolved"] as const;
export type WorkflowRoleAssignmentStatus = (typeof WORKFLOW_ROLE_ASSIGNMENT_STATUSES)[number];

export const WorkflowRoleAssignmentSchema = Type.Object(
  {
    slotId: Type.String({ minLength: 1, maxLength: 64 }),
    status: Type.Union(WORKFLOW_ROLE_ASSIGNMENT_STATUSES.map(s => Type.Literal(s))),
    /** Present only when `status` is `"resolved"`. */
    userId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    displayName: Type.Optional(Type.String()),
    email: Type.Optional(Type.String()),
  },
  { title: "WorkflowRoleAssignment", additionalProperties: false },
);
export type WorkflowRoleAssignment = Static<typeof WorkflowRoleAssignmentSchema>;

export const WorkflowRoleAssignmentListSchema = Type.Object(
  { items: Type.Array(WorkflowRoleAssignmentSchema) },
  { title: "WorkflowRoleAssignmentList", additionalProperties: false },
);
export type WorkflowRoleAssignmentList = Static<typeof WorkflowRoleAssignmentListSchema>;
