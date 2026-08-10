// The signing recipient surface.
//
//   GET    /workspaces/:workspaceId/documents/:documentId/recipients
//   POST   /workspaces/:workspaceId/documents/:documentId/recipients
//   PATCH  /workspaces/:workspaceId/documents/:documentId/recipients/:recipientId
//   DELETE /workspaces/:workspaceId/documents/:documentId/recipients/:recipientId
//   PUT    /workspaces/:workspaceId/documents/:documentId/recipients/order
//
// ── Nested under the document, not top-level ───────────────────────────────
//
// A recipient belongs to one document's preparation and has no meaning outside
// it. `/recipients/:id` as a top-level route would imply a global namespace to
// look one up in, and would make the parent check something the handler had to
// remember rather than something the URL states (§121).
//
// ── Per-recipient, unlike the layout's whole-set PUT ───────────────────────
//
// The editor's recipient list is a form with add and remove buttons, not a
// drag-and-drop canvas that autosaves. Individual operations match it, produce
// specific errors ("that address is already a recipient" naming the right row),
// and avoid the lost-update problem a whole-set replace would create. Order is
// the exception, because reordering IS a whole-set operation (§103).
//
// ── No role appears in this file ───────────────────────────────────────────
//
// The BACKEND-27 guard greps this directory.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  listRecipients, addRecipient, updateRecipient, removeRecipient, reorderRecipients,
  type RecipientDependencies, type RecipientView,
  type SessionId, type UserId,
} from "@lagda/application";
import {
  RecipientSchema, RecipientTypeSchema,
  RECIPIENT_NAME_MAX_LENGTH, RECIPIENT_EMAIL_MAX_LENGTH,
  RECIPIENT_ORGANIZATION_MAX_LENGTH, MAX_RECIPIENTS_PER_PREPARATION,
  type DocumentId, type WorkspaceId,
} from "@lagda/contracts";
import type { MetricsRecorder } from "../observability/metrics.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

const DocumentParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  documentId: Type.String({ minLength: 1, maxLength: 64 }),
});

const RecipientParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  documentId: Type.String({ minLength: 1, maxLength: 64 }),
  recipientId: Type.String({ minLength: 1, maxLength: 64 }),
});

/**
 * Adding a recipient: typed by hand, or copied from a contact.
 *
 * ── A union, so the two cannot be mixed ────────────────────────────────────
 *
 * `{ source: "contact", contactId }` accepts NO name, email or organization —
 * `additionalProperties: false` on each branch rejects them with 422. The
 * alternative, a contact id alongside optional overrides, lets a caller send a
 * contact id and a contradicting name and leaves the server choosing which it
 * believes. Here the source decides, and the schema enforces it.
 *
 * ── Read the exclusions ────────────────────────────────────────────────────
 *
 * Rejected on both branches:
 *
 *   recipientId               server-generated (§7)
 *   sourceContactId           provenance the server sets, not a claim a caller
 *                             makes about where a snapshot came from
 *   orderIndex                appended by the server; reordering is its own route
 *   userId, isRegisteredUser  a recipient is never resolved to an account (§94)
 *   emailVerified, verifiedAt, accessToken, otp
 *                             authentication LAGDA has not performed (§162)
 *   signedAt, viewedAt, emailSentAt
 *                             ceremony state that does not exist yet
 */
const ManualRecipientSchema = Type.Object({
  source: Type.Literal("manual"),
  name: Type.String({ minLength: 1, maxLength: RECIPIENT_NAME_MAX_LENGTH }),
  /** The DELIVERY address. Syntax is checked; possession is not (§162). */
  email: Type.String({ minLength: 1, maxLength: RECIPIENT_EMAIL_MAX_LENGTH }),
  organization: Type.Optional(Type.Union([
    Type.String({ maxLength: RECIPIENT_ORGANIZATION_MAX_LENGTH }),
    Type.Null(),
  ])),
  type: RecipientTypeSchema,
  isRequired: Type.Optional(Type.Boolean()),
  routingOrder: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

const ContactRecipientSchema = Type.Object({
  source: Type.Literal("contact"),
  contactId: Type.String({ minLength: 1, maxLength: 64 }),
  type: RecipientTypeSchema,
  isRequired: Type.Optional(Type.Boolean()),
  routingOrder: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

const AddRecipientRequestSchema = Type.Union(
  [ManualRecipientSchema, ContactRecipientSchema],
  { title: "AddRecipientRequest" },
);

/**
 * Editing a recipient.
 *
 * `orderIndex` is absent deliberately: renumbering one row out of step with the
 * rest is how a list ends up with two recipients at position 2. Order is set
 * for the whole list at once, by the order route.
 *
 * `sourceContactId` is absent because provenance is not editable — a caller
 * that could set it could claim a snapshot came from a contact it never did.
 */
const UpdateRecipientRequestSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: RECIPIENT_NAME_MAX_LENGTH })),
  email: Type.Optional(Type.String({ minLength: 1, maxLength: RECIPIENT_EMAIL_MAX_LENGTH })),
  organization: Type.Optional(Type.Union([
    Type.String({ maxLength: RECIPIENT_ORGANIZATION_MAX_LENGTH }),
    Type.Null(),
  ])),
  type: Type.Optional(RecipientTypeSchema),
  isRequired: Type.Optional(Type.Boolean()),
  routingOrder: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

/**
 * Reordering: the COMPLETE list of ids, each exactly once.
 *
 * Bounded here as well as in the domain — an unbounded array is an unbounded
 * request body, and the bound belongs where a request can be rejected before it
 * becomes one.
 */
const ReorderRequestSchema = Type.Object({
  recipientIds: Type.Array(
    Type.String({ minLength: 1, maxLength: 64 }),
    { maxItems: MAX_RECIPIENTS_PER_PREPARATION },
  ),
}, { additionalProperties: false });

const RecipientListSchema = Type.Object({
  recipients: Type.Array(RecipientSchema),
}, { title: "RecipientList", additionalProperties: false });

export type AddRecipientBody = Static<typeof AddRecipientRequestSchema>;
export type UpdateRecipientBody = Static<typeof UpdateRecipientRequestSchema>;
export type ReorderRecipientsBody = Static<typeof ReorderRequestSchema>;

// ── Options ─────────────────────────────────────────────────────────────────

export interface RecipientRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly recipientDependencies: () => RecipientDependencies;
  readonly metrics?: MetricsRecorder;
}

/**
 * A recipient list is the names, email addresses and roles of the parties to a
 * contract. Never a shared cache.
 */
function noStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
  void reply.header("Pragma", "no-cache");
}

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({
    error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." },
  });
}

const iso = (ms: number): string => new Date(ms).toISOString();

const present = (recipient: RecipientView) => ({
  recipientId: recipient.recipientId,
  name: recipient.name,
  email: recipient.email,
  organization: recipient.organization,
  type: recipient.type,
  isRequired: recipient.isRequired,
  orderIndex: recipient.orderIndex,
  routingOrder: recipient.routingOrder,
  sourceContactId: recipient.sourceContactId,
  createdAt: iso(recipient.createdAt),
  updatedAt: iso(recipient.updatedAt),
});

export function registerRecipientRoutes(
  app: FastifyInstance,
  options: RecipientRouteOptions,
): void {
  const metrics = options.metrics;

  const actorOf = async (request: FastifyRequest) => {
    const actor = await options.authenticatedUser(request);
    return actor === null
      ? null
      : { actorType: "user" as const, userId: actor.userId, sessionId: actor.sessionId };
  };

  /**
   * What a recipient operation may record.
   *
   * ── No name, no email, ever ────────────────────────────────────────────
   *
   * A recipient row is the name and address of a party to a contract. Logging
   * either would put the participants of every LAGDA agreement into whatever
   * reads the log — §188 and RECIPIENT_DATA_CLASSIFICATION.md.
   *
   * `recipientType` is included: it is a vocabulary term from a fixed set of
   * six, tells an operator whether senders actually use approvers and viewers,
   * and identifies nobody. `fromContact` is a boolean, not the contact id.
   */
  const record = (
    request: FastifyRequest,
    event: string,
    detail: Record<string, unknown>,
  ): void => {
    request.log.info({ event, result: "success", ...detail }, event);
    metrics?.increment("document_recipient_operations_total", {
      operation: event.replace("document.recipient.", ""),
      result: "success",
      processRole: "api",
    });
  };

  // ── List ────────────────────────────────────────────────────────────────
  app.get("/workspaces/:workspaceId/documents/:documentId/recipients", {
    schema: {
      params: DocumentParamsSchema,
      response: { 200: RecipientListSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, documentId } = request.params as Static<typeof DocumentParamsSchema>;

    const recipients = await listRecipients(
      actor, workspaceId as WorkspaceId, documentId as DocumentId,
      options.recipientDependencies());

    // Reads are not logged. The editor polls this alongside the layout.
    return reply.status(200).send({ recipients: recipients.map(present) });
  });

  // ── Add ─────────────────────────────────────────────────────────────────
  app.post("/workspaces/:workspaceId/documents/:documentId/recipients", {
    schema: {
      params: DocumentParamsSchema,
      body: AddRecipientRequestSchema,
      response: { 201: RecipientSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, documentId } = request.params as Static<typeof DocumentParamsSchema>;
    const body = request.body as AddRecipientBody;

    const recipient = await addRecipient(
      actor, workspaceId as WorkspaceId, documentId as DocumentId,
      body, options.recipientDependencies());

    record(request, "document.recipient.added", {
      workspaceId,
      documentId,
      recipientId: recipient.recipientId,
      actorUserId: actor.userId,
      recipientType: recipient.type,
      // Whether a contact was copied — not WHICH contact, which would identify
      // the person as surely as the address would.
      fromContact: recipient.sourceContactId !== null,
    });

    return reply.status(201).send(present(recipient));
  });

  // ── Update ──────────────────────────────────────────────────────────────
  app.patch("/workspaces/:workspaceId/documents/:documentId/recipients/:recipientId", {
    schema: {
      params: RecipientParamsSchema,
      body: UpdateRecipientRequestSchema,
      response: { 200: RecipientSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, documentId, recipientId } =
      request.params as Static<typeof RecipientParamsSchema>;
    const body = request.body as UpdateRecipientBody;

    const recipient = await updateRecipient(
      actor, workspaceId as WorkspaceId, documentId as DocumentId, recipientId,
      body, options.recipientDependencies());

    // WHICH fields changed, never their values. "The name was corrected" is an
    // operational fact; the name is a party to a contract.
    record(request, "document.recipient.updated", {
      workspaceId,
      documentId,
      recipientId: recipient.recipientId,
      actorUserId: actor.userId,
      changedFields: Object.keys(body).sort(),
    });

    return reply.status(200).send(present(recipient));
  });

  // ── Remove ──────────────────────────────────────────────────────────────
  app.delete("/workspaces/:workspaceId/documents/:documentId/recipients/:recipientId", {
    schema: { params: RecipientParamsSchema },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, documentId, recipientId } =
      request.params as Static<typeof RecipientParamsSchema>;

    await removeRecipient(
      actor, workspaceId as WorkspaceId, documentId as DocumentId, recipientId,
      options.recipientDependencies());

    record(request, "document.recipient.removed", {
      workspaceId,
      documentId,
      recipientId,
      actorUserId: actor.userId,
    });

    // 204: there is no remaining representation, and a body would invite a
    // client to read one.
    return reply.status(204).send();
  });

  // ── Reorder ─────────────────────────────────────────────────────────────
  //
  // A fixed sub-path rather than a parameter, so it can never be shadowed by a
  // recipient whose id happens to be "order".
  app.put("/workspaces/:workspaceId/documents/:documentId/recipients/order", {
    schema: {
      params: DocumentParamsSchema,
      body: ReorderRequestSchema,
      response: { 200: RecipientListSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, documentId } = request.params as Static<typeof DocumentParamsSchema>;
    const body = request.body as ReorderRecipientsBody;

    const recipients = await reorderRecipients(
      actor, workspaceId as WorkspaceId, documentId as DocumentId, body.recipientIds,
      options.recipientDependencies());

    // The COUNT. The ids would be a stable pseudonymous handle per party, and a
    // log that carries them across every reorder builds a participation graph.
    record(request, "document.recipient.reordered", {
      workspaceId,
      documentId,
      actorUserId: actor.userId,
      recipientCount: recipients.length,
    });

    return reply.status(200).send({ recipients: recipients.map(present) });
  });
}
