// The sender cancellation surface (OD-154).
//
//   POST /workspaces/:workspaceId/signing-requests/:signingRequestId/cancel
//
// One route, one verb, and never a DELETE. Cancelling does not remove the
// request — it ends it, and the request, its recipients, its fields and every
// signature already collected all survive. A DELETE would say the opposite.
//
// ── No role appears in this file ───────────────────────────────────────────
//
// The handler validates shape and identity and calls the use case. Whether the
// actor may cancel is `signing-request.cancel`, asked for inside the mutation
// transaction — because a sender demoted a moment ago must not withdraw a
// document under authority they have lost.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  cancelSigningRequest,
  type SigningWorkflowDependencies,
  type RateLimitCheck, type SessionId, type UserId,
} from "@lagda/application";
import { policyById } from "@lagda/application";
import {
  CancelSigningRequestBodySchema, CancelSigningRequestResponseSchema,
  type WorkspaceId,
} from "@lagda/contracts";
import { checkSemanticLimits, type RateLimitOptions } from "../security/rate-limit-plugin.js";
import type { MetricsRecorder } from "../observability/metrics.js";

const CancelParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  signingRequestId: Type.String({ minLength: 1, maxLength: 64 }),
});

export interface CancelRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly workflowDependencies: () => SigningWorkflowDependencies;
  readonly rateLimit?: RateLimitOptions;
  readonly metrics?: MetricsRecorder;
}

export function registerCancelRoutes(
  app: FastifyInstance,
  options: CancelRouteOptions,
): void {
  const metrics = options.metrics;

  app.post("/workspaces/:workspaceId/signing-requests/:signingRequestId/cancel", {
    schema: {
      params: CancelParamsSchema,
      body: CancelSigningRequestBodySchema,
      response: { 200: CancelSigningRequestResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    void reply.header("Cache-Control", "no-store");
    void reply.header("Pragma", "no-cache");

    const actor = await options.authenticatedUser(request);
    if (actor === null) {
      return reply.status(401).send({
        error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." },
      });
    }

    const { workspaceId, signingRequestId } =
      request.params as Static<typeof CancelParamsSchema>;
    const body = request.body as Static<typeof CancelSigningRequestBodySchema>;

    if (options.rateLimit !== undefined) {
      const checks: readonly RateLimitCheck[] = [{
        policy: policyById("signing-request.send.user"),
        scope: { type: "user", userId: actor.userId },
      }];
      await checkSemanticLimits(request, checks, options.rateLimit);
    }

    const result = await cancelSigningRequest({
      actor: { actorType: "user", userId: actor.userId, sessionId: actor.sessionId },
      workspaceId: workspaceId as WorkspaceId,
      signingRequestId,
      reason: body.reason,
    }, options.workflowDependencies());

    // Counts, and the request id. NEVER the reason: it is the sender's own
    // words about their document, and a log line is not where it belongs
    // (§197). Never the revoked recipients either.
    request.log.info({
      event: "signing_request.cancelled",
      signingRequestId: result.signingRequestId,
      revokedGrantCount: result.revokedGrantCount,
      revokedSessionCount: result.revokedSessionCount,
    }, "signing_request.cancelled");
    metrics?.increment("signing_request_cancellations_total", {
      result: "cancelled", processRole: "api",
    });

    return reply.status(200).send(result);
  });
}
