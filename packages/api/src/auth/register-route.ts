// POST /auth/register
//
// PUBLIC and unauthenticated. From the handoff's service map:
// `auth.service.ts → POST /auth/sign-in, /auth/register, /auth/sign-out`.
//
// ── Order ──────────────────────────────────────────────────────────────────
//
//   schema validation → IP rate limit → use case → response
//
// The rate limit is an `onRequest` hook, so it runs before the handler and
// therefore before Argon2id. That ordering is the difference between a bounded
// cost and an unauthenticated memory-hard DoS primitive (INV-234).
//
// ── No CSRF token, deliberately ────────────────────────────────────────────
//
// BACKEND-13's CSRF is session-bound, and a registering user has no session —
// requiring one would make registration impossible. What defends this route is
// the CORS allowlist (exact origins, never `*`), Origin validation, and the
// rate limits above. Recorded rather than silently skipped (§75, §154).

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  registerUser, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, MAX_EMAIL_LENGTH,
  type RegisterUserDependencies,
} from "@lagda/application";

/**
 * The request contract, matching the real `CreateAccountRequest` plus the
 * password the form collects separately.
 *
 * `additionalProperties: false` is the mass-assignment defence: a body carrying
 * `role`, `isAdmin`, `emailVerified` or `userId` is REJECTED (INV-245).
 *
 * ── This REQUIRES `removeAdditional: false` on the app ──────────────────────
 *
 * Fastify's default ajv STRIPS unknown properties instead of rejecting them, so
 * on a default-configured instance this schema rejects nothing. `createApp`
 * sets `removeAdditional: false` for exactly this reason (API_CONVENTIONS §4),
 * and a test asserts that setting.
 *
 * A handler-level guard was written first and DELETED: by the time the handler
 * runs, a stripping app has already removed the field, so `Object.keys(body)`
 * cannot see it. It read as defence in depth while being incapable of firing -
 * which is worse than no guard, because it invites trusting it.
 */
export const RegisterRequestSchema = Type.Object({
  email: Type.String({ minLength: 3, maxLength: MAX_EMAIL_LENGTH }),
  // Bounded at the schema so an oversized body is refused before it reaches the
  // hasher. NOT trimmed — a schema-wide "trim all strings" transform would
  // silently alter passwords (§103).
  password: Type.String({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH }),
  name: Type.String({ minLength: 2, maxLength: 200 }),
  organization: Type.Optional(Type.String({ maxLength: 200 })),
  intendedUse: Type.Optional(Type.String({ maxLength: 64 })),
  /**
   * "I agree to LAGDA's Terms of Service and Privacy Policy."
   *
   * `const: true` rather than a boolean: sending `false` is a validation error,
   * not a registration that proceeds without acceptance.
   */
  consent: Type.Literal(true),
}, { additionalProperties: false });

export type RegisterRequest = Static<typeof RegisterRequestSchema>;

/**
 * The response. An explicit projection, never the user entity.
 *
 * Contains no password hash, no normalized email, no verification token, no
 * verification digest, and no session credential (INV-238).
 */
export const RegisterResponseSchema = Type.Object({
  userId: Type.String(),
  email: Type.String(),
  /** Always false here. Verification is never implied by registration. */
  emailVerified: Type.Boolean(),
  /**
   * What the client should do next, as a STABLE FIELD rather than prose the
   * frontend would have to parse. The real UI navigates to `/verify-email`.
   */
  nextAction: Type.Literal("verify-email"),
}, { additionalProperties: false });

export interface RegisterRouteOptions {
  readonly path: string;
  /**
   * Builds the use case's dependencies.
   *
   * A factory so the route holds no repository, no hasher and no database
   * handle of its own — it cannot query, hash or enqueue even by accident
   * (§156, §226).
   */
  readonly dependencies: () => RegisterUserDependencies;
  /**
   * Delivers the verification link.
   *
   * Optional, and absent today: notification infrastructure is BACKEND-44/45.
   * When it is absent the challenge is still created and the raw token is
   * DISCARDED — the account simply cannot be verified until delivery exists.
   *
   * That is stated in the report as a blocker rather than papered over: the
   * response never claims an email was sent (§119, §229).
   */
  readonly deliverVerification?: (input: {
    readonly email: string;
    readonly rawToken: string;
    readonly expiresAt: number;
  }) => Promise<void>;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  options: RegisterRouteOptions,
): void {
  app.post(options.path, {
    schema: {
      body: RegisterRequestSchema,
      response: { 201: RegisterResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    // EXPLICIT field mapping. Never `registerUser(request.body, ...)`: a spread
    // is how a field nobody intended becomes a persisted value (INV-245).
    const body = request.body as RegisterRequest;

    const result = await registerUser({
      email: body.email,
      password: body.password,
      displayName: body.name,
      ...(body.organization === undefined ? {} : { organization: body.organization }),
      ...(body.intendedUse === undefined ? {} : { intendedUse: body.intendedUse }),
      acceptedTerms: body.consent,
    }, options.dependencies());

    if (result.outcome === "rejected") {
      return sendFailure(reply, result.failure.kind);
    }

    // Delivery is attempted AFTER the account is committed. A failure here does
    // not un-register the user — the account exists and BACKEND-21's resend is
    // the recovery path. The response says "verify-email", never "email sent".
    if (options.deliverVerification !== undefined) {
      await options.deliverVerification({
        email: result.email,
        rawToken: result.verificationToken,
        expiresAt: result.verificationExpiresAt,
      });
    }

    // 201, per API conventions for a created resource. No `Location` header:
    // there is no account resource route to point at yet, and inventing one
    // would advertise an endpoint that 404s.
    //
    // NO SESSION COOKIE. The real frontend navigates to `/verify-email` and
    // treats the user as `email-verification-required` — measured from
    // CreateAccount.tsx, not assumed (INV-246).
    return reply.status(201).send({
      userId: result.userId,
      email: result.email,
      emailVerified: false,
      nextAction: "verify-email" as const,
    });
  });
}

/**
 * Failure mapping.
 *
 * `email-already-registered` is a 409 that SAYS SO. That is a deliberate
 * decision, not an oversight: at signup the user has already asserted this
 * address is theirs, so telling them an account exists reveals nothing they did
 * not just claim, and hiding it produces the far worse experience of a
 * "successful" registration that can never be logged into.
 *
 * This does NOT set policy for login or password reset. Those are approached by
 * someone who may not own the address, and BACKEND-20/22 must make their own
 * anti-enumeration decisions (§42).
 */
function sendFailure(reply: FastifyReply, kind: string): FastifyReply {
  if (kind === "email-already-registered") {
    return reply.status(409).send({
      error: {
        code: "EMAIL_ALREADY_REGISTERED",
        message: "An account already exists for this email address.",
      },
    });
  }
  if (kind === "invalid-email") {
    return reply.status(422).send({
      error: { code: "INVALID_EMAIL", message: "Enter a valid email address." },
    });
  }
  if (kind === "invalid-password") {
    return reply.status(422).send({
      error: {
        code: "INVALID_PASSWORD",
        // The RULE, never why hashing failed or what algorithm is used (§97).
        message: `Password must be between ${String(PASSWORD_MIN_LENGTH)} and `
          + `${String(PASSWORD_MAX_LENGTH)} characters.`,
      },
    });
  }
  return reply.status(422).send({
    error: {
      code: "TERMS_NOT_ACCEPTED",
      message: "You must accept the Terms of Service and Privacy Policy.",
    },
  });
}
