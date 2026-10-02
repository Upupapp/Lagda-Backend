// Messages from the public website (095).
//
//   POST /public/inquiries            a demo request, contact message or
//                                     eNotary waitlist sign-up — NO credential
//   GET  /public-inquiries            the inbox, newest first (inbox account only)
//   GET  /public-inquiries/:inquiryId one message (inbox account only)
//
// Two registrations, because the two halves live in different realms. The
// POST is registered OUTSIDE every authenticated scope: its caller has no
// account. What protects it is shape — closed, bounded fields, a fail-closed
// IP limiter, and the fact that it returns nothing but a receipt. The GETs are
// registered INSIDE the authenticated scope, and to every account but the
// inbox's they answer not-found.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  submitPublicInquiry, listPublicInquiries, getPublicInquiry, policyById,
  PUBLIC_INQUIRY_KIND_LABELS,
  type PublicInquiryDependencies, type PublicInquiryRecord, type RateLimitCheck,
  type SessionId, type UserId,
} from "@lagda/application";
import type { MetricsRecorder } from "../observability/metrics.js";
import { checkSemanticLimits, type RateLimitOptions } from "../security/rate-limit-plugin.js";

export interface PublicInquirySubmitRouteOptions {
  readonly dependencies: () => PublicInquiryDependencies;
  readonly metrics?: MetricsRecorder;
  /**
   * Absent means unmetered, which only an app built without a limiter (a route
   * test) should be. The composition root always passes one.
   */
  readonly rateLimit?: RateLimitOptions;
}

export interface PublicInquiryInboxRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly dependencies: () => PublicInquiryDependencies;
}

// ── Schemas ───────────────────────────────────────────────────────────────

const KindLiteral = Type.Union([
  Type.Literal("demo"), Type.Literal("contact"), Type.Literal("waitlist"),
]);
const NullableString = Type.Union([Type.String(), Type.Null()]);

/**
 * Closed, and every field bounded at the wire. The use case trims and
 * re-checks; these bounds exist so an oversized body is refused before it is
 * read into a use case at all.
 */
export const SubmitInquiryBody = Type.Object({
  kind: KindLiteral,
  name: Type.String({ minLength: 1, maxLength: 120 }),
  email: Type.String({ minLength: 3, maxLength: 254 }),
  organization: Type.Optional(Type.String({ maxLength: 160 })),
  role: Type.Optional(Type.String({ maxLength: 120 })),
  organizationSize: Type.Optional(Type.String({ maxLength: 40 })),
  industry: Type.Optional(Type.String({ maxLength: 120 })),
  phone: Type.Optional(Type.String({ maxLength: 40 })),
  topic: Type.Optional(Type.String({ maxLength: 120 })),
  subject: Type.Optional(Type.String({ maxLength: 200 })),
  message: Type.Optional(Type.String({ maxLength: 4000 })),
  /** Literal true: a body saying anything else is refused. */
  consent: Type.Literal(true),
}, { additionalProperties: false });

export const SubmitInquiryResponse = Type.Object({
  inquiryId: Type.String(),
  kind: KindLiteral,
  receivedAt: Type.String(),
}, { additionalProperties: false });

const InquirySchema = Type.Object({
  inquiryId: Type.String(),
  kind: KindLiteral,
  kindLabel: Type.String(),
  name: Type.String(),
  email: Type.String(),
  organization: NullableString,
  role: NullableString,
  organizationSize: NullableString,
  industry: NullableString,
  phone: NullableString,
  topic: NullableString,
  subject: NullableString,
  message: NullableString,
  createdAt: Type.String(),
}, { additionalProperties: false });

const InboxSchema = Type.Object({
  inquiries: Type.Array(InquirySchema),
  counts: Type.Object({
    demo: Type.Integer(), contact: Type.Integer(), waitlist: Type.Integer(),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const InboxQuery = Type.Object({
  kind: Type.Optional(KindLiteral),
}, { additionalProperties: false });

const InquiryParams = Type.Object({
  inquiryId: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });

/** Field by field: every schema here is closed. */
const present = (i: PublicInquiryRecord) => ({
  inquiryId: i.inquiryId,
  kind: i.kind,
  kindLabel: PUBLIC_INQUIRY_KIND_LABELS[i.kind],
  name: i.name,
  email: i.email,
  organization: i.organization,
  role: i.role,
  organizationSize: i.organizationSize,
  industry: i.industry,
  phone: i.phone,
  topic: i.topic,
  subject: i.subject,
  message: i.message,
  createdAt: new Date(i.createdAt).toISOString(),
});

function noStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
}

// ── The public half: no credential ────────────────────────────────────────

export function registerPublicInquirySubmitRoute(
  app: FastifyInstance,
  options: PublicInquirySubmitRouteOptions,
): void {
  app.post("/public/inquiries", {
    schema: { body: SubmitInquiryBody, response: { 201: SubmitInquiryResponse } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    // IP is the only scope there is: no account, no session, no credential.
    if (options.rateLimit !== undefined) {
      const checks: RateLimitCheck[] = [{
        policy: policyById("public-inquiry.submit.ip"),
        scope: { type: "ip", ipAddress: request.ip },
      }];
      await checkSemanticLimits(request, checks, options.rateLimit);
    }

    const body = request.body as Static<typeof SubmitInquiryBody>;
    const receipt = await submitPublicInquiry(body, options.dependencies());

    noStore(reply);
    // The kind is a bounded label. Nothing the visitor typed is logged.
    request.log.info(
      { event: "public_inquiry.received", result: "success", kind: receipt.kind, inquiryId: receipt.inquiryId },
      "public_inquiry.received");
    options.metrics?.increment(
      "public_inquiry_operations_total", { operation: receipt.kind, result: "success", processRole: "api" });

    return reply.status(201).send({
      inquiryId: receipt.inquiryId,
      kind: receipt.kind,
      receivedAt: new Date(receipt.receivedAt).toISOString(),
    });
  });
}

// ── The reading half: the inbox account, in the authenticated scope ───────

export function registerPublicInquiryInboxRoutes(
  app: FastifyInstance,
  options: PublicInquiryInboxRouteOptions,
): void {
  const actorOf = async (request: FastifyRequest) => {
    const actor = await options.authenticatedUser(request);
    return actor === null
      ? null
      : { actorType: "user" as const, userId: actor.userId, sessionId: actor.sessionId };
  };
  const unauthenticated = (reply: FastifyReply) => reply.status(401).send({
    error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." },
  });

  app.get("/public-inquiries", {
    schema: { querystring: InboxQuery, response: { 200: InboxSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const query = request.query as Static<typeof InboxQuery>;
    const inbox = await listPublicInquiries(actor, { kind: query.kind }, options.dependencies());
    return reply.status(200).send({ inquiries: inbox.inquiries.map(present), counts: { ...inbox.counts } });
  });

  app.get("/public-inquiries/:inquiryId", {
    schema: { params: InquiryParams, response: { 200: InquirySchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await actorOf(request);
    if (actor === null) return unauthenticated(reply);
    const { inquiryId } = request.params as Static<typeof InquiryParams>;
    return reply.status(200).send(present(await getPublicInquiry(actor, inquiryId, options.dependencies())));
  });
}
