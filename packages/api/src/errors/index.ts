// Mapping every failure onto LAGDA's one error envelope.
//
// Nothing else in the API may build an error response. A route that calls
// `reply.status(500).send({ message: e.message })` has invented a second
// envelope AND leaked an internal message, and both failures look fine in a
// passing test.
//
// The mapper NEVER inspects error message text. `message.includes("not found")`
// is how error mapping silently breaks when someone improves the copy.

import {
  API_ERROR_CODES, CATEGORY_HTTP_STATUS, MAX_ERROR_DETAILS,
  type ApiError, type ApiErrorCategory, type ApiErrorDetail, type RequestId,
} from "@lagda/contracts";
import { ApplicationError, type ApplicationErrorCategory } from "@lagda/application";

/**
 * Application categories are already the API's categories.
 *
 * Written as an explicit total map rather than a cast, so adding a category to
 * either side fails the build here instead of silently mapping to 500.
 */
const APPLICATION_TO_API: Record<ApplicationErrorCategory, ApiErrorCategory> = {
  validation: "validation",
  authentication: "authentication",
  authorization: "authorization",
  "not-found": "not-found",
  gone: "gone",
  conflict: "conflict",
  "rate-limit": "rate-limit",
  "dependency-unavailable": "dependency-unavailable",
  internal: "internal",
};

/** The generic message for anything unexpected. Identical for every cause. */
const INTERNAL_MESSAGE = "An unexpected error occurred. Please try again.";

export interface MappedError {
  readonly status: number;
  readonly body: ApiError;
  /** How the server should log it. Client-caused problems are not incidents. */
  readonly logLevel: "error" | "warn" | "info";
  /** Present only for internal errors, for the log. Never serialized. */
  readonly cause?: unknown;
}

function envelope(
  code: string,
  message: string,
  requestId: RequestId,
  details?: readonly ApiErrorDetail[],
): ApiError {
  return {
    error: {
      code,
      message,
      requestId,
      // Bounded. An unbounded list turns one bad payload into a response larger
      // than the request that caused it.
      ...(details && details.length > 0
        ? { details: details.slice(0, MAX_ERROR_DETAILS) }
        : {}),
    },
  };
}

/** A LAGDA-owned error raised by the HTTP layer itself, before any use case runs. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: readonly ApiErrorDetail[],
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string, details?: readonly ApiErrorDetail[]): HttpError =>
  // 400, not 422: the request could not be interpreted at all. 422 means valid
  // JSON with invalid content.
  new HttpError(400, API_ERROR_CODES.validationError, message, details);

/**
 * Schema validation failed — 422, not 400.
 *
 * The body parsed fine; its content is wrong. 400 is reserved for a request
 * that could not be interpreted at all (API_CONVENTIONS §3).
 */
export const validationFailed = (details: readonly ApiErrorDetail[]): HttpError =>
  new HttpError(CATEGORY_HTTP_STATUS.validation, API_ERROR_CODES.validationError,
    "One or more fields contain invalid values.", details);

export const unsupportedMediaType = (): HttpError =>
  new HttpError(415, API_ERROR_CODES.validationError,
    "Content-Type must be application/json.");

export const payloadTooLarge = (): HttpError =>
  new HttpError(413, API_ERROR_CODES.validationError,
    "The request body is larger than this endpoint accepts.");

export const routeNotFound = (): HttpError =>
  new HttpError(CATEGORY_HTTP_STATUS["not-found"], API_ERROR_CODES.notFound,
    "The requested endpoint does not exist.");

/**
 * The single entry point. Every failure becomes an envelope here.
 *
 * The `unknown` parameter type is deliberate — a thrown value is genuinely
 * unknown, and narrowing happens by `instanceof`, never by reading properties
 * off an untyped object.
 */
export function mapError(error: unknown, requestId: RequestId): MappedError {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: envelope(error.code, error.message, requestId, error.details),
      // A client sending malformed JSON is not a server incident.
      logLevel: "info",
    };
  }

  if (error instanceof ApplicationError) {
    const category = APPLICATION_TO_API[error.category];

    // An application error categorised `internal` is still an internal error:
    // its message was written for developers and must not be published.
    if (category === "internal") {
      return {
        status: 500,
        body: envelope(API_ERROR_CODES.internalError, INTERNAL_MESSAGE, requestId),
        logLevel: "error",
        cause: error,
      };
    }

    return {
      status: CATEGORY_HTTP_STATUS[category],
      body: envelope(error.code, error.message, requestId, extractDetails(error)),
      // 5xx is an incident; 4xx is a client telling us something we expected.
      logLevel: CATEGORY_HTTP_STATUS[category] >= 500 ? "error" : "info",
    };
  }

  // Anything else: a bug, a driver error, a library throwing a string. The
  // client learns nothing beyond the request ID, which is what lets support
  // find the log line that has everything.
  return {
    status: 500,
    body: envelope(API_ERROR_CODES.internalError, INTERNAL_MESSAGE, requestId),
    logLevel: "error",
    cause: error,
  };
}

/**
 * Reads field-level details from an application validation error.
 *
 * Structural, not string parsing: the error either carries a typed `details`
 * array or it does not.
 */
function extractDetails(error: ApplicationError): readonly ApiErrorDetail[] | undefined {
  const candidate: unknown = (error as { details?: unknown }).details;
  if (!Array.isArray(candidate)) return undefined;

  const details: ApiErrorDetail[] = [];
  for (const item of candidate) {
    if (typeof item !== "object" || item === null) continue;
    const { field, code, message } = item as Record<string, unknown>;
    if (typeof field === "string" && typeof code === "string" && typeof message === "string") {
      details.push({ field, code, message });
    }
  }
  return details.length > 0 ? details : undefined;
}
