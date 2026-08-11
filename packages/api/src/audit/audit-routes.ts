// The private signing audit trail (BACKEND-43 §111, §112).
//
//   GET /workspaces/:workspaceId/signing-requests/:signingRequestId/audit
//
// ── One verb, and nothing else ─────────────────────────────────────────────
//
// §112 and §277/§278: no POST, PATCH or DELETE exists here, and none may be
// added. Evidence is append-oriented and only a domain transition may append —
// an HTTP endpoint that could write to a legal record puts event semantics one
// controller away from a request body.
//
// The route also writes nothing itself (§197). Reading a history does not make
// the reader a participant in the signing, and a "you viewed the audit" event
// would be a fact about a workspace user in a record about a transaction.
//
// ── Not the public verification surface ────────────────────────────────────
//
// §109, §239, §287. That one is reachable with no credential and returns a
// deliberately tiny projection keyed by VerificationId. This one requires a
// workspace session and a capability, and returns a different, larger shape. A
// VerificationId cannot reach this route: there is no path here that accepts
// one, and the workspace and request ids are what this route is keyed by.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  getSigningRequestAuditTrail, type AuditTrailDependencies,
} from "@lagda/application";
import type { WorkspaceId } from "@lagda/contracts";
import type { SigningRequestId } from "@lagda/application";

const AuditParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  signingRequestId: Type.String({ minLength: 1, maxLength: 64 }),
});

/**
 * The response, stated as a closed schema.
 *
 * §201, §276: the schema is a security boundary, not documentation. A field
 * added to the projection without being added here is stripped at the wire
 * rather than published — which is what stops an internal id from reaching a
 * client the first time someone widens the view type.
 */
const AuditActorSchema = Type.Object({
  type: Type.Union([
    Type.Literal("workspace-user"), Type.Literal("recipient"), Type.Literal("system"),
  ]),
  displayName: Type.String(),
  // Present only for recipients. Never `actorUserId` (§204) — a workspace
  // user's identity is not something the timeline needs to expose.
  recipientId: Type.Optional(Type.String()),
}, { additionalProperties: false });

const AuditDetailsSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("authentication"), method: Type.String(),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("consent"),
    consentType: Type.String(),
    consentVersion: Type.String(),
  }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("none") }, { additionalProperties: false }),
]);

const AuditEntrySchema = Type.Object({
  id: Type.String(),
  type: Type.String(),
  eventVersion: Type.Number(),
  occurredAt: Type.String(),
  actor: AuditActorSchema,
  description: Type.String(),
  details: AuditDetailsSchema,
}, { additionalProperties: false });

const AuditTrailSchema = Type.Object({
  signingRequestId: Type.String(),
  state: Type.String(),
  entries: Type.Array(AuditEntrySchema),
}, { additionalProperties: false });

export interface AuditRouteOptions {
  readonly auditDependencies: () => AuditTrailDependencies;
  readonly actorOf: (request: FastifyRequest) => Promise<{ userId: string } | null>;
  readonly unauthenticated: (reply: FastifyReply) => FastifyReply;
  readonly noStore: (reply: FastifyReply) => void;
}

export function registerAuditRoutes(
  app: FastifyInstance,
  options: AuditRouteOptions,
): void {
  app.get("/workspaces/:workspaceId/signing-requests/:signingRequestId/audit", {
    schema: {
      params: AuditParamsSchema,
      response: { 200: AuditTrailSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    options.noStore(reply);
    const actor = await options.actorOf(request);
    if (actor === null) return options.unauthenticated(reply);

    const { workspaceId, signingRequestId } =
      request.params as Static<typeof AuditParamsSchema>;

    // Authorization, tenancy and request scoping ALL happen in the use case,
    // inside the transaction (§96, §99, §101). The route performs no role
    // check of its own — §283 forbids one, and a check here would run outside
    // the transaction that reads the membership.
    //
    // A request in another workspace, or one that does not exist, raises the
    // same hidden 404 as everywhere else (§102). The route does not
    // distinguish them because it never learns the difference.
    const trail = await getSigningRequestAuditTrail({
      actor: actor as never,
      workspaceId: workspaceId as WorkspaceId,
      signingRequestId: signingRequestId as SigningRequestId,
    }, options.auditDependencies());

    // No metric or log line carries the request id, the event ids or a
    // recipient id (§112, §195, §196). Reads are not logged at all, matching
    // the signing-request read route: a sender refreshing a page would
    // otherwise produce a line per refresh.
    return reply.status(200).send(trail);
  });
}
