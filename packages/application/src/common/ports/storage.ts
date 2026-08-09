// Object storage.
//
// PostgreSQL stores what an artifact IS — ownership, digest, provenance,
// lifecycle. Object storage stores the bytes. This port is the seam between
// them, and it is owned here so that replacing the provider is an adapter
// change rather than a business-logic change (INV-203).
//
// Nothing in this file names S3, a bucket, an SDK type or a URL. That is not
// stylistic: `@lagda/application` is imported by the API, the worker and every
// use case, and a provider type here would spread through all of them.

import type { WorkspaceId, DocumentId, Sha256Digest } from "@lagda/contracts";
import type { ArtifactId } from "./evidence.js";

// ── Storage zones ────────────────────────────────────────────────────────────

/**
 * Logical storage locations, separated by TRUST rather than by convenience.
 *
 * A closed union, not a bucket string. The application says "this belongs in
 * quarantine"; only the adapter knows which bucket that is (INV-208). An
 * arbitrary string here would let a caller invent a zone, and the first typo
 * would write documents somewhere with no access policy at all.
 */
export const STORAGE_ZONES = ["quarantine", "artifacts"] as const;
export type StorageZone = (typeof STORAGE_ZONES)[number];

// ── Object keys ──────────────────────────────────────────────────────────────

/**
 * An internal object key.
 *
 * Branded, so a bare string from a request body cannot become one by assignment.
 * That matters more here than in most places: the whole tenancy argument for
 * storage rests on keys being DERIVED from authorized identifiers, never
 * accepted from a client (INV-205).
 *
 * The key is infrastructure identity. It is never returned by a public API and
 * never appears in a frontend contract.
 */
export type StorageObjectKey = string & { readonly __brand: "StorageObjectKey" };

/** Keys are bounded and free of anything that could be read as a path trick. */
const MAX_KEY_LENGTH = 512;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * The ONLY validating constructor for a key.
 *
 * Rejects traversal segments, absolute paths, doubled separators, control
 * characters and anything over the column width that stores it. A key that
 * fails here is a programming error, not user input — user input never reaches
 * this function.
 */
export function toStorageObjectKey(value: string): StorageObjectKey {
  if (value.length === 0 || value.length > MAX_KEY_LENGTH) {
    throw new InvalidStorageReferenceError(
      `Storage key must be 1-${String(MAX_KEY_LENGTH)} characters.`,
    );
  }
  if (!KEY_PATTERN.test(value)) {
    throw new InvalidStorageReferenceError(
      "Storage key contains characters outside the permitted set.",
    );
  }
  // Checked explicitly rather than left to the pattern, so the error names the
  // actual hazard instead of "did not match a regular expression".
  if (value.includes("..") || value.includes("//") || value.endsWith("/")) {
    throw new InvalidStorageReferenceError(
      "Storage key must not contain traversal segments, empty segments or a trailing separator.",
    );
  }
  return value as StorageObjectKey;
}

/**
 * A stored object's full internal identity: which zone, which key.
 *
 * Deliberately NOT a URL and NOT a bucket name. A URL would either expire (a
 * presigned URL is a credential) or imply public reachability, and both are
 * wrong to persist (INV-207).
 */
export interface StorageObjectRef {
  readonly zone: StorageZone;
  readonly key: StorageObjectKey;
}

// ── Content ──────────────────────────────────────────────────────────────────

/**
 * The binary abstraction, chosen once for the whole codebase.
 *
 * `AsyncIterable<Uint8Array>` rather than a Node `Readable` or an SDK stream
 * wrapper: it is a language-level protocol, `for await` consumes it, Node
 * streams already satisfy it, and no provider type appears in an application
 * signature (INV-204).
 *
 * The cost is that backpressure is the iterator's business rather than a
 * stream's. That is acceptable here — the adapter hands the SDK an object it
 * understands, and the SDK does the flow control.
 */
export type ByteStream = AsyncIterable<Uint8Array>;

/**
 * Content going in: a stream, or bytes when the caller already has them.
 *
 * Both, deliberately. Forcing stream plumbing on a caller that holds a sealed
 * PDF in memory is ceremony; forcing a 200 MB upload through a byte array is a
 * memory incident. The adapter converts bytes to a stream internally, so there
 * is one write path (§30).
 */
export type ObjectContent =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "stream"; readonly stream: ByteStream; readonly contentLength: number };

export interface PutObjectInput {
  readonly ref: StorageObjectRef;
  readonly content: ObjectContent;
  /**
   * The VALIDATED media type, not the browser's claim. For accepted PDFs this
   * is `application/pdf` because a pipeline proved it, never because a filename
   * ended in `.pdf` (§39).
   */
  readonly mediaType: string;
  /**
   * Operational metadata only. Never customer filenames, names, addresses or
   * anything else that would end up readable in a provider console (INV-209).
   */
  readonly metadata?: {
    readonly artifactId?: ArtifactId;
    readonly workspaceId?: WorkspaceId;
    /**
     * LAGDA's digest, stored alongside the bytes for operational diagnosis.
     * The PostgreSQL integrity record stays authoritative; this is a
     * convenience for an operator, not a second source of truth (§33).
     */
    readonly digest?: Sha256Digest;
  };
}

export interface StoredObject {
  readonly ref: StorageObjectRef;
  readonly sizeBytes: number;
  /**
   * The provider's entity tag, for diagnostics ONLY.
   *
   * It is NOT a SHA-256 and must never be treated as one. For a multipart
   * upload S3 returns a digest-of-digests with a part suffix; even for a single
   * part it is an MD5, and some S3-compatible providers compute it differently
   * again. LAGDA's digest is computed by LAGDA (INV-206).
   */
  readonly providerEntityTag?: string;
}

export interface StoredObjectMetadata {
  readonly ref: StorageObjectRef;
  readonly sizeBytes: number;
  readonly mediaType: string;
  /**
   * The provider's clock, for operations. NOT artifact creation time and never
   * signing evidence — `document_artifacts.created_at` is authoritative (§173).
   */
  readonly lastModified?: number;
  readonly providerEntityTag?: string;
}

export interface StoredObjectContent {
  readonly ref: StorageObjectRef;
  readonly sizeBytes: number;
  readonly mediaType: string;
  /**
   * Consume exactly once. Abandoning it without consuming leaves a socket open
   * until the client times out, so a caller that gives up must break out of the
   * loop, which closes the underlying stream.
   */
  readonly stream: ByteStream;
}

// ── The port ─────────────────────────────────────────────────────────────────

/**
 * Provider-neutral object storage.
 *
 * Four operations, all broadly supported by S3-compatible providers. Nothing
 * exotic: obscure features are where compatibility claims quietly stop being
 * true (§117).
 */
export interface ObjectStorage {
  // Declared as PROPERTIES, not method shorthand. No implementation uses
  // `this`, and a consumer that destructures one capability off an injected
  // object is doing something normal - method shorthand makes that look like a
  // possible `this` bug to both the type checker and the linter.

  /**
   * Writes an object.
   *
   * CREATE-ONCE for the `artifacts` zone: writing different bytes to a key that
   * already holds an accepted artifact is an integrity failure, not an update
   * (INV-205). See the adapter for exactly how far the provider can enforce
   * this and where LAGDA's key uniqueness carries it instead.
   */
  readonly putObject: (input: PutObjectInput) => Promise<StoredObject>;

  /** Returns a stream. `null` when the object does not exist. */
  readonly getObject: (ref: StorageObjectRef) => Promise<StoredObjectContent | null>;

  /** Metadata without transferring bytes. `null` when absent. */
  readonly headObject: (ref: StorageObjectRef) => Promise<StoredObjectMetadata | null>;

  /**
   * Deletes an object. Idempotent: deleting an absent object succeeds.
   *
   * A PRIVILEGED primitive. It exists for quarantine cleanup and, later, for
   * retention workflows that BACKEND-55 owns. No tenant-facing use case calls
   * it, and accepted evidence artifacts are not deleted through ordinary
   * product flows (§50, §52).
   */
  readonly deleteObject: (ref: StorageObjectRef) => Promise<void>;
}

// ── Key construction ─────────────────────────────────────────────────────────

/**
 * Builds keys from trusted identifiers.
 *
 * A port rather than a loose function because the layout is infrastructure
 * knowledge: the application knows *which artifact*, not *where bytes live*.
 */
export interface StorageKeyStrategy {
  readonly artifactKey: (input: {
    readonly workspaceId: WorkspaceId;
    readonly documentId: DocumentId;
    readonly artifactId: ArtifactId;
  }) => StorageObjectRef;

  /**
   * A quarantine key for an upload that has not been accepted.
   *
   * Takes an upload identifier, NOT an artifact identifier, and that is the
   * point: untrusted bytes must not be given the identity of an accepted
   * artifact before anything has validated them (§163). Promotion mints a new
   * artifact identity.
   */
  readonly quarantineKey: (input: {
    readonly workspaceId: WorkspaceId;
    readonly uploadId: string;
  }) => StorageObjectRef;
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Storage failure categories.
 *
 * LAGDA-owned. An SDK error reaching a use case would make business code branch
 * on provider vocabulary, and the branch would be silently wrong the day the
 * provider changes (INV-210).
 */
export type StorageErrorCategory =
  | "object-not-found"
  | "object-already-exists"
  | "invalid-storage-reference"
  | "integrity-mismatch"
  | "access-denied"
  | "unavailable"
  | "timeout"
  | "read-failed"
  | "write-failed";

export class StorageError extends Error {
  readonly category: StorageErrorCategory;
  /**
   * Whether a later attempt could plausibly succeed.
   *
   * Consumed by the worker's retry policy. `access-denied` is deliberately NOT
   * retryable: it is a misconfiguration, and retrying it turns a clear failure
   * into a slow one.
   */
  readonly retryable: boolean;
  /** Provider request id, when available. Useful in a support ticket. */
  readonly providerRequestId?: string;

  constructor(
    category: StorageErrorCategory,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly providerRequestId?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "StorageError";
    this.category = category;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(category);
    if (options.providerRequestId !== undefined) {
      this.providerRequestId = options.providerRequestId;
    }
  }
}

/** Infrastructure trouble that may pass. Everything else is a bug or a state fact. */
const RETRYABLE_BY_DEFAULT = new Set<StorageErrorCategory>([
  "unavailable",
  "timeout",
  "read-failed",
  "write-failed",
]);

export class InvalidStorageReferenceError extends StorageError {
  constructor(message: string) {
    super("invalid-storage-reference", message, { retryable: false });
    this.name = "InvalidStorageReferenceError";
  }
}

/**
 * Different bytes were written under a key that already holds an artifact.
 *
 * Never recoverable by retrying, and never resolved by overwriting. It means
 * two different artifacts were given one identity, and the correct response is
 * to fail loudly (§75).
 */
export class ObjectAlreadyExistsError extends StorageError {
  constructor(ref: StorageObjectRef) {
    super(
      "object-already-exists",
      `An object already exists at ${ref.zone}:${ref.key} and immutable artifacts are never overwritten.`,
      { retryable: false },
    );
    this.name = "ObjectAlreadyExistsError";
  }
}

/** Bytes did not match what was expected. Never deliver them. */
export class StorageIntegrityError extends StorageError {
  constructor(message: string) {
    super("integrity-mismatch", message, { retryable: false });
    this.name = "StorageIntegrityError";
  }
}
