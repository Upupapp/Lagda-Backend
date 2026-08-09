// The S3-compatible object storage adapter.
//
// The ONLY file in LAGDA permitted to import an AWS SDK type. Everything above
// it works with `ObjectStorage`, `StorageObjectRef` and `ByteStream`, which is
// what makes the provider replaceable (INV-203).
//
// ── Create-once, and its honest limit ──────────────────────────────────────
//
// Accepted artifacts must never be silently overwritten (INV-205). Two things
// enforce that, and only together:
//
//   1. A HEAD before the write, comparing LAGDA's digest (or size, when no
//      digest was supplied). Reliable for the case that actually happens: a
//      retry, a double-submit, a re-run. Same content converges; different
//      content raises ObjectAlreadyExistsError.
//   2. `IfNoneMatch: "*"` on PUT. AWS S3 supports it; MinIO answers 412 for a
//      key that already exists.
//
// What it is NOT: atomic against concurrent creates. MEASURED on MinIO with six
// simultaneous writers and the header set — ALL SIX SUCCEEDED. An earlier
// version of this comment claimed atomicity on the strength of the sequential
// measurement, which was wrong.
//
// So the real guarantee is: create-once against retries and sequential
// rewrites, and against genuine collisions by GLOBALLY UNIQUE ARTIFACT IDS —
// two distinct artifacts never share a key, so a true race for one key means
// one artifact written twice, where converging is the correct outcome. What is
// proven under concurrency is that the stored object is exactly one writer's
// bytes, never a mixture.

import { Readable } from "node:stream";
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import {
  ObjectAlreadyExistsError, StorageError,
  type ObjectStorage, type PutObjectInput, type StorageObjectRef,
  type StoredObject, type StoredObjectContent, type StoredObjectMetadata,
  type ByteStream, type ObjectContent,
} from "@lagda/application";
import type { S3StorageConfig } from "./s3-config.js";
import { mapStorageError, isNotFound } from "./s3-error-mapper.js";

/**
 * A hard technical ceiling, not a product limit.
 *
 * Plan-level and per-upload size policy belongs to BACKEND-18; this only stops
 * a runaway or malformed length from being handed to the provider (§168).
 */
const MAX_OBJECT_BYTES = 512 * 1024 * 1024;

export function createS3ObjectStorage(config: S3StorageConfig): ObjectStorage {
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // Bounded. The SDK retries transport failures a fixed number of times; the
    // worker retries whole jobs. Two layers, both bounded, both documented — a
    // third would multiply into a retry storm against a struggling provider.
    maxAttempts: config.maxAttempts,
    // Bounded request and connection timeouts, so a hung provider connection
    // cannot wedge a worker indefinitely (§69). The SDK accepts this options
    // object and constructs its own Node HTTP handler from it.
    requestHandler: {
      requestTimeout: config.requestTimeoutMs,
      connectionTimeout: Math.min(config.requestTimeoutMs, 10_000),
    },
  });

  const bucketFor = (ref: StorageObjectRef): string => config.buckets[ref.zone];

  return {
    async putObject(input: PutObjectInput): Promise<StoredObject> {
      const { ref, content, mediaType } = input;
      const contentLength = lengthOf(content);
      if (contentLength > MAX_OBJECT_BYTES) {
        throw new StorageError(
          "write-failed",
          `Object exceeds the ${String(MAX_OBJECT_BYTES)} byte technical maximum.`,
          { retryable: false },
        );
      }

      const immutable = ref.zone === "artifacts";

      // Defence 2, before the write. Quarantine is excluded deliberately:
      // those objects are transient and a re-put there is not an integrity
      // event.
      if (immutable) {
        const existing = await describeExisting(client, bucketFor(ref), ref.key);
        if (existing !== null) {
          // ALREADY PRESENT. Two outcomes, and the difference matters:
          //
          //   same bytes  -> converge. A worker retry after an ambiguous
          //                  timeout must succeed, not fail (§74).
          //   other bytes -> refuse. Two artifacts were given one identity,
          //                  and overwriting destroys the evidence that the
          //                  first ever existed (§75).
          if (!sameContent(existing, contentLength, input)) {
            throw new ObjectAlreadyExistsError(ref);
          }
          return {
            ref,
            sizeBytes: existing.sizeBytes,
            ...(existing.entityTag === undefined
              ? {}
              : { providerEntityTag: existing.entityTag }),
          };
        }
      }

      try {
        const result = await client.send(new PutObjectCommand({
          Bucket: bucketFor(ref),
          Key: ref.key,
          Body: bodyFor(content),
          ContentLength: contentLength,
          ContentType: mediaType,
          // Provider metadata: identifiers only. No filename, no title, no
          // party name — a provider console is not a place customer data
          // should be readable (INV-209).
          Metadata: providerMetadata(input),
          // Defence 2. Honoured sequentially by MinIO and AWS S3; it does NOT
          // serialise concurrent creates on MinIO (measured). Kept because it
          // costs nothing and is a genuine second line on providers that do
          // enforce it - not because it makes this operation atomic.
          ...(immutable ? { IfNoneMatch: "*" } : {}),
        }));

        return {
          ref,
          sizeBytes: contentLength,
          // Diagnostics only. NEVER a SHA-256 — see INV-206.
          ...(result.ETag === undefined ? {} : { providerEntityTag: result.ETag }),
        };
      } catch (error) {
        if (isPreconditionFailed(error)) {
          // Lost the race. Whoever won may have written the same bytes (two
          // workers retrying one job) or different ones (a real collision).
          // Re-read and decide, rather than assuming either.
          const winner = await describeExisting(client, bucketFor(ref), ref.key);
          if (winner !== null && sameContent(winner, contentLength, input)) {
            return {
              ref,
              sizeBytes: winner.sizeBytes,
              ...(winner.entityTag === undefined
                ? {}
                : { providerEntityTag: winner.entityTag }),
            };
          }
          throw new ObjectAlreadyExistsError(ref);
        }
        throw mapStorageError(error, "write-failed", "put");
      }
    },

    async getObject(ref: StorageObjectRef): Promise<StoredObjectContent | null> {
      try {
        const result = await client.send(new GetObjectCommand({
          Bucket: bucketFor(ref), Key: ref.key,
        }));
        if (result.Body === undefined) {
          throw new StorageError("read-failed", "Object storage returned no body.");
        }
        return {
          ref,
          sizeBytes: result.ContentLength ?? 0,
          mediaType: result.ContentType ?? "application/octet-stream",
          // The SDK's body is already an async iterable of chunks. Exposed as
          // `ByteStream` so no SDK type crosses the port, and NOT buffered
          // here — buffering would make every download hold a whole document
          // in memory (§27).
          stream: toByteStream(result.Body),
        };
      } catch (error) {
        // Absence is an answer, not a failure. Mapping a 404 to a 500 is how a
        // missing object becomes an opaque incident (§66).
        if (isNotFound(error)) return null;
        throw mapStorageError(error, "read-failed", "get");
      }
    },

    async headObject(ref: StorageObjectRef): Promise<StoredObjectMetadata | null> {
      try {
        const result = await client.send(new HeadObjectCommand({
          Bucket: bucketFor(ref), Key: ref.key,
        }));
        return {
          ref,
          sizeBytes: result.ContentLength ?? 0,
          mediaType: result.ContentType ?? "application/octet-stream",
          // The PROVIDER's clock. Operational only: artifact creation time
          // lives in PostgreSQL and is what evidence refers to (§173).
          ...(result.LastModified === undefined
            ? {}
            : { lastModified: result.LastModified.getTime() }),
          ...(result.ETag === undefined ? {} : { providerEntityTag: result.ETag }),
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw mapStorageError(error, "read-failed", "head");
      }
    },

    async deleteObject(ref: StorageObjectRef): Promise<void> {
      try {
        await client.send(new DeleteObjectCommand({
          Bucket: bucketFor(ref), Key: ref.key,
        }));
      } catch (error) {
        // Idempotent by design: cleanup workflows re-run, and "already gone"
        // is the outcome they wanted (§136).
        if (isNotFound(error)) return;
        throw mapStorageError(error, "write-failed", "delete");
      }
    },
  };
}

function lengthOf(content: ObjectContent): number {
  return content.kind === "bytes" ? content.bytes.byteLength : content.contentLength;
}

/**
 * Bytes are wrapped into a single-chunk stream so there is ONE write path.
 *
 * The convenience of accepting a `Uint8Array` (a sealed PDF already in memory)
 * does not justify a second code path with its own bugs (§30).
 *
 * `Readable.from` is the conversion from LAGDA's neutral `AsyncIterable` to
 * what the SDK accepts. It belongs HERE and nowhere higher: the whole reason
 * the port speaks `AsyncIterable<Uint8Array>` is that a Node stream type in an
 * application signature would spread to every caller. It also streams rather
 * than buffers, so a large upload never materialises in memory (§27).
 */
function bodyFor(content: ObjectContent): Readable | Uint8Array {
  // BYTES STAY BYTES. Wrapping an in-memory array in a stream was the earlier
  // shape, justified as "one write path" - and it silently made every small
  // upload NON-RETRYABLE, because the SDK cannot rewind a stream in order to
  // retry it. The real service said exactly that: "An error was encountered in
  // a non-retryable streaming request." A tidier code path is not worth losing
  // transport retries on every sealed PDF.
  if (content.kind === "bytes") return content.bytes;
  // A genuine stream is unrewindable regardless, so nothing is lost by
  // streaming it - and buffering it to regain retries would defeat the reason
  // streaming exists at all (§27).
  return Readable.from(content.stream);
}

/** Size, LAGDA digest and entity tag of an object that already exists. */
interface ExistingObject {
  readonly sizeBytes: number;
  readonly digest?: string;
  readonly entityTag?: string;
}

async function describeExisting(
  client: S3Client, bucket: string, key: string,
): Promise<ExistingObject | null> {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const digest = head.Metadata?.["lagda-sha256"];
    return {
      sizeBytes: head.ContentLength ?? 0,
      ...(digest === undefined ? {} : { digest }),
      ...(head.ETag === undefined ? {} : { entityTag: head.ETag }),
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw mapStorageError(error, "read-failed", "head");
  }
}

/**
 * Whether an existing object holds the same content as the incoming write.
 *
 * Prefers LAGDA's SHA-256, which the writer stores as provider metadata. Falls
 * back to content length when either side lacks a digest - weaker, and
 * deliberately so: the alternative is refusing every legitimate retry, and
 * length still catches the case that actually matters, a different document
 * written under one artifact identity.
 */
function sameContent(
  existing: ExistingObject, contentLength: number, input: PutObjectInput,
): boolean {
  const incoming = input.metadata?.digest;
  if (existing.digest !== undefined && incoming !== undefined) {
    return existing.digest === incoming;
  }
  return existing.sizeBytes === contentLength;
}

function providerMetadata(input: PutObjectInput): Record<string, string> {
  const metadata: Record<string, string> = {};
  const source = input.metadata;
  if (source === undefined) return metadata;
  if (source.artifactId !== undefined) metadata["lagda-artifact-id"] = source.artifactId;
  if (source.workspaceId !== undefined) metadata["lagda-workspace-id"] = source.workspaceId;
  // LAGDA's digest, for an operator diagnosing a mismatch. The PostgreSQL
  // integrity record stays authoritative; nothing reads this back as truth.
  if (source.digest !== undefined) metadata["lagda-sha256"] = source.digest;
  return metadata;
}

/**
 * Normalises the SDK body to `AsyncIterable<Uint8Array>`.
 *
 * The v3 body is a Node `Readable` on Node, which is already async-iterable, so
 * this is mostly a type boundary. It is a real conversion for a web stream,
 * which is what a future non-Node runtime would produce.
 */
function toByteStream(body: unknown): ByteStream {
  if (isAsyncIterable(body)) return body;
  if (isWebStream(body)) {
    return (async function* fromReader(): AsyncGenerator<Uint8Array> {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) yield value;
        }
      } finally {
        // Releases the socket when a caller abandons the stream mid-download.
        reader.releaseLock();
      }
    })();
  }
  throw new StorageError("read-failed", "Object storage returned an unreadable body.");
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === "object" && value !== null
    && Symbol.asyncIterator in value;
}

function isWebStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof value === "object" && value !== null
    && typeof (value as { getReader?: unknown }).getReader === "function";
}

function isPreconditionFailed(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const shaped = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return shaped.name === "PreconditionFailed"
    || shaped.$metadata?.httpStatusCode === 412;
}
