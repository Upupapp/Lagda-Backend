// The send surface.
//
//   POST /workspaces/:workspaceId/signing-requests/:signingRequestId/send
//
// One route, one verb. Never a GET: sending is the least idempotent-looking
// side effect in the product, and a link or a prefetch must not be able to
// trigger it.
//
// ── 200, not 202 ───────────────────────────────────────────────────────────
//
// 202 would say "accepted for processing", which is true of the EMAIL and
// false of the thing this route actually did. The workflow transition is
// complete and committed when the response is written; only provider delivery
// is asynchronous, and the response never claims delivery either way.
//
// The body carries the meaning. `state: "sent"` and a `sentAt` say the request
// was committed; nothing in it says an email arrived.
//
// ── No role appears in this file ───────────────────────────────────────────

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  sendSigningRequest, assertValidKey,
  type SendSigningRequestDependencies, type SigningRequestSentView,
  type RateLimitCheck, type SessionId, type UserId,
} from "@lagda/application";
import { policyById } from "@lagda/application";
import {
  IDEMPOTENCY_KEY_HEADER,
  type WorkspaceId,
} from "@lagda/contracts";
import { checkSemanticLimits, type RateLimitOptions } from "../security/rate-limit-plugin.js";
import type { MetricsRecorder } from "../observability/metrics.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

const SendParamsSchema = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 64 }),
  signingRequestId: Type.String({ minLength: 1, maxLength: 64 }),
});

/**
 * The send body: empty, and closed.
 *
 * Rejected with 422 rather than ignored:
 *
 *   state, sentAt              the server decides both
 *   recipientIds, activate…    routing policy decides who activates (§226)
 *   fields, sourceArtifactId   the snapshot decides
 *   accessToken                credentials are minted, never supplied
 *   subject, message           the product has no send screen; BACKEND-46
 *   expiresAt, reminders       BACKEND-46
 *
 * There is nothing to configure at send time because the product configures
 * nothing at send time. An empty body is the honest contract.
 */
const SendRequestBodySchema = Type.Object({}, {
  title: "SendSigningRequestRequest",
  additionalProperties: false,
  description:
    "Deliberately empty. Everything sent is determined by the immutable "
    + "request snapshot and by routing policy.",
});

const SentResponseSchema = Type.Object({
  signingRequestId: Type.String({ minLength: 1, maxLength: 64 }),
  state: Type.Literal("sent"),
  sentAt: Type.String({ format: "date-time" }),
  /** Counts, never who. */
  activatedRecipientCount: Type.Integer({ minimum: 0 }),
  waitingRecipientCount: Type.Integer({ minimum: 0 }),
}, { title: "SigningRequestSent", additionalProperties: false });

// ── Options ─────────────────────────────────────────────────────────────────

export interface SendRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
    readonly sessionId: SessionId;
  } | null>;
  readonly sendDependencies: () => SendSigningRequestDependencies;
  /**
   * Send triggers outbound email, amplified by recipient count. The check runs
   * BEFORE any credential is generated (§204).
   */
  readonly rateLimit?: RateLimitOptions;
  readonly metrics?: MetricsRecorder;
}

function noStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
  void reply.header("Pragma", "no-cache");
}

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({
    error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." },
  });
}

async function limit(
  request: FastifyRequest,
  options: SendRouteOptions,
  checks: readonly RateLimitCheck[],
): Promise<void> {
  if (options.rateLimit === undefined) return;
  await checkSemanticLimits(request, checks, options.rateLimit);
}

const present = (sent: SigningRequestSentView) => ({
  signingRequestId: sent.signingRequestId,
  state: sent.state,
  sentAt: new Date(sent.sentAt).toISOString(),
  activatedRecipientCount: sent.activatedRecipientCount,
  waitingRecipientCount: sent.waitingRecipientCount,
});

export function registerSendRoutes(
  app: FastifyInstance,
  options: SendRouteOptions,
): void {
  const metrics = options.metrics;

  app.post("/workspaces/:workspaceId/signing-requests/:signingRequestId/send", {
    schema: {
      params: SendParamsSchema,
      body: SendRequestBodySchema,
      response: { 200: SentResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    const actor = await options.authenticatedUser(request);
    if (actor === null) return unauthenticated(reply);

    const { workspaceId, signingRequestId } =
      request.params as Static<typeof SendParamsSchema>;

    // Abuse control BEFORE anything expensive. A send can mint up to 50 bearer
    // credentials and 50 delivery intents; the cheap check comes first.
    await limit(request, options, [
      {
        policy: policyById("signing-request.send.user"),
        scope: { type: "user", userId: actor.userId },
      },
      {
        policy: policyById("signing-request.send.workspace"),
        scope: { type: "workspace", workspaceId: workspaceId as WorkspaceId },
      },
    ]);

    // Required. A double click or a lost response must not re-invite anyone.
    const key = assertValidKey(
      request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()] as string | undefined);

    const sent = await sendSigningRequest({
      actor: { actorType: "user", userId: actor.userId, sessionId: actor.sessionId },
      workspaceId: workspaceId as WorkspaceId,
      signingRequestId,
      idempotencyKey: key,
    }, options.sendDependencies());

    /**
     * COUNTS and ids. Never a recipient, a credential or a link.
     *
     * A send log line is the most sensitive one in the product: it names a
     * moment when specific people were asked to sign a specific agreement.
     * What it carries is how MANY and what SHAPE — enough to answer "are sends
     * working, and is sequential routing being used" and nothing that
     * identifies anyone.
     *
     * `signing_request.sent` is a security event, not merely telemetry: it
     * records that a sender committed a workflow. It does NOT prove any
     * recipient received anything, and the event name deliberately does not
     * say "delivered".
     */
    request.log.info({
      event: "signing_request.sent",
      result: "success",
      workspaceId,
      signingRequestId: sent.signingRequestId,
      actorUserId: actor.userId,
      activatedRecipientCount: sent.activatedRecipientCount,
      waitingRecipientCount: sent.waitingRecipientCount,
    }, "signing_request.sent");

    metrics?.increment("signing_request_send_results_total", {
      result: "success",
      // Bounded: parallel, sequential or mixed. Derived from the snapshot by
      // the domain, not guessed here — a count cannot tell sequential from
      // mixed. Not a cohort number and not a recipient count, either of which
      // would be an unbounded label.
      routingShape: sent.routingShape,
      processRole: "api",
    });

    // 200. The workflow transition is complete; only provider delivery is
    // asynchronous, and nothing here claims otherwise.
    return reply.status(200).send(present(sent));
  });
}
