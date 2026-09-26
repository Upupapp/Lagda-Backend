// Verify Document participant access by emailed code (083). Replaces
// OD-135's email-only unlock.
//
//   POST /public/verifications/:verificationId/access-code  {email}         202, always
//   POST /public/verifications/:verificationId/access       {email, code}   200 grant | 401
//   POST /public/verifications/:verificationId/details      {accessToken}   200 details | 401
//   POST /public/verifications/:verificationId/document     {accessToken}   200 PDF | 401
//   POST /verifications/:verificationId/member-access        (session+CSRF)  200 grant | 401
//
// A deliberate SECOND surface from `public-verification-routes.ts`, whose own
// header states an invariant ("no route in this file returns document bytes")
// this feature exists specifically to cross.
//
// ── What changed from OD-135 ────────────────────────────────────────────────
//
// Knowing a participant's address used to be the whole proof. It no longer
// unlocks anything: `{email}` alone only ever asks for a code, and the answer
// to that is the same 202 whether or not the address is on the document. The
// document and details routes accept nothing but an access grant.
//
// ── Still no oracle ─────────────────────────────────────────────────────────
//
// Every negative — unknown reference, not completed, no such participant,
// wrong, expired, consumed or exhausted code, unknown, expired or
// other-document grant — is one 401 `verification_access_denied`.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { Type, type Static } from "@sinclair/typebox";
import {
  requestVerificationAccessCode, redeemVerificationAccessCode,
  getVerificationAccessDetails, resolveVerificationAccessDocument,
  grantMemberVerificationAccess, policyById,
  MAX_EMAIL_LENGTH,
  type VerificationAccessDependencies, type VerificationAccessResult, type RateLimitCheck,
} from "@lagda/application";
import type { UserId } from "@lagda/contracts";
import { checkSemanticLimits, type RateLimitOptions } from "../security/rate-limit-plugin.js";
import type { MetricsRecorder } from "../observability/metrics.js";

const ParamsSchema = Type.Object({
  verificationId: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });

const EmailSchema = Type.String({ minLength: 1, maxLength: MAX_EMAIL_LENGTH });

const AccessCodeBodySchema = Type.Object({
  email: EmailSchema,
}, {
  title: "VerificationAccessCodeRequest",
  additionalProperties: false,
  description: "Asks for a six-digit code for this completed document. The "
    + "answer is identical whether or not the address is a participant.",
});

const AccessCodeSentSchema = Type.Object({
  sent: Type.Literal(true),
  expiresInSeconds: Type.Integer(),
}, { title: "VerificationAccessCodeSent", additionalProperties: false });

const AccessBodySchema = Type.Object({
  email: EmailSchema,
  code: Type.String({ minLength: 1, maxLength: 16 }),
}, {
  title: "VerificationAccessRequest",
  additionalProperties: false,
  description: "The emailed code and the address it was sent to.",
});

const GrantBodySchema = Type.Object({
  accessToken: Type.String({ minLength: 1, maxLength: 128 }),
}, {
  title: "VerificationAccessGrantRequest",
  additionalProperties: false,
  description: "An access token from a granted /access or /member-access call.",
});

const DetailsSchema = Type.Object({
  documentTitle: Type.String(),
  completedAt: Type.Number(),
  /** SHA-256 hex of the sealed file. */
  sealedDigest: Type.String(),
  participants: Type.Array(Type.Object({
    name: Type.String(),
    maskedEmail: Type.String(),
    recipientType: Type.String(),
    status: Type.Union([
      Type.Literal("signed"), Type.Literal("approved"), Type.Literal("declined"),
      Type.Literal("skipped"), Type.Literal("viewed"), Type.Literal("no-action"),
    ]),
    actedAt: Type.Union([Type.Number(), Type.Null()]),
    routingOrder: Type.Integer(),
  }, { additionalProperties: false })),
  events: Type.Array(Type.Object({
    type: Type.String(),
    label: Type.String(),
    at: Type.Number(),
  }, { additionalProperties: false })),
}, { title: "VerificationAccessDetails", additionalProperties: false });

const GrantedSchema = Type.Object({
  outcome: Type.Literal("granted"),
  accessToken: Type.String(),
  expiresAt: Type.Number(),
  documentTitle: Type.String(),
  /** Display only. Not a capability — every role reaches this the same way. */
  recipientType: Type.String(),
  details: DetailsSchema,
}, { title: "VerificationAccessGranted", additionalProperties: false });

const DetailsResponseSchema = Type.Object({
  details: DetailsSchema,
}, { title: "VerificationAccessDetailsResponse", additionalProperties: false });

const DENIED = {
  error: {
    code: "verification_access_denied",
    message: "That reference, email and code do not unlock a completed LAGDA document.",
  },
} as const;

type PublicPolicy =
  | "public-verification.access-code.ip"
  | "public-verification.access.ip"
  | "public-verification.document.ip";

export interface PublicParticipantRouteOptions {
  readonly deps: () => VerificationAccessDependencies;
  readonly metrics: MetricsRecorder;
  readonly rateLimit?: RateLimitOptions;
}

function ipCheck(request: FastifyRequest, policy: PublicPolicy): RateLimitCheck {
  return { policy: policyById(policy), scope: { type: "ip", ipAddress: request.ip } };
}

function limits(
  request: FastifyRequest,
  checks: readonly RateLimitCheck[],
  rateLimit: RateLimitOptions | undefined,
): Promise<void> {
  if (rateLimit === undefined) return Promise.resolve();
  return checkSemanticLimits(request, checks, rateLimit);
}

function sendGranted(reply: FastifyReply, result: VerificationAccessResult): FastifyReply {
  if (result.outcome === "denied") return reply.code(401).send(DENIED);
  return reply.code(200).send({
    outcome: "granted",
    accessToken: result.accessToken,
    expiresAt: result.expiresAt,
    documentTitle: result.documentTitle,
    recipientType: result.recipientType,
    details: result.details,
  });
}

export function registerPublicParticipantRoutes(
  app: FastifyInstance,
  options: PublicParticipantRouteOptions,
): void {
  app.post("/public/verifications/:verificationId/access-code", {
    schema: {
      params: ParamsSchema,
      body: AccessCodeBodySchema,
      response: { 202: AccessCodeSentSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    void reply.header("Cache-Control", "no-store");
    const { verificationId } = request.params as Static<typeof ParamsSchema>;
    const { email } = request.body as Static<typeof AccessCodeBodySchema>;
    await limits(request, [
      ipCheck(request, "public-verification.access-code.ip"),
      {
        policy: policyById("public-verification.access-code.participant"),
        // Self-declared, so an abuse bucket only; digested before storage.
        scope: {
          type: "account",
          accountKey: `verification-access:${verificationId.trim()}:${email.trim().toLowerCase()}`,
        },
      },
    ], options.rateLimit);

    const result = await requestVerificationAccessCode(verificationId, email, options.deps());
    options.metrics.increment("public_verification_access_total", {
      result: "requested", mode: "access-code",
    });
    return reply.code(202).send(result);
  });

  app.post("/public/verifications/:verificationId/access", {
    schema: {
      params: ParamsSchema,
      body: AccessBodySchema,
      response: { 200: GrantedSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    void reply.header("Cache-Control", "no-store");
    await limits(request, [ipCheck(request, "public-verification.access.ip")], options.rateLimit);
    const { verificationId } = request.params as Static<typeof ParamsSchema>;
    const { email, code } = request.body as Static<typeof AccessBodySchema>;

    const result = await redeemVerificationAccessCode(verificationId, email, code, options.deps());
    options.metrics.increment("public_verification_access_total", {
      result: result.outcome, mode: "access",
    });
    return sendGranted(reply, result);
  });

  app.post("/public/verifications/:verificationId/details", {
    schema: {
      params: ParamsSchema,
      body: GrantBodySchema,
      response: { 200: DetailsResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    void reply.header("Cache-Control", "no-store");
    await limits(request, [ipCheck(request, "public-verification.document.ip")], options.rateLimit);
    const { verificationId } = request.params as Static<typeof ParamsSchema>;
    const { accessToken } = request.body as Static<typeof GrantBodySchema>;

    const result = await getVerificationAccessDetails(verificationId, accessToken, options.deps());
    options.metrics.increment("public_verification_access_total", {
      result: result.outcome, mode: "details",
    });
    if (result.outcome === "denied") return reply.code(401).send(DENIED);
    return reply.code(200).send({ details: result.details });
  });

  app.post("/public/verifications/:verificationId/document", {
    schema: {
      params: ParamsSchema,
      body: GrantBodySchema,
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    void reply.header("Cache-Control", "no-store");
    await limits(request, [ipCheck(request, "public-verification.document.ip")], options.rateLimit);
    const { verificationId } = request.params as Static<typeof ParamsSchema>;
    const { accessToken } = request.body as Static<typeof GrantBodySchema>;

    const result = await resolveVerificationAccessDocument(
      verificationId, accessToken, options.deps());
    options.metrics.increment("public_verification_access_total", {
      result: result.outcome, mode: "document",
    });
    if (result.outcome === "denied") return reply.code(401).send(DENIED);

    void reply.header("Content-Type", result.document.mediaType);
    void reply.header("Content-Length", String(result.document.sizeBytes));
    void reply.header("Content-Disposition", "inline");
    void reply.header("Accept-Ranges", "none");
    return reply.status(200).send(Readable.from(result.document.stream));
  });
}

// ── Signed-in participants ───────────────────────────────────────────────────

export interface MemberVerificationAccessRouteOptions {
  readonly authenticatedUser: (request: FastifyRequest) => Promise<{
    readonly userId: UserId;
  } | null>;
  readonly deps: () => VerificationAccessDependencies;
  readonly metrics: MetricsRecorder;
  readonly rateLimit?: RateLimitOptions;
}

/**
 * Registered INSIDE the session + CSRF scope. A signed-in account whose
 * VERIFIED email is a participant gets a grant with no code; anything else is
 * the same 401 the public routes give, and the page falls back to the code.
 */
export function registerMemberVerificationAccessRoute(
  scope: FastifyInstance,
  options: MemberVerificationAccessRouteOptions,
): void {
  scope.post("/verifications/:verificationId/member-access", {
    schema: {
      params: ParamsSchema,
      response: { 200: GrantedSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    void reply.header("Cache-Control", "no-store");
    const who = await options.authenticatedUser(request);
    if (who === null) return reply.code(401).send(DENIED);
    await limits(request, [{
      policy: policyById("verification.member-access.user"),
      scope: { type: "user", userId: who.userId },
    }], options.rateLimit);
    const { verificationId } = request.params as Static<typeof ParamsSchema>;

    const result = await grantMemberVerificationAccess(who.userId, verificationId, options.deps());
    options.metrics.increment("public_verification_access_total", {
      result: result.outcome, mode: "member-access",
    });
    return sendGranted(reply, result);
  });
}
