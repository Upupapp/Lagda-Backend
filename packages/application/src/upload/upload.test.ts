// The upload pipeline, against fakes.
//
// Fakes here so every FAILURE path can be driven deliberately — a scanner that
// times out, storage that dies mid-promotion, a database that rejects the
// acceptance transaction. Those are the paths that decide whether the pipeline
// fails closed, and a real scanner cannot be asked to fail on command.
//
// The real ClamAV, real MinIO and real PostgreSQL run in upload.integration.test.ts.

import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import type { DocumentId, Sha256Digest, WorkspaceId } from "@lagda/contracts";
import {
  processDocumentUpload, normalizeFilename,
  type UploadDependencies, type UploadLimits, type UploadResult,
  type MalwareScanResult, type InspectionResult,
  type UploadId, type ArtifactId, type UploadRecord,
  type StorageObjectRef, type ObjectStorage,
} from "../index.js";

const WS = "ws_alpha" as WorkspaceId;
const DOC = "doc_1" as DocumentId;
const PDF = new TextEncoder().encode(
  "%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

const LIMITS: UploadLimits = { maxBytes: 1024 * 1024, maxPages: 100 };

const sha256 = (bytes: Uint8Array): Sha256Digest =>
  createHash("sha256").update(bytes).digest("hex") as Sha256Digest;

// eslint-disable-next-line @typescript-eslint/require-await
async function* one(bytes: Uint8Array): AsyncGenerator<Uint8Array> { yield bytes; }

interface Harness {
  readonly deps: UploadDependencies;
  readonly objects: Map<string, Uint8Array>;
  readonly rows: UploadRecord[];
  readonly completions: { status: string; reason?: string; artifactId?: string }[];
  readonly committed: { artifactId: string; digest: string }[];
  readonly order: string[];
}

function harness(overrides: {
  scan?: () => Promise<MalwareScanResult>;
  inspect?: () => Promise<InspectionResult>;
  failPut?: (ref: StorageObjectRef) => boolean;
  failCommit?: boolean;
  failDelete?: boolean;
} = {}): Harness {
  const objects = new Map<string, Uint8Array>();
  const rows: UploadRecord[] = [];
  const completions: { status: string; reason?: string; artifactId?: string }[] = [];
  const committed: { artifactId: string; digest: string }[] = [];
  const order: string[] = [];

  const storage: ObjectStorage = {
    async putObject(input) {
      order.push(`put:${input.ref.zone}`);
      if (overrides.failPut?.(input.ref) === true) throw new Error("storage down");
      const bytes = input.content.kind === "bytes"
        ? input.content.bytes
        : new Uint8Array();
      objects.set(`${input.ref.zone}:${input.ref.key}`, Uint8Array.from(bytes));
      return Promise.resolve({ ref: input.ref, sizeBytes: bytes.byteLength });
    },
    getObject(ref) {
      const bytes = objects.get(`${ref.zone}:${ref.key}`);
      if (bytes === undefined) return Promise.resolve(null);
      return Promise.resolve({
        ref, sizeBytes: bytes.byteLength, mediaType: "application/pdf",
        stream: one(Uint8Array.from(bytes)),
      });
    },
    headObject(ref) {
      const bytes = objects.get(`${ref.zone}:${ref.key}`);
      return Promise.resolve(bytes === undefined ? null : {
        ref, sizeBytes: bytes.byteLength, mediaType: "application/pdf",
      });
    },
    deleteObject(ref) {
      order.push("delete:quarantine");
      if (overrides.failDelete === true) return Promise.reject(new Error("delete failed"));
      objects.delete(`${ref.zone}:${ref.key}`);
      return Promise.resolve();
    },
  };

  let uploadSeq = 0;
  let artifactSeq = 0;

  const deps: UploadDependencies = {
    storage,
    keys: {
      artifactKey: ({ workspaceId, documentId, artifactId }) => ({
        zone: "artifacts",
        key: `workspaces/${workspaceId}/documents/${documentId}/artifacts/${artifactId}.pdf` as never,
      }),
      quarantineKey: ({ workspaceId, uploadId }) => ({
        zone: "quarantine",
        key: `quarantine/${workspaceId}/uploads/${uploadId}` as never,
      }),
    },
    inspector: {
      inspect: overrides.inspect ?? ((): Promise<InspectionResult> => {
        order.push("inspect");
        return Promise.resolve({
          outcome: "ok", detectedMediaType: "application/pdf",
          pageCount: 1, pageSizes: [{ width: 612, height: 792 }],
        });
      }),
    },
    scanner: {
      scan: overrides.scan ?? ((): Promise<MalwareScanResult> => {
        order.push("scan");
        return Promise.resolve({ outcome: "clean" });
      }),
      isAvailable: () => Promise.resolve(true),
    },
    uploads: {
      insert(record) { rows.push(record); return Promise.resolve(); },
      find: () => Promise.resolve(null),
      complete(input) {
        completions.push({
          status: input.status,
          ...(input.rejectionReason === undefined ? {} : { reason: input.rejectionReason }),
        });
        return Promise.resolve();
      },
    },
    commitAcceptance(input) {
      order.push("commit");
      if (overrides.failCommit === true) return Promise.reject(new Error("db down"));
      committed.push({ artifactId: input.artifact.artifactId, digest: input.digest });
      return Promise.resolve();
    },
    newUploadId: () => { uploadSeq += 1; return `upl_${String(uploadSeq)}` as UploadId; },
    newArtifactId: () => { artifactSeq += 1; return `art_${String(artifactSeq)}` as ArtifactId; },
    clock: { now: () => 1_700_000_000_000 },
    digestOf: sha256,
  };

  return { deps, objects, rows, completions, committed, order };
}

const upload = (h: Harness, bytes: Uint8Array, extra: Record<string, unknown> = {}):
Promise<UploadResult> =>
  processDocumentUpload({
    workspaceId: WS, uploaderUserId: "usr_1", documentId: DOC,
    content: one(bytes), ...extra,
  }, h.deps, LIMITS);

describe("upload pipeline", () => {
  it("accepts a clean PDF and records an immutable artifact", async () => {
    const h = harness();
    const result = await upload(h, PDF);

    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") return;
    expect(result.digest).toBe(sha256(PDF));
    expect(result.mediaType).toBe("application/pdf");
    expect(result.pageCount).toBe(1);
    // The accepted object exists at the artifact key, byte-identical.
    const stored = h.objects.get(
      `artifacts:workspaces/${WS}/documents/${DOC}/artifacts/${result.artifactId}.pdf`);
    expect(stored).toBeDefined();
    expect(sha256(stored!)).toBe(sha256(PDF));
  });

  it("QUARANTINES before anything else touches the bytes", async () => {
    // The ordering the whole command exists to guarantee: untrusted bytes reach
    // quarantine first, and the accepted zone only after inspection AND scan.
    const h = harness();
    await upload(h, PDF);

    expect(h.order[0]).toBe("put:quarantine");
    expect(h.order.indexOf("inspect")).toBeLessThan(h.order.indexOf("scan"));
    expect(h.order.indexOf("scan")).toBeLessThan(h.order.indexOf("put:artifacts"));
    // And metadata is committed only after the accepted bytes exist.
    expect(h.order.indexOf("put:artifacts")).toBeLessThan(h.order.indexOf("commit"));
  });

  it("NEVER writes the accepted object when the scan finds malware", async () => {
    const h = harness({
      scan: () => Promise.resolve({ outcome: "infected", signature: "Test-Sig" }),
    });
    const result = await upload(h, PDF);

    expect(result).toMatchObject({ outcome: "rejected", reason: "malware-detected" });
    expect(h.order).not.toContain("put:artifacts");
    expect(h.committed).toHaveLength(0);
    expect(h.completions[0]).toMatchObject({ status: "rejected", reason: "malware-detected" });
  });

  it("FAILS CLOSED when the scanner is unavailable", async () => {
    // The single most important behaviour here. An outage must never be read as
    // "clean" - that would silently disable malware protection while everyone
    // believed it was on.
    const h = harness({
      scan: () => Promise.resolve({ outcome: "unavailable", reason: "connect refused" }),
    });
    const result = await upload(h, PDF);

    expect(result).toMatchObject({ outcome: "rejected", reason: "scan-unavailable" });
    expect(h.order).not.toContain("put:artifacts");
    expect(h.committed).toHaveLength(0);
  });

  it("distinguishes an INFECTED file from an UNAVAILABLE scanner", async () => {
    // Both refuse, but a client may retry one and must never retry the other.
    const infected = await upload(
      harness({ scan: () => Promise.resolve({ outcome: "infected" }) }), PDF);
    const unavailable = await upload(
      harness({ scan: () => Promise.resolve({ outcome: "unavailable" }) }), PDF);

    expect(infected).toMatchObject({ reason: "malware-detected", clientFault: true });
    expect(unavailable).toMatchObject({ reason: "scan-unavailable", clientFault: false });
  });

  it("rejects an unsupported type WITHOUT scanning it", async () => {
    // Cheap checks first: a scanner pass on a file already known to be
    // unacceptable is wasted work an attacker can request at will.
    const scan = vi.fn(() => Promise.resolve<MalwareScanResult>({ outcome: "clean" }));
    const h = harness({
      inspect: () => Promise.resolve({ outcome: "rejected", failure: "unsupported-type" }),
      scan,
    });
    const result = await upload(h, PDF);

    expect(result).toMatchObject({ reason: "unsupported-file-type" });
    expect(scan).not.toHaveBeenCalled();
  });

  it("maps every inspection failure to a stable reason", async () => {
    const cases = [
      ["unsupported-type", "unsupported-file-type"],
      ["malformed", "malformed-pdf"],
      ["encrypted", "encrypted-pdf-unsupported"],
      ["too-many-pages", "too-many-pages"],
      ["inspection-failed", "malformed-pdf"],
    ] as const;
    for (const [failure, reason] of cases) {
      const h = harness({
        inspect: () => Promise.resolve({ outcome: "rejected", failure }),
      });
      expect(await upload(h, PDF)).toMatchObject({ reason });
    }
  });

  it("rejects a file over the limit WITHOUT writing quarantine", async () => {
    const h = harness();
    const big = new Uint8Array(LIMITS.maxBytes + 1);
    const result = await upload(h, big);

    expect(result).toMatchObject({ outcome: "rejected", reason: "file-too-large" });
    // Nothing stored, and no row: the bound fired before any I/O.
    expect(h.objects.size).toBe(0);
    expect(h.rows).toHaveLength(0);
  });

  it("stops reading as soon as the bound is crossed", async () => {
    // An oversized upload must not be drained to the end. Continuing to receive
    // bytes LAGDA has already refused is free work for an attacker.
    let chunksRead = 0;
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* endless(): AsyncGenerator<Uint8Array> {
      for (;;) {
        chunksRead += 1;
        yield new Uint8Array(64 * 1024);
        if (chunksRead > 1000) throw new Error("stream was drained far past the limit");
      }
    }
    const h = harness();
    const result = await processDocumentUpload({
      workspaceId: WS, uploaderUserId: "usr_1", documentId: DOC, content: endless(),
    }, h.deps, LIMITS);

    expect(result).toMatchObject({ reason: "file-too-large" });
    // 1 MiB / 64 KiB = 16 chunks, plus the one that crossed it.
    expect(chunksRead).toBeLessThanOrEqual(18);
  });

  it("rejects a zero-byte file", async () => {
    const h = harness();
    expect(await upload(h, new Uint8Array())).toMatchObject({ reason: "empty-file" });
    expect(h.objects.size).toBe(0);
  });

  it("does not accept when the accepted-object write fails", async () => {
    const h = harness({ failPut: ref => ref.zone === "artifacts" });
    const result = await upload(h, PDF);

    expect(result).toMatchObject({ outcome: "rejected", reason: "storage-failure" });
    expect(h.committed).toHaveLength(0);
    // Quarantine is NOT deleted: it is the only remaining copy, and a retry
    // needs it.
    expect(h.order).not.toContain("delete:quarantine");
  });

  it("does not report acceptance when the DB commit fails after promotion", async () => {
    // The dangerous window. Bytes exist at the artifact key but no row
    // references them, so nothing user-visible was accepted.
    const h = harness({ failCommit: true });
    const result = await upload(h, PDF);

    expect(result).toMatchObject({ outcome: "rejected", reason: "storage-failure" });
    expect(h.committed).toHaveLength(0);
    expect(h.completions.at(-1)).toMatchObject({ status: "failed" });
    // The orphan object is left in place, private and unreferenced. Deleting on
    // an uncertain transaction outcome is how a real artifact gets destroyed.
    const orphan = [...h.objects.keys()].filter(k => k.startsWith("artifacts:"));
    expect(orphan).toHaveLength(1);
  });

  it("still ACCEPTS when quarantine cleanup fails", async () => {
    // Cleanup is best effort. Failing an accepted upload because LAGDA could
    // not tidy up would be telling a user their document was rejected for
    // LAGDA's own housekeeping.
    const h = harness({ failDelete: true });
    const result = await upload(h, PDF);

    expect(result.outcome).toBe("accepted");
    expect(h.committed).toHaveLength(1);
  });

  it("refuses to promote when quarantine bytes changed after scanning", async () => {
    // Time-of-check to time-of-use. The digest is re-verified during promotion,
    // so bytes that changed between the scan and the copy cannot become an
    // accepted artifact whose digest describes something else.
    const h = harness();
    const original = h.deps.storage.getObject.bind(h.deps.storage);
    const tampering: typeof h.deps.storage = {
      ...h.deps.storage,
      getObject: async (ref) => {
        const real = await original(ref);
        if (real === null) return null;
        return { ...real, stream: one(new TextEncoder().encode("%PDF-1.7 tampered")) };
      },
    };
    const result = await processDocumentUpload(
      { workspaceId: WS, uploaderUserId: "usr_1", documentId: DOC, content: one(PDF) },
      { ...h.deps, storage: tampering }, LIMITS);

    expect(result).toMatchObject({ outcome: "rejected", reason: "integrity-failure" });
    expect(h.committed).toHaveLength(0);
  });

  it("records the CLIENT's media type but accepts on the DETECTED one", async () => {
    const h = harness();
    const result = await upload(h, PDF, { clientMediaType: "image/png" });

    expect(result).toMatchObject({ outcome: "accepted", mediaType: "application/pdf" });
    // The claim is kept for diagnosis, and is not what acceptance used.
    expect(h.rows[0]?.clientMediaType).toBe("image/png");
    expect(h.rows[0]?.detectedMediaType).toBeNull();
  });

  it("enforces the page ceiling", async () => {
    const h = harness({
      inspect: () => Promise.resolve({
        outcome: "ok", detectedMediaType: "application/pdf",
        pageCount: LIMITS.maxPages + 1, pageSizes: [],
      }),
    });
    expect(await upload(h, PDF)).toMatchObject({ reason: "too-many-pages" });
  });

  it("hashes identically regardless of chunk boundaries", async () => {
    // The digest must describe the bytes, not the transport's framing.
    const bytes = new Uint8Array(50_000).map((_, i) => (i * 7) % 251);
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* chunked(size: number): AsyncGenerator<Uint8Array> {
      for (let at = 0; at < bytes.length; at += size) {
        yield bytes.subarray(at, Math.min(at + size, bytes.length));
      }
      return;
    }
    const digests: string[] = [];
    for (const size of [1, 7, 1024, 49_999, 50_000]) {
      const h = harness();
      const result = await processDocumentUpload(
        { workspaceId: WS, uploaderUserId: "usr_1", documentId: DOC, content: chunked(size) },
        h.deps, LIMITS);
      if (result.outcome === "accepted") digests.push(result.digest);
    }
    expect(new Set(digests).size).toBe(1);
    expect(digests[0]).toBe(sha256(bytes));
  });
});

describe("filename handling", () => {
  it("keeps a filename as display metadata only, never as identity", async () => {
    const h = harness();
    const result = await upload(h, PDF, {
      originalFilename: "../../etc/passwd\u0000.pdf",
    });

    expect(result.outcome).toBe("accepted");
    // The storage keys are built from identifiers. No fragment of the filename
    // reaches either of them.
    for (const key of h.objects.keys()) {
      expect(key).not.toContain("passwd");
      expect(key).not.toContain("..");
    }
  });

  it("normalizes control characters, separators and length", () => {
    expect(normalizeFilename("a\u0000b\u001fc.pdf")).toBe("abc.pdf");
    expect(normalizeFilename("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(normalizeFilename("a\\b/c.pdf")).toBe("a_b_c.pdf");
    expect(normalizeFilename("x".repeat(400))?.length).toBe(255);
    expect(normalizeFilename("   ")).toBeNull();
    expect(normalizeFilename(undefined)).toBeNull();
  });
});
