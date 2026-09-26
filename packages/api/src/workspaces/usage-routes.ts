// Workspace usage summary.
//
//   GET /workspaces/:workspaceId/usage     any member (`workspace.view`)
//
// Registered inside the authenticated scope. Counts only: no name, address or
// document title is in the response, and every number is the workspace's own.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  getWorkspaceUsage,
  type WorkspaceUsageDependencies, type AuthenticatedActor, type SessionId, type UserId,
} from "@lagda/application";
import type { WorkspaceId } from "@lagda/contracts";

const Params = Type.Object({ workspaceId: Type.String({ minLength: 1, maxLength: 64 }) });

const Count = Type.Integer({ minimum: 0 });

export const WorkspaceUsageSchema = Type.Object({
  /**
   * The current calendar month in UTC, epoch ms. `start` is its first
   * millisecond and `end` its last, both inclusive.
   */
  period: Type.Object({
    start: Type.Integer(),
    end: Type.Integer(),
  }, { additionalProperties: false }),
  documents: Type.Object({
    /** Documents not deleted. */
    total: Count,
    /** Documents created in the period. */
    uploadedThisMonth: Count,
  }, { additionalProperties: false }),
  signingRequests: Type.Object({
    sentThisMonth: Count,
    sentTotal: Count,
    /** Sent, partially completed, or completing. */
    inProgress: Count,
    completedThisMonth: Count,
    completedTotal: Count,
  }, { additionalProperties: false }),
  members: Count,
  /** Workflow templates. */
  templates: Count,
  /** Unarchived contacts the caller can see (shared, plus their own personal ones). */
  contacts: Count,
  /** Always 0 today: public verification lookups are not recorded. */
  verificationsThisMonth: Count,
  /** Sum of stored document artifact sizes, in bytes. */
  storageBytes: Count,
}, { title: "WorkspaceUsage", additionalProperties: false });

export interface UsageRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId; readonly sessionId: SessionId;
  } | null>;
  readonly dependencies: () => WorkspaceUsageDependencies;
}

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({ error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." } });
}

export function registerUsageRoutes(app: FastifyInstance, options: UsageRouteOptions): void {
  app.get("/workspaces/:workspaceId/usage", {
    schema: { params: Params, response: { 200: WorkspaceUsageSchema } },
  }, async (request, reply) => {
    void reply.header("Cache-Control", "no-store");
    const who = await options.authenticatedUser(request);
    if (who === null) return unauthenticated(reply);
    const actor: AuthenticatedActor = { actorType: "user", userId: who.userId, sessionId: who.sessionId };
    const workspaceId = (request.params as Static<typeof Params>).workspaceId as WorkspaceId;
    return reply.status(200).send(await getWorkspaceUsage(actor, workspaceId, options.dependencies()));
  });
}
