// The canonical LAGDA API error envelope.
//
// SHAPE AND CODE FORMAT COME FROM THE HANDOFF, NOT FROM PREFERENCE.
// `backend-integration-handoff.md` §26 already specifies the wire codes as
// lowercase snake_case — `auth_required`, `permission_denied`,
// `validation_error` — together with their HTTP statuses and the frontend
// `LagdaErrorCode` each maps to. BACKEND-03 suggested UPPER_SNAKE_CASE, but its
// §9 says not to impose the suggested shape where a specification already
// establishes one. Renaming ten already-specified wire values to suit a style
// preference would be a breaking change with no product benefit.
//
// Success responses are NOT wrapped. The frontend has a dead
// `ApiResponse<T> = { success: true, data }` type in `models/index.ts` with zero
// consumers; adopting it would add a wrapper HTTP status already communicates.

import { Type, type Static } from "@sinclair/typebox";

// ── Codes ────────────────────────────────────────────────────────────────────

/**
 * Common codes, verbatim from handoff §26 plus the small number needed to cover
 * categories it does not reach (rate limiting, dependency failure, internal).
 *
 * Feature commands ADD domain codes (`signing_request_already_sent`) rather than
 * overloading these. A code is a stable API contract: renaming one breaks every
 * client branch and every stored log.
 */
export const API_ERROR_CODES = {
  // Authentication — 401
  authRequired: "auth_required",
  sessionExpired: "session_expired",
  // Authorization — 403
  permissionDenied: "permission_denied",
  planRestricted: "plan_restricted",
  // Resource — 404
  notFound: "not_found",
  // Conflict — 409
  conflict: "conflict",
  // Gone — 410. Present in the handoff and easy to miss: an expired or
  // cancelled signing request is not "not found", and the difference is what
  // lets the recipient screen explain what happened.
  requestExpired: "request_expired",
  requestCancelled: "request_cancelled",
  // Validation — 422
  validationError: "validation_error",
  invalidState: "invalid_state",
  // Rate limiting — 429
  rateLimited: "rate_limited",
  // Server — 503 / 500
  dependencyUnavailable: "dependency_unavailable",
  internalError: "internal_error",
} as const;

export const API_ERROR_CODE_VALUES = Object.values(API_ERROR_CODES);

export const ApiErrorCodeSchema = Type.String({
  minLength: 1,
  pattern: "^[a-z][a-z0-9_]*$",
  title: "ApiErrorCode",
  description:
    "Machine-readable error code, lowercase snake_case. Clients branch on this, never on `message`.",
});
export type ApiErrorCode = Static<typeof ApiErrorCodeSchema>;

/**
 * Deliberately a validated string rather than a closed union of the common
 * codes. Domain commands must be able to add codes without editing this file,
 * and a client receiving an unrecognised code should fall back gracefully
 * rather than fail to parse the response.
 */

// ── Validation detail ────────────────────────────────────────────────────────

export const ApiErrorDetailSchema = Type.Object(
  {
    /**
     * Dotted path with bracketed indices: `email`,
     * `recipients[0].email`, `fields[2].page`. One representation, chosen so a
     * form can map a detail straight to an input.
     */
    field: Type.String({ minLength: 1, examples: ["email", "recipients[0].email"] }),
    code: ApiErrorCodeSchema,
    /**
     * Human-readable, and never echoes the submitted value — a detail that
     * quotes a rejected password puts the secret in logs and error reporting.
     */
    message: Type.String({ minLength: 1 }),
  },
  { title: "ApiErrorDetail", additionalProperties: false },
);
export type ApiErrorDetail = Static<typeof ApiErrorDetailSchema>;

/**
 * Cap on returned details. One malformed request with thousands of bad fields
 * must not produce a response larger than the request.
 */
export const MAX_ERROR_DETAILS = 25;

// ── Envelope ─────────────────────────────────────────────────────────────────

export const ApiErrorSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: ApiErrorCodeSchema,
        /**
         * Safe for a developer to read and acceptable as a user-facing
         * fallback. Never a stack trace, SQL, file path, or internal topology —
         * and never authoritative for client behaviour.
         */
        message: Type.String({ minLength: 1 }),
        details: Type.Optional(
          Type.Array(ApiErrorDetailSchema, { maxItems: MAX_ERROR_DETAILS }),
        ),
        /** Correlates the response with server logs. Also sent as a header. */
        requestId: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
  },
  {
    title: "ApiError",
    description: "The only error shape any LAGDA endpoint returns.",
    additionalProperties: false,
  },
);
export type ApiError = Static<typeof ApiErrorSchema>;

// ── Categories and HTTP mapping ──────────────────────────────────────────────

/**
 * Application errors carry a CATEGORY; the HTTP layer maps category to status.
 * Domain code never returns a status, and the mapper never inspects a message —
 * `error.message.includes("not found")` is how status mapping silently breaks
 * when copy changes.
 */
export const API_ERROR_CATEGORIES = [
  "validation", "authentication", "authorization", "not-found",
  "gone", "conflict", "rate-limit", "dependency-unavailable", "internal",
] as const;
export type ApiErrorCategory = (typeof API_ERROR_CATEGORIES)[number];

/**
 * Validation maps to **422**, not 400, because handoff §26 specifies
 * `validation_error → 422`. 400 is reserved for a request that cannot be
 * interpreted at all — malformed JSON, wrong content type.
 */
export const CATEGORY_HTTP_STATUS: Record<ApiErrorCategory, number> = {
  validation: 422,
  authentication: 401,
  authorization: 403,
  "not-found": 404,
  gone: 410,
  conflict: 409,
  "rate-limit": 429,
  "dependency-unavailable": 503,
  internal: 500,
};

export const CODE_CATEGORY: Record<string, ApiErrorCategory> = {
  [API_ERROR_CODES.authRequired]: "authentication",
  [API_ERROR_CODES.sessionExpired]: "authentication",
  [API_ERROR_CODES.permissionDenied]: "authorization",
  [API_ERROR_CODES.planRestricted]: "authorization",
  [API_ERROR_CODES.notFound]: "not-found",
  [API_ERROR_CODES.conflict]: "conflict",
  [API_ERROR_CODES.requestExpired]: "gone",
  [API_ERROR_CODES.requestCancelled]: "gone",
  [API_ERROR_CODES.validationError]: "validation",
  [API_ERROR_CODES.invalidState]: "validation",
  [API_ERROR_CODES.rateLimited]: "rate-limit",
  [API_ERROR_CODES.dependencyUnavailable]: "dependency-unavailable",
  [API_ERROR_CODES.internalError]: "internal",
};
