// The ready-made template library (093's Personal feature).
//
//   GET /ready-made-templates/catalog               every document WITHOUT its text
//   GET /workspaces/:workspaceId/ready-made-templates   the full library
//
// The catalogue is what a Free account's gallery shows under its frosted
// cover: titles, categories and signing roles, and not one word of any
// document. The full library goes only to a MEMBER of a workspace whose owner
// is on Personal or higher — checked here on every request, so a Free account
// cannot obtain the text however it calls the API. The web app bundles none
// of it.
//
// Registered inside the authenticated scope: both need a session.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  requireMemberOfPlanWorkspace,
  type PlanReadDependencies, type SessionId, type UserId,
} from "@lagda/application";
import type { WorkspaceId } from "@lagda/contracts";
import { READY_MADE_LIBRARY, type ReadyMadeLibrary } from "./library.js";

export interface ReadyMadeRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly dependencies: () => PlanReadDependencies;
  /** For tests: another library. */
  readonly library?: ReadyMadeLibrary;
}

const Step = Type.Object({
  step: Type.Integer(),
  role: Type.String(),
  action_type: Type.String(),
}, { additionalProperties: false });

const CatalogDocument = Type.Object({
  document_type: Type.String(),
  title: Type.String(),
  signing_workflow: Type.Array(Step),
}, { additionalProperties: false });

const FullDocument = Type.Object({
  document_type: Type.String(),
  title: Type.String(),
  body_content: Type.String(),
  signing_workflow: Type.Array(Step),
}, { additionalProperties: false });

const library = <T extends ReturnType<typeof Type.Object>>(doc: T) => Type.Object({
  categories: Type.Array(Type.Object({
    category: Type.String(),
    documents: Type.Array(doc),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const CatalogSchema = library(CatalogDocument);
const LibrarySchema = library(FullDocument);
const WorkspaceParams = Type.Object({ workspaceId: Type.String({ minLength: 1, maxLength: 64 }) });

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({
    error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." },
  });
}

/** The catalogue: the same shape, field by field, with every document's text left out. */
export function catalogOf(source: ReadyMadeLibrary): Static<typeof CatalogSchema> {
  return {
    categories: source.categories.map(c => ({
      category: c.category,
      documents: c.documents.map(d => ({
        document_type: d.document_type,
        title: d.title,
        signing_workflow: d.signing_workflow.map(s => ({ step: s.step, role: s.role, action_type: s.action_type })),
      })),
    })),
  };
}

export function registerReadyMadeRoutes(app: FastifyInstance, options: ReadyMadeRouteOptions): void {
  const source = options.library ?? READY_MADE_LIBRARY;
  const catalog = catalogOf(source);

  app.get("/ready-made-templates/catalog", {
    schema: { response: { 200: CatalogSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);
    void reply.header("Cache-Control", "private, max-age=300");
    return reply.status(200).send(catalog);
  });

  app.get("/workspaces/:workspaceId/ready-made-templates", {
    schema: { params: WorkspaceParams, response: { 200: LibrarySchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);
    const { workspaceId } = request.params as Static<typeof WorkspaceParams>;
    await requireMemberOfPlanWorkspace(
      { actorType: "user", userId: actor.userId, sessionId: actor.sessionId },
      workspaceId as WorkspaceId, "personal", "Ready-made templates", options.dependencies());
    // Never cached: a lapsed plan must stop receiving it on the next read.
    void reply.header("Cache-Control", "no-store");
    return reply.status(200).send(source);
  });
}
