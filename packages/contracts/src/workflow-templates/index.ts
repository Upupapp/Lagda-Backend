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
   * It is ORDERING. The real workflow engine advances on `routing_order` and
   * does not branch on recipient type: there is no `approved` recipient state,
   * and an approver's act is recorded exactly as a signature is. So this value
   * means "the approver goes first, and if they decline the request ends for
   * everyone" — which is true and useful — and it does NOT mean the system
   * holds a distinct approval record. Any wording shown to a user must say the
   * former.
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
    /** What the admin calls this hole: "Client Signer", "HR Approver". */
    label: Type.String({ minLength: 1, maxLength: 120 }),
    role: RecipientTypeSchema,
    required: Type.Boolean(),
    /** 1-based. Equal values across slots mean parallel. */
    routingStep: Type.Integer({ minimum: 1, maximum: 100 }),
    defaultAuthMethod: WorkflowSlotAuthMethodSchema,
  },
  {
    title: "WorkflowRoleSlot",
    additionalProperties: false,
    description: "A named role placeholder, not a person.",
  },
);
export type WorkflowRoleSlot = Static<typeof WorkflowRoleSlotSchema>;

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

// ── The template ─────────────────────────────────────────────────────────────

export const WorkflowTemplateSchema = Type.Object(
  {
    workflowTemplateId: Type.String({ minLength: 1, maxLength: 64 }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    routingMode: WorkflowRoutingModeSchema,
    /** Ordered. At least one — a template that routes nobody is not one. */
    roleSlots: Type.Array(WorkflowRoleSlotSchema, { minItems: 1, maxItems: 50 }),
    completionSettings: WorkflowCompletionSettingsSchema,
    /**
     * 059. `null` until a document is attached via the dedicated
     * document endpoint — never through this object's own write path, so a
     * PUT to name/routing/slots cannot silently detach it as a side effect.
     * Both present or both null, matching the storage CHECK constraint.
     */
    documentId: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 64 })]),
    sourceArtifactId: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 64 })]),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
  },
  {
    title: "WorkflowTemplate",
    additionalProperties: false,
    description:
      "A reusable workflow shape: named role slots and a routing mode, "
      + "optionally attached to one document. Holds no people and no bytes "
      + "of its own — the document, when attached, is an ordinary document "
      + "uploaded through the ordinary path, only referenced here.",
  },
);
export type WorkflowTemplateView = Static<typeof WorkflowTemplateSchema>;

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
    roleSlots: Type.Array(WorkflowRoleSlotSchema, { minItems: 1, maxItems: 50 }),
    completionSettings: WorkflowCompletionSettingsSchema,
  },
  { title: "WorkflowTemplateWrite", additionalProperties: false },
);
export type WorkflowTemplateWrite = Static<typeof WorkflowTemplateWriteSchema>;

export const WorkflowTemplateListSchema = Type.Object(
  { items: Type.Array(WorkflowTemplateSchema) },
  { title: "WorkflowTemplateList", additionalProperties: false },
);
