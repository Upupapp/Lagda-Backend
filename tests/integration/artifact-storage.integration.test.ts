// PostgreSQL artifact metadata and object storage, together.
//
// Two adapters, deliberately NOT merged: the repository never speaks S3 and the
// storage adapter never queries PostgreSQL (INV-213). This test proves they
// compose — and that the composition is what carries tenancy, since object
// storage decides no authorization at all.
//
// It lives in tests/integration/ rather than inside either package, because
// composing adapters is the composition root's job. Written inside
// packages/storage it had to import @lagda/db, which the architecture forbids
// — the lint rule caught it, and moving the file was the right answer rather
// than exempting the rule.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import {
  type ArtifactId, type ArtifactRecord, type ObjectStorage,
} from "@lagda/application";
import type { WorkspaceId, DocumentId, Sha256Digest } from "@lagda/contracts";
import {
  createTestDatabase, hasIntegrationDatabase, truncateAll,
  createTransactionManager, type LagdaDatabase,
} from "@lagda/db";
import {
  createS3ObjectStorage, createStorageKeyStrategy, collect, samplePdf,
  ensureTestBuckets, testStorageConfig,
} from "@lagda/storage";

const ENDPOINT = process.env["OBJECT_STORAGE_TEST_ENDPOINT"];
const ready = ENDPOINT !== undefined && ENDPOINT !== "" && hasIntegrationDatabase();

const WS_A = "ws_alpha" as WorkspaceId;
const WS_B = "ws_beta" as WorkspaceId;
const DOC = "doc_1" as DocumentId;
const ART = "art_original" as ArtifactId;

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!ready)("artifact metadata and object storage", () => {
  let database: LagdaDatabase;
  let storage: ObjectStorage;
  let uow: ReturnType<typeof createTransactionManager>;
  const keys = createStorageKeyStrategy();

  beforeAll(async () => {
    database = await createTestDatabase();
    uow = createTransactionManager(database.db);
    await ensureTestBuckets(ENDPOINT ?? "");
    storage = createS3ObjectStorage(testStorageConfig(ENDPOINT ?? ""));
  }, 90_000);

  afterAll(async () => { await database?.close(); });

  beforeEach(async () => {
    await truncateAll(database);
    for (const workspace of [WS_A, WS_B]) {
      await database.db.insertInto("workspaces").values({
        workspace_id: workspace, name: workspace,
        created_at: new Date(0),
      }).execute();
    }
  });

  it("stores bytes, records metadata, and reloads BYTE-EXACTLY", async () => {
    // The full round trip a feature command will perform: write the object,
    // record what it is, then later resolve identity -> reference -> bytes.
    const bytes = samplePdf();
    const digest = sha256(bytes) as Sha256Digest;
    const ref = keys.artifactKey({ workspaceId: WS_A, documentId: DOC, artifactId: ART });

    // 1. Bytes first, metadata second. An artifact row pointing at an object
    //    that does not exist is worse than an orphan object: it is a document
    //    the product believes it has (§83).
    const stored = await storage.putObject({
      ref, content: { kind: "bytes", bytes }, mediaType: "application/pdf",
      metadata: { artifactId: ART, workspaceId: WS_A, digest },
    });
    expect(stored.sizeBytes).toBe(bytes.byteLength);

    const record: ArtifactRecord = {
      artifactId: ART, workspaceId: WS_A, documentId: DOC, artifactType: "original",
      storageReference: ref.key, mediaType: "application/pdf",
      sizeBytes: bytes.byteLength, digestAlgorithm: "sha-256", digest,
      createdAt: 0,
    };
    await uow.runForWorkspace(WS_A, uw => uw.artifacts.insert(record));

    // 2. Resolve the way a use case will: authorized identity -> repository ->
    //    reference -> storage. The key is never supplied by a caller.
    const loaded = await uow.runForWorkspace(WS_A, uw => uw.artifacts.find(ART));
    expect(loaded).not.toBeNull();

    const content = await storage.getObject({
      zone: "artifacts", key: loaded!.storageReference,
    });
    const read = await collect(content!.stream);

    // The digest recorded in PostgreSQL still describes the bytes in storage.
    // That equality is the entire integrity claim.
    expect(sha256(read)).toBe(loaded!.digest);
  }, 60_000);

  it("gives WORKSPACE B no path to workspace A's storage reference", async () => {
    // Object storage performs no authorization. What stops cross-tenant access
    // is that B never obtains the reference: the repository is tenant-scoped
    // and RLS enforces it. The object itself is perfectly readable to anyone
    // holding the key, which is exactly why the key must not be reachable.
    const bytes = samplePdf();
    const ref = keys.artifactKey({ workspaceId: WS_A, documentId: DOC, artifactId: ART });
    await storage.putObject({
      ref, content: { kind: "bytes", bytes }, mediaType: "application/pdf",
    });
    await uow.runForWorkspace(WS_A, uw => uw.artifacts.insert({
        artifactId: ART, workspaceId: WS_A, documentId: DOC, artifactType: "original",
        storageReference: ref.key, mediaType: "application/pdf",
        sizeBytes: bytes.byteLength, digestAlgorithm: "sha-256",
        digest: sha256(bytes) as Sha256Digest, createdAt: 0,
      }));

    // B asks for the same artifact id and gets nothing — so there is no
    // reference for B to hand to storage.
    const asB = await uow.runForWorkspace(WS_B, uw => uw.artifacts.find(ART));
    expect(asB).toBeNull();

    // And B's own key strategy addresses a different object entirely.
    const bKey = keys.artifactKey({ workspaceId: WS_B, documentId: DOC, artifactId: ART });
    expect(await storage.headObject(bKey)).toBeNull();
  }, 60_000);

  it("surfaces a MISSING object rather than returning an empty document", async () => {
    // Metadata can outlive its bytes: a manual deletion, a restored database,
    // a provider incident. Returning empty content would present a corrupted
    // document as a valid one (§86).
    const ref = keys.artifactKey({
      workspaceId: WS_A, documentId: DOC, artifactId: "art_ghost" as ArtifactId,
    });
    await uow.runForWorkspace(WS_A, uw => uw.artifacts.insert({
        artifactId: "art_ghost" as ArtifactId, workspaceId: WS_A, documentId: DOC,
        artifactType: "original", storageReference: ref.key,
        mediaType: "application/pdf", sizeBytes: 100, digestAlgorithm: "sha-256",
        digest: sha256(samplePdf()) as Sha256Digest, createdAt: 0,
      }));

    const loaded = await uow.runForWorkspace(WS_A, uw => uw.artifacts.find("art_ghost" as ArtifactId));
    expect(loaded).not.toBeNull();

    // null is an explicit, typed absence — a caller cannot mistake it for
    // content, which a zero-length buffer absolutely could be.
    expect(await storage.getObject({ zone: "artifacts", key: loaded!.storageReference }))
      .toBeNull();
  }, 60_000);

  it("persists a KEY, never a URL or a credential", async () => {
    // A presigned URL expires and is a bearer credential; a permanent public
    // URL would mean the bucket is readable (INV-207).
    const ref = keys.artifactKey({ workspaceId: WS_A, documentId: DOC, artifactId: ART });
    const { rows } = await database.db
      .selectFrom("document_artifacts").select("storage_reference")
      .where("workspace_id", "=", WS_A).execute()
      .then(r => ({ rows: r }));
    expect(rows).toHaveLength(0); // nothing written yet in this test

    await uow.runForWorkspace(WS_A, uw => uw.artifacts.insert({
        artifactId: ART, workspaceId: WS_A, documentId: DOC, artifactType: "original",
        storageReference: ref.key, mediaType: "application/pdf", sizeBytes: 10,
        digestAlgorithm: "sha-256", digest: sha256(samplePdf()) as Sha256Digest,
        createdAt: 0,
      }));

    const stored = await database.db.selectFrom("document_artifacts")
      .select("storage_reference").executeTakeFirstOrThrow();
    expect(stored.storage_reference).toBe(ref.key);
    for (const forbidden of ["http://", "https://", "X-Amz-", "Signature", "?"]) {
      expect(stored.storage_reference).not.toContain(forbidden);
    }
  }, 60_000);
});
