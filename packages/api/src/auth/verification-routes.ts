// POST /auth/verify-email  and  POST /auth/resend-verification
//
// ── Both are POST, deliberately ────────────────────────────────────────────
//
// Verification changes account state, so it is a mutation. Email security
// scanners and messaging clients routinely fetch every link in a message before
// a human sees it — a GET that consumed a code would let a scanner "verify" an
// account, or burn the code so the real user cannot (§32).
//
// The product already avoids this: `VerifyEmail.tsx` presents a field the user
// TYPES a code into and submits. Nothing is consumed by merely opening a page.
// If a link is added later it must land on that page, not on this endpoint
// (INV-268).
//
// ── Public, token-authorized ───────────────────────────────────────────────
//
// Neither route requires a session. Verification links are opened on phones,
// from other browsers, from desktop mail clients — requiring the browser that
// registered would strand most users (§82, §83). Possession of the code
// authorizes exactly one action: verifying the account it was issued for. It is
// never a session, never a reset credential, never workspace access (§37).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import {
  verifyEmail, resendEmailVerification, MAX_EMAIL_LENGTH,
  type ResendVerificationDependencies, type VerifyEmailDependencies,
} from "@lagda/application";

/**
 * The submitted code.
 *
 * Bounded generously because the canonicalizer accepts grouping and separators
 * — `K7QM-2X9F-P4TB` and `k7qm 2x9f p4tb` are the same credential. Anything
 * longer than a plausible formatted code is refused before it reaches a digest.
 */
export const VerifyEmailRequestSchema = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });

export const VerifyEmailResponseSchema = Type.Object({
  verified: Type.Boolean(),
  /** A stable field the client branches on, never prose it has to parse. */
  nextAction: Type.Union([Type.Literal("sign-in"), Type.Literal("none")]),
}, { additionalProperties: false });

export const ResendVerificationRequestSchema = Type.Object({
  email: Type.String({ minLength: 3, maxLength: MAX_EMAIL_LENGTH }),
}, { additionalProperties: false });

/**
 * ONE response shape for every outcome.
 *
 * Unknown address, already-verified account and successful rotation are
 * indistinguishable. Anything else turns resend into an account-existence
 * oracle, and unlike registration the caller has asserted nothing here
 * (INV-266).
 */
export const ResendVerificationResponseSchema = Type.Object({
  /**
   * Deliberately NOT `emailSent`. Nothing here proves a message left the
   * building — delivery is asynchronous, and with no notification
   * infrastructure it does not happen at all (§52).
   */
  accepted: Type.Literal(true),
}, { additionalProperties: false });

export type VerifyEmailRequest = Static<typeof VerifyEmailRequestSchema>;
export type ResendVerificationRequest = Static<typeof ResendVerificationRequestSchema>;

export interface VerificationRouteOptions {
  readonly verifyPath: string;
  readonly resendPath: string;
  readonly verifyDependencies: () => VerifyEmailDependencies;
  readonly resendDependencies: () => ResendVerificationDependencies;
}

export function registerVerificationRoutes(
  app: FastifyInstance,
  options: VerificationRouteOptions,
): void {
  // ── Verify ──────────────────────────────────────────────────────────────
  app.post(options.verifyPath, {
    schema: {
      body: VerifyEmailRequestSchema,
      response: { 200: VerifyEmailResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as VerifyEmailRequest;
    const result = await verifyEmail(body.code, options.verifyDependencies());

    if (result.outcome === "invalid") {
      // Unknown, expired, consumed and superseded COLLAPSE into one public
      // answer. Distinguishing them would tell an attacker submitting random
      // codes which ones ever existed (§57).
      //
      // The frontend's own error vocabulary is `invalid | expired | locked`,
      // and it renders a generic retry message for `invalid` — so one code
      // matches what the UI already does.
      return reply.status(422).send({
        error: {
          code: "INVALID_OR_EXPIRED_VERIFICATION_CODE",
          message: "That code is not valid or has expired. Request a new one.",
        },
      });
    }

    // Both `verified` and `already-verified` are successes. A user who submits
    // twice, or whose response was lost and who retried, sees the same thing
    // rather than a confusing failure (§112).
    //
    // The response carries NO email address and NO user id: possession of the
    // code proves mailbox access, but echoing account data back is PII this
    // response does not need (§88).
    return reply.status(200).send({
      verified: true,
      nextAction: "sign-in" as const,
    });
  });

  // ── Resend ──────────────────────────────────────────────────────────────
  app.post(options.resendPath, {
    schema: {
      body: ResendVerificationRequestSchema,
      response: { 202: ResendVerificationResponseSchema },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as ResendVerificationRequest;
    await resendEmailVerification(body.email, options.resendDependencies());

    // ALWAYS 202, always the same body. The use case's telemetry reason never
    // reaches here — it is exactly the distinction anti-enumeration hides.
    //
    // 202 rather than 200: the work is accepted, and whether a message is ever
    // delivered is decided later by infrastructure this route does not own.
    return reply.status(202).send({ accepted: true as const });
  });
}
