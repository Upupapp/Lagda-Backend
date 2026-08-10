// The signing request contract.
//
// ── A request is a SNAPSHOT ────────────────────────────────────────────────
//
// Everything in this file describes state that was copied once, at creation,
// from one coherent preparation revision. Nothing here is re-read from the
// preparation, the contacts or the document afterwards.
//
// That is the difference between this file and `preparation/index.ts`, which
// describes the same shapes while they are still being edited.
//
// ── Creating is not sending ────────────────────────────────────────────────
//
// There is deliberately no `subject`, no `message`, no `expiresAt`, no
// `sentAt`, no `signingUrl` and no `accessToken`. A request that exists has
// been configured; nothing has left the building. BACKEND-33 owns send.

import { Type, type Static } from "@sinclair/typebox";
import { RecipientTypeSchema } from "../recipients/index.js";
import { PreparationFieldTypeSchema, PreparationRectSchema } from "../preparation/index.js";

// ── State ────────────────────────────────────────────────────────────────────

/**
 * The lifecycle states a signing request can be IN.
 *
 * ── Moved here, not invented here ──────────────────────────────────────────
 *
 * An earlier command derived this list from the product's `TransactionStatus`
 * and declared it in `core/src/signing/lifecycle.ts`, along with the reasoning
 * for the six canonical values it deliberately EXCLUDES: `delivered`, `viewed`
 * and `authentication-completed` are events rather than states, and
 * `awaiting-signature`, `awaiting-approval` and `failed-delivery` are derived.
 * That reasoning still lives beside the transition table, where it is useful.
 *
 * It moves to contracts in BACKEND-32 because the state is now PERSISTED and
 * RETURNED, and every other wire vocabulary is declared here. `lifecycle.ts`
 * re-exports it — one declaration, the same direction `WORKSPACE_ROLES` runs.
 *
 * ── What BACKEND-32 can actually write ─────────────────────────────────────
 *
 * `draft`, and nothing else. The type is the whole vocabulary; the DATABASE is
 * the gate. Migration 019's CHECK admits `draft` alone, so a bug that tried to
 * insert `sent` fails at the write rather than producing a request that claims
 * something nobody did. BACKEND-33 widens the CHECK when it earns the value.
 */
export const SIGNING_REQUEST_STATES = [
  "draft",
  "ready-to-send",
  "sent",
  "partially-completed",
  /**
   * Every required signing participant has completed their obligation, and the
   * final signed artifact has NOT been produced.
   *
   * ── The one value in this union the product does not have ──────────────────
   *
   * Every other member was read out of the product's `TransactionStatus`. This
   * one was added by BACKEND-37, deliberately, because the product conflates
   * two facts that fail independently: "everyone signed" and "the completed
   * document exists". PDF merge, certificate generation and sealing can each
   * fail after the last signature is legally binding, and a status field that
   * called that moment `completed` would be claiming an artifact nobody has.
   *
   * Naming it `completed` and repairing it later is not available: `completed`
   * is terminal and legally significant, and a request that reached it wrongly
   * cannot be walked back.
   *
   * BACKEND-38 owns the transition out of here. BACKEND-37 must never write
   * `completed`.
   */
  "completion-ready",
  "completed",
  "declined",
  "cancelled",
  "expired",
] as const;

export type SigningRequestState = (typeof SIGNING_REQUEST_STATES)[number];

/**
 * What one recipient of one signing request is currently doing about it.
 *
 * ── Four values, and why not more ──────────────────────────────────────────
 *
 * The product's `StageParticipantStatus` has thirteen, and nine of them are
 * either EVENTS (`viewed`, `in-progress`), facts about a different subject
 * (`waiting-for-prior-stage`), or outcomes of a machine that does not exist yet
 * (`authentication-failed`, `no-longer-required`). A status field with one slot
 * cannot hold a history, which is the same finding `lifecycle.ts` recorded for
 * the request — so the events are stored as their own timestamps and only the
 * mutually exclusive positions are states.
 *
 * `waiting` and `active` are BACKEND-33's, unchanged in meaning. `signed` and
 * `declined` are the ceremony outcomes BACKEND-37 adds.
 *
 * There is no `viewed` state on purpose: a recipient who opened the document is
 * still `active`, and overwriting that would lose the only thing the routing
 * gate needs to know. First entry is a timestamp on `signing_recipient_progress`
 * (BACKEND-35) and stays there.
 */
export const RECIPIENT_WORKFLOW_STATES = [
  /** In the request, not yet this recipient's turn. Holds no credential. */
  "waiting",
  /** May authenticate, enter the ceremony and submit. Not "has viewed". */
  "active",
  /** An accepted `RecipientSubmission` exists for them. Terminal. */
  "signed",
  /** They refused. Terminal, and it ends the request for everyone. */
  "declined",
] as const;

export type RecipientWorkflowState = (typeof RECIPIENT_WORKFLOW_STATES)[number];

export const RecipientWorkflowStateSchema = Type.Union(
  RECIPIENT_WORKFLOW_STATES.map(state => Type.Literal(state)),
  {
    title: "RecipientWorkflowState",
    description: "Where one recipient stands in one signing request.",
  },
);

/**
 * Why a recipient refused, as a CLOSED set.
 *
 * Exactly `DECLINE_REASON_CATEGORIES` from `models/recipient.ts`, in the
 * product's order. A closed code rather than the free-text note the product
 * also collects: §78 warns that a free-text reason creates PII and content
 * risk, the note is optional in the product and its own copy tells the
 * recipient nothing is persisted, and an unbounded string authored by an
 * external party would land in a legal record with no redaction path.
 *
 * The code is enough for every use the product makes of it — the sender sees
 * that the request was declined and why, from a bounded vocabulary that is
 * safe to log, safe to aggregate and safe to render.
 */
export const SIGNING_DECLINE_REASONS = [
  "not-agree",
  "not-intended",
  "needs-correction",
  "cannot-complete",
  "other",
] as const;

export type SigningDeclineReason = (typeof SIGNING_DECLINE_REASONS)[number];

export const SigningDeclineReasonSchema = Type.Union(
  SIGNING_DECLINE_REASONS.map(reason => Type.Literal(reason)),
  {
    title: "SigningDeclineReason",
    description: "Why the recipient declined. A closed vocabulary, never free text.",
  },
);

/**
 * The wire schema.
 *
 * Deliberately the FULL union rather than just `draft`: a response schema
 * admitting one value would need widening in lockstep with every future
 * transition, and a client generated from it would break on the first `sent`
 * request it ever saw.
 */
export const SigningRequestStateSchema = Type.Union(
  SIGNING_REQUEST_STATES.map(state => Type.Literal(state)),
  {
    title: "SigningRequestState",
    description:
      "The request's lifecycle state. BACKEND-32 can only produce `draft`.",
  },
);

// ── Limits ───────────────────────────────────────────────────────────────────

/** Matches `documents.title`, which is what is snapshotted. */
export const SIGNING_REQUEST_TITLE_MAX_LENGTH = 300;

// ── The wire shapes ──────────────────────────────────────────────────────────

/**
 * A recipient, as snapshotted onto a request.
 *
 * ── Read the absences ──────────────────────────────────────────────────────
 *
 * No `normalizedEmail`: an internal comparison value. No `sourceContactId` and
 * no `sourcePreparationRecipientId` — provenance is an operator's concern, and
 * exposing either would invite a client to resolve the snapshot back to mutable
 * state, which is the one thing this whole aggregate exists to prevent.
 *
 * No `userId` and no `isRegisteredUser`: a recipient is never matched against
 * an account, and telling a sender which of their counterparties have LAGDA
 * logins would leak user existence.
 *
 * No `deliveryStatus`, `sentAt`, `viewedAt`, `signedAt`, `accessToken`,
 * `signingUrl` or `authenticatedAt`. Nothing has been sent and nobody has been
 * authenticated.
 */
export const SigningRequestRecipientSchema = Type.Object(
  {
    /** Request-scoped. NOT the preparation recipient's id. */
    recipientId: Type.String({ minLength: 1, maxLength: 64 }),
    name: Type.String({ minLength: 1 }),
    /** The delivery address as it was at snapshot time. Unverified. */
    email: Type.String({ maxLength: 254 }),
    organization: Type.Union([Type.String(), Type.Null()]),
    type: RecipientTypeSchema,
    isRequired: Type.Boolean(),
    orderIndex: Type.Integer({ minimum: 0 }),
    /** The routing step. EQUAL VALUES MEAN PARALLEL within a step. */
    routingOrder: Type.Integer({ minimum: 1 }),
  },
  {
    title: "SigningRequestRecipient",
    additionalProperties: false,
    description:
      "A participant as captured when the request was created. Not a live "
      + "reference to a preparation recipient or a contact.",
  },
);
export type SigningRequestRecipient = Static<typeof SigningRequestRecipientSchema>;

/**
 * A field, as snapshotted onto a request.
 *
 * `recipientId` is NOT nullable here, unlike the preparation field it came
 * from. An unassigned field is a legitimate authoring state and an impossible
 * workflow state — nobody could complete it — so readiness refuses to snapshot
 * one and the column is `NOT NULL`.
 */
export const SigningRequestFieldSchema = Type.Object(
  {
    /** Request-scoped. NOT the preparation field's id. */
    fieldId: Type.String({ minLength: 1, maxLength: 64 }),
    type: PreparationFieldTypeSchema,
    /** **1-based**, the same canonical model as preparation and sealing. */
    pageNumber: Type.Integer({ minimum: 1 }),
    /** Normalized 0–1, top-left origin. Copied exactly, never recomputed. */
    rect: PreparationRectSchema,
    required: Type.Boolean(),
    label: Type.String(),
    layer: Type.Integer({ minimum: 0 }),
    /** A recipient of THIS request. Always present. */
    recipientId: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { title: "SigningRequestField", additionalProperties: false },
);
export type SigningRequestField = Static<typeof SigningRequestFieldSchema>;

/**
 * The request itself.
 *
 * `documentTitle` is the SNAPSHOT, not the document's current title. Renaming
 * the document does not rename a transaction someone was asked to sign.
 */
export const SigningRequestSchema = Type.Object(
  {
    signingRequestId: Type.String({ minLength: 1, maxLength: 64 }),
    documentId: Type.String({ minLength: 1, maxLength: 64 }),
    /** The title as it was when the request was created. */
    documentTitle: Type.String({ maxLength: SIGNING_REQUEST_TITLE_MAX_LENGTH }),
    state: SigningRequestStateSchema,
    recipients: Type.Array(SigningRequestRecipientSchema),
    fields: Type.Array(SigningRequestFieldSchema),
    createdAt: Type.String({ format: "date-time" }),
  },
  {
    title: "SigningRequest",
    additionalProperties: false,
    description:
      "An immutable snapshot of one coherent preparation state. Configured, "
      + "not sent.",
  },
);
export type SigningRequest = Static<typeof SigningRequestSchema>;

/**
 * The creation response.
 *
 * Counts rather than the full snapshot: the caller just supplied the
 * preparation this was built from, so echoing every recipient's name and
 * address back over the wire adds nothing and puts a list of the parties to a
 * contract into one more place. `GET` returns the detail when it is actually
 * needed.
 */
export const SigningRequestCreatedSchema = Type.Object(
  {
    signingRequestId: Type.String({ minLength: 1, maxLength: 64 }),
    documentId: Type.String({ minLength: 1, maxLength: 64 }),
    state: SigningRequestStateSchema,
    recipientCount: Type.Integer({ minimum: 0 }),
    fieldCount: Type.Integer({ minimum: 0 }),
    createdAt: Type.String({ format: "date-time" }),
  },
  { title: "SigningRequestCreated", additionalProperties: false },
);
export type SigningRequestCreated = Static<typeof SigningRequestCreatedSchema>;
