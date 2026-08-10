// Signature submission against REAL PostgreSQL, as the RUNTIME role.
//
// What only this suite can prove:
//
//   1. ONE accepted submission per recipient, under genuine concurrency.
//   2. Another recipient's field has NO REFERENT — the four-column assignment
//      key means a cross-recipient value is impossible, not merely refused.
//   3. An accepted value cannot be updated or deleted, because the runtime
//      role holds no such privilege.
//   4. The recipient realm reads only its own submission.
//   5. The runtime role still has no BYPASSRLS and is not a superuser.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type {
  DocumentId, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import type {
  ArtifactId, PreparationId, RecipientId,
  SigningRequestId, SigningRequestRecipientId, SigningRequestFieldId,
  SigningAccessGrantId, SigningAccessDigest, RecipientSessionDigest,
  RecipientSigningSessionId, RecipientSubmissionId, SigningFieldValueId,
  NewSigningRequestSnapshot,
} from "@lagda/application";
import { createDatabase, type LagdaDatabase } from "./client/index.js";
import { loadDatabaseConfig } from "./config/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-08-10T07:00:00.000Z");
const USER = "usr_ss" as UserId;
const WS = "ws_ss" as WorkspaceId;
const DOC = "doc_ss" as DocumentId;
const REQUEST = "sr_ss" as SigningRequestId;
const R1 = "srr_ss_1" as SigningRequestRecipientId;
const R2 = "srr_ss_2" as SigningRequestRecipientId;
const F1 = "srf_ss_1" as SigningRequestFieldId;
const F2 = "srf_ss_2" as SigningRequestFieldId;
const SESSION_1 = "1".repeat(64) as RecipientSessionDigest;
const SESSION_2 = "2".repeat(64) as RecipientSessionDigest;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("signature submission (RLS, constraints, runtime role)", () => {
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

  /** One request, TWO recipients, one text field each. */
  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, USER);
    const tx = createTransactionManager(owner.db);

    await tx.runForWorkspace(WS, async uow => {
      await uow.workspaces.insert({ workspaceId: WS, name: "WS", createdAt: AT });
      await uow.memberships.insert({
        memberId: "mem_ss" as WorkspaceMemberId, workspaceId: WS,
        userId: USER, role: "owner", createdAt: AT,
      });
      await uow.documents.insert({
        documentId: DOC, workspaceId: WS, title: "Lease",
        originalFilename: null, createdByUserId: USER, createdAt: AT,
      });
      await uow.artifacts.insert({
        artifactId: "art_ss" as ArtifactId, workspaceId: WS, documentId: DOC,
        artifactType: "original", storageReference: "ws/a" as never,
        mediaType: "application/pdf", sizeBytes: 1024,
        digestAlgorithm: "sha-256", digest: "f".repeat(64) as never,
        pageCount: 3, rotatedPageCount: 0, createdAt: AT,
      });
      await uow.preparations.insert({
        preparationId: "prep_ss" as PreparationId, workspaceId: WS,
        documentId: DOC, sourceArtifactId: "art_ss", createdAt: AT,
      });
      await uow.recipients.insert({
        recipientId: "rcp_ss" as RecipientId, workspaceId: WS,
        preparationId: "prep_ss" as PreparationId, sourceContactId: null,
        name: "Juan", email: "Juan@Example.com",
        emailKey: "juan@example.com" as never, organization: null,
        type: "signer", isRequired: true, orderIndex: 0, routingOrder: 1,
        createdAt: AT,
      });

      const snapshot: NewSigningRequestSnapshot = {
        request: {
          signingRequestId: REQUEST, workspaceId: WS, documentId: DOC,
          sourceArtifactId: "art_ss" as ArtifactId,
          sourcePreparationId: "prep_ss" as PreparationId,
          sourcePreparationRevision: 1, state: "draft",
          documentTitle: "Lease", createdByUserId: USER,
          createdAt: AT, updatedAt: AT,
        },
        recipients: [
          {
            recipientId: R1, sourcePreparationRecipientId: null,
            name: "Juan", email: "Juan@Example.com",
            normalizedEmail: "juan@example.com", organization: null,
            type: "signer", isRequired: true, orderIndex: 0, routingOrder: 1,
          },
          {
            recipientId: R2, sourcePreparationRecipientId: null,
            name: "Maria", email: "Maria@Example.com",
            normalizedEmail: "maria@example.com", organization: null,
            type: "signer", isRequired: true, orderIndex: 1, routingOrder: 1,
          },
        ],
        fields: [
          {
            fieldId: F1, sourcePreparationFieldId: null, type: "text",
            pageNumber: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.05,
            required: true, label: "Notes", layer: 0, recipientId: R1,
          },
          {
            fieldId: F2, sourcePreparationFieldId: null, type: "text",
            pageNumber: 1, x: 0.5, y: 0.2, width: 0.3, height: 0.05,
            required: true, label: "Notes", layer: 0, recipientId: R2,
          },
        ],
      };
      await uow.signingRequests.createSnapshot(snapshot);
      await uow.signingAccess.insertActivations({
        signingRequestId: REQUEST,
        activations: [
          { recipientId: R1, state: "active", activatedAt: AT },
          { recipientId: R2, state: "active", activatedAt: AT },
        ],
        createdAt: AT,
      });
      await uow.signingAccess.insertGrant({
        grantId: "sag_ss" as SigningAccessGrantId, workspaceId: WS,
        signingRequestId: REQUEST, recipientId: R1,
        credentialDigest: "a".repeat(64) as SigningAccessDigest,
        createdAt: AT, expiresAt: AT + 14 * 24 * 3_600_000,
      });
      await uow.signingRequests.markSentIfDraft({
        signingRequestId: REQUEST, sentAt: AT,
      });
    });

    await sql`
      insert into recipient_signing_sessions (
        signing_session_id, workspace_id, signing_request_id,
        request_recipient_id, source_grant_id, token_digest, csrf_token_digest,
        authentication_method, authenticated_at, created_at, expires_at)
      values
        ('rss_1', ${WS}, ${REQUEST}, ${R1}, 'sag_ss', ${SESSION_1},
         ${"c".repeat(64)}, 'link-only', to_timestamp(${AT / 1000}),
         to_timestamp(${AT / 1000}), to_timestamp(${(AT + 8 * 3_600_000) / 1000})),
        ('rss_2', ${WS}, ${REQUEST}, ${R2}, 'sag_ss', ${SESSION_2},
         ${"d".repeat(64)}, 'link-only', to_timestamp(${AT / 1000}),
         to_timestamp(${AT / 1000}), to_timestamp(${(AT + 8 * 3_600_000) / 1000}))
    `.execute(owner.db);
  });

  const scopeOf = (recipientId: SigningRequestRecipientId) => ({
    workspaceId: WS, signingRequestId: REQUEST, recipientId,
  });

  const submitAs = (
    digest: RecipientSessionDigest,
    recipientId: SigningRequestRecipientId,
    submissionId: string,
    fieldId: SigningRequestFieldId,
    text: string,
    sessionId: string,
  ) => createTransactionManager(app.db).runForRecipientSession(digest, sessionUow =>
    sessionUow.enterWorkspace(scopeOf(recipientId), uow =>
      uow.submissions.create({
        submissionId: submissionId as RecipientSubmissionId,
        acceptedAt: AT,
        signingSessionId: sessionId as RecipientSigningSessionId,
        authenticationMethod: "link-only",
        consentId: null,
        representations: [],
        values: [{
          valueId: `${submissionId}_v` as SigningFieldValueId,
          fieldId, fieldType: "text", valueKind: "text",
          valueSource: "RECIPIENT_PROVIDED",
          textValue: text, booleanValue: null, instantValue: null,
          representationId: null,
        }],
      })));

  // ── One per recipient ─────────────────────────────────────────────────────

  describe("one accepted submission per recipient", () => {
    it("accepts the first and refuses a second", async () => {
      await submitAs(SESSION_1, R1, "sub_a", F1, "first", "rss_1");
      await expect(submitAs(SESSION_1, R1, "sub_b", F1, "second", "rss_1"))
        .rejects.toThrow();

      const rows = await sql<{ n: string }>`
        select count(*)::text as n from recipient_submissions`.execute(owner.db);
      expect(Number(rows.rows[0]?.n)).toBe(1);
      const value = await sql<{ text_value: string }>`
        select text_value from signing_field_values`.execute(owner.db);
      // The FIRST value stands. Not overwritten.
      expect(value.rows[0]?.text_value).toBe("first");
    });

    it("accepts exactly one of two CONCURRENT conflicting submissions", async () => {
      const results = await Promise.allSettled([
        submitAs(SESSION_1, R1, "sub_x", F1, "device one", "rss_1"),
        submitAs(SESSION_1, R1, "sub_y", F1, "device two", "rss_1"),
      ]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);

      const rows = await sql<{ n: string }>`
        select count(*)::text as n from recipient_submissions`.execute(owner.db);
      expect(Number(rows.rows[0]?.n)).toBe(1);
    });

    it("lets a DIFFERENT recipient of the same request submit", async () => {
      await submitAs(SESSION_1, R1, "sub_1", F1, "juan", "rss_1");
      await submitAs(SESSION_2, R2, "sub_2", F2, "maria", "rss_2");
      const rows = await sql<{ n: string }>`
        select count(*)::text as n from recipient_submissions`.execute(owner.db);
      expect(Number(rows.rows[0]?.n)).toBe(2);
    });
  });

  // ── Field ownership, at the database ──────────────────────────────────────

  describe("a value cannot point at another recipient's field", () => {
    it("has no referent for a cross-recipient assignment", async () => {
      // R1's session, R2's field. Every application check bypassed — this is
      // the raw insert an application bug would produce.
      await expect(submitAs(SESSION_1, R1, "sub_bad", F2, "not mine", "rss_1"))
        .rejects.toThrow();
      const rows = await sql<{ n: string }>`
        select count(*)::text as n from signing_field_values`.execute(owner.db);
      expect(Number(rows.rows[0]?.n)).toBe(0);
    });

    it("refuses a value for a field of another request", async () => {
      await expect(sql`
        insert into signing_field_values (
          value_id, workspace_id, signing_request_id, request_recipient_id,
          submission_id, request_field_id, field_type, value_kind, value_source,
          text_value)
        values ('v_x', ${WS}, 'sr_other', ${R1}, 'sub_none', ${F1},
                'text', 'text', 'RECIPIENT_PROVIDED', 'x')
      `.execute(owner.db)).rejects.toThrow();
    });

    it("refuses a second value for the same field", async () => {
      await submitAs(SESSION_1, R1, "sub_1", F1, "first", "rss_1");
      await expect(sql`
        insert into signing_field_values (
          value_id, workspace_id, signing_request_id, request_recipient_id,
          submission_id, request_field_id, field_type, value_kind, value_source,
          text_value)
        values ('v_2', ${WS}, ${REQUEST}, ${R1}, 'sub_1', ${F1},
                'text', 'text', 'RECIPIENT_PROVIDED', 'second')
      `.execute(owner.db)).rejects.toThrow();
    });
  });

  // ── Immutability ──────────────────────────────────────────────────────────

  describe("accepted values are immutable", () => {
    it("cannot be UPDATEd by the runtime role", async () => {
      await submitAs(SESSION_1, R1, "sub_1", F1, "signed", "rss_1");
      await expect(sql`update signing_field_values set text_value = 'changed'`
        .execute(app.db)).rejects.toThrow(/permission denied/i);
      await expect(sql`update recipient_submissions set accepted_at = now()`
        .execute(app.db)).rejects.toThrow(/permission denied/i);
    });

    it("cannot be DELETEd by the runtime role", async () => {
      await submitAs(SESSION_1, R1, "sub_1", F1, "signed", "rss_1");
      for (const table of [
        "signing_field_values", "signing_representations", "recipient_submissions",
      ]) {
        await expect(sql`delete from ${sql.raw(table)}`.execute(app.db))
          .rejects.toThrow(/permission denied/i);
      }
    });
  });

  // ── Representation constraints ────────────────────────────────────────────

  describe("representation integrity", () => {
    it("refuses a typed representation carrying raster bytes", async () => {
      await submitAs(SESSION_1, R1, "sub_1", F1, "x", "rss_1");
      await expect(sql`
        insert into signing_representations (
          representation_id, workspace_id, signing_request_id,
          request_recipient_id, submission_id, purpose, representation_type,
          typed_text, typed_style_index, raster_bytes, raster_media_type,
          raster_width, raster_height, digest)
        values ('rep_bad', ${WS}, ${REQUEST}, ${R1}, 'sub_1', 'signature',
                'TYPED_SIGNATURE_V1', 'Juan', 0, '\\x8950'::bytea, 'image/png',
                10, 10, ${"a".repeat(64)})
      `.execute(owner.db)).rejects.toThrow();
    });

    it("refuses a raster over the byte bound", async () => {
      await submitAs(SESSION_1, R1, "sub_1", F1, "x", "rss_1");
      await expect(sql`
        insert into signing_representations (
          representation_id, workspace_id, signing_request_id,
          request_recipient_id, submission_id, purpose, representation_type,
          raster_bytes, raster_media_type, raster_width, raster_height, digest)
        values ('rep_big', ${WS}, ${REQUEST}, ${R1}, 'sub_1', 'signature',
                'RASTER_SIGNATURE_V1',
                repeat('a', 70000)::bytea, 'image/png', 420, 120,
                ${"a".repeat(64)})
      `.execute(owner.db)).rejects.toThrow();
    });

    it("refuses two representations of the same purpose in one submission", async () => {
      await submitAs(SESSION_1, R1, "sub_1", F1, "x", "rss_1");
      const insert = (id: string) => sql`
        insert into signing_representations (
          representation_id, workspace_id, signing_request_id,
          request_recipient_id, submission_id, purpose, representation_type,
          typed_text, typed_style_index, digest)
        values (${id}, ${WS}, ${REQUEST}, ${R1}, 'sub_1', 'signature',
                'TYPED_SIGNATURE_V1', 'Juan', 0, ${"a".repeat(64)})
      `.execute(owner.db);
      await insert("rep_1");
      await expect(insert("rep_2")).rejects.toThrow();
    });
  });

  // ── Realm ─────────────────────────────────────────────────────────────────

  describe("the recipient realm reads only its own submission", () => {
    it("sees one submission of two", async () => {
      await submitAs(SESSION_1, R1, "sub_1", F1, "juan", "rss_1");
      await submitAs(SESSION_2, R2, "sub_2", F2, "maria", "rss_2");

      const visible = await app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.recipient_session_digest', ${SESSION_1}, true)`
          .execute(trx);
        await sql`select set_config('lagda.workspace_id', ${WS}, true)`.execute(trx);
        const rows = await sql<{ n: string }>`
          select count(*)::text as n from recipient_submissions`.execute(trx);
        const values = await sql<{ text_value: string }>`
          select text_value from signing_field_values`.execute(trx);
        return { count: Number(rows.rows[0]?.n), texts: values.rows.map(r => r.text_value) };
      });

      expect(visible.count).toBe(1);
      expect(visible.texts).toEqual(["juan"]);
    });

    it("holds no BYPASSRLS and is not a superuser", async () => {
      const row = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`
        select rolbypassrls, rolsuper from pg_roles where rolname = 'lagda_app'
      `.execute(owner.db);
      expect(row.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    });

    it("keeps every submission scope policy restrictive", async () => {
      const rows = await sql<{ relname: string; polpermissive: boolean }>`
        select c.relname, p.polpermissive
        from pg_policy p join pg_class c on c.oid = p.polrelid
        where p.polname = 'recipient_submission_scope' order by c.relname
      `.execute(owner.db);
      expect(rows.rows).toHaveLength(3);
      expect(rows.rows.every(r => r.polpermissive === false)).toBe(true);
    });
  });
});
