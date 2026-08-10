// Preparation against REAL PostgreSQL, as the RUNTIME role.
//
// What only this suite can prove:
//
//   1. The compound foreign keys make a cross-tenant preparation, or one
//      targeting another workspace's artifact, a CONSTRAINT VIOLATION.
//   2. `UNIQUE (workspace_id, document_id)` converges two genuinely concurrent
//      first-saves onto one preparation — the race the fake cannot model,
//      because its rollback restores a whole-store snapshot.
//   3. The geometry CHECK constraints reject what the domain rejects, so a
//      writer that skipped the domain still cannot store a bad rectangle.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type {
  DocumentId, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import type {
  ArtifactId, PreparationId, PreparationFieldId, PreparationFieldRecord,
} from "@lagda/application";
import { createDatabase, type LagdaDatabase } from "./client/index.js";
import { loadDatabaseConfig } from "./config/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-08-10T07:00:00.000Z");
const USER = "usr_prep" as UserId;
const WS_A = "ws_prep_a" as WorkspaceId;
const WS_B = "ws_prep_b" as WorkspaceId;
const DOC_A = "doc_prep_a" as DocumentId;
const DOC_B = "doc_prep_b" as DocumentId;
const ART_A = "art_prep_a" as ArtifactId;
const ART_B = "art_prep_b" as ArtifactId;
const DIGEST = "c".repeat(64);

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("document preparation (RLS, runtime role)", () => {
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
    for (const [ws, member, doc, art] of [
      [WS_A, "mem_pa", DOC_A, ART_A],
      [WS_B, "mem_pb", DOC_B, ART_B],
    ] as const) {
      await tx.runForWorkspace(ws, async uow => {
        await uow.workspaces.insert({ workspaceId: ws, name: `WS ${ws}`, createdAt: AT });
        await uow.memberships.insert({
          memberId: member as WorkspaceMemberId, workspaceId: ws,
          userId: USER, role: "owner", createdAt: AT,
        });
        await uow.documents.insert({
          documentId: doc, workspaceId: ws, title: "Lease",
          originalFilename: null, createdByUserId: USER, createdAt: AT,
        });
        await uow.artifacts.insert({
          artifactId: art, workspaceId: ws, documentId: doc,
          artifactType: "original",
          storageReference: `${ws}/${doc}/${art}` as never,
          mediaType: "application/pdf", sizeBytes: 1024,
          digestAlgorithm: "sha-256", digest: DIGEST as never,
          pageCount: 5, rotatedPageCount: 0, createdAt: AT,
        });
      });
    }
  });

  const newPreparation = (
    workspaceId: WorkspaceId, preparationId: string,
    documentId: DocumentId, artifactId: ArtifactId,
  ) => createTransactionManager(app.db).runForWorkspace(workspaceId, uow =>
    uow.preparations.insert({
      preparationId: preparationId as PreparationId,
      workspaceId, documentId, sourceArtifactId: artifactId, createdAt: AT,
    }));

  const field = (over: Partial<PreparationFieldRecord> = {}): PreparationFieldRecord => ({
    fieldId: "pf_1" as PreparationFieldId,
    type: "signature",
    pageNumber: 1,
    x: 0.1, y: 0.2, width: 0.3, height: 0.05,
    required: true,
    label: "Landlord signature",
    layer: 0,
    recipientId: null,
    ...over,
  });

  // ── Tenant-safe foreign keys ──────────────────────────────────────────────

  describe("cross-tenant linkage is a constraint violation", () => {
    it("refuses a preparation in B targeting A's document", async () => {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_B}, true)`.execute(trx);
        await sql`
          insert into document_preparations (preparation_id, workspace_id,
            document_id, source_artifact_id, created_at, updated_at)
          values ('prep_x', ${WS_B}, ${DOC_A}, ${ART_B}, now(), now())
        `.execute(trx);
      })).rejects.toThrow(/foreign key|violates/i);
    });

    it("refuses a preparation targeting another workspace's ARTIFACT", async () => {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_B}, true)`.execute(trx);
        await sql`
          insert into document_preparations (preparation_id, workspace_id,
            document_id, source_artifact_id, created_at, updated_at)
          values ('prep_y', ${WS_B}, ${DOC_B}, ${ART_A}, now(), now())
        `.execute(trx);
      })).rejects.toThrow(/foreign key|violates/i);
    });

    it("refuses a field attached to another workspace's preparation", async () => {
      await newPreparation(WS_A, "prep_a", DOC_A, ART_A);
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_B}, true)`.execute(trx);
        await sql`
          insert into preparation_fields (field_id, workspace_id, preparation_id,
            field_type, page_number, x, y, width, height, required, label, layer)
          values ('pf_x', ${WS_B}, 'prep_a', 'signature', 1, 0.1, 0.1, 0.1, 0.1,
            true, 'x', 0)
        `.execute(trx);
      })).rejects.toThrow(/foreign key|violates/i);
    });
  });

  // ── One preparation per document, under real concurrency ──────────────────

  describe("one preparation per document", () => {
    it("refuses a second preparation for the same document", async () => {
      await newPreparation(WS_A, "prep_1", DOC_A, ART_A);
      await expect(newPreparation(WS_A, "prep_2", DOC_A, ART_A))
        .rejects.toThrow(/unique|duplicate/i);
    });

    it("converges when two inserts race for real", async () => {
      // Genuinely concurrent transactions against PostgreSQL. Exactly one
      // commits; the other violates the unique constraint. This is the case the
      // in-memory fake cannot model, because its rollback restores a
      // whole-store snapshot and would discard the winner too.
      const results = await Promise.allSettled([
        newPreparation(WS_A, "prep_race_1", DOC_A, ART_A),
        newPreparation(WS_A, "prep_race_2", DOC_A, ART_A),
      ]);

      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      const rows = await sql<{ n: string }>`
        select count(*) as n from document_preparations where document_id = ${DOC_A}
      `.execute(owner.db);
      expect(Number(rows.rows[0]?.n)).toBe(1);
    });

    it("permits one preparation per document across two documents", async () => {
      const tx = createTransactionManager(owner.db);
      await tx.runForWorkspace(WS_A, uow => uow.documents.insert({
        documentId: "doc_prep_a2" as DocumentId, workspaceId: WS_A, title: "Second",
        originalFilename: null, createdByUserId: USER, createdAt: AT,
      }));
      await tx.runForWorkspace(WS_A, uow => uow.artifacts.insert({
        artifactId: "art_a2" as ArtifactId, workspaceId: WS_A,
        documentId: "doc_prep_a2" as DocumentId, artifactType: "original",
        storageReference: "k2" as never, mediaType: "application/pdf",
        sizeBytes: 1, digestAlgorithm: "sha-256", digest: DIGEST as never,
        pageCount: 2, rotatedPageCount: 0, createdAt: AT,
      }));

      await newPreparation(WS_A, "prep_d1", DOC_A, ART_A);
      await expect(newPreparation(
        WS_A, "prep_d2", "doc_prep_a2" as DocumentId, "art_a2" as ArtifactId))
        .resolves.toBeUndefined();
    });
  });

  // ── Geometry, at the database ─────────────────────────────────────────────

  describe("geometry CHECK constraints", () => {
    const insertRaw = (values: string) => app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
      await sql`
        insert into preparation_fields (field_id, workspace_id, preparation_id,
          field_type, page_number, x, y, width, height, required, label, layer)
        values ${sql.raw(values)}
      `.execute(trx);
    });

    beforeEach(async () => { await newPreparation(WS_A, "prep_g", DOC_A, ART_A); });

    it("refuses zero and negative size", async () => {
      for (const [w, h] of [["0", "0.1"], ["0.1", "0"], ["-0.1", "0.1"]]) {
        await expect(insertRaw(
          `('pf_z', '${WS_A}', 'prep_g', 'signature', 1, 0.1, 0.1, ${w}, ${h}, true, 'x', 0)`,
        )).rejects.toThrow(/check constraint/i);
      }
    });

    it("refuses a field outside the page", async () => {
      // Possible as a CHECK only because the coordinates are normalized: the
      // page is 1 wide by definition, so no page dimension is needed.
      for (const values of [
        `('pf_o', '${WS_A}', 'prep_g', 'signature', 1, 0.95, 0.1, 0.1, 0.1, true, 'x', 0)`,
        `('pf_o', '${WS_A}', 'prep_g', 'signature', 1, -0.1, 0.1, 0.1, 0.1, true, 'x', 0)`,
        `('pf_o', '${WS_A}', 'prep_g', 'signature', 1, 0.1, 0.98, 0.1, 0.1, true, 'x', 0)`,
      ]) {
        await expect(insertRaw(values)).rejects.toThrow(/check constraint/i);
      }
    });

    it("refuses NaN and Infinity", async () => {
      // They fail the bounds comparison, which is why the CHECK catches them
      // without a separate `isfinite` clause.
      for (const bad of ["'NaN'", "'Infinity'"]) {
        await expect(insertRaw(
          `('pf_n', '${WS_A}', 'prep_g', 'signature', 1, 0.1, 0.1, ${bad}::double precision, 0.1, true, 'x', 0)`,
        )).rejects.toThrow(/check constraint/i);
      }
    });

    it("refuses page 0 and a negative page", async () => {
      for (const page of ["0", "-1"]) {
        await expect(insertRaw(
          `('pf_p', '${WS_A}', 'prep_g', 'signature', ${page}, 0.1, 0.1, 0.1, 0.1, true, 'x', 0)`,
        )).rejects.toThrow(/check constraint/i);
      }
    });

    it("refuses an unknown field type", async () => {
      // The eight editor types with no renderer, and anything invented.
      for (const type of ["radio-group", "multiline-text", "sender-text", "dropdown"]) {
        await expect(insertRaw(
          `('pf_t', '${WS_A}', 'prep_g', '${type}', 1, 0.1, 0.1, 0.1, 0.1, true, 'x', 0)`,
        )).rejects.toThrow(/check constraint/i);
      }
    });

    it("accepts every implemented field type", async () => {
      const types = [
        "signature", "initials", "date-signed", "text", "checkbox",
        "full-name", "email", "title", "company",
      ];
      const tx = createTransactionManager(app.db);
      const fields = types.map((type, index) => field({
        fieldId: `pf_${type}` as PreparationFieldId,
        type: type as PreparationFieldRecord["type"],
        layer: index,
      }));
      const revision = await tx.runForWorkspace(WS_A, uow =>
        uow.preparations.replaceLayout({
          preparationId: "prep_g" as PreparationId,
          expectedRevision: 1, fields, now: AT + 100,
        }));
      expect(revision).toBe(2);
    });
  });

  // ── Layout replacement ────────────────────────────────────────────────────

  describe("replaceLayout", () => {
    beforeEach(async () => { await newPreparation(WS_A, "prep_r", DOC_A, ART_A); });

    const replace = (
      expectedRevision: number, fields: readonly PreparationFieldRecord[],
    ) => createTransactionManager(app.db).runForWorkspace(WS_A, uow =>
      uow.preparations.replaceLayout({
        preparationId: "prep_r" as PreparationId, expectedRevision, fields, now: AT + 50,
      }));

    it("replaces the whole set and advances the revision", async () => {
      expect(await replace(1, [field({ fieldId: "pf_a" as PreparationFieldId })])).toBe(2);
      expect(await replace(2, [
        field({ fieldId: "pf_b" as PreparationFieldId, label: "b" }),
        field({ fieldId: "pf_c" as PreparationFieldId, label: "c", layer: 1 }),
      ])).toBe(3);

      const listed = await createTransactionManager(app.db).runForWorkspace(WS_A,
        uow => uow.preparations.listFields("prep_r" as PreparationId));
      expect(listed.map(f => f.fieldId)).toEqual(["pf_b", "pf_c"]);
    });

    it("REFUSES a stale revision and changes nothing", async () => {
      await replace(1, [field({ fieldId: "pf_keep" as PreparationFieldId })]);
      expect(await replace(1, [field({ fieldId: "pf_lost" as PreparationFieldId })]))
        .toBeNull();

      const listed = await createTransactionManager(app.db).runForWorkspace(WS_A,
        uow => uow.preparations.listFields("prep_r" as PreparationId));
      expect(listed.map(f => f.fieldId)).toEqual(["pf_keep"]);
    });

    it("REFUSES to mutate a LOCKED preparation", async () => {
      // Nothing in BACKEND-30 sets `locked_at`; setting it directly is how the
      // freeze seam is exercised before BACKEND-32 exists to trigger it.
      await sql`
        update document_preparations set locked_at = now() where preparation_id = 'prep_r'
      `.execute(owner.db);

      expect(await replace(1, [field()])).toBeNull();
    });

    it("clears every field when given an empty layout", async () => {
      await replace(1, [field({ fieldId: "pf_gone" as PreparationFieldId })]);
      expect(await replace(2, [])).toBe(3);

      const listed = await createTransactionManager(app.db).runForWorkspace(WS_A,
        uow => uow.preparations.listFields("prep_r" as PreparationId));
      expect(listed).toEqual([]);
    });

    it("is ATOMIC — a bad field leaves the previous layout intact", async () => {
      await replace(1, [field({ fieldId: "pf_good" as PreparationFieldId })]);

      // A geometry the CHECK refuses, alongside a valid field.
      await expect(replace(2, [
        field({ fieldId: "pf_ok" as PreparationFieldId }),
        field({ fieldId: "pf_bad" as PreparationFieldId, width: 5 }),
      ])).rejects.toThrow();

      const listed = await createTransactionManager(app.db).runForWorkspace(WS_A,
        uow => uow.preparations.listFields("prep_r" as PreparationId));
      expect(listed.map(f => f.fieldId)).toEqual(["pf_good"]);
    });

    it("returns fields in page, layer, id order", async () => {
      await replace(1, [
        field({ fieldId: "pf_3" as PreparationFieldId, pageNumber: 3, layer: 0 }),
        field({ fieldId: "pf_2" as PreparationFieldId, pageNumber: 1, layer: 9 }),
        field({ fieldId: "pf_1" as PreparationFieldId, pageNumber: 1, layer: 0 }),
      ]);
      const listed = await createTransactionManager(app.db).runForWorkspace(WS_A,
        uow => uow.preparations.listFields("prep_r" as PreparationId));
      expect(listed.map(f => f.fieldId)).toEqual(["pf_1", "pf_2", "pf_3"]);
    });

    it("round-trips coordinates without drift", async () => {
      await replace(1, [field({
        fieldId: "pf_precise" as PreparationFieldId,
        // Six-decimal values that stay inside the page: the fixture originally
        // used y=0.987654 with height 0.050001, which sums past 1 — and the
        // bounds CHECK caught it, which is the constraint working.
        x: 0.123457, y: 0.887654, width: 0.25, height: 0.050001,
      })]);
      const listed = await createTransactionManager(app.db).runForWorkspace(WS_A,
        uow => uow.preparations.listFields("prep_r" as PreparationId));
      expect(listed[0]).toMatchObject({
        x: 0.123457, y: 0.887654, width: 0.25, height: 0.050001,
      });
    });
  });

  // ── The original stays untouched ──────────────────────────────────────────

  it("never changes the source artifact", async () => {
    await newPreparation(WS_A, "prep_imm", DOC_A, ART_A);
    const tx = createTransactionManager(app.db);
    const before = await tx.runForWorkspace(WS_A, uow => uow.artifacts.find(ART_A));

    await tx.runForWorkspace(WS_A, uow => uow.preparations.replaceLayout({
      preparationId: "prep_imm" as PreparationId, expectedRevision: 1,
      fields: [field(), field({ fieldId: "pf_2" as PreparationFieldId, layer: 1 })],
      now: AT + 10,
    }));

    const after = await tx.runForWorkspace(WS_A, uow => uow.artifacts.find(ART_A));
    // The whole row: digest, size, storage reference, page count, rotation.
    expect(after).toEqual(before);
    expect(after?.digest).toBe(DIGEST);
  });

  // ── Tenancy ───────────────────────────────────────────────────────────────

  describe("tenant isolation", () => {
    it("hides another workspace's preparation entirely", async () => {
      await newPreparation(WS_A, "prep_hidden", DOC_A, ART_A);
      const tx = createTransactionManager(app.db);
      expect(await tx.runForWorkspace(WS_B,
        uow => uow.preparations.findByDocument(DOC_A))).toBeNull();
    });

    it("cannot replace another workspace's layout", async () => {
      await newPreparation(WS_A, "prep_x", DOC_A, ART_A);
      const applied = await createTransactionManager(app.db).runForWorkspace(WS_B,
        uow => uow.preparations.replaceLayout({
          preparationId: "prep_x" as PreparationId, expectedRevision: 1,
          fields: [field()], now: AT + 1,
        }));
      expect(applied).toBeNull();
    });

    it("sees nothing with no tenant context", async () => {
      await newPreparation(WS_A, "prep_ctx", DOC_A, ART_A);
      const rows = await app.db.transaction().execute(trx =>
        trx.selectFrom("document_preparations").selectAll().execute());
      expect(rows).toHaveLength(0);
    });
  });

  // ── Cascade ───────────────────────────────────────────────────────────────

  it("cascades fields when a preparation is removed, and nothing else", async () => {
    await newPreparation(WS_A, "prep_cascade", DOC_A, ART_A);
    await createTransactionManager(app.db).runForWorkspace(WS_A,
      uow => uow.preparations.replaceLayout({
        preparationId: "prep_cascade" as PreparationId, expectedRevision: 1,
        fields: [field()], now: AT,
      }));

    // The one CASCADE in the schema: a field has no meaning without its
    // preparation and nothing references it.
    await app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
      await sql`delete from document_preparations where preparation_id = 'prep_cascade'`
        .execute(trx);
    });

    const fields = await sql<{ n: string }>`
      select count(*) as n from preparation_fields
    `.execute(owner.db);
    expect(Number(fields.rows[0]?.n)).toBe(0);

    // The document and its artifact survive — RESTRICT, not cascade.
    const artifacts = await sql<{ n: string }>`
      select count(*) as n from document_artifacts where artifact_id = ${ART_A}
    `.execute(owner.db);
    expect(Number(artifacts.rows[0]?.n)).toBe(1);
  });
});
