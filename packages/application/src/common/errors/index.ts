// Application errors.
//
// HTTP-independent by construction: no status code, no header, no log level.
// BACKEND-03 defined the category → status mapping, and BACKEND-11 will apply
// it at the boundary. Keeping the number out of here is what lets one use case
// serve an HTTP route, a worker, and a future partner API.

/**
 * Categories, matching the API conventions so the boundary mapping is a lookup
 * rather than a judgement.
 */
export const APPLICATION_ERROR_CATEGORIES = [
  "validation", "authentication", "authorization",
  "not-found", "gone", "conflict", "rate-limit",
  "dependency-unavailable", "internal",
] as const;

// `gone` and `rate-limit` were MISSING until BACKEND-11, even though the comment
// above claimed this list matched the API conventions. The API's explicit total
// category map is what caught it.
//
// `gone` is the one that mattered: API_CONVENTIONS states an expired signing
// request "is not 'not found' — the recipient screen needs the difference to
// explain what happened". Without the category, a use case could only report
// `not-found` or `conflict`, and the 410 the conventions require would have been
// unreachable from the application layer.
export type ApplicationErrorCategory = (typeof APPLICATION_ERROR_CATEGORIES)[number];

/**
 * Base application error.
 *
 * `cause` is preserved for diagnosis but is deliberately NOT part of any
 * contract — serializing it is how a SQL string or a stack trace reaches a
 * client. Messages name resources by kind, never by value: "Workspace not
 * found", never `Workspace ws_123 owned by juan@example.com not found`.
 */
export abstract class ApplicationError extends Error {
  abstract readonly category: ApplicationErrorCategory;
  abstract readonly code: string;

  // `override` because Error already declares `cause`. Narrowing it here keeps
  // the diagnostic value while making it explicit that this is the same slot.
  protected constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = new.target.name;
  }
}

/** A resource does not exist, or is not visible in the caller's scope. */
export class ResourceNotFoundError extends ApplicationError {
  readonly category = "not-found" as const;
  readonly code = "resource_not_found";

  constructor(readonly resource: string) {
    super(`${resource} was not found.`);
  }
}

/**
 * The requested change conflicts with current state.
 *
 * Where domain rules are violated, this is what an `InvalidStateTransitionError`
 * becomes — translated deliberately, so an internal domain vocabulary never
 * reaches a client and can change without breaking one.
 */
export class ResourceConflictError extends ApplicationError {
  readonly category = "conflict" as const;
  readonly code = "resource_conflict";

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

/** Input is well-formed but violates a rule requiring authoritative state. */
export class ApplicationValidationError extends ApplicationError {
  readonly category = "validation" as const;
  readonly code = "validation_failed";

  constructor(message: string, readonly issues: readonly string[] = []) {
    super(message);
  }
}

/**
 * The actor is known but may not perform this action.
 *
 * Distinct from not-found on purpose. Where revealing the difference would
 * confirm another workspace's resource exists, the caller returns not-found
 * instead — a decision made per operation, not globally, and one that
 * security-sensitive commands may deliberately collapse further.
 */
export class AccessDeniedError extends ApplicationError {
  readonly category = "authorization" as const;
  readonly code = "access_denied";

  constructor(action: string) {
    super(`Not permitted: ${action}.`);
  }
}

/** An external dependency failed in a way that may succeed on retry. */
export class DependencyUnavailableError extends ApplicationError {
  readonly category = "dependency-unavailable" as const;
  readonly code = "dependency_unavailable";

  constructor(dependency: string, cause?: unknown) {
    super(`${dependency} is unavailable.`, cause);
  }
}
