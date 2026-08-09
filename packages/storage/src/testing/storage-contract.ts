// The behavioural contract every ObjectStorage implementation must satisfy.
//
// Run against the in-memory fake AND the real S3 adapter. That is the point: a
// fake whose behaviour has quietly diverged from the adapter makes every
// application test that uses it a lie. Provider-specific behaviour — headers,
// conditional writes, error shapes — is tested separately, against a real
// service (§193).

import { describe, it, expect } from "vitest";
import {
  ObjectAlreadyExistsError,
  type ObjectStorage, type StorageObjectRef, type ByteStream,
} from "@lagda/application";
import { collect } from "./in-memory-object-storage.js";

export interface ContractHarness {
  readonly storage: ObjectStorage;
  /** A ref unique to this test run, so parallel runs cannot collide. */
  readonly ref: (zone: "artifacts" | "quarantine", suffix: string) => StorageObjectRef;
}

function chunked(bytes: Uint8Array, chunkSize: number): ByteStream {
  // An async generator is the shape AsyncIterable requires; an in-memory
  // source has nothing to await.
  // eslint-disable-next-line @typescript-eslint/require-await
  return (async function* stream(): AsyncGenerator<Uint8Array> {
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
    }
  })();
}

/** A small syntactically valid PDF. Synthetic — never a customer document. */
export function samplePdf(): Uint8Array {
  return new TextEncoder().encode(
    "%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  );
}

export function runObjectStorageContract(
  name: string,
  createHarness: () => ContractHarness,
): void {
  describe(`ObjectStorage contract: ${name}`, () => {
    it("round-trips bytes EXACTLY", async () => {
      // The single most important property. A digest computed before the write
      // must still describe the bytes after the read, or every integrity claim
      // LAGDA makes about a document is void.
      const { storage, ref } = createHarness();
      const target = ref("artifacts", "roundtrip");
      const bytes = samplePdf();

      await storage.putObject({
        ref: target, content: { kind: "bytes", bytes }, mediaType: "application/pdf",
      });

      const got = await storage.getObject(target);
      expect(got).not.toBeNull();
      const read = await collect(got!.stream);
      expect(Array.from(read)).toEqual(Array.from(bytes));
    });

    it("round-trips a CHUNKED stream without reassembly errors", async () => {
      // Deliberately many small chunks. A one-chunk test passes even if the
      // implementation only ever reads the first chunk (§130).
      const { storage, ref } = createHarness();
      const target = ref("artifacts", "chunked");
      const bytes = new Uint8Array(300_000);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31) % 251;

      await storage.putObject({
        ref: target,
        content: { kind: "stream", stream: chunked(bytes, 8_192), contentLength: bytes.byteLength },
        mediaType: "application/pdf",
      });

      const got = await storage.getObject(target);
      const read = await collect(got!.stream);
      expect(read.byteLength).toBe(bytes.byteLength);
      // Compared as a digest-like scan rather than element by element, so a
      // failure message stays readable.
      expect(read.every((value, index) => value === bytes[index])).toBe(true);
    });

    it("reports size and media type from head", async () => {
      const { storage, ref } = createHarness();
      const target = ref("artifacts", "head");
      const bytes = samplePdf();
      await storage.putObject({
        ref: target, content: { kind: "bytes", bytes }, mediaType: "application/pdf",
      });

      const meta = await storage.headObject(target);
      expect(meta?.sizeBytes).toBe(bytes.byteLength);
      expect(meta?.mediaType).toBe("application/pdf");
    });

    it("returns null for a missing object rather than throwing", async () => {
      // Absence is an answer. A provider 404 turned into a 500 makes a normal
      // condition indistinguishable from an outage (§66).
      const { storage, ref } = createHarness();
      const missing = ref("artifacts", "never-written");
      expect(await storage.getObject(missing)).toBeNull();
      expect(await storage.headObject(missing)).toBeNull();
    });

    it("REFUSES different bytes under an existing artifact key", async () => {
      // Immutability. Accepting this write would destroy the only evidence the
      // earlier bytes existed, and leave a digest in PostgreSQL describing
      // content the object no longer holds (INV-205).
      const { storage, ref } = createHarness();
      const target = ref("artifacts", "immutable");
      await storage.putObject({
        ref: target, content: { kind: "bytes", bytes: samplePdf() },
        mediaType: "application/pdf",
      });

      await expect(storage.putObject({
        ref: target,
        content: { kind: "bytes", bytes: new TextEncoder().encode("%PDF-1.7 different") },
        mediaType: "application/pdf",
      })).rejects.toBeInstanceOf(ObjectAlreadyExistsError);

      // And the original survives untouched.
      const got = await storage.getObject(target);
      expect(Array.from(await collect(got!.stream))).toEqual(Array.from(samplePdf()));
    });

    it("deletes, and deleting a missing object succeeds", async () => {
      // Idempotent, because cleanup workflows re-run and "already gone" is the
      // outcome they wanted (§136).
      const { storage, ref } = createHarness();
      const target = ref("quarantine", "delete");
      await storage.putObject({
        ref: target, content: { kind: "bytes", bytes: samplePdf() },
        mediaType: "application/pdf",
      });
      expect(await storage.headObject(target)).not.toBeNull();

      await storage.deleteObject(target);
      expect(await storage.headObject(target)).toBeNull();
      await expect(storage.deleteObject(target)).resolves.toBeUndefined();
    });

    it("keeps zones separate: the same key in two zones is two objects", async () => {
      // Quarantine and accepted storage must not alias. If they did, an
      // unvalidated upload could be read through an accepted-artifact path.
      const { storage, ref } = createHarness();
      const q = ref("quarantine", "zone-split");
      const a: StorageObjectRef = { zone: "artifacts", key: q.key };

      await storage.putObject({
        ref: q, content: { kind: "bytes", bytes: new TextEncoder().encode("quarantined") },
        mediaType: "application/octet-stream",
      });

      expect(await storage.headObject(a)).toBeNull();
    });

    it("does not let a READER mutate what the next reader sees", async () => {
      // The aliasing risk that survives: a reader mutating the array it was
      // handed must not change stored content. Writing was already safe by
      // accident (the write path copies while draining), so a probe that
      // removed the write-side copy broke nothing - this is the direction that
      // actually needed a test.
      const { storage, ref } = createHarness();
      const target = ref("artifacts", "reader-isolation");
      await storage.putObject({
        ref: target, content: { kind: "bytes", bytes: samplePdf() },
        mediaType: "application/pdf",
      });

      // The chunk AS YIELDED, not a collected copy. `collect` allocates a
      // fresh array, so a test written through it can never observe the stored
      // buffer - it passed with the copy removed.
      for await (const chunk of (await storage.getObject(target))!.stream) {
        chunk.fill(0);
      }

      const second = await collect((await storage.getObject(target))!.stream);
      expect(Array.from(second)).toEqual(Array.from(samplePdf()));
    });

    it("does not let a caller mutate stored bytes after writing", async () => {
      // A stored object holding a live reference to the caller's array would
      // let content change after the digest was computed.
      const { storage, ref } = createHarness();
      const target = ref("artifacts", "no-aliasing");
      const bytes = samplePdf();
      await storage.putObject({
        ref: target, content: { kind: "bytes", bytes }, mediaType: "application/pdf",
      });

      bytes.fill(0);

      const got = await storage.getObject(target);
      const read = await collect(got!.stream);
      expect(read[0]).toBe(0x25); // '%' of "%PDF"
    });
  });
}
