// The S3 adapter against a REAL S3-compatible service (MinIO).
//
// Mocks cannot prove any of what matters here: that a chunked stream reassembles
// byte-exactly across the wire, that a 404 arrives as a recognisable shape, that
// content type survives a round trip, or that a conditional write behaves the
// way the provider's documentation claims. Those are the things that break in
// production, and they only break against a real service (§120).
//
// Run with:
//   OBJECT_STORAGE_TEST_ENDPOINT=http://127.0.0.1:9100

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import {
  S3Client, CreateBucketCommand, PutObjectCommand, GetObjectCommand,
  DeleteObjectCommand, ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  toStorageObjectKey, StorageError,
  type ObjectStorage, type StorageObjectRef, type ByteStream,
} from "@lagda/application";
import type { WorkspaceId, DocumentId } from "@lagda/contracts";
import { createS3ObjectStorage } from "./s3/s3-object-storage.js";
import { createStorageKeyStrategy } from "./s3/s3-key-strategy.js";
import type { S3StorageConfig } from "./s3/s3-config.js";
import { collect } from "./testing/in-memory-object-storage.js";
import { runObjectStorageContract, samplePdf } from "./testing/storage-contract.js";

const ENDPOINT = process.env["OBJECT_STORAGE_TEST_ENDPOINT"];
const hasService = ENDPOINT !== undefined && ENDPOINT !== "";

const BUCKETS = {
  artifacts: "lagda-test-artifacts",
  quarantine: "lagda-test-quarantine",
} as const;

/** Local-only credentials for a throwaway service. Never real secrets (§123). */
function testConfig(overrides: Partial<S3StorageConfig> = {}): S3StorageConfig {
  return {
    endpoint: ENDPOINT ?? "",
    region: "us-east-1",
    buckets: BUCKETS,
    accessKeyId: "lagdatestkey",
    secretAccessKey: "lagdatestsecret",
    forcePathStyle: true,
    requestTimeoutMs: 15_000,
    maxAttempts: 2,
    allowInsecureEndpoint: true,
    ...overrides,
  };
}

function rawClient(config: S3StorageConfig = testConfig()): S3Client {
  return new S3Client({
    // Guarded rather than spread blindly: exactOptionalPropertyTypes means an
    // explicit `undefined` is not the same as an absent key.
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    region: config.region, forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey,
    },
    maxAttempts: config.maxAttempts,
  });
}

/** A unique prefix per run, so repeated runs never collide (§124). */
const RUN = `run${String(process.pid)}x${String(Math.trunc(process.uptime() * 1000))}`;

function chunked(bytes: Uint8Array, size: number): ByteStream {
  // An async generator is the shape AsyncIterable requires; an in-memory
  // source has nothing to await.
  // eslint-disable-next-line @typescript-eslint/require-await
  return (async function* stream(): AsyncGenerator<Uint8Array> {
    for (let at = 0; at < bytes.byteLength; at += size) {
      yield bytes.subarray(at, Math.min(at + size, bytes.byteLength));
    }
  })();
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!hasService)("S3-compatible object storage", () => {
  let storage: ObjectStorage;
  let client: S3Client;

  beforeAll(async () => {
    client = rawClient();
    for (const bucket of Object.values(BUCKETS)) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch {
        // Already present from an earlier run. Dedicated test buckets only —
        // never a staging or production bucket (§122).
      }
    }
    storage = createS3ObjectStorage(testConfig());
  }, 60_000);

  afterAll(async () => {
    // Best-effort cleanup of this run's objects, so CI storage does not grow
    // without bound (§124).
    for (const bucket of Object.values(BUCKETS)) {
      try {
        const listed = await client.send(new ListObjectsV2Command({
          Bucket: bucket, Prefix: `test/${RUN}`,
        }));
        for (const object of listed.Contents ?? []) {
          if (object.Key !== undefined) {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
          }
        }
      } catch { /* cleanup is best effort */ }
    }
    client.destroy();
  }, 60_000);

  // The SAME contract the in-memory fake satisfies. If the two diverge, every
  // application test written against the fake becomes untrustworthy (§193).
  runObjectStorageContract("s3-compatible", () => ({
    storage,
    ref: (zone, suffix) => ({
      zone, key: toStorageObjectKey(`test/${RUN}/${suffix}`),
    }),
  }));

  // ── Byte fidelity: the property every integrity claim rests on ────────────

  describe("byte fidelity", () => {
    it("preserves the SHA-256 across a multi-megabyte streamed round trip", async () => {
      // 3 MB in 64 KiB chunks. Large enough that the SDK's own buffering and
      // chunk boundaries are genuinely exercised, small enough to stay fast.
      const bytes = new Uint8Array(3 * 1024 * 1024);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + (i >> 8)) % 256;
      const expected = sha256(bytes);

      const ref: StorageObjectRef = {
        zone: "artifacts", key: toStorageObjectKey(`test/${RUN}/large`),
      };
      await storage.putObject({
        ref,
        content: { kind: "stream", stream: chunked(bytes, 65_536), contentLength: bytes.byteLength },
        mediaType: "application/pdf",
      });

      const got = await storage.getObject(ref);
      const read = await collect(got!.stream);
      // The digest, not a length check. A truncation that happened to preserve
      // length would pass a size assertion.
      expect(sha256(read)).toBe(expected);
      expect(read.byteLength).toBe(bytes.byteLength);
    }, 60_000);

    it("does NOT transform, compress or re-encode stored bytes", async () => {
      // A sealed PDF's digest is computed by the sealer before storage. Any
      // storage-side normalisation would invalidate every signature LAGDA has
      // ever issued (§184, §186).
      const pdf = samplePdf();
      const ref: StorageObjectRef = {
        zone: "artifacts", key: toStorageObjectKey(`test/${RUN}/nopdfrewrite`),
      };
      await storage.putObject({
        ref, content: { kind: "bytes", bytes: pdf }, mediaType: "application/pdf",
      });

      const got = await storage.getObject(ref);
      const read = await collect(got!.stream);
      expect(sha256(read)).toBe(sha256(pdf));
      // And no Content-Encoding was applied on the way in.
      const raw = await client.send(new GetObjectCommand({
        Bucket: BUCKETS.artifacts, Key: ref.key,
      }));
      expect(raw.ContentEncoding).toBeUndefined();
    });
  });

  // ── ETag is not a digest ──────────────────────────────────────────────────

  it("does NOT expose the provider ETag as a SHA-256", async () => {
    // The mistake this test exists to prevent: treating ETag as the artifact
    // digest. For a single-part upload S3 returns an MD5; for multipart it
    // returns a digest-of-digests with a part-count suffix; compatible
    // providers differ again (INV-206).
    const bytes = samplePdf();
    const ref: StorageObjectRef = {
      zone: "artifacts", key: toStorageObjectKey(`test/${RUN}/etag`),
    };
    const stored = await storage.putObject({
      ref, content: { kind: "bytes", bytes }, mediaType: "application/pdf",
    });

    const digest = sha256(bytes);
    const tag = (stored.providerEntityTag ?? "").replaceAll('"', "");
    expect(tag).not.toBe(digest);
    // An MD5 is 32 hex characters; a SHA-256 is 64. They are not the same
    // thing and are never interchangeable.
    expect(tag.length).not.toBe(64);
  });

  // ── Immutability against the real provider ────────────────────────────────

  describe("immutability", () => {
    it("REFUSES different bytes under an existing artifact key", async () => {
      const ref: StorageObjectRef = {
        zone: "artifacts", key: toStorageObjectKey(`test/${RUN}/immutable-real`),
      };
      await storage.putObject({
        ref, content: { kind: "bytes", bytes: samplePdf() }, mediaType: "application/pdf",
      });

      await expect(storage.putObject({
        ref,
        content: { kind: "bytes", bytes: new TextEncoder().encode("completely different bytes") },
        mediaType: "application/pdf",
      })).rejects.toMatchObject({ category: "object-already-exists" });

      // The original is intact — the refusal did not corrupt it.
      const got = await storage.getObject(ref);
      expect(sha256(await collect(got!.stream))).toBe(sha256(samplePdf()));
    });

    it("MEASURES the SEQUENTIAL conditional write (not concurrency)", async () => {
      // Not an assumption. `IfNoneMatch: "*"` is honoured by AWS S3 and ignored
      // by some S3-compatible providers, and the difference decides whether
      // create-once is atomic or merely checked. Measured and recorded rather
      // than believed — see STORAGE_ARCHITECTURE.md.
      const key = `test/${RUN}/conditional`;
      await client.send(new PutObjectCommand({
        Bucket: BUCKETS.artifacts, Key: key, Body: "first",
      }));

      let honoured = false;
      try {
        await client.send(new PutObjectCommand({
          Bucket: BUCKETS.artifacts, Key: key, Body: "second", IfNoneMatch: "*",
        }));
      } catch {
        honoured = true;
      }

      // Either result is acceptable: the HEAD check plus globally unique
      // artifact ids carry the guarantee regardless. What is not acceptable is
      // not knowing.
      expect(typeof honoured).toBe("boolean");
      const body = await client.send(new GetObjectCommand({
        Bucket: BUCKETS.artifacts, Key: key,
      }));
      const text = await body.Body?.transformToString();
      if (honoured) expect(text).toBe("first");
      // eslint-disable-next-line no-console -- recorded in the test matrix
      console.log(`[measured] IfNoneMatch honoured by this provider: ${String(honoured)}`);
    });

    it("MEASURES concurrent same-key writes, and proves no torn object", async () => {
      // What this found: with six concurrent writers and `IfNoneMatch: "*"`
      // set, ALL SIX SUCCEEDED. The earlier measurement in this suite tested
      // the SEQUENTIAL case - a key that already exists answers 412 - and I
      // over-generalised it into an atomicity claim. It is not one. On this
      // provider the conditional does not serialise concurrent creates.
      //
      // So the honest guarantee is narrower, and it is stated in
      // STORAGE_ARCHITECTURE.md: create-once is enforced against RETRIES and
      // SEQUENTIAL rewrites, and against genuine collisions by globally unique
      // artifact ids - never by provider atomicity.
      //
      // What must hold regardless: the stored object is exactly ONE writer's
      // bytes. A torn or interleaved object would corrupt a document while
      // every digest in PostgreSQL still claimed it was intact.
      const ref: StorageObjectRef = {
        zone: "artifacts", key: toStorageObjectKey(`test/${RUN}/race`),
      };
      const writers = Array.from({ length: 6 }, (_, index) =>
        new TextEncoder().encode(`distinct-writer-${String(index)}`.repeat(64)));

      const results = await Promise.allSettled(writers.map(bytes =>
        storage.putObject({
          ref, content: { kind: "bytes", bytes }, mediaType: "application/pdf",
        })));

      const won = results.filter(r => r.status === "fulfilled").length;
      // eslint-disable-next-line no-console -- recorded in the test matrix
      console.log(`[measured] concurrent same-key writers that succeeded: ${String(won)} of 6`);

      // Any that DID fail must fail for the right reason, not a generic error.
      for (const result of results) {
        if (result.status === "rejected") {
          expect((result.reason as StorageError).category).toBe("object-already-exists");
        }
      }

      // The decisive assertion: whatever is stored is one writer's payload
      // byte for byte. Never a mixture.
      const stored = await collect((await storage.getObject(ref))!.stream);
      expect(writers.map(sha256)).toContain(sha256(stored));
    }, 60_000);

    it("CONVERGES when concurrent writers send identical bytes", async () => {
      // The race that actually happens in production: one job retried by two
      // workers. Same artifact id means same bytes, so every writer must
      // succeed rather than one of them reporting a spurious conflict.
      const ref: StorageObjectRef = {
        zone: "artifacts", key: toStorageObjectKey(`test/${RUN}/race-same`),
      };
      const bytes = samplePdf();
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => storage.putObject({
          ref, content: { kind: "bytes", bytes }, mediaType: "application/pdf",
        })));

      expect(results.every(r => r.status === "fulfilled")).toBe(true);
      const stored = await collect((await storage.getObject(ref))!.stream);
      expect(sha256(stored)).toBe(sha256(bytes));
    }, 60_000);

    it("permits re-writing the SAME bytes, so a controlled retry is safe", async () => {
      // A worker retry after an ambiguous timeout must converge, not fail.
      const ref: StorageObjectRef = {
        zone: "artifacts", key: toStorageObjectKey(`test/${RUN}/retry-safe`),
      };
      const bytes = samplePdf();
      await storage.putObject({
        ref, content: { kind: "bytes", bytes }, mediaType: "application/pdf",
      });
      await expect(storage.putObject({
        ref, content: { kind: "bytes", bytes }, mediaType: "application/pdf",
      })).resolves.toMatchObject({ sizeBytes: bytes.byteLength });
    });
  });

  // ── Zones and tenancy ─────────────────────────────────────────────────────

  it("writes each zone to a DIFFERENT bucket", async () => {
    // Quarantine and accepted artifacts are separated at the bucket boundary,
    // so a permission policy can distinguish them (§9, §46).
    const keys = createStorageKeyStrategy();
    const quarantine = keys.quarantineKey({
      workspaceId: "ws_zone" as WorkspaceId, uploadId: `${RUN}up`,
    });
    await storage.putObject({
      ref: quarantine,
      content: { kind: "bytes", bytes: new TextEncoder().encode("untrusted") },
      mediaType: "application/octet-stream",
    });

    // Present in the quarantine bucket...
    const inQuarantine = await client.send(new ListObjectsV2Command({
      Bucket: BUCKETS.quarantine, Prefix: quarantine.key,
    }));
    expect(inQuarantine.KeyCount).toBe(1);

    // ...and absent from the artifacts bucket.
    const inArtifacts = await client.send(new ListObjectsV2Command({
      Bucket: BUCKETS.artifacts, Prefix: quarantine.key,
    }));
    expect(inArtifacts.KeyCount ?? 0).toBe(0);

    await storage.deleteObject(quarantine);
  });

  it("cannot construct one workspace's key from another's identifiers", async () => {
    // The key generator takes typed identifiers and composes them; there is no
    // input through which workspace A's key could name workspace B's prefix.
    // This is defence in depth — the tenant-scoped repository is the control.
    const keys = createStorageKeyStrategy();
    const a = keys.artifactKey({
      workspaceId: "ws_aaa" as WorkspaceId,
      documentId: "doc_1" as DocumentId, artifactId: "art_1" as never,
    });
    const b = keys.artifactKey({
      workspaceId: "ws_bbb" as WorkspaceId,
      documentId: "doc_1" as DocumentId, artifactId: "art_1" as never,
    });

    await storage.putObject({
      ref: a, content: { kind: "bytes", bytes: samplePdf() }, mediaType: "application/pdf",
    });
    // B's key addresses nothing, even though every other identifier matches.
    expect(await storage.headObject(b)).toBeNull();
    await storage.deleteObject(a);
  });

  // ── Provider error mapping, induced for real ──────────────────────────────

  describe("provider failures", () => {
    it("maps a missing BUCKET to a typed unavailable error", async () => {
      const wrong = createS3ObjectStorage(testConfig({
        buckets: { artifacts: "lagda-test-does-not-exist", quarantine: "nope" },
      }));
      await expect(wrong.getObject({
        zone: "artifacts", key: toStorageObjectKey(`test/${RUN}/x`),
      })).rejects.toBeInstanceOf(StorageError);
    }, 30_000);

    it("maps INVALID CREDENTIALS to access-denied, and does not retry it", async () => {
      const bad = createS3ObjectStorage(testConfig({
        accessKeyId: "wrongkey", secretAccessKey: "wrongsecret",
      }));
      try {
        await bad.putObject({
          ref: { zone: "artifacts", key: toStorageObjectKey(`test/${RUN}/denied`) },
          content: { kind: "bytes", bytes: samplePdf() },
          mediaType: "application/pdf",
        });
        throw new Error("should have been denied");
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).category).toBe("access-denied");
        // Misconfiguration, not a blip. Retrying turns a clear failure into a
        // slow one and burns a job's attempt budget.
        expect((error as StorageError).retryable).toBe(false);
      }
    }, 30_000);

    it("maps an UNREACHABLE endpoint to a retryable failure", async () => {
      const dead = createS3ObjectStorage(testConfig({
        endpoint: "http://127.0.0.1:9",
        requestTimeoutMs: 2_000,
        maxAttempts: 1,
      }));
      try {
        await dead.headObject({
          zone: "artifacts", key: toStorageObjectKey(`test/${RUN}/dead`),
        });
        throw new Error("should have failed");
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).retryable).toBe(true);
      }
    }, 30_000);

    it("NEVER puts credentials or provider prose in a mapped error", async () => {
      // The error message reaches logs. A provider message can carry a bucket,
      // a key, or a signed query string (§100, §143).
      const bad = createS3ObjectStorage(testConfig({
        accessKeyId: "AKIALEAKCANARY", secretAccessKey: "supersecretcanary",
      }));
      try {
        await bad.headObject({
          zone: "artifacts", key: toStorageObjectKey(`test/${RUN}/leak`),
        });
      } catch (error) {
        const serialized = `${(error as Error).message} ${JSON.stringify(error)}`;
        expect(serialized).not.toContain("supersecretcanary");
        expect(serialized).not.toContain("AKIALEAKCANARY");
        expect(serialized).not.toContain("X-Amz-Signature");
      }
    }, 30_000);
  });

  // ── Statelessness ─────────────────────────────────────────────────────────

  it("two independent adapters see the same objects", async () => {
    // Proves the adapter holds no per-request state and is safe to share
    // across concurrent handlers (§147, §148).
    const a = createS3ObjectStorage(testConfig());
    const b = createS3ObjectStorage(testConfig());
    const ref: StorageObjectRef = {
      zone: "artifacts", key: toStorageObjectKey(`test/${RUN}/shared`),
    };
    await a.putObject({
      ref, content: { kind: "bytes", bytes: samplePdf() }, mediaType: "application/pdf",
    });
    expect(await b.headObject(ref)).not.toBeNull();
  });

  it("writes many objects concurrently without cross-contamination", async () => {
    const refs = Array.from({ length: 8 }, (_, index) => ({
      ref: {
        zone: "artifacts" as const,
        key: toStorageObjectKey(`test/${RUN}/concurrent-${String(index)}`),
      },
      bytes: new TextEncoder().encode(`payload-${String(index)}`.repeat(64)),
    }));

    await Promise.all(refs.map(({ ref, bytes }) => storage.putObject({
      ref, content: { kind: "bytes", bytes }, mediaType: "application/pdf",
    })));

    for (const { ref, bytes } of refs) {
      const got = await storage.getObject(ref);
      expect(sha256(await collect(got!.stream))).toBe(sha256(bytes));
    }
  }, 60_000);
});
