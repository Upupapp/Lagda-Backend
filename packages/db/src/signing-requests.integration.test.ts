// Signing requests against REAL PostgreSQL, as the RUNTIME role.
//
// What only this suite can prove:
//
//   1. A field of request A cannot name a recipient of request B, even in one
//      workspace — the three-column key. RLS is no help: both rows are
//      legitimately visible.
//   2. The runtime role holds NO UPDATE grant on either snapshot table, so
//      immutability is a privilege rather than a convention.
//   3. Deleting a preparation recipient or field NULLs the request's provenance
//      and leaves the snapshot standing, without failing on a not-null column.
//   4. Cross-tenant document, artifact and preparation references are
//      constraint violations.
//   5. Two genuinely concurrent creations under one idempotency key produce
//      exactly one request.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type {
  DocumentId, IdempotencyKey, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import type {
  ArtifactId, PreparationId, PreparationFieldId, PreparationFieldRecord,
  RecipientId, SigningRequestId, SigningRequestRecipientId, SigningRequestFieldId,
  NewSigningRequestSnapshot,
} from "@lagda/application";
import { createSigningRequest } from "@lagda/application";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "@lagda/application/test-support";
import { createDatabase, type LagdaDatabase } from "./client/index.js";
import { loadDatabaseConfig } from "./config/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-08-10T07:00:00.000Z");
const USER = "usr_sr" as UserId;
const WS_A = "ws_sr_a" as WorkspaceId;
const WS_B = "ws_sr_b" as WorkspaceId;
const DOC_A = "doc_sr_a" as DocumentId;
const DOC_B = "doc_sr_b" as DocumentId;
const DIGEST = "f".repeat(64);

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("signing requests (RLS, runtime role)", () => {
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

  const PREP_A = "prep_sr_a" as PreparationId;
  const PREP_B = "prep_sr_b" as PreparationId;
  const RCP_A = "rcp_sr_a" as RecipientId;
  const FIELD_A = "pf_sr_a" as PreparationFieldId;

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, USER);
    const tx = createTransactionManager(owner.db);

    for (const [ws, member, doc, prep, rcp, field] of [
      [WS_A, "mem_sa", DOC_A, PREP_A, RCP_A, FIELD_A],
      [WS_B, "mem_sb", DOC_B, PREP_B, "rcp_sr_b", "pf_sr_b"],
    ] as const) {
      await tx.runForWorkspace(ws, async uow => {
        await uow.workspaces.insert({ workspaceId: ws, name: `WS ${ws}`, createdAt: AT });
        await uow.memberships.insert({
          memberId: member as WorkspaceMemberId, workspaceId: ws,
          userId: USER, role: "owner", createdAt: AT,
        });
        await uow.documents.insert({
          documentId: doc, workspaceId: ws, title: "Office Lease",
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
          preparationId: prep, workspaceId: ws, documentId: doc,
          sourceArtifactId: `art_${doc}`, createdAt: AT,
        });
        await uow.recipients.insert({
          recipientId: rcp as RecipientId, workspaceId: ws, preparationId: prep,
          sourceContactId: null,
          name: "Juan dela Cruz", email: "Juan@Example.com",
          emailKey: "juan@example.com" as never,
          organization: null, type: "signer", isRequired: true,
          orderIndex: 0, routingOrder: 1, createdAt: AT,
        });
        await uow.preparations.replaceLayout({
          preparationId: prep, expectedRevision: 1, now: AT,
          fields: [{
            fieldId: field as PreparationFieldId,
            type: "signature", pageNumber: 1,
            x: 0.1, y: 0.2, width: 0.3, height: 0.05,
            required: true, label: "Landlord signature", layer: 0,
            recipientId: rcp as RecipientId,
          } satisfies PreparationFieldRecord],
        });
      });
    }
  });

  /** Builds a raw snapshot, so a test can write shapes the use case would refuse. */
  const snapshot = (
    workspaceId: WorkspaceId,
    over: {
      requestId?: string; recipientId?: string; fieldId?: string;
      fieldRecipientId?: string; preparationId?: PreparationId;
      documentId?: DocumentId; artifactId?: string;
    } = {},
  ): NewSigningRequestSnapshot => {
    const requestId = (over.requestId ?? "sr_1") as SigningRequestId;
    const recipientId = (over.recipientId ?? "srr_1") as SigningRequestRecipientId;
    return {
      request: {
        signingRequestId: requestId,
        workspaceId,
        documentId: over.documentId ?? DOC_A,
        sourceArtifactId: (over.artifactId ?? `art_${DOC_A}`) as ArtifactId,
        sourcePreparationId: over.preparationId ?? PREP_A,
        sourcePreparationRevision: 2,
        state: "draft",
        documentTitle: "Office Lease",
        createdByUserId: USER,
        createdAt: AT,
        updatedAt: AT,
      },
      recipients: [{
        recipientId,
        sourcePreparationRecipientId: RCP_A,
        name: "Juan dela Cruz",
        email: "Juan@Example.com",
        normalizedEmail: "juan@example.com",
        organization: null,
        type: "signer",
        isRequired: true,
        orderIndex: 0,
        routingOrder: 1,
      }],
      fields: [{
        fieldId: (over.fieldId ?? "srf_1") as SigningRequestFieldId,
        sourcePreparationFieldId: FIELD_A,
        type: "signature",
        pageNumber: 1,
        x: 0.1, y: 0.2, width: 0.3, height: 0.05,
        required: true, label: "Landlord signature", layer: 0,
        recipientId: (over.fieldRecipientId ?? recipientId) as SigningRequestRecipientId,
      }],
    };
  };

  const write = (workspaceId: WorkspaceId, over = {}) =>
    createTransactionManager(app.db).runForWorkspace(workspaceId, uow =>
      uow.signingRequests.createSnapshot(snapshot(workspaceId, over)));

  // ── Tenancy ───────────────────────────────────────────────────────────────

  describe("row-level security", () => {
    it("hides another workspace's request", async () => {
      await write(WS_A);
      const seen = await createTransactionManager(app.db)
        .runForWorkspace(WS_B, uow => uow.signingRequests.find("sr_1" as SigningRequestId));
      expect(seen).toBeNull();
    });

    it("refuses a request whose workspace differs from the bound scope", async () => {
      await expect(createTransactionManager(app.db).runForWorkspace(WS_A, uow =>
        uow.signingRequests.createSnapshot(snapshot(WS_B)),
      )).rejects.toThrow(/workspace/i);
    });

    it("refuses a request naming another workspace's document", async () => {
      await expect(write(WS_A, { documentId: DOC_B })).rejects
        .toThrow(/foreign key|violates/i);
    });

    it("refuses a request naming another workspace's artifact", async () => {
      await expect(write(WS_A, { artifactId: `art_${DOC_B}` })).rejects
        .toThrow(/foreign key|violates/i);
    });

    it("refuses a request naming another workspace's preparation", async () => {
      await expect(write(WS_A, { preparationId: PREP_B })).rejects
        .toThrow(/foreign key|violates/i);
    });

    it("holds no BYPASSRLS and is not a superuser", async () => {
      const row = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`
        select rolbypassrls, rolsuper from pg_roles where rolname = 'lagda_app'
      `.execute(owner.db);
      expect(row.rows[0]?.rolbypassrls).toBe(false);
      expect(row.rows[0]?.rolsuper).toBe(false);
    });
  });

  // ── The three-column assignment key ───────────────────────────────────────

  describe("a field cannot name another request's recipient", () => {
    it("refuses it even within one workspace", async () => {
      // Both requests belong to the same tenant, so RLS sees both. Only the
      // middle column of the key separates them.
      await write(WS_A);
      await expect(write(WS_A, {
        requestId: "sr_2", recipientId: "srr_2", fieldId: "srf_2",
        // The FIRST request's recipient.
        fieldRecipientId: "srr_1",
      })).rejects.toThrow(/foreign key|violates/i);
    });

    it("refuses a recipient id that names nothing", async () => {
      await expect(write(WS_A, { fieldRecipientId: "srr_nothing" })).rejects
        .toThrow(/foreign key|violates/i);
    });
  });

  // ── Immutability by privilege ─────────────────────────────────────────────

  describe("snapshot rows are immutable at the database", () => {
    it("grants the runtime role no UPDATE on the recipient table", async () => {
      const grants = await sql<{ privilege_type: string }>`
        select privilege_type from information_schema.role_table_grants
        where grantee = 'lagda_app' and table_name = 'signing_request_recipients'
      `.execute(owner.db);
      const held = grants.rows.map(row => row.privilege_type);
      expect(held).toContain("INSERT");
      expect(held).toContain("SELECT");
      expect(held).not.toContain("UPDATE");
    });

    it("grants the runtime role no UPDATE on the field table", async () => {
      const grants = await sql<{ privilege_type: string }>`
        select privilege_type from information_schema.role_table_grants
        where grantee = 'lagda_app' and table_name = 'signing_request_fields'
      `.execute(owner.db);
      expect(grants.rows.map(row => row.privilege_type)).not.toContain("UPDATE");
    });

    it("refuses an UPDATE attempted as the runtime role", async () => {
      // The grant, proven by the failure rather than by reading a catalog.
      await write(WS_A);
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`
          update signing_request_recipients set name = 'Rewritten'
          where request_recipient_id = 'srr_1'
        `.execute(trx);
      })).rejects.toThrow(/permission denied/i);
    });

    it("DOES grant UPDATE on the request row, for BACKEND-33's transition", async () => {
      const grants = await sql<{ privilege_type: string }>`
        select privilege_type from information_schema.role_table_grants
        where grantee = 'lagda_app' and table_name = 'signing_requests'
      `.execute(owner.db);
      expect(grants.rows.map(row => row.privilege_type)).toContain("UPDATE");
    });

    it("refuses a state the CHECK does not admit", async () => {
      // `sent` is a claim BACKEND-32 cannot make true. Widening the CHECK is
      // BACKEND-33's, and it arrives with the mechanism that earns it.
      await write(WS_A);
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`
          update signing_requests set state = 'sent' where signing_request_id = 'sr_1'
        `.execute(trx);
      })).rejects.toThrow(/check|violates/i);
    });
  });

  // ── Provenance ────────────────────────────────────────────────────────────

  describe("provenance survives the mutable side changing", () => {
    it("nulls the recipient's provenance when the preparation recipient is deleted", async () => {
      await write(WS_A);
      // The field must go first: BACKEND-31's assignment FK is RESTRICT.
      await createTransactionManager(app.db).runForWorkspace(WS_A, uow =>
        uow.preparations.replaceLayout({
          preparationId: PREP_A, expectedRevision: 2, fields: [], now: AT,
        }));
      await createTransactionManager(app.db).runForWorkspace(WS_A, uow =>
        uow.recipients.remove({ preparationId: PREP_A, recipientId: RCP_A }));

      const [recipient] = await createTransactionManager(app.db).runForWorkspace(
        WS_A, uow => uow.signingRequests.listRecipients("sr_1" as SigningRequestId));
      // The snapshot is intact; only the pointer back is gone.
      expect(recipient?.name).toBe("Juan dela Cruz");
      expect(recipient?.email).toBe("Juan@Example.com");
      expect(recipient?.sourcePreparationRecipientId).toBeNull();
    });

    it("nulls the field's provenance when the preparation field is deleted", async () => {
      await write(WS_A);
      await createTransactionManager(app.db).runForWorkspace(WS_A, uow =>
        uow.preparations.replaceLayout({
          preparationId: PREP_A, expectedRevision: 2, fields: [], now: AT,
        }));

      const [field] = await createTransactionManager(app.db).runForWorkspace(
        WS_A, uow => uow.signingRequests.listFields("sr_1" as SigningRequestId));
      expect(field?.x).toBe(0.1);
      expect(field?.pageNumber).toBe(1);
      expect(field?.sourcePreparationFieldId).toBeNull();
    });

    it("refuses to delete the document a request names", async () => {
      // RESTRICT. A signing workflow is the record that a document was put in
      // front of people; nothing upstream may delete it out from under itself.
      await write(WS_A);
      await expect(
        sql`delete from documents where document_id = ${DOC_A}`.execute(owner.db),
      ).rejects.toThrow(/foreign key|violates/i);
    });
  });

  // ── Constraints ───────────────────────────────────────────────────────────

  describe("CHECK constraints refuse what the domain refuses", () => {
    const raw = (columns: string, values: string) =>
      app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql.raw(
          `insert into signing_requests (signing_request_id, workspace_id,
             document_id, source_artifact_id, source_preparation_id,
             source_preparation_revision, state, document_title,
             created_by_user_id, created_at, updated_at${columns})
           values ('sr_raw', '${WS_A}', '${DOC_A}', 'art_${DOC_A}', '${PREP_A}',
             2, 'draft', 'Office Lease', '${USER}', now(), now()${values})`,
        ).execute(trx);
        return true;
      });

    it("accepts a well-formed row, so the negatives below mean something", async () => {
      await expect(raw("", "")).resolves.toBe(true);
    });

    it("refuses a state outside the CHECK", async () => {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`
          insert into signing_requests (signing_request_id, workspace_id,
            document_id, source_artifact_id, source_preparation_id,
            source_preparation_revision, state, document_title,
            created_by_user_id, created_at, updated_at)
          values ('sr_s', ${WS_A}, ${DOC_A}, ${`art_${DOC_A}`}, ${PREP_A},
            2, 'completed', 'Office Lease', ${USER}, now(), now())
        `.execute(trx);
      })).rejects.toThrow(/check|violates/i);
    });

    it("refuses a blank document title", async () => {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`
          insert into signing_requests (signing_request_id, workspace_id,
            document_id, source_artifact_id, source_preparation_id,
            source_preparation_revision, state, document_title,
            created_by_user_id, created_at, updated_at)
          values ('sr_t', ${WS_A}, ${DOC_A}, ${`art_${DOC_A}`}, ${PREP_A},
            2, 'draft', '   ', ${USER}, now(), now())
        `.execute(trx);
      })).rejects.toThrow(/check|violates/i);
    });

    it("refuses a duplicate recipient address within one request", async () => {
      // The preparation's duplicate rule, preserved at request scope.
      await write(WS_A);
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`
          insert into signing_request_recipients (request_recipient_id, workspace_id,
            signing_request_id, name, email, normalized_email, recipient_type,
            is_required, order_index, routing_order, created_at)
          values ('srr_dup', ${WS_A}, 'sr_1', 'Someone', 'JUAN@EXAMPLE.COM',
            'juan@example.com', 'signer', true, 1, 1, now())
        `.execute(trx);
      })).rejects.toThrow(/duplicate|unique|violates/i);
    });

    it("refuses field geometry that falls off the page", async () => {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`
          insert into signing_requests (signing_request_id, workspace_id,
            document_id, source_artifact_id, source_preparation_id,
            source_preparation_revision, state, document_title,
            created_by_user_id, created_at, updated_at)
          values ('sr_g', ${WS_A}, ${DOC_A}, ${`art_${DOC_A}`}, ${PREP_A},
            2, 'draft', 'Office Lease', ${USER}, now(), now())
        `.execute(trx);
        await sql`
          insert into signing_request_recipients (request_recipient_id, workspace_id,
            signing_request_id, name, email, normalized_email, recipient_type,
            is_required, order_index, routing_order, created_at)
          values ('srr_g', ${WS_A}, 'sr_g', 'A', 'a@x.com', 'a@x.com',
            'signer', true, 0, 1, now())
        `.execute(trx);
        await sql`
          insert into signing_request_fields (request_field_id, workspace_id,
            signing_request_id, field_type, page_number, x, y, width, height,
            required, label, layer, request_recipient_id, created_at)
          values ('srf_g', ${WS_A}, 'sr_g', 'signature', 1,
            0.9, 0.2, 0.3, 0.05, true, 'Off the edge', 0, 'srr_g', now())
        `.execute(trx);
      })).rejects.toThrow(/check|violates/i);
    });
  });

  // ── Idempotency under real concurrency ────────────────────────────────────

  describe("concurrent creation", () => {
    const deps = () => ({
      transactions: createTransactionManager(app.db),
      clock: { now: () => AT },
      ids: freshIds(),
      idempotency: {
        // The REAL digester and id generator, not hand-rolled stand-ins: the
        // claim is inserted into the real table with real unique indexes, and
        // a fake digest would be testing this suite's own arithmetic.
        digester: createIdempotencyKeyDigester(),
        ids: createIdempotencyRecordIds(),
        clock: { now: () => AT },
        policy: { retentionMs: 86_400_000 },
      },
    });

    it("lets exactly one of two concurrent same-key creations win", async () => {
      const attempt = () => createSigningRequest({
        actor: { actorType: "user", userId: USER, sessionId: "ses" as never },
        workspaceId: WS_A,
        documentId: DOC_A,
        idempotencyKey: "concurrent-key" as IdempotencyKey,
      }, deps());

      const results = await Promise.allSettled([attempt(), attempt()]);
      // One may fail on the claim's unique index rather than replay, which is
      // the framework's documented in-progress behaviour. What must hold is
      // that exactly one REQUEST exists.
      const rows = await sql<{ total: string }>`
        select count(*) as total from signing_requests where workspace_id = ${WS_A}
      `.execute(owner.db);
      expect(Number(rows.rows[0]?.total)).toBe(1);
      expect(results.some(result => result.status === "fulfilled")).toBe(true);
    });

    it("writes the request, its recipients and its fields atomically", async () => {
      await createSigningRequest({
        actor: { actorType: "user", userId: USER, sessionId: "ses" as never },
        workspaceId: WS_A,
        documentId: DOC_A,
      }, deps());

      const counts = await sql<{ requests: string; recipients: string; fields: string }>`
        select
          (select count(*) from signing_requests) as requests,
          (select count(*) from signing_request_recipients) as recipients,
          (select count(*) from signing_request_fields) as fields
      `.execute(owner.db);
      expect(counts.rows[0]).toMatchObject({ requests: "1", recipients: "1", fields: "1" });
    });
  });
});

// ── Local generators ─────────────────────────────────────────────────────────
//
// A fresh set per call, so two concurrent attempts cannot collide on a
// generated id and make the idempotency assertion pass for the wrong reason.

let counter = 0;
function freshIds() {
  const base = ++counter;
  let n = 0;
  return {
    nextSigningRequestId: () => `sr_i${String(base)}_${String(++n)}` as SigningRequestId,
    nextSigningRequestRecipientId: () =>
      `srr_i${String(base)}_${String(++n)}` as SigningRequestRecipientId,
    nextSigningRequestFieldId: () =>
      `srf_i${String(base)}_${String(++n)}` as SigningRequestFieldId,
  };
}
