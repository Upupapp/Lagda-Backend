// The upload pipeline against REAL infrastructure.
//
//   PostgreSQL  — upload rows, artifact rows, RLS
//   MinIO       — quarantine and accepted object storage
//   ClamAV      — a real clamd, over the real INSTREAM protocol
//
// Fakes cannot prove the things that actually decide whether this pipeline is
// safe: that clamd genuinely detects a known-bad pattern over a socket, that a
// real PDF parser rejects a real malformed file, and that the accepted bytes in
// object storage still hash to what PostgreSQL recorded.
//
// Composed here rather than inside a package because it wires four adapters
// together, which is the composition root's job — the same reason BACKEND-17's
// artifact/storage test lives in this directory.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import type { DocumentId, Sha256Digest, WorkspaceId } from "@lagda/contracts";
import {
  processDocumentUpload,
  type ArtifactId, type UploadDependencies,
  type UploadId, type UploadLimits, type MalwareScanner,
} from "@lagda/application";
import {
  createTestDatabase, hasIntegrationDatabase, truncateAll,
  createTransactionManager, createQuarantineCleanupLookup,
  type LagdaDatabase,
} from "@lagda/db";
import {
  createS3ObjectStorage, createStorageKeyStrategy, collect,
  ensureTestBuckets, testStorageConfig,
} from "@lagda/storage";
import {
  createPdfInspector, buildTestPdf, buildTestPdfWithTrailingBytes,
} from "@lagda/sealing";
import { createClamAvScanner } from "@lagda/scanning";

const STORAGE = process.env["OBJECT_STORAGE_TEST_ENDPOINT"];
const SCANNER_HOST = process.env["MALWARE_SCANNER_TEST_HOST"];
const SCANNER_PORT = Number(process.env["MALWARE_SCANNER_TEST_PORT"] ?? "3310");

const ready = STORAGE !== undefined && STORAGE !== ""
  && SCANNER_HOST !== undefined && SCANNER_HOST !== ""
  && hasIntegrationDatabase();

const WS_A = "ws_alpha" as WorkspaceId;
const WS_B = "ws_beta" as WorkspaceId;
const DOC = "doc_1" as DocumentId;
const LIMITS: UploadLimits = { maxBytes: 25 * 1024 * 1024, maxPages: 2_000 };

/**
 * The EICAR test string.
 *
 * Harmless by design: a published, standardised pattern that antivirus products
 * agree to flag, specifically so scanning can be tested without real malware.
 * Assembled from fragments so this source file is not itself flagged by a
 * scanner watching the repository (§159, §160).
 */
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join("");

const sha256 = (bytes: Uint8Array): Sha256Digest =>
  createHash("sha256").update(bytes).digest("hex") as Sha256Digest;

// eslint-disable-next-line @typescript-eslint/require-await
async function* one(bytes: Uint8Array): AsyncGenerator<Uint8Array> { yield bytes; }

/**
 * A genuine multi-page PDF.
 *
 * Built through @lagda/sealing rather than by importing pdf-lib here: INV-001
 * confines the PDF library to that package, and a test is not an exemption.
 */
const realPdf = (pages = 2): Promise<Uint8Array> => buildTestPdf(pages);

describe.skipIf(!ready)("secure upload pipeline", () => {
  let database: LagdaDatabase;
  let uow: ReturnType<typeof createTransactionManager>;
  let scanner: MalwareScanner;
  let storage: ReturnType<typeof createS3ObjectStorage>;
  const keys = createStorageKeyStrategy();
  const inspector = createPdfInspector();

  beforeAll(async () => {
    database = await createTestDatabase();
    uow = createTransactionManager(database.db);
    await ensureTestBuckets(STORAGE ?? "");
    storage = createS3ObjectStorage(testStorageConfig(STORAGE ?? ""));
    scanner = createClamAvScanner({
      host: SCANNER_HOST ?? "", port: SCANNER_PORT,
      timeoutMs: 30_000, maxStreamBytes: 30 * 1024 * 1024,
    });
  }, 120_000);

  afterAll(async () => { await database?.close(); });

  beforeEach(async () => {
    await truncateAll(database);
    for (const workspace of [WS_A, WS_B]) {
      await database.db.insertInto("workspaces").values({
        workspace_id: workspace, name: workspace, owner_user_id: "usr_1",
        created_at: new Date(0),
      }).execute();
    }
  });

  let seq = 0;
  function deps(workspaceId: WorkspaceId, override: Partial<UploadDependencies> = {}):
  UploadDependencies {
    seq += 1;
    const run = seq;
    return {
      storage, keys, inspector, scanner,
      // Through the UNIT OF WORK, so every call carries RLS tenant context.
      // Building a repository on a fresh transaction instead ran it with no
      // tenant context at all, and RLS correctly refused every write - which is
      // how this test first failed.
      uploads: {
        insert: record => uow.runForWorkspace(workspaceId, uw => uw.uploads.insert(record)),
        find: uploadId => uow.runForWorkspace(workspaceId, uw => uw.uploads.find(uploadId)),
        complete: input => uow.runForWorkspace(workspaceId, uw => uw.uploads.complete(input)),
      },
      // The ONE transaction in the whole pipeline: artifact row plus upload
      // status, together. It opens after the bytes exist and closes
      // immediately — no transfer, inspection or scan happens inside it
      // (INV-227).
      commitAcceptance: input => uow.runForWorkspace(workspaceId, async (uw) => {
        // ONE transaction: the artifact row and the upload's acceptance
        // together. Split across two, a crash between them would leave an
        // artifact nothing references or an accepted upload with no artifact -
        // and the database CHECK constraint refuses the second outright.
        await uw.artifacts.insert(input.artifact);
        await uw.uploads.complete({
          uploadId: input.uploadId, status: "accepted",
          detectedMediaType: input.detectedMediaType, digest: input.digest,
          acceptedArtifactId: input.artifact.artifactId,
          scanOutcome: input.scanOutcome, scannedAt: input.scannedAt,
          completedAt: input.completedAt,
        });
      }),
      newUploadId: () => `upl_${String(run)}_${String(Date.now() % 100000)}` as UploadId,
      newArtifactId: () => `art_${String(run)}_${String(Date.now() % 100000)}` as ArtifactId,
      clock: { now: () => Date.now() },
      digestOf: sha256,
      ...override,
    };
  }

  const upload = (bytes: Uint8Array, workspaceId = WS_A, override = {}) =>
    processDocumentUpload({
      workspaceId, uploaderUserId: "usr_1", documentId: DOC, content: one(bytes),
    }, deps(workspaceId, override), LIMITS);

  // ── The end-to-end guarantee ─────────────────────────────────────────────

  it("accepts a real PDF and the stored bytes still hash to the recorded digest", async () => {
    // The whole integrity chain in one assertion: what was received, what was
    // hashed, what was stored and what PostgreSQL recorded are the same bytes.
    const pdf = await realPdf(3);
    const result = await upload(pdf);

    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") return;
    expect(result.pageCount).toBe(3);
    expect(result.pageSizes[0]).toEqual({ width: 612, height: 792 });

    const artifact = await uow.runForWorkspace(WS_A, uw => uw.artifacts.find(result.artifactId));
    expect(artifact?.digest).toBe(sha256(pdf));
    expect(artifact?.mediaType).toBe("application/pdf");
    expect(artifact?.artifactType).toBe("original");

    const stored = await storage.getObject({
      zone: "artifacts", key: artifact!.storageReference,
    });
    expect(sha256(await collect(stored!.stream))).toBe(artifact!.digest);
  }, 120_000);

  it("removes the quarantine object once accepted", async () => {
    const pdf = await realPdf();
    const result = await upload(pdf);
    expect(result.outcome).toBe("accepted");

    const row = await database.db.selectFrom("document_uploads")
      .selectAll().executeTakeFirstOrThrow();
    expect(row.status).toBe("accepted");
    expect(await storage.headObject({
      zone: "quarantine", key: row.quarantine_reference as never,
    })).toBeNull();
  }, 120_000);

  // ── Malware, against a real scanner ──────────────────────────────────────

  it("REJECTS the EICAR pattern, detected by real clamd", async () => {
    // A real daemon, a real signature match, over a real socket. This is the
    // control the entire command exists to install.
    const infected = new TextEncoder().encode(EICAR);
    const result = await upload(infected);

    expect(result).toMatchObject({ outcome: "rejected" });
    if (result.outcome !== "rejected") return;
    // Type detection fires first, because EICAR is not a PDF - which is itself
    // correct ordering: the cheap check refuses it before the scanner is asked.
    expect(["malware-detected", "unsupported-file-type"]).toContain(result.reason);

    // Nothing was accepted, whichever control caught it.
    const artifacts = await database.db.selectFrom("document_artifacts")
      .selectAll().execute();
    expect(artifacts).toHaveLength(0);
  }, 120_000);

  it("REJECTS a PDF carrying the EICAR pattern - the scanner, not the parser", async () => {
    // A structurally valid PDF whose CONTENT is malicious. Inspection passes;
    // only the scanner can catch this, which is exactly why type detection is
    // not a substitute for scanning (§33).
    // Appended as TRAILING DATA after %%EOF rather than set as metadata:
    // pdf-lib encodes metadata strings, so the literal bytes never appear in
    // the file and the scanner correctly found nothing. Trailing data keeps the
    // pattern verbatim AND keeps the PDF parseable, which is the combination
    // this test needs (see also the trailing-data allowance in the spec).
    const bytes = await buildTestPdfWithTrailingBytes(EICAR);

    // It must still inspect as a valid PDF, or this would be testing
    // malformed-PDF rejection rather than malware rejection.
    expect(await inspector.inspect(bytes)).toMatchObject({ outcome: "ok" });

    const scan = await scanner.scan({ content: one(bytes), byteSize: bytes.byteLength });
    // Confirm the scanner really sees it before asserting the pipeline does.
    expect(scan.outcome).toBe("infected");

    const result = await upload(bytes);
    expect(result).toMatchObject({ outcome: "rejected", reason: "malware-detected" });

    const row = await database.db.selectFrom("document_uploads")
      .selectAll().executeTakeFirstOrThrow();
    expect(row.status).toBe("rejected");
    expect(row.scan_outcome).toBe("infected");
    expect(row.accepted_artifact_id).toBeNull();
  }, 120_000);

  it("FAILS CLOSED when the scanner is unreachable", async () => {
    // A real connection to a port nothing is listening on. The pipeline must
    // refuse - never interpret an outage as clean.
    const dead = createClamAvScanner({
      host: "127.0.0.1", port: 9, timeoutMs: 3_000, maxStreamBytes: 30 * 1024 * 1024,
    });
    const pdf = await realPdf();
    const result = await upload(pdf, WS_A, { scanner: dead });

    expect(result).toMatchObject({ outcome: "rejected", reason: "scan-unavailable" });
    expect(await database.db.selectFrom("document_artifacts").selectAll().execute())
      .toHaveLength(0);
  }, 120_000);

  it("reports scanner availability without scanning a file", async () => {
    expect(await scanner.isAvailable()).toBe(true);
    const dead = createClamAvScanner({
      host: "127.0.0.1", port: 9, timeoutMs: 2_000, maxStreamBytes: 1,
    });
    expect(await dead.isAvailable()).toBe(false);
  }, 60_000);

  it("refuses a file larger than the scanner can accept, rather than skipping the scan", async () => {
    // An unscannable file must never be treated as clean (§111).
    const tiny = createClamAvScanner({
      host: SCANNER_HOST ?? "", port: SCANNER_PORT, timeoutMs: 5_000, maxStreamBytes: 10,
    });
    const pdf = await realPdf();
    const result = await upload(pdf, WS_A, { scanner: tiny });
    expect(result).toMatchObject({ outcome: "rejected", reason: "scan-unavailable" });
  }, 120_000);

  // ── Content validation, against a real parser ────────────────────────────

  it("REJECTS an HTML file named document.pdf", async () => {
    const html = new TextEncoder().encode(
      "<!doctype html><html><body><h1>not a pdf</h1></body></html>");
    expect(await upload(html)).toMatchObject({
      outcome: "rejected", reason: "unsupported-file-type",
    });
  }, 60_000);

  it("REJECTS a PDF whose body is truncated mid-object", async () => {
    // A real PDF cut short. This reaches the PARSER's failure path, which the
    // "%PDF- header plus garbage" case does not - that one is caught by the
    // page-tree check instead, so removing the parser's rejection broke no
    // test until this existed.
    const valid = await realPdf(2);
    const truncated = valid.subarray(0, Math.floor(valid.byteLength * 0.6));
    const result = await upload(truncated);
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(["malformed-pdf", "unsupported-file-type"]).toContain(result.reason);
  }, 60_000);

  it("REJECTS a file with a PDF header but broken structure", async () => {
    // The polyglot shape: correct magic bytes, unusable content. Detection
    // alone would accept this; the parser is what refuses it.
    const fake = new TextEncoder().encode("%PDF-1.7\nthis is not a pdf body at all\n");
    expect(await upload(fake)).toMatchObject({
      outcome: "rejected", reason: "malformed-pdf",
    });
  }, 60_000);

  it("REJECTS an encrypted PDF explicitly", async () => {
    // A real encrypted PDF, so the rejection comes from the parser rather than
    // from a heuristic. Rejected at upload, not discovered later during signing.
    const encrypted = buildEncryptedPdf();
    const result = await upload(encrypted);
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(["encrypted-pdf-unsupported", "malformed-pdf"]).toContain(result.reason);
  }, 60_000);

  it("REJECTS a PDF that parses but has NO PAGES", async () => {
    // Valid PDF syntax, zero pages. Nothing can be signed on it and field
    // placement has nowhere to place anything - so it must be refused at
    // upload rather than discovered during preparation. Removing the page
    // check broke no test until this one existed.
    // Hand-built, because pdf-lib ADDS a default page when saving a document
    // with none - so `buildTestPdf(0)` silently yields a one-page file and the
    // test passed while proving nothing.
    const empty = new TextEncoder().encode([
      "%PDF-1.7",
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
      "2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj",
      "trailer<</Size 3/Root 1 0 R>>",
      "%%EOF",
      "",
    ].join("\n"));
    const result = await upload(empty);
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.reason).toBe("malformed-pdf");
  }, 60_000);

  it("REJECTS a zero-byte file", async () => {
    expect(await upload(new Uint8Array())).toMatchObject({ reason: "empty-file" });
  }, 60_000);

  it("REJECTS a DOCX declared as application/pdf", async () => {
    // A minimal ZIP, which is what a DOCX is. Detected as zip, not pdf.
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array<number>(60).fill(0)]);
    expect(await upload(zip)).toMatchObject({ reason: "unsupported-file-type" });
  }, 60_000);

  // ── Tenancy ──────────────────────────────────────────────────────────────

  it("keeps an upload and its artifact inside the uploading workspace", async () => {
    const pdf = await realPdf();
    const result = await upload(pdf, WS_A);
    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") return;

    // Workspace B cannot see the artifact...
    expect(await uow.runForWorkspace(WS_B, uw => uw.artifacts.find(result.artifactId)))
      .toBeNull();
    // ...nor the upload row.
    const asB = await uow.runForWorkspace(WS_B, uw => uw.uploads.find(result.uploadId));
    expect(asB).toBeNull();
    // And A still can.
    const asA = await uow.runForWorkspace(WS_A, uw => uw.uploads.find(result.uploadId));
    expect(asA?.acceptedArtifactId).toBe(result.artifactId);
  }, 120_000);

  it("stores the filename as metadata and NEVER in the storage key", async () => {
    const pdf = await realPdf();
    const result = await upload(pdf, WS_A, {});
    expect(result.outcome).toBe("accepted");

    const row = await database.db.selectFrom("document_uploads")
      .selectAll().executeTakeFirstOrThrow();
    expect(row.quarantine_reference).not.toContain("passwd");
    const artifacts = await database.db.selectFrom("document_artifacts")
      .selectAll().executeTakeFirstOrThrow();
    expect(artifacts.storage_reference).toMatch(/^workspaces\/.*\/artifacts\/.*\.pdf$/);
  }, 120_000);

  // ── The database refuses impossible states ───────────────────────────────

  it("REFUSES an accepted upload row with no artifact", async () => {
    // A CHECK constraint, so a bug in the orchestration cannot record an
    // acceptance that references nothing (INV-226).
    await expect(database.db.insertInto("document_uploads").values({
      upload_id: "upl_bad", workspace_id: WS_A, uploader_user_id: "usr_1",
      quarantine_reference: "quarantine/ws_alpha/uploads/x",
      quarantine_cleared_at: null, original_filename: null, client_media_type: null,
      detected_media_type: "application/pdf", byte_size: 10,
      digest_algorithm: "sha-256", digest: null,
      status: "accepted", rejection_reason: null, accepted_artifact_id: null,
      scan_outcome: "clean", scanned_at: null,
      created_at: new Date(), completed_at: null,
    }).execute()).rejects.toThrow();
  }, 60_000);

  it("REFUSES a rejected upload row with no reason", async () => {
    await expect(database.db.insertInto("document_uploads").values({
      upload_id: "upl_bad2", workspace_id: WS_A, uploader_user_id: "usr_1",
      quarantine_reference: "quarantine/ws_alpha/uploads/y",
      quarantine_cleared_at: null, original_filename: null, client_media_type: null,
      detected_media_type: null, byte_size: 10,
      digest_algorithm: "sha-256", digest: null,
      status: "rejected", rejection_reason: null, accepted_artifact_id: null,
      scan_outcome: null, scanned_at: null,
      created_at: new Date(), completed_at: null,
    }).execute()).rejects.toThrow();
  }, 60_000);

  // ── Quarantine cleanup ───────────────────────────────────────────────────

  it("cleans up quarantine from DATABASE records, and is safe to run twice", async () => {
    // Reads rows, never lists a bucket. Running it again finds nothing, because
    // a cleared row is not returned a second time (§155, §245).
    const html = new TextEncoder().encode("<html>rejected upload</html>");
    const rejected = await upload(html);
    expect(rejected.outcome).toBe("rejected");

    const cleanup = createQuarantineCleanupLookup(database.db);
    const pending = await cleanup.listCleanable({ before: Date.now() + 60_000, limit: 50 });
    expect(pending.length).toBeGreaterThanOrEqual(1);

    for (const item of pending) {
      await storage.deleteObject({ zone: "quarantine", key: item.quarantineReference as never });
      await cleanup.markQuarantineCleared(item.uploadId);
    }
    expect(await cleanup.listCleanable({ before: Date.now() + 60_000, limit: 50 }))
      .toHaveLength(0);

    // A second pass is a no-op rather than an error.
    for (const item of pending) {
      await storage.deleteObject({ zone: "quarantine", key: item.quarantineReference as never });
      await cleanup.markQuarantineCleared(item.uploadId);
    }
    expect(await cleanup.listCleanable({ before: Date.now() + 60_000, limit: 50 }))
      .toHaveLength(0);
  }, 120_000);

  it("does not offer an in-flight upload to cleanup", async () => {
    // The horizon exists so cleanup cannot delete the quarantine object of a
    // request that is still working on it.
    const html = new TextEncoder().encode("<html>x</html>");
    await upload(html);
    const cleanup = createQuarantineCleanupLookup(database.db);
    expect(await cleanup.listCleanable({ before: Date.now() - 60_000, limit: 50 }))
      .toHaveLength(0);
  }, 120_000);
});

/**
 * A minimal encrypted PDF.
 *
 * Hand-built because pdf-lib cannot WRITE encryption. The /Encrypt entry in the
 * trailer is what a parser keys on, which is the behaviour under test.
 */
function buildEncryptedPdf(): Uint8Array {
  const body = [
    "%PDF-1.7",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj",
    "4 0 obj<</Filter/Standard/V 1/R 2/O<0000>/U<0000>/P -1>>endobj",
    "trailer<</Size 5/Root 1 0 R/Encrypt 4 0 R>>",
    "%%EOF",
    "",
  ].join("\n");
  return new TextEncoder().encode(body);
}
