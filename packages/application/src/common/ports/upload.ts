// The untrusted-upload boundary.
//
// Two capabilities, kept SEPARATE on purpose:
//
//   DocumentInspector — is this actually a usable PDF?
//   MalwareScanner    — is this content malicious?
//
// Neither answers the other's question. A structurally perfect PDF can carry a
// dropper, and a corrupt file is unusable whether or not it is infected. Merging
// them would let one passing imply the other (INV-220).
//
// Nothing here names pdf-lib, file-type, ClamAV or a socket.

import type { Sha256Digest } from "@lagda/contracts";

// ── Document inspection ──────────────────────────────────────────────────────

/**
 * What LAGDA accepts today.
 *
 * PDF only. Handoff §7 lists "PDF (primary), DOCX, DOC (future)" — future means
 * not now, and accepting a DOCX while calling it a PDF is how a document nobody
 * can sign reaches the signing ceremony.
 */
export const SUPPORTED_MEDIA_TYPES = ["application/pdf"] as const;
export type SupportedMediaType = (typeof SUPPORTED_MEDIA_TYPES)[number];

/** Why an inspection refused the file. Closed — no library strings escape. */
export type InspectionFailure =
  | "unsupported-type"
  | "malformed"
  | "encrypted"
  | "too-many-pages"
  | "inspection-failed";

export interface InspectionOk {
  readonly outcome: "ok";
  /** DETECTED from content, never from a filename or a client header. */
  readonly detectedMediaType: SupportedMediaType;
  /**
   * Handoff §7 requires `pageCount` in the upload response, for field
   * placement. It is a genuine product need, not parser trivia kept "in case".
   */
  readonly pageCount: number;
  /**
   * Page sizes in PDF points. Handoff §7 and §8 need these for the field
   * editor's canvas.
   */
  readonly pageSizes: readonly { readonly width: number; readonly height: number }[];
  /**
   * How many pages carry a non-zero /Rotate value (BACKEND-30).
   *
   * A COUNT, not the per-page angles, because the only decision anything makes
   * with it today is "may fields be placed on this document at all". Storing
   * per-page angles would be storing data for a renderer that cannot yet use
   * them; PREPARATION_COORDINATES.md records what changes when it can.
   */
  readonly rotatedPageCount: number;
}

export interface InspectionRejected {
  readonly outcome: "rejected";
  readonly failure: InspectionFailure;
  /**
   * A SAFE detail for operators — never a library message, which can embed a
   * file path or a fragment of document content.
   */
  readonly detail?: string;
}

export type InspectionResult = InspectionOk | InspectionRejected;

/**
 * Inspects untrusted bytes.
 *
 * Takes the complete bytes rather than a stream: structural PDF validation
 * needs the cross-reference table at the END of the file, so a streaming
 * inspector would have to buffer anyway. The caller bounds the size long before
 * this is reached.
 */
export interface DocumentInspector {
  readonly inspect: (bytes: Uint8Array) => Promise<InspectionResult>;
}

// ── Malware scanning ─────────────────────────────────────────────────────────

/**
 * A scan verdict.
 *
 * `infected` and `unavailable` are DISTINCT, and that distinction is the whole
 * reason this is not a boolean. Both refuse the upload, but one is an attack on
 * the customer and the other is LAGDA's own outage — they need different
 * telemetry, different alerts and different client messages (§48).
 */
export type MalwareScanOutcome = "clean" | "infected" | "unavailable";

export interface MalwareScanResult {
  readonly outcome: MalwareScanOutcome;
  /**
   * The signature name, when the scanner reports one.
   *
   * INTERNAL security telemetry. Never returned to a client: it tells an
   * attacker exactly which signature caught them, which is how the next payload
   * gets tuned (§87).
   */
  readonly signature?: string;
  /** Why a scan could not conclude. Operator-facing, never client-facing. */
  readonly reason?: string;
}

export interface MalwareScanInput {
  /** Streamed to the scanner. Never buffered whole for the scanner's benefit. */
  readonly content: AsyncIterable<Uint8Array>;
  readonly byteSize: number;
}

/**
 * Scans untrusted content.
 *
 * MUST FAIL CLOSED. An implementation that cannot reach its scanner returns
 * `unavailable` — never `clean`. Returning `clean` on failure would make an
 * outage silently disable malware protection, which is worse than having none,
 * because everyone would believe it was on (INV-222).
 */
export interface MalwareScanner {
  readonly scan: (input: MalwareScanInput) => Promise<MalwareScanResult>;
  /** Cheap liveness. Never scans a file (§55). */
  readonly isAvailable: () => Promise<boolean>;
}

// ── Upload records ───────────────────────────────────────────────────────────

export type UploadId = string & { readonly __brand: "UploadId" };

/**
 * The upload lifecycle.
 *
 * Four states, each of which a row genuinely rests in — no decorative
 * `INSPECTING`/`SCANNING`, because processing is synchronous and a row never
 * observably sits in either (§7, §8).
 */
export const UPLOAD_STATUSES = ["quarantined", "accepted", "rejected", "failed"] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

/**
 * Why an upload was refused. A CLOSED set of safe categories.
 *
 * `scan-unavailable` is deliberately separate from `malware-detected`: the
 * client retries one and must never retry the other, and conflating them would
 * tell a user their file is infected when LAGDA's scanner was simply down.
 */
export const UPLOAD_REJECTION_REASONS = [
  "file-too-large",
  "empty-file",
  "unsupported-file-type",
  "malformed-pdf",
  "encrypted-pdf-unsupported",
  "too-many-pages",
  "malware-detected",
  "scan-unavailable",
  "integrity-failure",
  "storage-failure",
] as const;
export type UploadRejectionReason = (typeof UPLOAD_REJECTION_REASONS)[number];

/**
 * Rejections the CLIENT caused, versus failures LAGDA owns.
 *
 * Drives the HTTP mapping and, more importantly, whether retrying is
 * meaningful. A user can fix an encrypted PDF; they cannot fix LAGDA's scanner.
 */
export function isClientRejection(reason: UploadRejectionReason): boolean {
  return reason !== "scan-unavailable"
    && reason !== "storage-failure"
    && reason !== "integrity-failure";
}

export interface UploadRecord {
  readonly uploadId: UploadId;
  readonly workspaceId: string;
  readonly uploaderUserId: string;
  /** The quarantine object key. Internal; never leaves the backend. */
  readonly quarantineReference: string;
  /**
   * The client's filename, kept as UNTRUSTED display metadata only.
   * Never a storage key, never a type signal, never an authorization input.
   */
  readonly originalFilename: string | null;
  /** What the browser claimed. Diagnostics only (§29). */
  readonly clientMediaType: string | null;
  readonly detectedMediaType: string | null;
  readonly byteSize: number;
  readonly digest: Sha256Digest | null;
  readonly status: UploadStatus;
  readonly rejectionReason: UploadRejectionReason | null;
  /**
   * Set only once the artifact row exists. An upload is `accepted` and carries
   * an artifact id together, never one without the other.
   */
  readonly acceptedArtifactId: string | null;
  /**
   * Scan outcome and when. Operational security history — deliberately NOT the
   * scanner's raw response, and NOT presented as signing evidence (§207, §208).
   */
  readonly scanOutcome: MalwareScanOutcome | null;
  readonly scannedAt: number | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
}

/**
 * Upload records, tenant-scoped like every other workspace repository.
 *
 * Bound scope, not a passed workspace id: a method taking a workspace argument
 * can be called with the wrong one.
 */
export interface ScopedUploadRepository {
  readonly insert: (record: UploadRecord) => Promise<void>;
  readonly find: (uploadId: UploadId) => Promise<UploadRecord | null>;
  /** Records a terminal outcome. Never moves a row backwards. */
  readonly complete: (input: {
    readonly uploadId: UploadId;
    readonly status: Exclude<UploadStatus, "quarantined">;
    readonly detectedMediaType?: string;
    readonly digest?: Sha256Digest;
    readonly rejectionReason?: UploadRejectionReason;
    readonly acceptedArtifactId?: string;
    readonly scanOutcome?: MalwareScanOutcome;
    readonly scannedAt?: number;
    readonly completedAt: number;
  }) => Promise<void>;
}

/**
 * Quarantine objects still awaiting cleanup, oldest first.
 *
 * GLOBAL, because cleanup is a system job with no tenant context — and it reads
 * the DATABASE rather than listing a bucket. Listing a bucket to decide what to
 * delete is how a cleanup job deletes something real (§82).
 */
export interface QuarantineCleanupLookup {
  readonly listCleanable: (input: {
    readonly before: number;
    readonly limit: number;
  }) => Promise<readonly { readonly uploadId: UploadId; readonly quarantineReference: string }[]>;
  /** Marks the quarantine object gone so cleanup never revisits it. */
  readonly markQuarantineCleared: (uploadId: UploadId) => Promise<void>;
}
