// An in-memory ObjectStorage, for application tests that need storage to exist
// but are not testing storage.
//
// It is NOT evidence that the S3 adapter works. The shared contract suite runs
// against both, so the fake cannot drift into behaviour the real adapter does
// not have — but provider behaviour (headers, streams, error shapes, conditional
// writes) is only ever proven against a real S3-compatible service (§191).

import {
  ObjectAlreadyExistsError,
  type ByteStream, type ObjectStorage, type PutObjectInput,
  type StorageObjectRef, type StoredObject, type StoredObjectContent,
  type StoredObjectMetadata,
} from "@lagda/application";

interface StoredEntry {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly lastModified: number;
}

export interface InMemoryObjectStorage extends ObjectStorage {
  /** Object count, for assertions about cleanup. */
  readonly size: number;
  clear(): void;
}

export function createInMemoryObjectStorage(
  options: { readonly now?: () => number } = {},
): InMemoryObjectStorage {
  const objects = new Map<string, StoredEntry>();
  const now = options.now ?? ((): number => 0);
  const idOf = (ref: StorageObjectRef): string => `${ref.zone}:${ref.key}`;

  return {
    get size(): number { return objects.size; },
    clear(): void { objects.clear(); },

    async putObject(input: PutObjectInput): Promise<StoredObject> {
      const bytes = await collect(input.content.kind === "bytes"
        ? single(input.content.bytes)
        : input.content.stream);

      const id = idOf(input.ref);
      const existing = objects.get(id);
      if (existing !== undefined && input.ref.zone === "artifacts") {
        // Same immutability rule as the real adapter. A fake that permits an
        // overwrite would let a test pass against behaviour production forbids.
        if (!equalBytes(existing.bytes, bytes)) {
          throw new ObjectAlreadyExistsError(input.ref);
        }
      }

      // COPIED on the way in. Storing the caller's array would let a test
      // mutate it afterwards and silently change "stored" content (§192).
      objects.set(id, {
        bytes: Uint8Array.from(bytes),
        mediaType: input.mediaType,
        lastModified: now(),
      });
      return { ref: input.ref, sizeBytes: bytes.byteLength };
    },

    getObject(ref: StorageObjectRef): Promise<StoredObjectContent | null> {
      const entry = objects.get(idOf(ref));
      if (entry === undefined) return Promise.resolve(null);
      // Copied on the way out too, for the same reason.
      const copy = Uint8Array.from(entry.bytes);
      return Promise.resolve({
        ref,
        sizeBytes: copy.byteLength,
        mediaType: entry.mediaType,
        stream: single(copy),
      });
    },

    headObject(ref: StorageObjectRef): Promise<StoredObjectMetadata | null> {
      const entry = objects.get(idOf(ref));
      if (entry === undefined) return Promise.resolve(null);
      return Promise.resolve({
        ref,
        sizeBytes: entry.bytes.byteLength,
        mediaType: entry.mediaType,
        lastModified: entry.lastModified,
      });
    },

    deleteObject(ref: StorageObjectRef): Promise<void> {
      // Idempotent, matching the adapter.
      objects.delete(idOf(ref));
      return Promise.resolve();
    },
  };
}

function single(bytes: Uint8Array): ByteStream {
  // An async generator is the shape AsyncIterable requires; an in-memory
  // source has nothing to await.
  // eslint-disable-next-line @typescript-eslint/require-await
  return (async function* one(): AsyncGenerator<Uint8Array> { yield bytes; })();
}

/** Drains a stream into one array. Test-only: production streams straight through. */
export async function collect(stream: ByteStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
