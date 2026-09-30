// Contact connections (091): find a person by exact email, ask to add them,
// answer requests, and see the photos that go with them.
//
//   POST /workspaces/:workspaceId/contact-connections/lookup   find by exact email
//   POST /workspaces/:workspaceId/contact-connections          ask to add someone
//   GET  /me/contact-connections                               received and sent
//   POST /me/contact-connections/:connectionId/accept          { workspaceId }
//   POST /me/contact-connections/:connectionId/decline
//   POST /me/contact-connections/:connectionId/cancel
//   GET  /me/contact-discovery        |  PUT /me/contact-discovery
//   GET  /me/people/:userId/avatar    a found person's, or a requester's, photo
//   GET  /workspaces/:workspaceId/contacts/:contactId/avatar   a contact's photo
//
// Registered inside the authenticated scope: every route needs the session,
// and every mutation its CSRF check. A user id is only ever taken from the
// session, except as the TARGET of a photo read, which is authorized.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  lookupPerson, sendConnectionRequest, listConnections, acceptConnectionRequest,
  declineConnectionRequest, cancelConnectionRequest, getDiscovery, setDiscovery,
  canSeePhoto, resolveContactAccounts, getContact, policyById,
  type ContactConnectionDependencies, type ContactDependencies, type PersonView,
  type ConnectionView, type SessionId, type UserId,
} from "@lagda/application";
import type { WorkspaceId, ContactId } from "@lagda/contracts";
import type { MetricsRecorder } from "../observability/metrics.js";
import { checkSemanticLimits, type RateLimitOptions } from "../security/rate-limit-plugin.js";

export interface ContactConnectionRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly dependencies: () => ContactConnectionDependencies;
  readonly contactDependencies: () => ContactDependencies;
  /** 072's photos: the bytes by user id, and their versions in one read. */
  readonly avatars: () => {
    find(userId: string): Promise<{ mediaType: string; bytes: Uint8Array; digest: string } | null>;
  };
  readonly avatarVersions: (userIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  readonly metrics?: MetricsRecorder;
  readonly rateLimit?: RateLimitOptions;
}

// ── Schemas ───────────────────────────────────────────────────────────────

const Nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Union([t, Type.Null()]);

const PersonSchema = Type.Object({
  userId: Type.String(),
  displayName: Type.String(),
  jobTitle: Nullable(Type.String()),
  organization: Nullable(Type.String()),
  /** `/me/people/{userId}/avatar?v=` — null when there is no photo. */
  avatarVersion: Nullable(Type.String()),
}, { additionalProperties: false });

const LookupResponseSchema = Type.Object({
  person: Type.Union([
    Type.Object({
      userId: Type.String(),
      displayName: Type.String(),
      jobTitle: Nullable(Type.String()),
      organization: Nullable(Type.String()),
      avatarVersion: Nullable(Type.String()),
      relationship: Type.Union([
        Type.Literal("self"), Type.Literal("none"), Type.Literal("requested"), Type.Literal("incoming"),
      ]),
      connectionId: Nullable(Type.String()),
    }, { additionalProperties: false }),
    Type.Null(),
  ]),
  existingContactId: Nullable(Type.String()),
}, { additionalProperties: false });

const ConnectionSchema = Type.Object({
  connectionId: Type.String(),
  person: PersonSchema,
  workspaceName: Type.String(),
  status: Type.Literal("pending"),
  createdAt: Type.String(),
}, { additionalProperties: false });

const ConnectionListSchema = Type.Object({
  received: Type.Array(ConnectionSchema),
  sent: Type.Array(ConnectionSchema),
}, { additionalProperties: false });

const EmailBody = Type.Object({
  email: Type.String({ minLength: 1, maxLength: 320 }),
}, { additionalProperties: false });

const WorkspaceParams = Type.Object({ workspaceId: Type.String({ minLength: 1, maxLength: 64 }) });
const ConnectionParams = Type.Object({ connectionId: Type.String({ minLength: 1, maxLength: 64 }) });
const PersonParams = Type.Object({ userId: Type.String({ minLength: 1, maxLength: 64 }) });
const ContactParams = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  contactId: Type.String({ minLength: 1, maxLength: 64 }),
});

const AcceptBody = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });
const AcceptResponse = Type.Object({
  contactId: Nullable(Type.String()),
  workspaceId: Type.String(),
}, { additionalProperties: false });

const DiscoverySchema = Type.Object({
  discoverableByEmail: Type.Boolean(),
}, { additionalProperties: false });

// ── Helpers ───────────────────────────────────────────────────────────────

function noStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
  void reply.header("Pragma", "no-cache");
}

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({
    error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." },
  });
}

function noPhoto(reply: FastifyReply): FastifyReply {
  noStore(reply);
  return reply.status(404).send({ error: { code: "AVATAR_NOT_FOUND", message: "No profile photo is set." } });
}

/** Field by field: every schema here is closed. */
const presentPerson = (p: PersonView, versions: ReadonlyMap<string, string>) => ({
  userId: p.userId,
  displayName: p.displayName,
  jobTitle: p.jobTitle,
  organization: p.organization,
  avatarVersion: versions.get(p.userId) ?? null,
});

const presentConnection = (c: ConnectionView, versions: ReadonlyMap<string, string>) => ({
  connectionId: c.connectionId,
  person: presentPerson(c.person, versions),
  workspaceName: c.workspaceName,
  status: c.status,
  createdAt: new Date(c.createdAt).toISOString(),
});

type Operation = "lookup" | "requested" | "accepted" | "declined" | "cancelled" | "discovery_changed";

export function registerContactConnectionRoutes(
  app: FastifyInstance,
  options: ContactConnectionRouteOptions,
): void {
  const deps = options.dependencies;

  /** IDs and outcomes only — never an address or a name. */
  const record = (request: FastifyRequest, operation: Operation, fields: Record<string, unknown>) => {
    const event = `contact_connections.${operation}`;
    request.log.info({ event, result: "success", ...fields }, event);
    options.metrics?.increment("contact_connection_operations_total", {
      operation, result: "success", processRole: "api",
    });
  };

  const actorOf = async (request: FastifyRequest) => {
    const actor = await options.authenticatedUser(request);
    return actor === null
      ? null
      : { actorType: "user" as const, userId: actor.userId, sessionId: actor.sessionId };
  };

  const sendPhoto = async (reply: FastifyReply, userId: string) => {
    const avatar = await options.avatars().find(userId);
    if (avatar === null) return noPhoto(reply);
    // Versioned URL (`?v=<digest>`): a changed photo is a different URL.
    void reply.header("Cache-Control", "private, max-age=31536000, immutable");
    void reply.header("ETag", `"${avatar.digest}"`);
    void reply.header("X-Content-Type-Options", "nosniff");
    void reply.header("Content-Security-Policy", "default-src 'none'");
    return reply.type(avatar.mediaType).send(Buffer.from(avatar.bytes));
  };

  // ── Find and ask ────────────────────────────────────────────────────────

  app.post("/workspaces/:workspaceId/contact-connections/lookup", {
    schema: { params: WorkspaceParams, body: EmailBody, response: { 200: LookupResponseSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    if (options.rateLimit !== undefined) {
      await checkSemanticLimits(request, [{
        policy: policyById("contacts.lookup.user"), scope: { type: "user", userId: actor.userId },
      }], options.rateLimit);
    }
    const { workspaceId } = request.params as Static<typeof WorkspaceParams>;
    const { email } = request.body as Static<typeof EmailBody>;
    const result = await lookupPerson(actor, workspaceId as WorkspaceId, { email }, deps());
    const versions = await options.avatarVersions(result.person === null ? [] : [result.person.userId]);
    record(request, "lookup", { workspaceId, found: result.person !== null });
    return reply.status(200).send({
      person: result.person === null ? null : {
        ...presentPerson(result.person, versions),
        relationship: result.person.relationship,
        connectionId: result.person.connectionId,
      },
      existingContactId: result.existingContactId,
    });
  });

  app.post("/workspaces/:workspaceId/contact-connections", {
    schema: { params: WorkspaceParams, body: EmailBody, response: { 201: ConnectionSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId } = request.params as Static<typeof WorkspaceParams>;
    const { email } = request.body as Static<typeof EmailBody>;
    const view = await sendConnectionRequest(actor, workspaceId as WorkspaceId, { email }, deps());
    record(request, "requested", { workspaceId, connectionId: view.connectionId });
    const versions = await options.avatarVersions([view.person.userId]);
    return reply.status(201).send(presentConnection(view, versions));
  });

  // ── The account's own requests ──────────────────────────────────────────

  app.get("/me/contact-connections", {
    schema: { response: { 200: ConnectionListSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const lists = await listConnections(actor, deps());
    const versions = await options.avatarVersions(
      [...lists.received, ...lists.sent].map(c => c.person.userId));
    return reply.status(200).send({
      received: lists.received.map(c => presentConnection(c, versions)),
      sent: lists.sent.map(c => presentConnection(c, versions)),
    });
  });

  app.post("/me/contact-connections/:connectionId/accept", {
    schema: { params: ConnectionParams, body: AcceptBody, response: { 200: AcceptResponse } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { connectionId } = request.params as Static<typeof ConnectionParams>;
    const { workspaceId } = request.body as Static<typeof AcceptBody>;
    const result = await acceptConnectionRequest(actor, connectionId, { workspaceId: workspaceId as WorkspaceId }, deps());
    record(request, "accepted", { connectionId, workspaceId: result.workspaceId });
    return reply.status(200).send({ contactId: result.contactId, workspaceId: result.workspaceId });
  });

  app.post("/me/contact-connections/:connectionId/decline", {
    schema: { params: ConnectionParams },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { connectionId } = request.params as Static<typeof ConnectionParams>;
    await declineConnectionRequest(actor, connectionId, deps());
    record(request, "declined", { connectionId });
    return reply.status(204).send();
  });

  app.post("/me/contact-connections/:connectionId/cancel", {
    schema: { params: ConnectionParams },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { connectionId } = request.params as Static<typeof ConnectionParams>;
    await cancelConnectionRequest(actor, connectionId, deps());
    record(request, "cancelled", { connectionId });
    return reply.status(204).send();
  });

  // ── Being findable ──────────────────────────────────────────────────────

  app.get("/me/contact-discovery", {
    schema: { response: { 200: DiscoverySchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    return reply.status(200).send(await getDiscovery(actor, deps()));
  });

  app.put("/me/contact-discovery", {
    schema: { body: DiscoverySchema, response: { 200: DiscoverySchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const body = request.body as Static<typeof DiscoverySchema>;
    const result = await setDiscovery(actor, { discoverableByEmail: body.discoverableByEmail }, deps());
    record(request, "discovery_changed", { discoverable: result.discoverableByEmail });
    return reply.status(200).send(result);
  });

  // ── Photos ──────────────────────────────────────────────────────────────

  app.get("/me/people/:userId/avatar", {
    schema: { params: PersonParams },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { userId } = request.params as Static<typeof PersonParams>;
    // One answer for "not allowed" and "no photo".
    if (!(await canSeePhoto(actor.userId, userId as UserId, deps()))) return noPhoto(reply);
    return sendPhoto(reply, userId);
  });

  app.get("/workspaces/:workspaceId/contacts/:contactId/avatar", {
    schema: { params: ContactParams },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId, contactId } = request.params as Static<typeof ContactParams>;
    // Reading the contact is the authorization: the same visibility rules as
    // the contact itself, so its photo is never wider than its record.
    const contact = await getContact(actor, workspaceId as WorkspaceId, contactId as ContactId, options.contactDependencies());
    const accounts = await resolveContactAccounts(workspaceId as WorkspaceId, [contact], deps());
    const account = accounts.get(contact.contactId);
    if (account === undefined) return noPhoto(reply);
    return sendPhoto(reply, account.userId);
  });
}
