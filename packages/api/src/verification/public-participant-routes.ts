// The email-gated document view (OD-135).
//
//   POST /public/verifications/:verificationId/access     no credential
//   POST /public/verifications/:verificationId/document   no credential
//
// A deliberate SECOND surface from `public-verification-routes.ts`, not an
// addition to it — that file's own header states an invariant ("no route in
// this file returns document bytes") this feature exists specifically to
// cross. Splitting the file is what keeps that invariant honest rather than
// stale.
//
// ── Still no credential, and still no oracle ────────────────────────────────
//
// No account, no session, no signing link — the same "nothing but an
// identifier" shape as ID lookup, plus one more identifier: the email the
// caller claims to hold. Both routes collapse every negative case — unknown
// reference, not completed, no participant at that address — into one
// generic denial, for the same reason the plain lookup does: distinguishing
// them is an oracle for someone else's document or someone else's address.
//
// ── Why the email is resubmitted on the second call ─────────────────────────
//
// There is no session and no token minted by `/access`. `/document` re-proves
// the SAME match from scratch. That costs one extra database round trip per
// legitimate view and removes an entire credential type — mint, store,
// expire, revoke — that a stolen or replayed token would otherwise be.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { Type, type Static } from "@sinclair/typebox";
import {
  verifyParticipantAccess, resolveParticipantDocument, policyById,
  MAX_EMAIL_LENGTH,
  type ParticipantDocumentDependencies, type RateLimitCheck,
} from "@lagda/application";
import { checkSemanticLimits, type RateLimitOptions } from "../security/rate-limit-plugin.js";
import type { MetricsRecorder } from "../observability/metrics.js";

const ParamsSchema = Type.Object({
  verificationId: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });

const AccessBodySchema = Type.Object({
  email: Type.String({ minLength: 1, maxLength: MAX_EMAIL_LENGTH }),
}, {
  title: "VerificationAccessRequest",
  additionalProperties: false,
  description: "The email of a participant on the completed document this "
    + "verification ID names. No password: possession of the address is the "
    + "whole proof, exactly as it is for the completion-copy email itself.",
});

const AccessResponseSchema = Type.Object({
  outcome: Type.Literal("granted"),
  documentTitle: Type.String(),
  /** Display only. Not a capability — every role reaches this the same way. */
  recipientType: Type.String(),
}, { title: "VerificationAccessGranted", additionalProperties: false });

const DENIED = {
  error: {
    code: "verification_access_denied",
    message: "That reference and email do not match a completed LAGDA document.",
  },
} as const;

export interface PublicParticipantRouteOptions {
  readonly deps: () => ParticipantDocumentDependencies;
  readonly metrics: MetricsRecorder;
  readonly rateLimit?: RateLimitOptions;
}

function limits(
  request: FastifyRequest,
  policy: "public-verification.access.ip" | "public-verification.document.ip",
  options: PublicParticipantRouteOptions,
): Promise<void> {
  if (options.rateLimit === undefined) return Promise.resolve();
  const checks: RateLimitCheck[] = [{
    policy: policyById(policy),
    scope: { type: "ip", ipAddress: request.ip },
  }];
  return checkSemanticLimits(request, checks, options.rateLimit);
}

export function registerPublicParticipantRoutes(
  app: FastifyInstance,
  options: PublicParticipantRouteOptions,
): void {
  app.post("/public/verifications/:verificationId/access", {
    schema: {
      params: ParamsSchema,
      body: AccessBodySchema,
      response: { 200: AccessResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    void reply.header("Cache-Control", "no-store");
    await limits(request, "public-verification.access.ip", options);

    const { verificationId } = request.params as Static<typeof ParamsSchema>;
    const { email } = request.body as Static<typeof AccessBodySchema>;

    const result = await verifyParticipantAccess(verificationId, email, options.deps());

    options.metrics.increment("public_verification_access_total", {
      result: result.outcome, mode: "access",
    });

    if (result.outcome === "denied") {
      return reply.code(401).send(DENIED);
    }
    return reply.code(200).send({
      outcome: "granted",
      documentTitle: result.documentTitle,
      recipientType: result.recipientType,
    });
  });

  app.post("/public/verifications/:verificationId/document", {
    schema: {
      params: ParamsSchema,
      body: AccessBodySchema,
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    void reply.header("Cache-Control", "no-store");
    await limits(request, "public-verification.document.ip", options);

    const { verificationId } = request.params as Static<typeof ParamsSchema>;
    const { email } = request.body as Static<typeof AccessBodySchema>;

    const result = await resolveParticipantDocument(verificationId, email, options.deps());

    options.metrics.increment("public_verification_access_total", {
      result: result.outcome, mode: "document",
    });

    if (result.outcome === "denied") {
      return reply.code(401).send(DENIED);
    }

    void reply.header("Content-Type", result.document.mediaType);
    void reply.header("Content-Length", String(result.document.sizeBytes));
    void reply.header("Content-Disposition", "inline");
    void reply.header("Accept-Ranges", "none");
    return reply.status(200).send(Readable.from(result.document.stream));
  });
}
