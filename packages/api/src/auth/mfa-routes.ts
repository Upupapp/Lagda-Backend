// Multi-factor authentication routes.
//
//   POST /auth/mfa/verify     complete a login ceremony  (pre-auth cookie)
//   POST /auth/mfa/enroll     begin TOTP enrolment       (full session + CSRF)
//   POST /auth/mfa/confirm    finish enrolment           (full session + CSRF)
//   POST /auth/mfa/disable    remove the factor          (full session + CSRF + password)
//
// ── Two different credentials guard these ──────────────────────────────────
//
// `/verify` is reached by a browser that has proved a password and nothing
// else. It is authorized by the PRE-AUTH cookie, which is scoped to `/auth` and
// grants exactly one thing: finishing this ceremony (§46).
//
// The other three are ordinary authenticated mutations from a fully logged-in
// session, and take standard CSRF (§148, §262). Enrolling or removing a second
// factor from a half-authenticated browser would defeat the point of having
// one.
//
// ── No resend, no delivery ─────────────────────────────────────────────────
//
// The factor is TOTP. Nothing is issued per login and nothing is sent, so there
// is no `/auth/mfa/resend` — it would have nothing to resend. See
// MFA_OTP_PRODUCT_INVENTORY.md.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  completeMfaChallenge, beginMfaEnrolment, confirmMfaEnrolment, disableMfa,
  PASSWORD_MAX_LENGTH,
  type CompleteMfaDependencies, type BeginEnrolmentDependencies,
  type ConfirmEnrolmentDependencies, type DisableMfaDependencies,
  type UserId,
} from "@lagda/application";
import type { ApiConfig } from "../config/index.js";
import {
  PRE_AUTH_COOKIE_NAME, clearPreAuthCookieOptions,
  SESSION_COOKIE_NAME, CSRF_COOKIE_NAME,
  sessionCookieOptions, csrfCookieOptions,
} from "../security/cookies.js";

/**
 * The submitted second factor.
 *
 * `code` covers BOTH a 6-digit TOTP code and a 14-character recovery code —
 * the use case tells them apart by shape. One field, because the product
 * presents them on separate pages but they complete the same ceremony, and two
 * fields would mean two attempt counters where there must be one (§34).
 *
 * Bounded generously enough for a formatted recovery code with separators.
 */
export const VerifyMfaRequestSchema = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 32 }),
}, { additionalProperties: false });

export const VerifyMfaResponseSchema = Type.Object({
  status: Type.Literal("authenticated"),
  userId: Type.String(),
  /**
   * Present only when a RECOVERY code was spent, so the UI can warn a user who
   * is running out. Absent for an ordinary TOTP login, where it means nothing.
   */
  recoveryCodesRemaining: Type.Optional(Type.Integer()),
}, { additionalProperties: false });

export const EnrollMfaResponseSchema = Type.Object({
  /**
   * SECRET. Contains the enrolment secret in full — this is the QR payload.
   * Returned exactly once, to the enrolling session, and never logged (§187).
   */
  provisioningUri: Type.String(),
  /** The manual setup key, for apps without a camera. Same secret. */
  secret: Type.String(),
}, { additionalProperties: false });

export const ConfirmMfaRequestSchema = Type.Object({
  code: Type.String({ minLength: 6, maxLength: 6 }),
}, { additionalProperties: false });

export const ConfirmMfaResponseSchema = Type.Object({
  status: Type.Literal("enabled"),
  /** Shown ONCE. There is no endpoint that returns these again (§194). */
  recoveryCodes: Type.Array(Type.String()),
}, { additionalProperties: false });

export const DisableMfaRequestSchema = Type.Object({
  /** The CURRENT password. A session alone may not remove a second factor. */
  password: Type.String({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH }),
}, { additionalProperties: false });

export const DisableMfaResponseSchema = Type.Object({
  status: Type.Literal("disabled"),
}, { additionalProperties: false });

export type VerifyMfaRequest = Static<typeof VerifyMfaRequestSchema>;
export type ConfirmMfaRequest = Static<typeof ConfirmMfaRequestSchema>;
export type DisableMfaRequest = Static<typeof DisableMfaRequestSchema>;

export interface MfaRouteOptions {
  readonly verifyPath: string;
  readonly enrollPath: string;
  readonly confirmPath: string;
  readonly disablePath: string;
  readonly config: ApiConfig;
  readonly verifyDependencies: () => CompleteMfaDependencies;
  readonly enrollDependencies: () => BeginEnrolmentDependencies;
  readonly confirmDependencies: () => ConfirmEnrolmentDependencies;
  readonly disableDependencies: () => DisableMfaDependencies;
  /**
   * Issues the FULL session, after both factors succeed.
   *
   * Deliberately a separate capability rather than something the use case
   * does: session issuance living outside the MFA logic is what makes "no
   * session before MFA" checkable in one place (§79).
   */
  readonly issueSession: (userId: UserId) => Promise<{
    readonly sessionToken: string;
    readonly csrfToken: string;
    readonly expiresAt: number;
  }>;
  /**
   * Resolves the authenticated user for the three settings routes.
   *
   * Returns null when there is no FULL session. A pre-auth credential must
   * never resolve here — enrolling or disabling a factor mid-ceremony would
   * let a password alone change the account's security configuration (§255).
   */
  readonly authenticatedUser: (request: FastifyRequest) => Promise<UserId | null>;
}

export function registerMfaRoutes(
  app: FastifyInstance,
  options: MfaRouteOptions,
): void {
  // ── Verify: complete the login ceremony ─────────────────────────────────
  app.post(options.verifyPath, {
    schema: {
      body: VerifyMfaRequestSchema,
      response: { 200: VerifyMfaResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as VerifyMfaRequest;
    const pendingCredential = request.cookies[PRE_AUTH_COOKIE_NAME];
    if (pendingCredential === undefined) {
      // No ceremony in progress. The user restarts at the password.
      return reply.status(401).send({
        error: {
          code: "PRE_AUTH_REQUIRED",
          message: "Sign in again to continue.",
        },
      });
    }

    const result = await completeMfaChallenge(
      { pendingCredential, code: body.code },
      options.verifyDependencies(),
    );

    if (result.outcome === "rejected") {
      // ── Which failures are distinguished, and why ────────────────────────
      //
      // The caller already holds a valid password proof, so telling them that
      // a code was wrong or that their attempts are gone reveals nothing they
      // could not determine by trying. What is NOT returned is the attempt
      // COUNT — that discloses the security configuration for no UX gain, and
      // `MfaChallenge.tsx` renders a fixed message either way (§119).
      if (result.reason === "pending-expired" || result.reason === "pending-not-found") {
        void reply.clearCookie(
          PRE_AUTH_COOKIE_NAME, clearPreAuthCookieOptions(options.config));
        return reply.status(401).send({
          error: {
            code: "PRE_AUTH_EXPIRED",
            message: "That sign-in attempt has expired. Please sign in again.",
          },
        });
      }
      if (result.reason === "attempts-exhausted") {
        // The ceremony is dead. Clearing the cookie forces a fresh password —
        // the high-security reading of §83, and it is what makes
        // `MfaChallenge.tsx`'s `locked` state reachable at last.
        void reply.clearCookie(
          PRE_AUTH_COOKIE_NAME, clearPreAuthCookieOptions(options.config));
        return reply.status(422).send({
          error: {
            code: "MFA_ATTEMPTS_EXHAUSTED",
            message: "Too many incorrect attempts. Please sign in again.",
          },
        });
      }
      // `invalid-code`, `code-replayed` and `factor-missing` collapse. A
      // replay in particular must not be acknowledged: confirming that a code
      // WAS correct but already used tells an attacker their captured code is
      // the right one (§118, §143).
      return reply.status(422).send({
        error: { code: "INVALID_MFA_CODE", message: "That code is incorrect." },
      });
    }

    // ── A FRESH session, only now (§49, §103, §268) ───────────────────────
    //
    // Newly issued. The pre-auth credential is never promoted, never reused,
    // and has just been consumed — so a captured pre-auth value cannot become
    // a session, which is the session-fixation shape this whole design avoids.
    const credentials = await options.issueSession(result.userId);
    const maxAgeSeconds = Math.max(
      0, Math.floor((credentials.expiresAt - Date.now()) / 1000));

    void reply.setCookie(
      SESSION_COOKIE_NAME, credentials.sessionToken,
      sessionCookieOptions(options.config, maxAgeSeconds));
    void reply.setCookie(
      CSRF_COOKIE_NAME, credentials.csrfToken,
      csrfCookieOptions(options.config, maxAgeSeconds));
    // The half-finished credential is now worthless AND gone from the browser.
    void reply.clearCookie(
      PRE_AUTH_COOKIE_NAME, clearPreAuthCookieOptions(options.config));

    return reply.status(200).send({
      status: "authenticated" as const,
      userId: result.userId,
      ...(result.recoveryCodesRemaining === null
        ? {}
        : { recoveryCodesRemaining: result.recoveryCodesRemaining }),
    });
  });

  // ── Enrol: begin ────────────────────────────────────────────────────────
  app.post(options.enrollPath, {
    schema: { response: { 200: EnrollMfaResponseSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await options.authenticatedUser(request);
    if (userId === null) return unauthenticated(reply);

    const result = await beginMfaEnrolment(userId, options.enrollDependencies());
    if (result.outcome === "already-enabled") {
      return reply.status(409).send({
        error: {
          code: "MFA_ALREADY_ENABLED",
          message: "Two-factor authentication is already enabled.",
        },
      });
    }

    // The factor is NOT active yet. `verifiedAt` stays null until /confirm.
    return reply.status(200).send({
      provisioningUri: result.enrolment.provisioningUri,
      secret: result.enrolment.secret,
    });
  });

  // ── Enrol: confirm ──────────────────────────────────────────────────────
  app.post(options.confirmPath, {
    schema: {
      body: ConfirmMfaRequestSchema,
      response: { 200: ConfirmMfaResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await options.authenticatedUser(request);
    if (userId === null) return unauthenticated(reply);

    const body = request.body as ConfirmMfaRequest;
    const result = await confirmMfaEnrolment(
      { userId, code: body.code }, options.confirmDependencies());

    if (result.outcome === "invalid-code") {
      return reply.status(422).send({
        error: { code: "INVALID_MFA_CODE", message: "That code is incorrect." },
      });
    }
    if (result.outcome === "no-pending-enrolment") {
      return reply.status(409).send({
        error: {
          code: "NO_PENDING_ENROLMENT",
          message: "Start two-factor setup again.",
        },
      });
    }

    // The one and only time these are returned.
    return reply.status(200).send({
      status: "enabled" as const,
      recoveryCodes: [...result.recoveryCodes],
    });
  });

  // ── Disable ─────────────────────────────────────────────────────────────
  app.post(options.disablePath, {
    schema: {
      body: DisableMfaRequestSchema,
      response: { 200: DisableMfaResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await options.authenticatedUser(request);
    if (userId === null) return unauthenticated(reply);

    const body = request.body as DisableMfaRequest;
    const result = await disableMfa(
      { userId, password: body.password }, options.disableDependencies());

    if (result.outcome === "invalid-password") {
      // Removing a second factor is the first thing an attacker with a stolen
      // session tries. The password is what stops the session alone from
      // being enough (§94, §180).
      return reply.status(401).send({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "That password is incorrect.",
        },
      });
    }
    if (result.outcome === "not-enabled") {
      return reply.status(409).send({
        error: {
          code: "MFA_NOT_ENABLED",
          message: "Two-factor authentication is not enabled.",
        },
      });
    }

    return reply.status(200).send({ status: "disabled" as const });
  });
}

function unauthenticated(reply: FastifyReply): FastifyReply {
  // Deliberately the same answer a pre-auth-only browser gets. A half-finished
  // ceremony is not a session, and must not learn that it is close to one.
  return reply.status(401).send({
    error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." },
  });
}
