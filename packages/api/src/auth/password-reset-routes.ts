// POST /auth/forgot-password  and  POST /auth/reset-password
//
// ── Both are public, and both are POST ─────────────────────────────────────
//
// Public because a locked-out user has no session by definition. Requiring one
// to recover from having lost access is a contradiction (§29).
//
// POST because both mutate. The reset LINK is a GET to a frontend page that
// only renders a form — opening it changes nothing and consumes nothing, so a
// mail security scanner prefetching every link in the message cannot burn the
// user's token before they read the email (§46, §47, §191).
//
// ── What authorizes what ───────────────────────────────────────────────────
//
// The reset token is a NARROW bearer credential: it authorizes replacing the
// password of the one account it was issued for, and nothing else. It is not a
// session, it does not grant API access, it does not accept invitations, and it
// does not verify an email (§95, §96, §97, §98).
//
// If a browser happens to send a valid session cookie along with a reset
// request, that cookie is IGNORED. The challenge decides which account is being
// reset, always — otherwise a token for account A submitted from a session for
// account B would have two candidate answers, and one of them is a takeover
// (§203, §204).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  requestPasswordReset, resetPassword, MAX_EMAIL_LENGTH,
  PASSWORD_MAX_LENGTH,
  type RequestPasswordResetDependencies, type ResetPasswordDependencies,
} from "@lagda/application";
import type { ApiConfig } from "../config/index.js";
import {
  SESSION_COOKIE_NAME, CSRF_COOKIE_NAME,
  clearCookieOptions, clearCsrfCookieOptions,
} from "../security/cookies.js";

export const ForgotPasswordRequestSchema = Type.Object({
  email: Type.String({ minLength: 3, maxLength: MAX_EMAIL_LENGTH }),
}, { additionalProperties: false });

/**
 * ONE response shape for every outcome (§22, §118).
 *
 * Unknown address and eligible account are indistinguishable. Note what is
 * absent: no `userId`, no `challengeId`, no `accountExists`, no `verified`, and
 * no token. A field that is not on the schema cannot be leaked by a careless
 * `send()` later.
 */
export const ForgotPasswordResponseSchema = Type.Object({
  /**
   * Deliberately NOT `emailSent`. Nothing here proves a message left the
   * building — and asserting one did would also assert an account exists.
   */
  accepted: Type.Literal(true),
}, { additionalProperties: false });

/**
 * The reset submission.
 *
 * `token` and `newPassword`, and NOTHING else. No `userId`, no `email`, no
 * `role`, no `emailVerified` — the token resolves the account, and accepting a
 * second identity claim alongside it is how account confusion starts (§49,
 * §50, §180, §249).
 *
 * No `newPasswordConfirmation` either: `ResetPassword.tsx` compares the two
 * fields client-side and submits one password. Adding a server field the client
 * never sends would fail every real request.
 */
export const ResetPasswordRequestSchema = Type.Object({
  token: Type.String({ minLength: 1, maxLength: 128 }),
  newPassword: Type.String({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH }),
}, { additionalProperties: false });

export const ResetPasswordResponseSchema = Type.Object({
  passwordReset: Type.Boolean(),
  /**
   * `sign-in`, matching the product: `ResetPassword.tsx` navigates to
   * `/sign-in?notice=password-reset` on success. NO auto-login (§64, §201).
   */
  nextAction: Type.Literal("sign-in"),
}, { additionalProperties: false });

export type ForgotPasswordRequest = Static<typeof ForgotPasswordRequestSchema>;
export type ResetPasswordRequestBody = Static<typeof ResetPasswordRequestSchema>;

export interface PasswordResetRouteOptions {
  readonly forgotPath: string;
  readonly resetPath: string;
  readonly config: ApiConfig;
  readonly requestDependencies: () => RequestPasswordResetDependencies;
  readonly resetDependencies: () => ResetPasswordDependencies;
}

export function registerPasswordResetRoutes(
  app: FastifyInstance,
  options: PasswordResetRouteOptions,
): void {
  // ── Forgot password ─────────────────────────────────────────────────────
  app.post(options.forgotPath, {
    schema: {
      body: ForgotPasswordRequestSchema,
      response: { 202: ForgotPasswordResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as ForgotPasswordRequest;
    // The result is DISCARDED, not inspected. Its `telemetryReason`
    // distinguishes a known account from an unknown one, and that distinction
    // is precisely what anti-enumeration exists to withhold. Not reading it
    // here means no future edit can accidentally branch on it (§21, §22).
    await requestPasswordReset(body.email, options.requestDependencies());

    // ALWAYS 202, always the same body, for every branch. 202 rather than 200
    // because the work is accepted and whether a message is ever delivered is
    // decided later by infrastructure this route does not own (§23).
    //
    // Never 404 for an unknown address (§196).
    return reply.status(202).send({ accepted: true as const });
  });

  // ── Reset password ──────────────────────────────────────────────────────
  app.post(options.resetPath, {
    schema: {
      body: ResetPasswordRequestSchema,
      response: { 200: ResetPasswordResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as ResetPasswordRequestBody;
    const result = await resetPassword(
      { token: body.token, newPassword: body.newPassword },
      options.resetDependencies(),
    );

    if (result.outcome === "invalid-password") {
      // The PASSWORD is the problem, and saying so is safe: the caller chose
      // the value and already knows it. This does not disclose token state.
      return reply.status(422).send({
        error: {
          code: "INVALID_PASSWORD",
          message: result.reason === "too-short"
            ? "That password is too short."
            : "That password is too long.",
        },
      });
    }

    if (result.outcome === "invalid-token") {
      // Malformed, unknown, expired, consumed and superseded COLLAPSE into one
      // answer (§120, §197). Distinguishing them tells whoever holds a token
      // whether it is live, which is useful to exactly one party: someone who
      // obtained it and is not the account owner.
      //
      // `ResetPassword.tsx` has separate `expired` / `used` / `invalid`
      // screens, but it selects between them from a `?state=` URL parameter it
      // sets itself — a demo affordance, not an API contract. Its `invalid`
      // copy ("It may be malformed or from an older request") already covers
      // every case this returns. See OD-079.
      return reply.status(422).send({
        error: {
          code: "INVALID_OR_EXPIRED_RESET_TOKEN",
          message: "That reset link is not valid or has expired. Request a new one.",
        },
      });
    }

    // ── Clear the browser's credentials (§114, §115) ──────────────────────
    //
    // Every session was just revoked server-side, so an old cookie is already
    // powerless. Clearing it anyway is defence in depth: without this the
    // browser keeps presenting a dead credential on every request, and the user
    // sees a logged-in shell that 401s on contact.
    //
    // No new session and no new CSRF token are issued — there is no session for
    // one to protect, and minting either here would make the reset token a
    // route to authentication, which it must never be (§98, §116).
    void reply.clearCookie(SESSION_COOKIE_NAME, clearCookieOptions(options.config));
    void reply.clearCookie(CSRF_COOKIE_NAME, clearCsrfCookieOptions(options.config));

    // No `userId`, no `revokedSessionCount`, no email. The count is useful
    // telemetry and useless to the client (§82, §119).
    return reply.status(200).send({
      passwordReset: true,
      nextAction: "sign-in" as const,
    });
  });
}
