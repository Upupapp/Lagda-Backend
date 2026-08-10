// The recipient signing-access surface.
//
//   POST /signing-access/bootstrap      public, credential in the body
//   GET  /signing/context               recipient session cookie
//
// ── Registered OUTSIDE the authenticated scope ─────────────────────────────
//
// Deliberately. A recipient has no LAGDA session, and putting these inside the
// workspace scope would make `requireSession` reject every signer in the world.
// They carry their own credential and their own protections.
//
// ── Why bootstrap is a POST ────────────────────────────────────────────────
//
// Email gateways and link previews fetch links before a human sees them. A GET
// that exchanged a credential would let a scanner authenticate the recipient.
// The emailed link targets a FRONTEND route; nothing changes until this POST.
//
// ── No role, no capability, no membership ──────────────────────────────────
//
// This is the second authentication realm. `WorkspaceAccessContext` does not
// appear in this file and must not.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  bootstrapSigningAccess, resolveRecipientSession,
  SigningLinkInvalidOrExpiredError,
  type SigningAccessDependencies, type RecipientSigningView,
  type RateLimitCheck,
} from "@lagda/application";
import { policyById } from "@lagda/application";
import { checkSemanticLimits, type RateLimitOptions } from "../security/rate-limit-plugin.js";
import {
  RECIPIENT_SESSION_COOKIE_NAME, RECIPIENT_CSRF_COOKIE_NAME,
  recipientSessionCookieOptions, recipientCsrfCookieOptions,
  clearRecipientSessionCookieOptions, clearRecipientCsrfCookieOptions,
} from "../security/cookies.js";
import type { ApiConfig } from "../config/index.js";
import type { MetricsRecorder } from "../observability/metrics.js";

// ── Schemas ─────────────────────────────────────────────────────────────────

/**
 * The bootstrap body: one field, bounded, closed.
 *
 * `additionalProperties: false` rejects every attempt to supply authority:
 * `signingRequestId`, `recipientId`, `workspaceId`, `email`, `recipientEmail`,
 * `authenticationMethod`. All of them are resolved FROM the credential, and a
 * client that could name a recipient could name someone else's.
 *
 * 43 characters exactly — the credential's real encoded length. A wrong length
 * never reaches the digest function.
 */
const BootstrapBodySchema = Type.Object({
  token: Type.String({ minLength: 43, maxLength: 43 }),
}, {
  title: "SigningAccessBootstrapRequest",
  additionalProperties: false,
  description:
    "The bootstrap credential from the emailed signing link. Everything else "
    + "is resolved from it.",
});

/**
 * What bootstrap returns.
 *
 * No raw session token, no CSRF token, no digest, no credential, no workspace
 * id, no recipient id. The cookies carry the credentials; the body carries
 * what a landing page can display.
 */
const BootstrapResponseSchema = Type.Object({
  authenticated: Type.Literal(true),
  signingRequestId: Type.String({ minLength: 1, maxLength: 64 }),
  documentTitle: Type.String(),
  recipientName: Type.String(),
  /** `m***@example.com`. Enough to confirm, not enough to harvest. */
  maskedEmail: Type.String(),
  authenticationMethod: Type.Literal("link-only"),
  authenticatedAt: Type.String({ format: "date-time" }),
}, { title: "SigningAccessBootstrapped", additionalProperties: false });

const ContextResponseSchema = Type.Object({
  authenticated: Type.Literal(true),
  signingRequestId: Type.String({ minLength: 1, maxLength: 64 }),
  authenticationMethod: Type.Literal("link-only"),
}, { title: "RecipientSigningContext", additionalProperties: false });

// ── Options ─────────────────────────────────────────────────────────────────

export interface SigningAccessRouteOptions {
  readonly config: ApiConfig;
  readonly signingAccessDependencies: () => SigningAccessDependencies;
  readonly rateLimit?: RateLimitOptions;
  readonly metrics?: MetricsRecorder;
}

function noStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
  void reply.header("Pragma", "no-cache");
  // A signing page must not leak its URL — which may still carry the token at
  // the moment of the request — to anything it links to.
  void reply.header("Referrer-Policy", "no-referrer");
}

async function limit(
  request: FastifyRequest,
  options: SigningAccessRouteOptions,
  checks: readonly RateLimitCheck[],
): Promise<void> {
  if (options.rateLimit === undefined) return;
  await checkSemanticLimits(request, checks, options.rateLimit);
}

const present = (view: RecipientSigningView) => ({
  authenticated: true as const,
  signingRequestId: view.signingRequestId,
  documentTitle: view.documentTitle,
  recipientName: view.recipientName,
  maskedEmail: view.maskedEmail,
  authenticationMethod: view.authenticationMethod as "link-only",
  authenticatedAt: new Date(view.authenticatedAt).toISOString(),
});

export function registerSigningAccessRoutes(
  app: FastifyInstance,
  options: SigningAccessRouteOptions,
): void {
  const metrics = options.metrics;

  // ── Bootstrap ───────────────────────────────────────────────────────────
  app.post("/signing-access/bootstrap", {
    schema: {
      body: BootstrapBodySchema,
      response: { 200: BootstrapResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);

    // IP is the only scope available: the caller has no account and no
    // session. Token entropy is what makes guessing infeasible — 256 bits —
    // and this bounds volume and gives the attempt a signal.
    await limit(request, options, [{
      policy: policyById("signing-access.bootstrap.ip"),
      scope: { type: "ip", ipAddress: request.ip },
    }]);

    const { token } = request.body as Static<typeof BootstrapBodySchema>;

    let bootstrapped;
    try {
      bootstrapped = await bootstrapSigningAccess(
        token, options.signingAccessDependencies());
    } catch (error) {
      // The failure line carries a bounded reason and NEVER the token, not
      // even truncated — a prefix of a credential is still a credential's
      // prefix.
      request.log.info({
        event: "signing_access.bootstrap_failed",
        result: error instanceof SigningLinkInvalidOrExpiredError
          ? "invalid_or_expired"
          : "not_active",
      }, "signing_access.bootstrap_failed");
      metrics?.increment("signing_access_attempts_total", {
        operation: "bootstrap", result: "denied", processRole: "api",
      });
      throw error;
    }

    // ── Cookies, then the body ────────────────────────────────────────────
    //
    // The session row is already durable — the use case committed before
    // returning — so a cookie that fails to reach the browser leaves an unused
    // session that expires on its own. The reverse order would hand out a
    // credential for a row that might not exist.
    const maxAgeSeconds = Math.max(
      0,
      Math.floor((bootstrapped.credentials.expiresAt - Date.now()) / 1000));
    void reply.setCookie(
      RECIPIENT_SESSION_COOKIE_NAME,
      bootstrapped.credentials.rawSessionToken,
      recipientSessionCookieOptions(options.config, maxAgeSeconds),
    );
    void reply.setCookie(
      RECIPIENT_CSRF_COOKIE_NAME,
      bootstrapped.credentials.rawCsrfToken,
      recipientCsrfCookieOptions(options.config, maxAgeSeconds),
    );

    /**
     * Ids and a method. Never a credential, an address or a title.
     *
     * `signing_access.session_created` is a security event: it records that a
     * recipient authenticated, by which method, at a backend-authoritative
     * time. It does NOT record that they viewed, consented or signed — none of
     * which has happened.
     */
    request.log.info({
      event: "signing_access.session_created",
      result: "success",
      signingRequestId: bootstrapped.context.signingRequestId,
      recipientId: bootstrapped.context.recipientId,
      authenticationMethod: bootstrapped.context.authenticationMethod,
    }, "signing_access.session_created");

    metrics?.increment("signing_access_attempts_total", {
      operation: "bootstrap", result: "success", processRole: "api",
    });

    return reply.status(200).send(present(bootstrapped.view));
  });

  // ── Context ─────────────────────────────────────────────────────────────
  //
  // The minimum a frontend needs to know it is authenticated. NOT the
  // ceremony: the document, the fields and the routing state are BACKEND-35's,
  // and returning them here would make this endpoint the ceremony by accident.
  app.get("/signing/context", {
    schema: { response: { 200: ContextResponseSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);

    const raw = request.cookies[RECIPIENT_SESSION_COOKIE_NAME];
    if (raw === undefined) return recipientUnauthenticated(reply, options.config);

    const context = await resolveRecipientSession(
      raw, options.signingAccessDependencies());

    // Reads are not logged. A signing page polls this.
    return reply.status(200).send({
      authenticated: true as const,
      signingRequestId: context.signingRequestId,
      authenticationMethod: context.authenticationMethod as "link-only",
    });
  });
}

/**
 * The recipient realm's 401.
 *
 * A DIFFERENT code from the workspace realm's `AUTHENTICATION_REQUIRED`, so a
 * frontend cannot mistake "your signing session ended" for "sign in to LAGDA"
 * and send a recipient to a login page they have no account for.
 *
 * Both cookies are cleared: leaving a dead session cookie in place means every
 * subsequent request pays a database lookup to be told the same thing.
 */
function recipientUnauthenticated(
  reply: FastifyReply, config: ApiConfig,
): FastifyReply {
  void reply.clearCookie(
    RECIPIENT_SESSION_COOKIE_NAME, clearRecipientSessionCookieOptions(config));
  void reply.clearCookie(
    RECIPIENT_CSRF_COOKIE_NAME, clearRecipientCsrfCookieOptions(config));
  return reply.status(401).send({
    error: {
      code: "RECIPIENT_AUTHENTICATION_REQUIRED",
      message: "Open your signing link again to continue.",
    },
  });
}
