// HTTP header contracts clients need shared semantics for.
//
// Only these three. Modelling every header here would put transport parsing in
// a package the browser consumes; Fastify handles the rest.

import { Type, type Static } from "@sinclair/typebox";

declare const brand: unique symbol;
type Branded<T extends string> = string & { readonly [brand]: T };

// ── Request correlation ──────────────────────────────────────────────────────

export const REQUEST_ID_HEADER = "X-Request-Id";

/**
 * Correlates one HTTP attempt with server logs. Returned on every response,
 * and included in error bodies so a user can quote it in a support request.
 *
 * **The server always generates its own.** A client-supplied value is not
 * trusted: it is not unique, and it flows straight into logs, where an attacker
 * controlling it could forge log lines. If a client value is ever accepted it
 * must be echoed in a separate field, never used as the canonical ID.
 */
export type RequestId = Branded<"RequestId">;

export const RequestIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  title: "RequestId",
});

// ── Idempotency ──────────────────────────────────────────────────────────────

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Identifies a logical mutation so a retry does not perform it twice.
 *
 * NOT the same thing as a request ID, and the distinction matters:
 *
 *   RequestId       — "which HTTP attempt is this?"      New for every attempt.
 *   IdempotencyKey  — "which operation does this retry belong to?"
 *                     Deliberately the SAME across retries of one operation.
 *
 * A client generating a fresh key per retry has disabled idempotency while
 * appearing to use it.
 *
 * Opaque to the server: it is compared, never parsed. Required by handoff §28
 * for document send, invitations, plan changes, signature submission and OTP
 * delivery. Reusing a key with materially different content must FAIL rather
 * than silently return the first result — storage and fingerprinting are
 * BACKEND-14's.
 */
export type IdempotencyKey = Branded<"IdempotencyKey">;

export const IdempotencyKeySchema = Type.String({
  minLength: 1,
  maxLength: MAX_IDEMPOTENCY_KEY_LENGTH,
  title: "IdempotencyKey",
  description: "Opaque client-generated key. Same key = same logical operation.",
});

// ── CSRF ─────────────────────────────────────────────────────────────────────

/**
 * Authentication is a secure httpOnly session cookie (ADR-001), so
 * state-changing browser requests need a CSRF token the cookie cannot supply.
 *
 * CORS is not a substitute: it governs which origins may READ a response, and
 * a simple cross-origin POST is sent regardless. Nor is it authentication or
 * authorization. Four separate problems.
 */
export const CSRF_TOKEN_HEADER = "X-CSRF-Token";

export type CsrfTokenString = Static<typeof CsrfTokenSchema>;
export const CsrfTokenSchema = Type.String({ minLength: 1, maxLength: 256, title: "CsrfToken" });
