// The secure upload pipeline.
//
// ── Order, and why it is this order ────────────────────────────────────────
//
//   1. receive under a hard bound, hash, write to QUARANTINE
//   2. inspect the quarantined bytes  (type + structure)
//   3. SCAN the quarantined bytes     (malware)
//   4. promote to the immutable artifact key, re-verifying the digest
//   5. commit artifact metadata in a SHORT transaction
//   6. delete quarantine, best effort
//
// Every step operates on the SAME quarantined bytes, so "what was scanned",
// "what was hashed" and "what was stored" cannot diverge (§59, §106).
//
// The pipeline FAILS CLOSED at every branch. A file is accepted only by
// reaching the end; there is no path where an error, a timeout or an
// unrecognised state produces acceptance (INV-217).
//
// No database transaction is open during transfer, inspection or scanning
// (INV-227). Those take seconds and hold no locks here; the only transaction is
// step 5, which is a single insert plus an update.
//
// ── BUFFERED, not streamed, and why that is stated rather than hidden ──────
//
// The file is held in memory, bounded by `limits.maxBytes`. It is NOT streamed
// to quarantine. Two things force this today:
//
//   * `ObjectContent`'s stream variant requires `contentLength` up front, and a
//     multipart upload does not supply a length that may be trusted (§23).
//     Streaming with an unknown length needs S3 multipart, which would change
//     the BACKEND-17 storage contract.
//   * PDF structural inspection needs the cross-reference table at the END of
//     the file, so inspection buffers regardless.
//
// The cost is real and bounded: `maxBytes` per upload in flight, so 25 MB times
// concurrent uploads. The bound is enforced BEFORE any allocation grows past it,
// and the upload rate limit caps concurrency. Recorded as OD-058 for BACKEND-61
// rather than described as streaming, because calling this streaming would be
// the kind of claim this codebase keeps finding and deleting.

import type { DocumentId, Sha256Digest, WorkspaceId } from "@lagda/contracts";
import type { ArtifactId, ArtifactRecord } from "../common/ports/evidence.js";
import type {
  ByteStream, ObjectStorage, StorageKeyStrategy, StorageObjectRef,
} from "../common/ports/storage.js";
import {
  isClientRejection,
  type InspectionFailure,
  type DocumentInspector, type MalwareScanner, type ScopedUploadRepository,
  type UploadId, type UploadRejectionReason, type MalwareScanOutcome,
} from "../common/ports/upload.js";

/** Everything the pipeline needs. All ports — no concrete adapter types. */
export interface UploadDependencies {
  readonly storage: ObjectStorage;
  readonly keys: StorageKeyStrategy;
  readonly inspector: DocumentInspector;
  readonly scanner: MalwareScanner;
  readonly uploads: ScopedUploadRepository;
  /** Runs the acceptance transaction. Short, and opened only at step 5. */
  readonly commitAcceptance: (input: {
    readonly artifact: ArtifactRecord;
    readonly uploadId: UploadId;
    readonly digest: Sha256Digest;
    readonly detectedMediaType: string;
    readonly scanOutcome: MalwareScanOutcome;
    readonly scannedAt: number;
    readonly completedAt: number;
  }) => Promise<void>;
  readonly newUploadId: () => UploadId;
  readonly newArtifactId: () => ArtifactId;
  readonly clock: { readonly now: () => number };
  /** Digest of exactly the bytes given. Node's crypto, behind a seam for tests. */
  readonly digestOf: (bytes: Uint8Array) => Sha256Digest;
}

export interface UploadLimits {
  /**
   * The maximum accepted document size.
   *
   * Handoff §7 says "to be determined (suggest 25MB)" — SUGGESTED, not decided.
   * Configuration, with the suggestion as the default, and recorded as a
   * product decision still owed (OD-056).
   */
  readonly maxBytes: number;
  /**
   * A technical safety maximum, not a commercial plan limit.
   *
   * A tiny file can declare a pathological page tree; this bounds what field
   * placement and later rendering will be asked to handle (§121).
   */
  readonly maxPages: number;
}

export interface UploadRequest {
  /** From the authenticated route context. NEVER from a multipart field. */
  readonly workspaceId: WorkspaceId;
  readonly uploaderUserId: string;
  readonly documentId: DocumentId;
  /** The multipart file stream, already adapted to LAGDA's byte abstraction. */
  readonly content: ByteStream;
  /** Untrusted display metadata. Normalized before it is stored. */
  readonly originalFilename?: string;
  /** What the browser claimed. Recorded for diagnosis; trusted for nothing. */
  readonly clientMediaType?: string;
}

export interface UploadAccepted {
  readonly outcome: "accepted";
  readonly uploadId: UploadId;
  readonly artifactId: ArtifactId;
  readonly byteSize: number;
  readonly digest: Sha256Digest;
  readonly mediaType: string;
  readonly pageCount: number;
  readonly pageSizes: readonly { readonly width: number; readonly height: number }[];
  readonly originalFilename: string | null;
}

export interface UploadRejected {
  readonly outcome: "rejected";
  readonly uploadId: UploadId | null;
  readonly reason: UploadRejectionReason;
  /** True when the caller caused it and could fix it. Drives the HTTP status. */
  readonly clientFault: boolean;
}

export type UploadResult = UploadAccepted | UploadRejected;

/** Filenames are bounded and stripped, and are display metadata only (§27). */
export function normalizeFilename(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const stripped = raw
    // Control characters first: they are what breaks a log line or a terminal.
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u001f\u007f]/g, "")
    // Any path separator becomes an underscore. Not because the key is derived
    // from this — it never is — but because a name like `../../etc/passwd`
    // rendered in a UI or a report is a phishing surface of its own (§172).
    .replace(/[/\\]/g, "_")
    .trim();
  if (stripped.length === 0) return null;
  return stripped.slice(0, 255);
}

export async function processDocumentUpload(
  request: UploadRequest,
  deps: UploadDependencies,
  limits: UploadLimits,
): Promise<UploadResult> {
  const uploadId = deps.newUploadId();
  const quarantineRef = deps.keys.quarantineKey({
    workspaceId: request.workspaceId,
    uploadId,
  });
  const filename = normalizeFilename(request.originalFilename);

  // ── 1. Receive under a bound, then quarantine ───────────────────────────
  //
  // Never the accepted-artifact zone. Browser bytes reaching the immutable zone
  // before validation is the failure this whole command exists to prevent
  // (INV-218).
  let byteSize = 0;
  let collected: Uint8Array;
  try {
    const bounded = boundedCollect(request.content, limits.maxBytes);
    collected = await bounded.bytes;
    byteSize = collected.byteLength;
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      // Nothing was written, so there is nothing to clean up. The stream was
      // abandoned as soon as the bound was crossed rather than being drained
      // (§24).
      return { outcome: "rejected", uploadId: null, reason: "file-too-large", clientFault: true };
    }
    return { outcome: "rejected", uploadId: null, reason: "storage-failure", clientFault: false };
  }

  if (byteSize === 0) {
    // Rejected before any storage write. A zero-byte file is not a document,
    // and writing it would create quarantine litter for no reason (§168).
    return { outcome: "rejected", uploadId: null, reason: "empty-file", clientFault: true };
  }

  const digest = deps.digestOf(collected);
  const now = deps.clock.now();

  try {
    await deps.storage.putObject({
      ref: quarantineRef,
      content: { kind: "bytes", bytes: collected },
      // The CLIENT's claim, recorded on the quarantine object only. The
      // accepted artifact gets the DETECTED type instead (§68).
      mediaType: request.clientMediaType ?? "application/octet-stream",
    });
  } catch {
    return { outcome: "rejected", uploadId: null, reason: "storage-failure", clientFault: false };
  }

  // The durable record exists only AFTER the bytes do, so a row never claims a
  // quarantine object that was never written (§74 window A).
  await deps.uploads.insert({
    uploadId,
    workspaceId: request.workspaceId,
    uploaderUserId: request.uploaderUserId,
    quarantineReference: quarantineRef.key,
    originalFilename: filename,
    clientMediaType: request.clientMediaType ?? null,
    detectedMediaType: null,
    byteSize,
    digest,
    status: "quarantined",
    rejectionReason: null,
    acceptedArtifactId: null,
    scanOutcome: null,
    scannedAt: null,
    createdAt: now,
    completedAt: null,
  });

  const reject = async (reason: UploadRejectionReason): Promise<UploadRejected> => {
    await deps.uploads.complete({
      uploadId, status: "rejected", rejectionReason: reason,
      completedAt: deps.clock.now(),
    });
    // The quarantine object is left for the cleanup job rather than deleted
    // here. Deleting inline would make a rejection path do storage I/O it can
    // fail at, and the row already records what to remove (§83, §156).
    return { outcome: "rejected", uploadId, reason, clientFault: isClientRejection(reason) };
  };

  // ── 2. Inspect: is this actually a usable PDF? ───────────────────────────
  //
  // Content, not the filename and not the browser's Content-Type. Both are
  // attacker-controlled (INV-219).
  const inspection = await deps.inspector.inspect(collected);
  if (inspection.outcome === "rejected") {
    return reject(INSPECTION_TO_REASON[inspection.failure]);
  }
  if (inspection.pageCount > limits.maxPages) {
    return reject("too-many-pages");
  }

  // ── 3. Scan the SAME quarantined bytes ───────────────────────────────────
  const scan = await deps.scanner.scan({
    content: singleChunk(collected),
    byteSize,
  });
  const scannedAt = deps.clock.now();

  if (scan.outcome !== "clean") {
    // `infected` and `unavailable` both refuse. They are recorded separately
    // because one is an attack and the other is an outage (§48).
    await deps.uploads.complete({
      uploadId, status: "rejected",
      rejectionReason: scan.outcome === "infected" ? "malware-detected" : "scan-unavailable",
      scanOutcome: scan.outcome, scannedAt, completedAt: scannedAt,
    });
    const reason: UploadRejectionReason =
      scan.outcome === "infected" ? "malware-detected" : "scan-unavailable";
    return { outcome: "rejected", uploadId, reason, clientFault: isClientRejection(reason) };
  }

  // ── 4. Promote ───────────────────────────────────────────────────────────
  //
  // Only reachable with a clean scan and a successful inspection. There is no
  // other caller: promotion is not a capability the port exposes (§65).
  const artifactId = deps.newArtifactId();
  const artifactRef = deps.keys.artifactKey({
    workspaceId: request.workspaceId,
    documentId: request.documentId,
    artifactId,
  });

  try {
    await promote(deps, quarantineRef, artifactRef, digest, inspection.detectedMediaType, {
      artifactId, workspaceId: request.workspaceId,
    });
  } catch (error) {
    const reason: UploadRejectionReason =
      error instanceof PromotionIntegrityError ? "integrity-failure" : "storage-failure";
    await deps.uploads.complete({
      uploadId, status: "failed", rejectionReason: reason,
      scanOutcome: scan.outcome, scannedAt, completedAt: deps.clock.now(),
    });
    return { outcome: "rejected", uploadId, reason, clientFault: false };
  }

  // ── 5. Commit metadata, in a SHORT transaction ───────────────────────────
  //
  // Bytes already exist, so the row never announces an artifact that has none
  // (INV-226). The reverse window — bytes with no row — leaves a private,
  // unreferenced object, which is recoverable; see UPLOAD_CONSISTENCY.md.
  const completedAt = deps.clock.now();
  try {
    await deps.commitAcceptance({
      artifact: {
        artifactId, workspaceId: request.workspaceId, documentId: request.documentId,
        artifactType: "original",
        storageReference: artifactRef.key,
        mediaType: inspection.detectedMediaType,
        sizeBytes: byteSize,
        digestAlgorithm: "sha-256",
        digest,
        createdAt: completedAt,
      },
      uploadId, digest, detectedMediaType: inspection.detectedMediaType,
      scanOutcome: scan.outcome, scannedAt, completedAt,
    });
  } catch {
    // The object exists but is unreferenced and private. NOT deleted here: a
    // retry with the same artifact identity converges on identical bytes, and
    // deleting on an uncertain transaction outcome is how a real artifact is
    // destroyed (§78).
    await deps.uploads.complete({
      uploadId, status: "failed", rejectionReason: "storage-failure",
      scanOutcome: scan.outcome, scannedAt, completedAt: deps.clock.now(),
    }).catch(() => undefined);
    return {
      outcome: "rejected", uploadId, reason: "storage-failure", clientFault: false,
    };
  }

  // ── 6. Quarantine cleanup, BEST EFFORT ───────────────────────────────────
  //
  // The upload is already accepted and the accepted copy is authoritative.
  // Failing the request now would be telling a user their document was rejected
  // because LAGDA could not tidy up (§154).
  try {
    await deps.storage.deleteObject(quarantineRef);
  } catch {
    // Left for the cleanup job. The upload row still holds the reference.
  }

  return {
    outcome: "accepted",
    uploadId, artifactId, byteSize, digest,
    mediaType: inspection.detectedMediaType,
    pageCount: inspection.pageCount,
    pageSizes: inspection.pageSizes,
    originalFilename: filename,
  };
}

const INSPECTION_TO_REASON: Record<InspectionFailure, UploadRejectionReason> = {
  "unsupported-type": "unsupported-file-type",
  malformed: "malformed-pdf",
  encrypted: "encrypted-pdf-unsupported",
  "too-many-pages": "too-many-pages",
  "inspection-failed": "malformed-pdf",
};

export class UploadTooLargeError extends Error {
  constructor() {
    super("Upload exceeds the configured maximum.");
    this.name = "UploadTooLargeError";
  }
}

export class PromotionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionIntegrityError";
  }
}

/**
 * Copies quarantine bytes to the immutable artifact key, RE-VERIFYING the
 * digest on the way through.
 *
 * Stream-and-re-put rather than a server-side copy. A server-side copy would be
 * cheaper, but it would require exposing a generic copy capability on the
 * storage port — which is precisely the "promote arbitrary key" primitive that
 * must not exist (§65, §160) — and it would move bytes LAGDA never re-examined.
 * Re-reading and re-hashing means the accepted artifact's digest is verified
 * against the bytes actually written, not merely inherited (§66).
 */
async function promote(
  deps: UploadDependencies,
  from: StorageObjectRef,
  to: StorageObjectRef,
  expectedDigest: Sha256Digest,
  mediaType: string,
  metadata: { readonly artifactId: ArtifactId; readonly workspaceId: WorkspaceId },
): Promise<void> {
  const source = await deps.storage.getObject(from);
  if (source === null) {
    throw new PromotionIntegrityError("Quarantine object disappeared before promotion.");
  }

  const bytes = await drain(source.stream);
  const actual = deps.digestOf(bytes);
  if (actual !== expectedDigest) {
    // The bytes in quarantine are not the bytes that were scanned. Never
    // promote: an accepted artifact whose digest describes different content
    // would make every later verification a lie (§67).
    throw new PromotionIntegrityError("Quarantine digest changed before promotion.");
  }

  await deps.storage.putObject({
    ref: to,
    content: { kind: "bytes", bytes },
    // The DETECTED type. The client's claim never reaches the artifact.
    mediaType,
    metadata: {
      artifactId: metadata.artifactId,
      workspaceId: metadata.workspaceId,
      digest: expectedDigest,
    },
  });
}

/** Reads a stream, refusing to exceed the bound. */
function boundedCollect(
  stream: ByteStream, maxBytes: number,
): { readonly bytes: Promise<Uint8Array> } {
  const bytes = (async (): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        // Thrown mid-iteration, which ends the `for await` and closes the
        // source. The remaining upload is NOT drained: continuing to receive
        // bytes LAGDA has already decided to refuse is free work for an
        // attacker (§24).
        throw new UploadTooLargeError();
      }
      chunks.push(chunk);
    }
    return concat(chunks, total);
  })();
  return { bytes };
}

async function drain(stream: ByteStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  return concat(chunks, total);
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function singleChunk(bytes: Uint8Array): ByteStream {
  // eslint-disable-next-line @typescript-eslint/require-await
  return (async function* one(): AsyncGenerator<Uint8Array> { yield bytes; })();
}
