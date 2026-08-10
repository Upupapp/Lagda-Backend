// Documents against REAL PostgreSQL, as the RUNTIME role.
//
// Three things can only be proved here:
//
//   1. Migration 016's compound foreign key makes a cross-tenant
//      Document→Artifact link a CONSTRAINT VIOLATION, not a bug application
//      code happens to catch. §113 requires exactly this.
//   2. One ORIGINAL artifact per document, enforced by a partial unique index.
//   3. Renaming a document leaves the artifact's digest, size and storage
//      reference byte-for-byte identical.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type {
  DocumentId, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import type { ArtifactId } from "@lagda/application";
import { createDatabase, type LagdaDatabase } from "./client/index.js";
import { loadDatabaseConfig } from "./config/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-08-10T07:00:00.000Z");
const USER = "usr_documents" as UserId;
const WS_A = "ws_docs_a" as WorkspaceId;
const WS_B = "ws_docs_b" as WorkspaceId;

const DIGEST = "a".repeat(64);

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("documents (RLS, runtime role)", () => {
  let owner: LagdaDatabase;
  let app: LagdaDatabase;

  beforeAll(async () => {
    owner = await createTestDatabase();
    await sql`alter role lagda_app with login password 'lagda_app_test'`.execute(owner.db);
    const url = new URL(process.env["DATABASE_TEST_URL"] ?? "");
    url.username = "lagda_app";
    url.password = "lagda_app_test";
    app = createDatabase(loadDatabaseConfig({ DATABASE_URL: url.toString() }));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
  });

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, USER);
    const tx = createTransactionManager(owner.db);
    for (const [id, member] of [[WS_A, "mem_da"], [WS_B, "mem_db"]] as const) {
      await tx.runForWorkspace(id, async uow => {
        await uow.workspaces.insert({ workspaceId: id, name: `WS ${id}`, createdAt: AT });
        await uow.memberships.insert({
          memberId: member as WorkspaceMemberId, workspaceId: id,
          userId: USER, role: "owner", createdAt: AT,
        });
      });
    }
  });

  const newDocument = (workspaceId: WorkspaceId, documentId: string, title = documentId) =>
    createTransactionManager(app.db).runForWorkspace(workspaceId, uow =>
      uow.documents.insert({
        documentId: documentId as DocumentId,
        workspaceId,
        title,
        originalFilename: null,
        createdByUserId: USER,
        createdAt: AT,
      }));

  const newArtifact = (
    workspaceId: WorkspaceId,
    documentId: string,
    artifactId: string,
    over: { type?: "original" | "sealed"; pageCount?: number } = {},
  ) =>
    createTransactionManager(app.db).runForWorkspace(workspaceId, uow =>
      uow.artifacts.insert({
        artifactId: artifactId as ArtifactId,
        workspaceId,
        documentId: documentId as DocumentId,
        artifactType: over.type ?? "original",
        storageReference: `${workspaceId}/${documentId}/${artifactId}` as never,
        mediaType: "application/pdf",
        sizeBytes: 1024,
        digestAlgorithm: "sha-256",
        digest: DIGEST as never,
        ...(over.pageCount === undefined ? {} : { pageCount: over.pageCount }),
        createdAt: AT,
      }));

  // ── The constraint this migration exists for ──────────────────────────────

  describe("cross-tenant artifact linkage is a constraint violation", () => {
    it("refuses a Workspace B artifact naming a Workspace A document", async () => {
      await newDocument(WS_A, "doc_a1");

      // The artifact row is written in WS_B's tenant context, naming WS_A's
      // document. Before migration 016 this succeeded — `document_id` had no
      // foreign key at all — and the only thing standing between it and
      // production was application code.
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_B}, true)`.execute(trx);
        await sql`
          insert into document_artifacts (artifact_id, workspace_id, document_id,
            artifact_type, storage_reference, media_type, size_bytes,
            digest_algorithm, digest, created_at)
          values ('art_cross', ${WS_B}, 'doc_a1', 'original', 'k', 'application/pdf',
            10, 'sha-256', ${DIGEST}, now())
        `.execute(trx);
      })).rejects.toThrow(/foreign key|violates/i);
    });

    it("refuses an artifact naming a document that does not exist", async () => {
      // The dangling reference BACKEND-18 had to live with. `documentId` was a
      // caller-supplied string pointing at nothing until now.
      await expect(newArtifact(WS_A, "doc_ghost", "art_ghost"))
        .rejects.toThrow(/foreign key|violates/i);
    });

    it("permits the same document id in two workspaces, independently", async () => {
      // The compound key is (workspace_id, document_id), so two tenants may
      // legitimately hold the same opaque id without colliding — and an
      // artifact still cannot cross between them.
      await newDocument(WS_A, "doc_shared");
      await expect(newDocument(WS_B, "doc_shared")).rejects.toThrow();
    });
  });

  // ── One original per document ─────────────────────────────────────────────

  describe("a document has at most one ORIGINAL artifact", () => {
    it("refuses a second original", async () => {
      await newDocument(WS_A, "doc_two");
      await newArtifact(WS_A, "doc_two", "art_first");
      await expect(newArtifact(WS_A, "doc_two", "art_second"))
        .rejects.toThrow(/unique|duplicate/i);
    });

    it("permits a sealed artifact alongside the original", async () => {
      // The partial index covers `original` only. A document acquiring a
      // sealed version later is the whole point of separating identity from
      // bytes, and constraining artifact types nobody has decided about is how
      // a constraint ends up being dropped.
      await newDocument(WS_A, "doc_sealed");
      await newArtifact(WS_A, "doc_sealed", "art_orig");
      await expect(newArtifact(WS_A, "doc_sealed", "art_seal", { type: "sealed" }))
        .resolves.toBeUndefined();
    });

    it("permits an original for each of two documents", async () => {
      await newDocument(WS_A, "doc_p");
      await newDocument(WS_A, "doc_q");
      await newArtifact(WS_A, "doc_p", "art_p");
      await expect(newArtifact(WS_A, "doc_q", "art_q")).resolves.toBeUndefined();
    });
  });

  // ── Renaming never touches bytes ──────────────────────────────────────────

  it("a rename leaves the artifact digest, size and reference identical", async () => {
    await newDocument(WS_A, "doc_rename", "lease-v4-final");
    await newArtifact(WS_A, "doc_rename", "art_rename", { pageCount: 12 });

    const tx = createTransactionManager(app.db);
    const before = await tx.runForWorkspace(WS_A,
      uow => uow.artifacts.find("art_rename" as ArtifactId));

    await tx.runForWorkspace(WS_A, uow => uow.documents.rename({
      documentId: "doc_rename" as DocumentId, title: "Office Lease", now: AT + 5_000,
    }));

    const after = await tx.runForWorkspace(WS_A,
      uow => uow.artifacts.find("art_rename" as ArtifactId));

    // The whole artifact row, not just the digest. A rename must change nothing
    // about the bytes or where they live.
    expect(after).toEqual(before);
    expect(after?.digest).toBe(DIGEST);
    expect(after?.pageCount).toBe(12);

    const renamed = await tx.runForWorkspace(WS_A,
      uow => uow.documents.findById("doc_rename" as DocumentId));
    expect(renamed?.title).toBe("Office Lease");
    expect(renamed?.updatedAt).toBe(AT + 5_000);
  });

  it("persists the inspected page count on the artifact", async () => {
    // Before BACKEND-29 this number was computed during upload and discarded.
    await newDocument(WS_A, "doc_pages");
    await newArtifact(WS_A, "doc_pages", "art_pages", { pageCount: 7 });
    const found = await createTransactionManager(app.db).runForWorkspace(WS_A,
      uow => uow.artifacts.find("art_pages" as ArtifactId));
    expect(found?.pageCount).toBe(7);
  });

  it("refuses a non-positive page count", async () => {
    await newDocument(WS_A, "doc_zero");
    await expect(app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
      await sql`
        insert into document_artifacts (artifact_id, workspace_id, document_id,
          artifact_type, storage_reference, media_type, size_bytes,
          digest_algorithm, digest, page_count, created_at)
        values ('art_zero', ${WS_A}, 'doc_zero', 'original', 'k', 'application/pdf',
          10, 'sha-256', ${DIGEST}, 0, now())
      `.execute(trx);
    })).rejects.toThrow(/check constraint/i);
  });

  // ── Tenancy ───────────────────────────────────────────────────────────────

  describe("tenant isolation", () => {
    it("hides another workspace's document entirely", async () => {
      await newDocument(WS_A, "doc_hidden");
      const tx = createTransactionManager(app.db);

      expect(await tx.runForWorkspace(WS_B,
        uow => uow.documents.findById("doc_hidden" as DocumentId))).toBeNull();

      const listed = await tx.runForWorkspace(WS_B, uow => uow.documents.list({
        sort: "createdAt", direction: "desc", offset: 0, limit: 50,
      }));
      expect(listed.items).toHaveLength(0);
      expect(listed.total).toBe(0);
    });

    it("cannot rename across the boundary", async () => {
      await newDocument(WS_A, "doc_x", "Original Title");
      const tx = createTransactionManager(app.db);

      const applied = await tx.runForWorkspace(WS_B, uow => uow.documents.rename({
        documentId: "doc_x" as DocumentId, title: "Hijacked", now: AT + 1,
      }));
      expect(applied).toBe(false);

      const untouched = await tx.runForWorkspace(WS_A,
        uow => uow.documents.findById("doc_x" as DocumentId));
      expect(untouched?.title).toBe("Original Title");
    });

    it("refuses a raw insert naming another tenant", async () => {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_B}, true)`.execute(trx);
        await sql`
          insert into documents (document_id, workspace_id, title,
            created_by_user_id, created_at, updated_at)
          values ('doc_raw', ${WS_A}, 'Raw', ${USER}, now(), now())
        `.execute(trx);
      })).rejects.toThrow(/row-level security/i);
    });

    it("sees nothing at all with no tenant context", async () => {
      await newDocument(WS_A, "doc_ctx");
      const rows = await app.db.transaction().execute(trx =>
        trx.selectFrom("documents").selectAll().execute());
      expect(rows).toHaveLength(0);
    });
  });

  // ── Deletion is unavailable ───────────────────────────────────────────────

  describe("the runtime role cannot delete a document", () => {
    it("is refused a DELETE by PostgreSQL", async () => {
      await newDocument(WS_A, "doc_del");
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`delete from documents where document_id = 'doc_del'`.execute(trx);
      })).rejects.toThrow(/permission denied/i);
    });

    it("holds exactly select, insert and update", async () => {
      const grants = await sql<{ privilege_type: string }>`
        select privilege_type from information_schema.role_table_grants
        where grantee = 'lagda_app' and table_name = 'documents'
      `.execute(owner.db);
      expect(grants.rows.map(r => r.privilege_type).sort())
        .toEqual(["INSERT", "SELECT", "UPDATE"]);
    });
  });

  // ── Constraints and behaviour ─────────────────────────────────────────────

  it("refuses a blank title", async () => {
    await expect(app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
      await sql`
        insert into documents (document_id, workspace_id, title,
          created_by_user_id, created_at, updated_at)
        values ('doc_blank', ${WS_A}, '   ', ${USER}, now(), now())
      `.execute(trx);
    })).rejects.toThrow(/check constraint/i);
  });

  it("PERMITS two documents with the same title", async () => {
    // §167 — no UNIQUE(workspace_id, title). Two "Lease Agreement" documents in
    // one workspace is ordinary, and the product never suggests otherwise.
    await newDocument(WS_A, "doc_t1", "Lease Agreement");
    await expect(newDocument(WS_A, "doc_t2", "Lease Agreement")).resolves.toBeUndefined();
  });

  it("records the original filename write-once", async () => {
    await newDocument(WS_A, "doc_fn");
    const tx = createTransactionManager(app.db);

    expect(await tx.runForWorkspace(WS_A, uow => uow.documents.recordOriginalFilename({
      documentId: "doc_fn" as DocumentId, originalFilename: "lease.pdf", now: AT + 1,
    }))).toBe(true);

    // A second upload cannot rewrite the provenance of the first.
    expect(await tx.runForWorkspace(WS_A, uow => uow.documents.recordOriginalFilename({
      documentId: "doc_fn" as DocumentId, originalFilename: "other.pdf", now: AT + 2,
    }))).toBe(false);

    const found = await tx.runForWorkspace(WS_A,
      uow => uow.documents.findById("doc_fn" as DocumentId));
    expect(found?.originalFilename).toBe("lease.pdf");
  });

  it("paginates with a stable order and a filter-wide total", async () => {
    for (const id of ["doc_1", "doc_2", "doc_3"]) await newDocument(WS_A, id);
    const tx = createTransactionManager(app.db);

    const page1 = await tx.runForWorkspace(WS_A, uow => uow.documents.list({
      sort: "title", direction: "asc", offset: 0, limit: 2,
    }));
    expect(page1.items.map(d => d.title)).toEqual(["doc_1", "doc_2"]);
    expect(page1.total).toBe(3);

    const page2 = await tx.runForWorkspace(WS_A, uow => uow.documents.list({
      sort: "title", direction: "asc", offset: 2, limit: 2,
    }));
    expect(page2.items.map(d => d.title)).toEqual(["doc_3"]);
    expect(page2.total).toBe(3);
  });

  it("rolls a document back with the transaction that wrote it", async () => {
    const tx = createTransactionManager(app.db);
    await expect(tx.runForWorkspace(WS_A, async uow => {
      await uow.documents.insert({
        documentId: "doc_rollback" as DocumentId, workspaceId: WS_A,
        title: "Doomed", originalFilename: null,
        createdByUserId: USER, createdAt: AT,
      });
      throw new Error("boom");
    })).rejects.toThrow("boom");

    expect(await tx.runForWorkspace(WS_A,
      uow => uow.documents.findById("doc_rollback" as DocumentId))).toBeNull();
  });
});
