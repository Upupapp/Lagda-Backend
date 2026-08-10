// The signing ceremony against REAL PostgreSQL, as the RUNTIME role.
//
// What only this suite can prove:
//
//   1. The RESTRICTIVE scope policies actually restrict. Tenant isolation
//      alone would let a recipient realm read every row of the workspace it
//      entered; the counts below are the difference.
//   2. A recipient cannot see the OTHER recipient of their OWN request, nor
//      that recipient's fields — enforced by the database, not by a DTO.
//   3. The ceremony's artifact is the one the request froze, and no other
//      artifact of the same document is reachable.
//   4. Progress and consent cannot be UPDATEd or DELETEd, because the runtime
//      role holds no such privilege.
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
  RecipientSigningSessionId, SigningConsentId,
  NewSigningRequestSnapshot,
} from "@lagda/application";
import { createDatabase, type LagdaDatabase } from "./client/index.js";
import { loadDatabaseConfig } from "./config/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-08-10T07:00:00.000Z");
const USER = "usr_sc" as UserId;
const WS_A = "ws_sc_a" as WorkspaceId;
const WS_B = "ws_sc_b" as WorkspaceId;
const DOC_A = "doc_sc_a" as DocumentId;
const DOC_B = "doc_sc_b" as DocumentId;

/** Two recipients on workspace A's request. The second is the control. */
const R1 = "srr_sc_a1" as SigningRequestRecipientId;
const R2 = "srr_sc_a2" as SigningRequestRecipientId;

const SESSION_A = "1".repeat(64) as RecipientSessionDigest;
const SESSION_A2 = "2".repeat(64) as RecipientSessionDigest;
const SESSION_B = "3".repeat(64) as RecipientSessionDigest;
const UNKNOWN_SESSION = "9".repeat(64) as RecipientSessionDigest;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("signing ceremony (RLS, runtime role)", () => {
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

  const requestOf = (ws: WorkspaceId) => `sr_${ws}` as SigningRequestId;
  const recipientOf = (ws: WorkspaceId) =>
    (ws === WS_A ? R1 : (`srr_${ws}` as SigningRequestRecipientId));

  /**
   * Two workspaces. Workspace A's request has TWO recipients, so
   * "cannot see the other recipient of my own request" is a real assertion.
   * The document in A also has a SECOND artifact the request did not freeze.
   */
  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, USER);
    const tx = createTransactionManager(owner.db);

    for (const [ws, member, doc] of [
      [WS_A, "mem_sca", DOC_A],
      [WS_B, "mem_scb", DOC_B],
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
          artifactType: "original", storageReference: `${ws}/frozen` as never,
          mediaType: "application/pdf", sizeBytes: 1024,
          digestAlgorithm: "sha-256", digest: "f".repeat(64) as never,
          pageCount: 5, rotatedPageCount: 0, createdAt: AT,
        });
        // A LATER artifact on the same document. The request must not see it.
        //
        // `sealed`, not a second `original` - `document_artifacts_one_original_idx`
        // forbids two originals per document, which is a stronger guarantee than
        // this test needs and worth recording: the drift scenario cannot arise
        // from a re-upload at all, only from a derived artifact.
        await uow.artifacts.insert({
          artifactId: `art_${doc}_v2` as ArtifactId, workspaceId: ws, documentId: doc,
          artifactType: "sealed", storageReference: `${ws}/newer` as never,
          mediaType: "application/pdf", sizeBytes: 999_999,
          digestAlgorithm: "sha-256", digest: "e".repeat(64) as never,
          sourceArtifactId: `art_${doc}` as ArtifactId,
          pageCount: 40, rotatedPageCount: 0, createdAt: AT + 1,
        });
        await uow.preparations.insert({
          preparationId: `prep_${doc}` as PreparationId, workspaceId: ws,
          documentId: doc, sourceArtifactId: `art_${doc}`, createdAt: AT,
        });
        await uow.recipients.insert({
          recipientId: `rcp_${doc}` as RecipientId, workspaceId: ws,
          preparationId: `prep_${doc}` as PreparationId, sourceContactId: null,
          name: "Juan dela Cruz", email: "Juan@Example.com",
          emailKey: "juan@example.com" as never, organization: null,
          type: "signer", isRequired: true, orderIndex: 0, routingOrder: 1,
          createdAt: AT,
        });

        const second = ws === WS_A;
        const snapshot: NewSigningRequestSnapshot = {
          request: {
            signingRequestId: requestOf(ws), workspaceId: ws, documentId: doc,
            sourceArtifactId: `art_${doc}` as ArtifactId,
            sourcePreparationId: `prep_${doc}` as PreparationId,
            sourcePreparationRevision: 1, state: "draft",
            documentTitle: `Lease for ${ws}`, createdByUserId: USER,
            createdAt: AT, updatedAt: AT,
          },
          recipients: [
            {
              recipientId: recipientOf(ws), sourcePreparationRecipientId: null,
              name: "Juan dela Cruz", email: "Juan@Example.com",
              normalizedEmail: "juan@example.com", organization: null,
              type: "signer", isRequired: true, orderIndex: 0, routingOrder: 1,
            },
            ...(second ? [{
              recipientId: R2, sourcePreparationRecipientId: null,
              name: "Maria Santos", email: "Maria@Example.com",
              normalizedEmail: "maria@example.com", organization: null,
              type: "signer" as const, isRequired: true,
              orderIndex: 1, routingOrder: 1,
            }] : []),
          ],
          fields: [
            {
              fieldId: `srf_${ws}` as SigningRequestFieldId,
              sourcePreparationFieldId: null, type: "signature", pageNumber: 1,
              x: 0.1, y: 0.2, width: 0.3, height: 0.05, required: true,
              label: "Signature", layer: 0, recipientId: recipientOf(ws),
            },
            ...(second ? [{
              fieldId: "srf_sc_a2" as SigningRequestFieldId,
              sourcePreparationFieldId: null, type: "signature" as const,
              pageNumber: 1, x: 0.5, y: 0.2, width: 0.3, height: 0.05,
              required: true, label: "Maria Santos — Signature", layer: 0,
              recipientId: R2,
            }] : []),
          ],
        };
        await uow.signingRequests.createSnapshot(snapshot);
        await uow.signingAccess.insertActivations({
          signingRequestId: requestOf(ws),
          activations: [
            { recipientId: recipientOf(ws), state: "active", activatedAt: AT },
            ...(second ? [{ recipientId: R2, state: "active" as const, activatedAt: AT }] : []),
          ],
          createdAt: AT,
        });
        await uow.signingAccess.insertGrant({
          grantId: `sag_${ws}` as SigningAccessGrantId, workspaceId: ws,
          signingRequestId: requestOf(ws), recipientId: recipientOf(ws),
          credentialDigest: `${ws.slice(-1)}`.repeat(64).slice(0, 64) as SigningAccessDigest,
          createdAt: AT, expiresAt: AT + 14 * 24 * 3_600_000,
        });
        await uow.signingRequests.markSentIfDraft({
          signingRequestId: requestOf(ws), sentAt: AT,
        });
      });
    }

    // Sessions, written as the OWNER so the suite can construct fixtures the
    // recipient realm itself could never create.
    await sql`
      insert into recipient_signing_sessions (
        signing_session_id, workspace_id, signing_request_id,
        request_recipient_id, source_grant_id, token_digest, csrf_token_digest,
        authentication_method, authenticated_at, created_at, expires_at)
      values
        ('rss_a1', ${WS_A}, ${requestOf(WS_A)}, ${R1}, ${`sag_${WS_A}`},
         ${SESSION_A}, ${"a".repeat(64)}, 'link-only',
         to_timestamp(${AT / 1000}), to_timestamp(${AT / 1000}),
         to_timestamp(${(AT + 8 * 3_600_000) / 1000})),
        ('rss_a2', ${WS_A}, ${requestOf(WS_A)}, ${R2}, ${`sag_${WS_A}`},
         ${SESSION_A2}, ${"b".repeat(64)}, 'link-only',
         to_timestamp(${AT / 1000}), to_timestamp(${AT / 1000}),
         to_timestamp(${(AT + 8 * 3_600_000) / 1000})),
        ('rss_b', ${WS_B}, ${requestOf(WS_B)}, ${recipientOf(WS_B)}, ${`sag_${WS_B}`},
         ${SESSION_B}, ${"c".repeat(64)}, 'link-only',
         to_timestamp(${AT / 1000}), to_timestamp(${AT / 1000}),
         to_timestamp(${(AT + 8 * 3_600_000) / 1000}))
    `.execute(owner.db);
  });

  const SCOPE_A1 = {
    workspaceId: WS_A, signingRequestId: requestOf(WS_A), recipientId: R1,
  };

  /**
   * A transaction with BOTH settings live, for UNFILTERED counts.
   *
   * The repository always filters, so counting through it would prove nothing
   * about the policies. These queries are deliberately unfiltered: what they
   * measure is what the DATABASE is willing to return, which is the only thing
   * that matters when the question is whether RLS holds.
   *
   * Running them on `app.db` directly - outside the transaction - was the first
   * attempt, and every one returned zero. Correctly: with no settings set, the
   * policies deny everything. A test that passes because the connection had no
   * context proves nothing about the context it meant to test.
   */
  const inRecipientRealm = async <T>(
    sessionDigest: RecipientSessionDigest,
    workspaceId: WorkspaceId,
    query: (trx: never) => Promise<T>,
  ): Promise<T> =>
    app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.recipient_session_digest', ${sessionDigest}, true)`
        .execute(trx);
      await sql`select set_config('lagda.workspace_id', ${workspaceId}, true)`
        .execute(trx);
      return query(trx as never);
    });

  // ── The narrow path ───────────────────────────────────────────────────────

  describe("the recipient realm reads exactly its own rows", () => {
    it("resolves the request, the recipient, the fields and the artifact", async () => {
      const result = await createTransactionManager(app.db)
        .runForRecipientSession(SESSION_A, sessionUow =>
          sessionUow.enterWorkspace(SCOPE_A1, async uow => ({
            request: await uow.ceremony.getRequest(),
            recipient: await uow.ceremony.getRecipient(),
            fields: await uow.ceremony.listAssignedFields(),
            artifact: await uow.ceremony.getSourceArtifact(),
          })));

      expect(result.request?.documentTitle).toBe(`Lease for ${WS_A}`);
      expect(result.recipient?.name).toBe("Juan dela Cruz");
      expect(result.fields.map(f => f.fieldId)).toEqual([`srf_${WS_A}`]);
      // The FROZEN artifact, not the 40-page one added afterwards.
      expect(result.artifact?.sizeBytes).toBe(1024);
      expect(result.artifact?.pageCount).toBe(5);
    });

    it("cannot see the other recipient of its OWN request", async () => {
      // An unfiltered count. Two recipient rows exist on this request; the
      // restrictive policy admits one. Tenant isolation alone would admit both.
      const count = await inRecipientRealm(SESSION_A, WS_A, async (trx: never) => {
        const row = await sql<{ n: string }>`
          select count(*)::text as n from signing_request_recipients
        `.execute(trx);
        return Number(row.rows[0]?.n ?? "0");
      });
      expect(count).toBe(1);
    });

    it("cannot see the other recipient's fields", async () => {
      const rows = await inRecipientRealm(SESSION_A, WS_A, async (trx: never) => {
        const result = await sql<{ label: string }>`
          select label from signing_request_fields
        `.execute(trx);
        return result.rows.map(r => r.label);
      });
      expect(rows).toEqual(["Signature"]);
      // The other signer's NAME travels in a sender-authored label.
      expect(rows.join()).not.toContain("Maria");
    });

    it("cannot enumerate requests, in its own tenant or any other", async () => {
      const count = await inRecipientRealm(SESSION_A, WS_A, async (trx: never) => {
        const row = await sql<{ n: string }>`
          select count(*)::text as n from signing_requests
        `.execute(trx);
        return Number(row.rows[0]?.n ?? "0");
      });
      expect(count).toBe(1);
    });

    it("cannot reach the document's other artifact", async () => {
      // Two artifacts exist on this document. Only the frozen one is visible,
      // because the policy joins through `source_artifact_id`.
      const refs = await inRecipientRealm(SESSION_A, WS_A, async (trx: never) => {
        const result = await sql<{ storage_reference: string }>`
          select storage_reference from document_artifacts
        `.execute(trx);
        return result.rows.map(r => r.storage_reference);
      });
      expect(refs).toEqual([`${WS_A}/frozen`]);
    });

    it("a session for another tenant sees none of this one", async () => {
      const titles = await inRecipientRealm(SESSION_B, WS_B, async (trx: never) => {
        const result = await sql<{ document_title: string }>`
          select document_title from signing_requests
        `.execute(trx);
        return result.rows.map(r => r.document_title);
      });
      expect(titles).toEqual([`Lease for ${WS_B}`]);
    });
  });

  // ── Fail closed ───────────────────────────────────────────────────────────

  describe("the scope fails closed", () => {
    it("an unknown session digest resolves nothing", async () => {
      const found = await createTransactionManager(app.db)
        .runForRecipientSession(UNKNOWN_SESSION,
          uow => uow.session.findByTokenDigest(UNKNOWN_SESSION));
      expect(found).toBeNull();
    });

    it("a session digest that names no rows sees an empty ceremony", async () => {
      // The setting is present but matches no session, so every restrictive
      // policy's EXISTS is false and every table is empty.
      const counts = await inRecipientRealm(UNKNOWN_SESSION, WS_A, async (trx: never) => {
        const requests = await sql<{ n: string }>`
          select count(*)::text as n from signing_requests`.execute(trx);
        const fields = await sql<{ n: string }>`
          select count(*)::text as n from signing_request_fields`.execute(trx);
        return {
          requests: Number(requests.rows[0]?.n ?? "0"),
          fields: Number(fields.rows[0]?.n ?? "0"),
        };
      });
      expect(counts).toEqual({ requests: 0, fields: 0 });
    });

    it("leaves the workspace realm untouched", async () => {
      // The `is null` arm. A normal workspace transaction sets no recipient
      // session digest, so it still sees both recipients and both artifacts.
      const counts = await app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        const recipients = await sql<{ n: string }>`
          select count(*)::text as n from signing_request_recipients`.execute(trx);
        const artifacts = await sql<{ n: string }>`
          select count(*)::text as n from document_artifacts`.execute(trx);
        return {
          recipients: Number(recipients.rows[0]?.n ?? "0"),
          artifacts: Number(artifacts.rows[0]?.n ?? "0"),
        };
      });
      expect(counts).toEqual({ recipients: 2, artifacts: 2 });
    });
  });

  // ── Writes ────────────────────────────────────────────────────────────────

  describe("progress and consent", () => {
    const record = (digest: RecipientSessionDigest, scope: typeof SCOPE_A1) =>
      createTransactionManager(app.db).runForRecipientSession(digest, sessionUow =>
        sessionUow.enterWorkspace(scope, uow =>
          uow.ceremony.recordFirstEntry({ firstEnteredAt: AT, createdAt: AT })));

    it("records first entry once, and a second call does not move it", async () => {
      expect(await record(SESSION_A, SCOPE_A1)).toBe(true);
      expect(await record(SESSION_A, SCOPE_A1)).toBe(false);

      const rows = await sql<{ n: string }>`
        select count(*)::text as n from signing_recipient_progress
      `.execute(owner.db);
      expect(Number(rows.rows[0]?.n)).toBe(1);
    });

    it("each recipient's progress is its own", async () => {
      await record(SESSION_A, SCOPE_A1);
      await record(SESSION_A2, {
        workspaceId: WS_A, signingRequestId: requestOf(WS_A), recipientId: R2,
      });

      const mine = await inRecipientRealm(SESSION_A, WS_A, async (trx: never) => {
        const result = await sql<{ n: string }>`
          select count(*)::text as n from signing_recipient_progress
        `.execute(trx);
        return Number(result.rows[0]?.n ?? "0");
      });
      // Two rows exist; this recipient sees one.
      expect(mine).toBe(1);
      const all = await sql<{ n: string }>`
        select count(*)::text as n from signing_recipient_progress
      `.execute(owner.db);
      expect(Number(all.rows[0]?.n)).toBe(2);
    });

    it("accepts a consent once and converges on retry", async () => {
      const accept = () =>
        createTransactionManager(app.db).runForRecipientSession(SESSION_A, sessionUow =>
          sessionUow.enterWorkspace(SCOPE_A1, uow => uow.ceremony.insertConsent({
            consentId: "con_1" as SigningConsentId,
            consentType: "electronic-records-and-signature",
            consentVersion: "v0-demonstration",
            acceptedAt: AT,
            signingSessionId: "rss_a1" as RecipientSigningSessionId,
            authenticationMethod: "link-only",
            createdAt: AT,
          })));

      expect(await accept()).toBe(true);
      expect(await accept()).toBe(false);
      const rows = await sql<{ n: string }>`
        select count(*)::text as n from signing_recipient_consents
      `.execute(owner.db);
      expect(Number(rows.rows[0]?.n)).toBe(1);
    });

    it("a new version is a new row, not an edit", async () => {
      const accept = (version: string, id: string) =>
        createTransactionManager(app.db).runForRecipientSession(SESSION_A, sessionUow =>
          sessionUow.enterWorkspace(SCOPE_A1, uow => uow.ceremony.insertConsent({
            consentId: id as SigningConsentId,
            consentType: "electronic-records-and-signature",
            consentVersion: version, acceptedAt: AT,
            signingSessionId: "rss_a1" as RecipientSigningSessionId,
            authenticationMethod: "link-only", createdAt: AT,
          })));

      await accept("v0-demonstration", "con_1");
      await accept("v1", "con_2");
      const rows = await sql<{ consent_version: string }>`
        select consent_version from signing_recipient_consents order by consent_version
      `.execute(owner.db);
      expect(rows.rows.map(r => r.consent_version)).toEqual(["v0-demonstration", "v1"]);
    });

    it("refuses an unknown consent type", async () => {
      await expect(sql`
        insert into signing_recipient_consents (
          consent_id, workspace_id, signing_request_id, request_recipient_id,
          consent_type, consent_version, accepted_at, signing_session_id,
          authentication_method, created_at)
        values ('con_bad', ${WS_A}, ${requestOf(WS_A)}, ${R1},
          'invented-consent', 'v1', now(), 'rss_a1', 'link-only', now())
      `.execute(owner.db)).rejects.toThrow();
    });

    it("refuses a consent bound to another request's recipient", async () => {
      // The three-column foreign key. `R1` belongs to A's request, so pairing
      // it with B's request id has no referent.
      await expect(sql`
        insert into signing_recipient_consents (
          consent_id, workspace_id, signing_request_id, request_recipient_id,
          consent_type, consent_version, accepted_at, signing_session_id,
          authentication_method, created_at)
        values ('con_x', ${WS_A}, ${requestOf(WS_B)}, ${R1},
          'electronic-records-and-signature', 'v1', now(), 'rss_a1',
          'link-only', now())
      `.execute(owner.db)).rejects.toThrow();
    });
  });

  // ── Privileges ────────────────────────────────────────────────────────────

  describe("the runtime role's privileges", () => {
    it("cannot UPDATE progress or consent", async () => {
      await createTransactionManager(app.db).runForRecipientSession(
        SESSION_A, sessionUow => sessionUow.enterWorkspace(SCOPE_A1, uow =>
          uow.ceremony.recordFirstEntry({ firstEnteredAt: AT, createdAt: AT })));

      // No UPDATE grant, so this is a privilege error rather than zero rows.
      await expect(sql`
        update signing_recipient_progress set first_entered_at = now()
      `.execute(app.db)).rejects.toThrow(/permission denied/i);
    });

    it("cannot DELETE progress or consent", async () => {
      await expect(sql`delete from signing_recipient_progress`.execute(app.db))
        .rejects.toThrow(/permission denied/i);
      await expect(sql`delete from signing_recipient_consents`.execute(app.db))
        .rejects.toThrow(/permission denied/i);
    });

    it("holds no BYPASSRLS and is not a superuser", async () => {
      const row = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`
        select rolbypassrls, rolsuper from pg_roles where rolname = 'lagda_app'
      `.execute(owner.db);
      expect(row.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    });

    it("keeps every ceremony scope policy restrictive", async () => {
      const rows = await sql<{ relname: string; polpermissive: boolean }>`
        select c.relname, p.polpermissive
        from pg_policy p join pg_class c on c.oid = p.polrelid
        where p.polname = 'recipient_ceremony_scope'
        order by c.relname
      `.execute(owner.db);
      expect(rows.rows).toHaveLength(6);
      expect(rows.rows.every(r => r.polpermissive === false)).toBe(true);
    });
  });
});
