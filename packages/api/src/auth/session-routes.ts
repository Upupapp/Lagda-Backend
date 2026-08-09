// POST /auth/sign-in  and  POST /auth/sign-out
//
// Paths taken from the handoff service map
// (`auth.service.ts → POST /auth/sign-in, /auth/register, /auth/sign-out`),
// not invented as `/auth/login`.
//
// ── Login-CSRF ─────────────────────────────────────────────────────────────
//
// Login CSRF is a real attack, not a non-issue because the route is public: an
// attacker who can make a victim's browser log in as the ATTACKER'S account can
// then watch what the victim does inside it. The defences here are:
//
//   * SameSite=Lax on the session cookie, so the forged login's cookie is not
//     sent on subsequent cross-site navigations;
//   * exact-origin CORS (never `*`), so a scripted cross-origin login cannot
//     read the response;
//   * an ORIGIN CHECK on the request itself, below.
//
// A session-bound CSRF token cannot be required: the caller has no session yet,
// which is the whole point of logging in (INV-255).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  loginUser, MAX_EMAIL_LENGTH, PASSWORD_MAX_LENGTH,
  type LoginDependencies, type UserId,
} from "@lagda/application";
import type { ApiConfig } from "../config/index.js";
import {
  SESSION_COOKIE_NAME, CSRF_COOKIE_NAME,
  sessionCookieOptions, csrfCookieOptions,
  clearCookieOptions, clearCsrfCookieOptions,
} from "../security/cookies.js";

/**
 * Email and password. Nothing else.
 *
 * MEASURED from the real `SignIn.tsx`, which collects exactly these two. There
 * is no `rememberMe` field in the product, so none is invented — adding one
 * would mean inventing a session-lifetime policy nobody asked for.
 *
 * `additionalProperties: false`, so `role`, `userId` or `emailVerified` in the
 * body is a validation error rather than a silently ignored field (INV-254).
 */
export const SignInRequestSchema = Type.Object({
  email: Type.String({ minLength: 3, maxLength: MAX_EMAIL_LENGTH }),
  // Bounded so an oversized body cannot reach Argon2. NOT length-floored here:
  // a short password must fail as INVALID CREDENTIALS, identically to a wrong
  // one. Rejecting it with a schema error would say "no account has a password
  // this short", which is a small oracle but an oracle.
  password: Type.String({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH }),
}, { additionalProperties: false });

export type SignInRequest = Static<typeof SignInRequestSchema>;

/** The safe authenticated result. No token, no hash, no internal identity. */
export const SignInResponseSchema = Type.Object({
  userId: Type.String(),
  email: Type.String(),
  displayName: Type.String(),
  emailVerified: Type.Literal(true),
}, { additionalProperties: false });

export interface SessionRouteOptions {
  readonly signInPath: string;
  readonly signOutPath: string;
  readonly config: ApiConfig;
  readonly dependencies: () => LoginDependencies;
  /** Revokes the current session server-side. Provided by BACKEND-13's service. */
  readonly revokeSession: (sessionId: string) => Promise<void>;
}

export function registerSessionRoutes(
  app: FastifyInstance,
  options: SessionRouteOptions,
): void {
  // ── Sign in ─────────────────────────────────────────────────────────────
  app.post(options.signInPath, {
    schema: { body: SignInRequestSchema, response: { 200: SignInResponseSchema } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!originAllowed(request, options.config)) {
      // A cross-site forged login. Refused before any credential work.
      return reply.status(403).send({
        error: { code: "FORBIDDEN_ORIGIN", message: "Request origin is not allowed." },
      });
    }

    const body = request.body as SignInRequest;
    const result = await loginUser(
      { email: body.email, password: body.password },
      options.dependencies(),
    );

    if (result.outcome === "rejected") {
      if (result.failure.kind === "email-not-verified") {
        // Reached only after the password verified, so this is safe to be
        // specific about. The real frontend routes this to `/verify-email`.
        return reply.status(403).send({
          error: {
            code: "EMAIL_VERIFICATION_REQUIRED",
            message: "Verify your email address to continue.",
          },
        });
      }
      // ONE error for an unknown account AND a wrong password. No status
      // difference, no message difference, no metadata (INV-249).
      return reply.status(401).send({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "Email address or password is incorrect.",
        },
      });
    }

    // Cookies are written only AFTER the session row exists — `issue` persisted
    // it before returning. A cookie for a session that does not exist would
    // authenticate nothing and look like an outage (§74).
    const { credentials } = result;

    // `sessionCookieOptions` takes MAX-AGE IN SECONDS, not an absolute
    // timestamp. Passing `expiresAt` directly set Max-Age to roughly 1.7
    // trillion seconds - a cookie that outlives the session by 50 000 years,
    // so a revoked session would keep being presented by the browser forever.
    // Floored at 0 so a clock skew cannot produce a negative age.
    const maxAgeSeconds = Math.max(
      0, Math.floor((credentials.expiresAt - Date.now()) / 1000));

    void reply.setCookie(
      SESSION_COOKIE_NAME, credentials.sessionToken,
      sessionCookieOptions(options.config, maxAgeSeconds),
    );
    void reply.setCookie(
      CSRF_COOKIE_NAME, credentials.csrfToken,
      csrfCookieOptions(options.config, maxAgeSeconds),
    );

    // The RAW tokens went into cookies and go nowhere else. The JSON body
    // carries none of them (INV-252).
    return reply.status(200).send({
      userId: result.userId,
      email: result.email,
      displayName: result.displayName,
      emailVerified: true as const,
    });
  });

  // ── Sign out ────────────────────────────────────────────────────────────
  //
  // POST, never GET. A GET logout can be triggered by an `<img>` tag on any
  // page on the internet (§61). It is an authenticated state mutation, so it
  // carries the same CSRF requirement as every other mutation.
  app.post(options.signOutPath, async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = (request as { auth?: { sessionId?: string } }).auth;

    // No session at all. The cookie is cleared and success is returned:
    // repeated logouts, a second browser tab, and a retry after a dropped
    // response must all be safe rather than a 500 (§60, §65).
    if (auth?.sessionId === undefined) {
      clearCredentials(reply, options.config);
      return reply.status(204).send();
    }

    try {
      // SERVER-SIDE revocation. Clearing a cookie alone leaves a credential
      // that still authenticates if it was ever copied (INV-257).
      await options.revokeSession(auth.sessionId);
    } catch {
      // The browser credential is cleared regardless — that is locally
      // defensive and costs nothing. But the failure is NOT reported as a
      // successful logout: the session may still be valid to anyone who stole
      // the token, and pretending otherwise hides a real security event (§162).
      clearCredentials(reply, options.config);
      return reply.status(503).send({
        error: {
          code: "SESSION_REVOCATION_FAILED",
          message: "Signed out of this browser, but the session could not be revoked.",
        },
      });
    }

    clearCredentials(reply, options.config);
    return reply.status(204).send();
  });
}

/** Clears both credentials with the SAME scope they were written with. */
function clearCredentials(reply: FastifyReply, config: ApiConfig): void {
  // Name, path and attributes must match the original, or the browser keeps
  // the old cookie and the user stays "logged in" (§63).
  void reply.clearCookie(SESSION_COOKIE_NAME, clearCookieOptions(config));
  void reply.clearCookie(CSRF_COOKIE_NAME, clearCsrfCookieOptions(config));
}

/**
 * Origin check for the public login route.
 *
 * A same-origin browser request may omit `Origin` entirely, so an absent header
 * is allowed — rejecting it would break legitimate same-origin form posts. What
 * is rejected is an Origin that is PRESENT and not on the allowlist, which is
 * exactly the cross-site forged-login shape.
 *
 * This is defence in depth beside SameSite, not a replacement: SameSite is
 * enforced by the browser, this is enforced by LAGDA.
 */
function originAllowed(request: FastifyRequest, config: ApiConfig): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (config.corsOrigins.length === 0) return true;
  return config.corsOrigins.includes(origin);
}

/** Re-exported for the composition root. */
export type { UserId };
