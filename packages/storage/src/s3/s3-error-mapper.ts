// Provider errors into LAGDA categories.
//
// Mapped on STRUCTURE — the SDK's error name and the HTTP status — never by
// matching human-readable message text. Provider wording differs between AWS,
// MinIO and every other S3-compatible service, and it changes without notice;
// a substring match is a detector that silently stops detecting.

import { StorageError, type StorageErrorCategory } from "@lagda/application";

/**
 * The structured shape an AWS SDK v3 error carries.
 *
 * Declared locally rather than imported so that no SDK type appears in a
 * signature, and read defensively: anything can be thrown, including a bare
 * string from a broken transport.
 */
interface ProviderErrorShape {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly $metadata?: { readonly httpStatusCode?: unknown; readonly requestId?: unknown };
  readonly Code?: unknown;
  readonly code?: unknown;
}

/** Names S3-compatible providers use for the conditions LAGDA cares about. */
const BY_ERROR_NAME: ReadonlyMap<string, StorageErrorCategory> = new Map([
  ["NoSuchKey", "object-not-found"],
  ["NotFound", "object-not-found"],
  ["NoSuchBucket", "unavailable"],
  ["AccessDenied", "access-denied"],
  ["InvalidAccessKeyId", "access-denied"],
  ["SignatureDoesNotMatch", "access-denied"],
  ["AllAccessDisabled", "access-denied"],
  ["PreconditionFailed", "object-already-exists"],
  ["TimeoutError", "timeout"],
  ["RequestTimeout", "timeout"],
  ["ServiceUnavailable", "unavailable"],
  ["SlowDown", "unavailable"],
  ["InternalError", "unavailable"],
]);

/** Node transport failures, which never reach the SDK's own error vocabulary. */
const BY_SYSTEM_CODE: ReadonlyMap<string, StorageErrorCategory> = new Map([
  ["ECONNREFUSED", "unavailable"],
  ["ENOTFOUND", "unavailable"],
  ["ECONNRESET", "unavailable"],
  ["EPIPE", "unavailable"],
  ["ETIMEDOUT", "timeout"],
  ["ERR_SOCKET_CONNECTION_TIMEOUT", "timeout"],
  ["ABORT_ERR", "timeout"],
]);

function categoryFromStatus(status: number): StorageErrorCategory | undefined {
  if (status === 404) return "object-not-found";
  if (status === 403 || status === 401) return "access-denied";
  if (status === 412 || status === 409) return "object-already-exists";
  if (status === 408) return "timeout";
  if (status === 429 || status >= 500) return "unavailable";
  return undefined;
}

/**
 * Translates a thrown provider error.
 *
 * `fallback` says what a genuinely unrecognised failure means for the operation
 * in progress: a failed read is `read-failed`, a failed write is
 * `write-failed`. Both are retryable, which is the safe default for "something
 * went wrong in the transport" — unlike `access-denied`, which is a
 * misconfiguration and gains nothing from being retried.
 */
export function mapStorageError(
  error: unknown,
  fallback: StorageErrorCategory,
  context: string,
): StorageError {
  if (error instanceof StorageError) return error;

  const shaped: ProviderErrorShape = typeof error === "object" && error !== null
    ? error
    : {};

  const name = typeof shaped.name === "string" ? shaped.name : undefined;
  const providerCode = typeof shaped.Code === "string"
    ? shaped.Code
    : typeof shaped.code === "string" ? shaped.code : undefined;
  const status = typeof shaped.$metadata?.httpStatusCode === "number"
    ? shaped.$metadata.httpStatusCode
    : undefined;
  const requestId = typeof shaped.$metadata?.requestId === "string"
    ? shaped.$metadata.requestId
    : undefined;

  const category =
    (name === undefined ? undefined : BY_ERROR_NAME.get(name))
    ?? (providerCode === undefined ? undefined : BY_ERROR_NAME.get(providerCode))
    ?? (providerCode === undefined ? undefined : BY_SYSTEM_CODE.get(providerCode))
    ?? (name === undefined ? undefined : BY_SYSTEM_CODE.get(name))
    ?? (status === undefined ? undefined : categoryFromStatus(status))
    ?? fallback;

  // The message names the OPERATION, not the provider's prose. Provider text
  // can contain a bucket name, a key or a signed query string, and this message
  // reaches logs (§100).
  return new StorageError(category, `Object storage ${context} failed.`, {
    ...(requestId === undefined ? {} : { providerRequestId: requestId }),
    cause: error,
  });
}

/**
 * A 404 that is an expected answer rather than a failure.
 *
 * NoSuchBucket is EXCLUDED even though it also answers 404. A missing bucket is
 * a misconfiguration, and treating it as "object not found" would make every
 * document in the system silently report as absent instead of raising an
 * infrastructure error — a total outage presented to users as an empty account.
 * Found by pointing the adapter at a bucket that does not exist.
 */
export function isNotFound(error: unknown): boolean {
  const shaped: ProviderErrorShape = typeof error === "object" && error !== null
    ? error
    : {};
  const name = typeof shaped.name === "string" ? shaped.name : "";
  const code = typeof shaped.Code === "string" ? shaped.Code : "";
  if (name === "NoSuchBucket" || code === "NoSuchBucket") return false;

  const status = typeof shaped.$metadata?.httpStatusCode === "number"
    ? shaped.$metadata.httpStatusCode
    : 0;
  return name === "NoSuchKey" || name === "NotFound"
    || code === "NoSuchKey" || status === 404;
}
