// The workspace address-book surface.
//
//   GET     /workspaces/:workspaceId/contacts
//   POST    /workspaces/:workspaceId/contacts
//   GET     /workspaces/:workspaceId/contacts/:contactId
//   PUT     /workspaces/:workspaceId/contacts/:contactId
//   POST    /workspaces/:workspaceId/contacts/:contactId/archive
//   POST    /workspaces/:workspaceId/contacts/:contactId/restore
//
// ── Nested under the workspace, and that is a security property ────────────
//
// Not `/contacts?workspaceId=...`. The tenant is a PATH segment, so every route
// in this file has one and no handler can be written that forgets it. A query
// parameter is optional by nature, and the request that omitted it would have to
// be caught by a runtime check rather than by the router.
//
// ── Archive is a POST to a sub-resource, not a DELETE ──────────────────────
//
// `DELETE /contacts/:id` would describe an operation LAGDA does not perform.
// The record survives, it is reversible, and there is a `restore` that undoes
// it. Naming it DELETE would tell every client author the row is gone — and
// would be the obvious place for someone to later "fix" it into a real delete.
//
// ── No role appears in this file ───────────────────────────────────────────
//
// Not in a comparison, not in a switch, not in a schema. Authorization happens
// inside the use case, against a membership row the server read, keyed on a
// capability. The BACKEND-27 architecture guard greps this directory.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  createContact, listContacts, getContact, updateContact,
  archiveContact, restoreContact,
  type ContactDependencies, type SessionId, type UserId,
} from "@lagda/application";
import {
  ContactSchema, ContactStateSchema, ContactSortFieldSchema,
  CONTACT_NAME_MAX_LENGTH, CONTACT_EMAIL_MAX_LENGTH, CONTACT_PHONE_MAX_LENGTH,
  CONTACT_ORGANIZATION_MAX_LENGTH, CONTACT_TITLE_MAX_LENGTH,
  CONTACT_SEARCH_MAX_LENGTH, MAX_PER_PAGE, DEFAULT_PER_PAGE,
  type ContactId, type WorkspaceId,
} from "@lagda/contracts";
import type { MetricsRecorder } from "../observability/metrics.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

const WorkspaceParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
});

const ContactParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  contactId: Type.String({ minLength: 1, maxLength: 64 }),
});

/**
 * Creating or replacing a contact.
 *
 * ── Bounded at the schema, then validated again in the domain ──────────────
 *
 * The `maxLength` values here are the same numbers `@lagda/core` enforces, and
 * the duplication is intentional rather than sloppy. This layer rejects an
 * oversized payload BEFORE it becomes a database round trip and before the
 * domain has to reason about it; the domain enforces the rule for every caller,
 * including a worker with no HTTP request. Neither is redundant with the other,
 * and the constants come from one place so they cannot drift.
 *
 * Note what the schema does NOT enforce: email FORMAT. TypeBox's
 * `format: "email"` would be a second, differently-shaped email rule alongside
 * `hasEmailSyntax`, and the two would disagree on some address at some point —
 * with the schema's rejection arriving as a generic 400 that names no field.
 *
 * Deliberately absent: `workspaceId` (it is the path), `contactId` (the server
 * generates it), `state`/`archivedAt` (archiving is its own route),
 * `createdAt`/`updatedAt` (the server stamps them), `userId` (a contact is not
 * a user, and there is no field through which a client could suggest one).
 */
const ContactBodySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: CONTACT_NAME_MAX_LENGTH }),
  email: Type.String({ minLength: 1, maxLength: CONTACT_EMAIL_MAX_LENGTH }),
  // Nullable and optional: absent means "not provided", explicit null means
  // "clear it". On create the two are identical; on replace they are not, and
  // one schema serving both keeps the client's mental model single.
  phone: Type.Optional(Type.Union([
    Type.String({ maxLength: CONTACT_PHONE_MAX_LENGTH }), Type.Null(),
  ])),
  organization: Type.Optional(Type.Union([
    Type.String({ maxLength: CONTACT_ORGANIZATION_MAX_LENGTH }), Type.Null(),
  ])),
  title: Type.Optional(Type.Union([
    Type.String({ maxLength: CONTACT_TITLE_MAX_LENGTH }), Type.Null(),
  ])),
}, { additionalProperties: false });

export type ContactBody = Static<typeof ContactBodySchema>;

const ContactListQuerySchema = Type.Object({
  search: Type.Optional(Type.String({ maxLength: CONTACT_SEARCH_MAX_LENGTH })),
  state: Type.Optional(ContactStateSchema),
  sort: Type.Optional(ContactSortFieldSchema),
  direction: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
  // Coerced and BOUNDED here. `perPage=1000000` is a valid integer and an
  // invalid request; leaving the bound to the handler means the one route that
  // forgets it can be made to read the whole table.
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  perPage: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PER_PAGE, default: DEFAULT_PER_PAGE }),
  ),
}, { additionalProperties: false });

/**
 * A duplicate warning, returned alongside a SUCCESSFUL write.
 *
 * Three fields, and no email. The caller already knows the address — they just
 * typed it — so returning it adds nothing, and a warning payload is not a way to
 * read contact records one at a time.
 */
const DuplicateWarningSchema = Type.Object({
  contactId: Type.String(),
  name: Type.String(),
  organization: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });

const ContactWriteResponseSchema = Type.Object({
  contact: ContactSchema,
  duplicates: Type.Array(DuplicateWarningSchema),
}, { additionalProperties: false });

const ContactListResponseSchema = Type.Object({
  items: Type.Array(ContactSchema),
  total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }),
  perPage: Type.Integer({ minimum: 1 }),
  hasNextPage: Type.Boolean(),
}, { additionalProperties: false });

// ── Options ─────────────────────────────────────────────────────────────────

export interface ContactRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly contactDependencies: () => ContactDependencies;
  readonly metrics?: MetricsRecorder;
}

/**
 * An address book is a list of named people with their email addresses and
 * phone numbers. It does not belong in any cache a second party can read.
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

/** Timestamps leave as ISO-8601. The domain works in epoch milliseconds. */
const iso = (ms: number): string => new Date(ms).toISOString();

interface ContactLike {
  readonly contactId: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string | null;
  readonly organization: string | null;
  readonly title: string | null;
  readonly state: "active" | "archived";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archivedAt: number | null;
}

const present = (contact: ContactLike) => ({
  contactId: contact.contactId,
  name: contact.name,
  email: contact.email,
  phone: contact.phone,
  organization: contact.organization,
  title: contact.title,
  state: contact.state,
  createdAt: iso(contact.createdAt),
  updatedAt: iso(contact.updatedAt),
  archivedAt: contact.archivedAt === null ? null : iso(contact.archivedAt),
});

export function registerContactRoutes(
  app: FastifyInstance,
  options: ContactRouteOptions,
): void {
  const metrics = options.metrics;

  /**
   * A write to the address book.
   *
   * ── IDs and outcomes only ──────────────────────────────────────────────────
   *
   * Never the contact's name, email, phone, organization or title. A contact
   * record is somebody else's personal data — a counterparty who is not a LAGDA
   * user and never agreed to anything — and a log line is the easiest place in
   * the system for it to end up somewhere nobody audited.
   *
   * `duplicateCount` is a NUMBER, not the matching contacts. It answers "is the
   * duplicate warning firing in production" without putting a second person's
   * details in a log to do it.
   *
   * The metric labels are `operation` and `result`: two closed sets. No
   * contactId, no workspaceId, no email — an unbounded label value is a
   * cardinality explosion, and an email as a label is a PII leak into a metrics
   * store that is usually retained longer and read more widely than logs.
   */
  const record = (
    request: FastifyRequest,
    event: "contact.created" | "contact.updated" | "contact.archived" | "contact.restored",
    fields: Record<string, unknown>,
  ): void => {
    request.log.info({ event, result: "success", ...fields }, event);
    metrics?.increment("contact_operations_total", {
      operation: event.slice("contact.".length),
      result: "success",
      processRole: "api",
    });
  };

  const actorOf = async (request: FastifyRequest) => {
    const actor = await options.authenticatedUser(request);
    return actor === null
      ? null
      : { actorType: "user" as const, userId: actor.userId, sessionId: actor.sessionId };
  };

  // ── List ────────────────────────────────────────────────────────────────
  app.get("/workspaces/:workspaceId/contacts", {
    schema: {
      params: WorkspaceParamsSchema,
      querystring: ContactListQuerySchema,
      response: { 200: ContactListResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId } = request.params as Static<typeof WorkspaceParamsSchema>;
    const query = request.query as Static<typeof ContactListQuerySchema>;

    const result = await listContacts(
      actor, workspaceId as WorkspaceId,
      {
        // Each key passed only when the client supplied it, so the use case's
        // documented defaults are the ones that apply. Spreading `undefined`
        // into an optional field works, but it puts the default in two places.
        ...(query.search === undefined ? {} : { search: query.search }),
        ...(query.state === undefined ? {} : { state: query.state }),
        ...(query.sort === undefined ? {} : { sort: query.sort }),
        ...(query.direction === undefined ? {} : { direction: query.direction }),
        ...(query.page === undefined ? {} : { page: query.page }),
        ...(query.perPage === undefined ? {} : { perPage: query.perPage }),
      },
      options.contactDependencies(),
    );

    // A page past the end is 200 with an empty array, per API_CONVENTIONS. The
    // collection exists; the page is simply empty.
    return reply.status(200).send({
      items: result.items.map(present),
      total: result.total,
      page: result.page,
      perPage: result.perPage,
      hasNextPage: result.hasNextPage,
    });
  });

  // ── Create ──────────────────────────────────────────────────────────────
  app.post("/workspaces/:workspaceId/contacts", {
    schema: {
      params: WorkspaceParamsSchema,
      body: ContactBodySchema,
      response: { 201: ContactWriteResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId } = request.params as Static<typeof WorkspaceParamsSchema>;
    const body = request.body as ContactBody;

    const result = await createContact(
      actor, workspaceId as WorkspaceId, body, options.contactDependencies());

    record(request, "contact.created", {
      workspaceId,
      contactId: result.contact.contactId,
      actorUserId: actor.userId,
      duplicateCount: result.duplicates.length,
    });

    // 201 with the created record, and 201 even when duplicates were found. The
    // contact WAS created — LAGDA warns, it does not refuse — and returning 409
    // would tell a client the write failed when it did not.
    void reply.header("Location",
      `/workspaces/${workspaceId}/contacts/${result.contact.contactId}`);
    return reply.status(201).send({
      contact: present(result.contact),
      duplicates: result.duplicates,
    });
  });

  // ── Get one ─────────────────────────────────────────────────────────────
  app.get("/workspaces/:workspaceId/contacts/:contactId", {
    schema: {
      params: ContactParamsSchema,
      response: { 200: ContactSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, contactId } = request.params as Static<typeof ContactParamsSchema>;
    const contact = await getContact(
      actor, workspaceId as WorkspaceId, contactId as ContactId,
      options.contactDependencies());

    return reply.status(200).send(present(contact));
  });

  // ── Replace ─────────────────────────────────────────────────────────────
  //
  // PUT rather than PATCH, and the body carries every editable field.
  //
  // A PATCH whose absent keys mean "leave unchanged" cannot express "clear the
  // phone number" without a null that means something different from absent —
  // which is exactly the ambiguity that makes partial-update APIs subtly wrong.
  // A full replacement is unambiguous, is naturally idempotent, and matches the
  // product: the contact form submits every field.
  app.put("/workspaces/:workspaceId/contacts/:contactId", {
    schema: {
      params: ContactParamsSchema,
      body: ContactBodySchema,
      response: { 200: ContactWriteResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, contactId } = request.params as Static<typeof ContactParamsSchema>;
    const body = request.body as ContactBody;

    const result = await updateContact(
      actor, workspaceId as WorkspaceId, contactId as ContactId, body,
      options.contactDependencies());

    record(request, "contact.updated", {
      workspaceId, contactId,
      actorUserId: actor.userId,
      duplicateCount: result.duplicates.length,
    });

    return reply.status(200).send({
      contact: present(result.contact),
      duplicates: result.duplicates,
    });
  });

  // ── Archive ─────────────────────────────────────────────────────────────
  app.post("/workspaces/:workspaceId/contacts/:contactId/archive", {
    schema: {
      params: ContactParamsSchema,
      response: { 200: ContactSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, contactId } = request.params as Static<typeof ContactParamsSchema>;

    // No body. There is nothing a client could usefully say about archiving,
    // and a `reason` field would be free text nobody reads.
    const contact = await archiveContact(
      actor, workspaceId as WorkspaceId, contactId as ContactId,
      options.contactDependencies());

    record(request, "contact.archived", {
      workspaceId, contactId, actorUserId: actor.userId,
    });
    return reply.status(200).send(present(contact));
  });

  // ── Restore ─────────────────────────────────────────────────────────────
  app.post("/workspaces/:workspaceId/contacts/:contactId/restore", {
    schema: {
      params: ContactParamsSchema,
      response: { 200: ContactSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, contactId } = request.params as Static<typeof ContactParamsSchema>;

    const contact = await restoreContact(
      actor, workspaceId as WorkspaceId, contactId as ContactId,
      options.contactDependencies());

    record(request, "contact.restored", {
      workspaceId, contactId, actorUserId: actor.userId,
    });
    return reply.status(200).send(present(contact));
  });
}
