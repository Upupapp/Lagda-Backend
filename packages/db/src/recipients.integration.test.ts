// Recipients against REAL PostgreSQL, as the RUNTIME role.
//
// What only this suite can prove:
//
//   1. RLS hides another tenant's recipients from the runtime role, and the
//      compound foreign keys make cross-tenant linkage a constraint violation.
//   2. `UNIQUE (workspace_id, preparation_id, normalized_recipient_email)`
//      refuses a duplicate under genuine concurrency — the race the fake cannot
//      model, because its rollback restores a whole-store snapshot.
//   3. The three-column assignment key refuses a field naming a recipient of a
//      DIFFERENT preparation in the SAME workspace. Tenant isolation cannot
//      catch that one: both rows are legitimately visible.
//   4. ON DELETE SET NULL leaves a recipient standing when its source contact
//      is deleted, and ON DELETE RESTRICT refuses to remove one that still
//      holds fields.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type {
  ContactId, DocumentId, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import type {
  ArtifactId, PreparationId, PreparationFieldId, PreparationFieldRecord,
  RecipientId, NewRecipient,
} from "@lagda/application";
import type { RecipientEmailKey } from "@lagda/core";
import { createDatabase, type LagdaDatabase } from "./client/index.js";
import { loadDatabaseConfig } from "./config/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-08-10T07:00:00.000Z");
const USER = "usr_rcp" as UserId;
const WS_A = "ws_rcp_a" as WorkspaceId;
const WS_B = "ws_rcp_b" as WorkspaceId;
const DOC_A1 = "doc_rcp_a1" as DocumentId;
const DOC_A2 = "doc_rcp_a2" as DocumentId;
const DOC_B = "doc_rcp_b" as DocumentId;
const CONTACT_A = "con_rcp_a" as ContactId;
const DIGEST = "e".repeat(64);

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("preparation recipients (RLS, runtime role)", () => {
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

  /**
   * Two workspaces. Workspace A has TWO prepared documents, because half of
   * what this suite proves is that a recipient of one cannot be used by the
   * other — and both are in the same tenant, so RLS is no help.
   */
  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, USER);
    const tx = createTransactionManager(owner.db);

    for (const [ws, member, documents] of [
      [WS_A, "mem_ra", [DOC_A1, DOC_A2]],
      [WS_B, "mem_rb", [DOC_B]],
    ] as const) {
      await tx.runForWorkspace(ws, async uow => {
        await uow.workspaces.insert({ workspaceId: ws, name: `WS ${ws}`, createdAt: AT });
        await uow.memberships.insert({
          memberId: member as WorkspaceMemberId, workspaceId: ws,
          userId: USER, role: "owner", createdAt: AT,
        });
        for (const doc of documents) {
          await uow.documents.insert({
            documentId: doc, workspaceId: ws, title: "Lease",
            originalFilename: null, createdByUserId: USER, createdAt: AT,
          });
          await uow.artifacts.insert({
            artifactId: `art_${doc}` as ArtifactId, workspaceId: ws, documentId: doc,
            artifactType: "original",
            storageReference: `${ws}/${doc}/art` as never,
            mediaType: "application/pdf", sizeBytes: 1024,
            digestAlgorithm: "sha-256", digest: DIGEST as never,
            pageCount: 5, rotatedPageCount: 0, createdAt: AT,
          });
          await uow.preparations.insert({
            preparationId: `prep_${doc}` as PreparationId,
            workspaceId: ws, documentId: doc,
            sourceArtifactId: `art_${doc}`, createdAt: AT,
          });
        }
      });
    }

    await tx.runForWorkspace(WS_A, uow => uow.contacts.insert({
      contactId: CONTACT_A, workspaceId: WS_A,
      name: "Maria Santos", email: "Maria@AyalaLand.ph",
      emailKey: "maria@ayalaland.ph" as never,
      phone: null, organization: "Ayala Land", title: null,
      createdAt: AT,
    }));
  });

  const PREP_A1 = "prep_doc_rcp_a1" as PreparationId;
  const PREP_A2 = "prep_doc_rcp_a2" as PreparationId;
  const PREP_B = "prep_doc_rcp_b" as PreparationId;

  const recipient = (over: Partial<NewRecipient> = {}): NewRecipient => ({
    recipientId: "rcp_1" as RecipientId,
    workspaceId: WS_A,
    preparationId: PREP_A1,
    sourceContactId: null,
    name: "Juan dela Cruz",
    email: "Juan@Example.com",
    emailKey: "juan@example.com" as RecipientEmailKey,
    organization: null,
    type: "signer",
    isRequired: true,
    orderIndex: 0,
    routingOrder: 1,
    createdAt: AT,
    ...over,
  });

  const add = (workspaceId: WorkspaceId, over: Partial<NewRecipient> = {}) =>
    createTransactionManager(app.db).runForWorkspace(workspaceId, uow =>
      uow.recipients.insert(recipient({ workspaceId, ...over })));

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

  // ── Tenancy ───────────────────────────────────────────────────────────────

  describe("row-level security", () => {
    it("hides another workspace's recipients", async () => {
      await add(WS_A);
      await add(WS_B, { recipientId: "rcp_b" as RecipientId, preparationId: PREP_B });

      const seen = await createTransactionManager(app.db)
        .runForWorkspace(WS_B, uow => uow.recipients.list(PREP_B));
      expect(seen).toHaveLength(1);
      expect(seen[0]?.recipientId).toBe("rcp_b");

      // A's preparation is invisible from B's scope, so listing it is empty
      // rather than an error — the same silence as everywhere else.
      const across = await createTransactionManager(app.db)
        .runForWorkspace(WS_B, uow => uow.recipients.list(PREP_A1));
      expect(across).toHaveLength(0);
    });

    it("refuses a recipient whose workspace differs from the bound scope", async () => {
      await expect(createTransactionManager(app.db).runForWorkspace(WS_A, uow =>
        uow.recipients.insert(recipient({ workspaceId: WS_B })),
      )).rejects.toThrow(/workspace/i);
    });

    it("refuses a recipient naming another workspace's preparation", async () => {
      // The RLS policy's WITH CHECK and the compound foreign key both apply.
      await expect(createTransactionManager(app.db).runForWorkspace(WS_A, uow =>
        uow.recipients.insert(recipient({ preparationId: PREP_B })),
      )).rejects.toThrow(/foreign key|violates/i);
    });

    it("refuses a recipient naming another workspace's contact", async () => {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_B}, true)`.execute(trx);
        await sql`
          insert into preparation_recipients (recipient_id, workspace_id,
            preparation_id, source_contact_id, name, email,
            normalized_recipient_email, recipient_type, is_required,
            order_index, routing_order, created_at, updated_at)
          values ('rcp_x', ${WS_B}, ${PREP_B}, ${CONTACT_A}, 'X', 'x@y.com',
            'x@y.com', 'signer', true, 0, 1, now(), now())
        `.execute(trx);
      })).rejects.toThrow(/foreign key|violates/i);
    });
  });

  // ── The duplicate rule ────────────────────────────────────────────────────

  describe("one delivery address per preparation", () => {
    it("refuses a second recipient with the same folded address", async () => {
      await add(WS_A);
      await expect(add(WS_A, {
        recipientId: "rcp_2" as RecipientId,
        // A different display address folding to the same key — which is
        // exactly what the constraint compares.
        email: "JUAN@EXAMPLE.COM",
      })).rejects.toThrow(/duplicate|unique|violates/i);
    });

    it("permits the same address on a different preparation", async () => {
      await add(WS_A);
      await add(WS_A, { recipientId: "rcp_2" as RecipientId, preparationId: PREP_A2 });
      const listed = await createTransactionManager(app.db)
        .runForWorkspace(WS_A, uow => uow.recipients.list(PREP_A2));
      expect(listed).toHaveLength(1);
    });

    it("lets exactly one of two concurrent inserts win", async () => {
      // The race the fake cannot model. Both transactions are open before
      // either commits, so the constraint is the only thing separating them.
      const attempt = (recipientId: string) =>
        createTransactionManager(app.db).runForWorkspace(WS_A, uow =>
          uow.recipients.insert(recipient({ recipientId: recipientId as RecipientId })));

      const results = await Promise.allSettled([attempt("rcp_x"), attempt("rcp_y")]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(r => r.status === "rejected")).toHaveLength(1);

      const listed = await createTransactionManager(app.db)
        .runForWorkspace(WS_A, uow => uow.recipients.list(PREP_A1));
      expect(listed).toHaveLength(1);
    });
  });

  // ── Field assignment ──────────────────────────────────────────────────────

  describe("the three-column assignment key", () => {
    const place = (preparationId: PreparationId, assignedTo: string | null) =>
      createTransactionManager(app.db).runForWorkspace(WS_A, uow =>
        uow.preparations.replaceLayout({
          preparationId,
          expectedRevision: 1,
          fields: [field({ recipientId: assignedTo as RecipientId | null })],
          now: AT,
        }));

    it("accepts a recipient of the same preparation", async () => {
      await add(WS_A);
      await expect(place(PREP_A1, "rcp_1")).resolves.toBe(2);
    });

    it("refuses a recipient of a DIFFERENT preparation in the SAME workspace", async () => {
      // Both rows are legitimately visible to this tenant. Only the third
      // column separates them, which is the whole reason the key has three.
      await add(WS_A, { preparationId: PREP_A2 });
      await expect(place(PREP_A1, "rcp_1")).rejects.toThrow(/foreign key|violates/i);
    });

    it("refuses a recipient id that names nothing", async () => {
      await expect(place(PREP_A1, "rcp_nothing")).rejects.toThrow(/foreign key|violates/i);
    });

    it("accepts an unassigned field", async () => {
      await expect(place(PREP_A1, null)).resolves.toBe(2);
    });
  });

  // ── Deletion behaviour ────────────────────────────────────────────────────

  describe("what deletion does", () => {
    it("keeps the recipient and nulls provenance when the contact is deleted", async () => {
      await add(WS_A, { sourceContactId: CONTACT_A });

      // BACKEND-28 granted the runtime role no DELETE on contacts, so the
      // OWNER role performs it — which is precisely the case the SET NULL
      // exists for: a future administrative deletion must not take a party to
      // a contract with it.
      await sql`delete from contacts where contact_id = ${CONTACT_A}`.execute(owner.db);

      const [after] = await createTransactionManager(app.db)
        .runForWorkspace(WS_A, uow => uow.recipients.list(PREP_A1));
      expect(after?.name).toBe("Juan dela Cruz");
      expect(after?.email).toBe("Juan@Example.com");
      expect(after?.sourceContactId).toBeNull();
    });

    it("refuses to delete a recipient that still holds a field", async () => {
      await add(WS_A);
      await createTransactionManager(app.db).runForWorkspace(WS_A, uow =>
        uow.preparations.replaceLayout({
          preparationId: PREP_A1, expectedRevision: 1,
          fields: [field({ recipientId: "rcp_1" as RecipientId })], now: AT,
        }));

      await expect(createTransactionManager(app.db).runForWorkspace(WS_A, uow =>
        uow.recipients.remove({
          preparationId: PREP_A1, recipientId: "rcp_1" as RecipientId,
        }),
      )).rejects.toThrow(/foreign key|violates|restrict/i);

      // And the placed work is still there.
      const fields = await createTransactionManager(app.db)
        .runForWorkspace(WS_A, uow => uow.preparations.listFields(PREP_A1));
      expect(fields).toHaveLength(1);
    });

    it("removes a recipient that holds none", async () => {
      await add(WS_A);
      const removed = await createTransactionManager(app.db).runForWorkspace(WS_A, uow =>
        uow.recipients.remove({
          preparationId: PREP_A1, recipientId: "rcp_1" as RecipientId,
        }));
      expect(removed).toBe(true);
    });
  });

  // ── The column constraints ────────────────────────────────────────────────

  describe("CHECK constraints refuse what the domain refuses", () => {
    const raw = (columns: string, values: string) =>
      app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql.raw(
          `insert into preparation_recipients (recipient_id, workspace_id,
             preparation_id, name, email, normalized_recipient_email,
             recipient_type, is_required, order_index, routing_order,
             created_at, updated_at${columns})
           values ('rcp_raw', '${WS_A}', '${PREP_A1}', 'X', 'x@y.com', 'x@y.com',
             'signer', true, 0, 1, now(), now()${values})`,
        ).execute(trx);
        // Returned so the positive fixture can assert something. A callback
        // that returns nothing makes `resolves.toBeDefined()` fail on a row
        // that inserted perfectly well.
        return true;
      });

    it("accepts a well-formed row, so the negatives below mean something", async () => {
      // A detector with no positive fixture proves nothing.
      await expect(raw("", "")).resolves.toBeDefined();
    });

    it("refuses an unknown recipient type", async () => {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`
          insert into preparation_recipients (recipient_id, workspace_id,
            preparation_id, name, email, normalized_recipient_email,
            recipient_type, is_required, order_index, routing_order,
            created_at, updated_at)
          values ('rcp_w', ${WS_A}, ${PREP_A1}, 'X', 'x@y.com', 'x@y.com',
            'witness', true, 0, 1, now(), now())
        `.execute(trx);
      })).rejects.toThrow(/check|violates/i);
    });

    it("refuses a routing order below 1", async () => {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`
          insert into preparation_recipients (recipient_id, workspace_id,
            preparation_id, name, email, normalized_recipient_email,
            recipient_type, is_required, order_index, routing_order,
            created_at, updated_at)
          values ('rcp_r', ${WS_A}, ${PREP_A1}, 'X', 'x@y.com', 'x@y.com',
            'signer', true, 0, 0, now(), now())
        `.execute(trx);
      })).rejects.toThrow(/check|violates/i);
    });

    it("refuses an unfolded comparison key", async () => {
      // The column is the FOLD. A writer that skipped the domain and stored a
      // mixed-case key would defeat the duplicate rule silently.
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`
          insert into preparation_recipients (recipient_id, workspace_id,
            preparation_id, name, email, normalized_recipient_email,
            recipient_type, is_required, order_index, routing_order,
            created_at, updated_at)
          values ('rcp_u', ${WS_A}, ${PREP_A1}, 'X', 'X@Y.com', 'X@Y.com',
            'signer', true, 0, 1, now(), now())
        `.execute(trx);
      })).rejects.toThrow(/check|violates/i);
    });

    it("refuses a blank name", async () => {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`
          insert into preparation_recipients (recipient_id, workspace_id,
            preparation_id, name, email, normalized_recipient_email,
            recipient_type, is_required, order_index, routing_order,
            created_at, updated_at)
          values ('rcp_n', ${WS_A}, ${PREP_A1}, '   ', 'x@y.com', 'x@y.com',
            'signer', true, 0, 1, now(), now())
        `.execute(trx);
      })).rejects.toThrow(/check|violates/i);
    });
  });

  // ── The runtime role's grants ─────────────────────────────────────────────

  describe("the runtime role", () => {
    it("holds no BYPASSRLS and is not a superuser", async () => {
      const row = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`
        select rolbypassrls, rolsuper from pg_roles where rolname = 'lagda_app'
      `.execute(owner.db);
      expect(row.rows[0]?.rolbypassrls).toBe(false);
      expect(row.rows[0]?.rolsuper).toBe(false);
    });

    it("may delete a recipient, unlike a contact", async () => {
      // The grant asymmetry is deliberate and the reason is in the product: a
      // draft recipient has been sent nowhere, while a contact is a record
      // BACKEND-28 chose to archive rather than destroy.
      const grants = await sql<{ privilege_type: string }>`
        select privilege_type from information_schema.role_table_grants
        where grantee = 'lagda_app' and table_name = 'preparation_recipients'
      `.execute(owner.db);
      expect(grants.rows.map(r => r.privilege_type)).toContain("DELETE");
    });
  });
});
