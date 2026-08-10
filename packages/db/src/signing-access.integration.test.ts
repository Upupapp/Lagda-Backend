// Recipient signing access against REAL PostgreSQL, as the RUNTIME role.
//
// What only this suite can prove — and it is the whole security argument of
// BACKEND-34:
//
//   1. The credential path resolves EXACTLY the one grant it names, and
//      CANNOT enumerate anything else. Not other grants, not other requests,
//      not other recipients, not another tenant.
//   2. It cannot WRITE, because every policy is FOR SELECT.
//   3. A missing setting sees nothing — fail closed.
//   4. The runtime role still holds no BYPASSRLS and is not a superuser.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type {
  DocumentId, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import type {
  ArtifactId, PreparationId, RecipientId,
  SigningRequestId, SigningRequestRecipientId, SigningRequestFieldId,
  SigningAccessGrantId, SigningAccessDigest, RecipientSessionDigest,
  RecipientCsrfDigest, RecipientSigningSessionId,
  NewSigningRequestSnapshot,
} from "@lagda/application";
import { createDatabase, type LagdaDatabase } from "./client/index.js";
import { loadDatabaseConfig } from "./config/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-08-10T07:00:00.000Z");
const USER = "usr_sa" as UserId;
const WS_A = "ws_sa_a" as WorkspaceId;
const WS_B = "ws_sa_b" as WorkspaceId;
const DOC_A = "doc_sa_a" as DocumentId;
const DOC_B = "doc_sa_b" as DocumentId;
const DIGEST_A = "a".repeat(64) as SigningAccessDigest;
const DIGEST_B = "b".repeat(64) as SigningAccessDigest;
const UNKNOWN = "c".repeat(64) as SigningAccessDigest;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("recipient signing access (RLS, runtime role)", () => {
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
  const recipientOf = (ws: WorkspaceId) => `srr_${ws}` as SigningRequestRecipientId;
  const grantOf = (ws: WorkspaceId) => `sag_${ws}` as SigningAccessGrantId;

  /**
   * Two workspaces, each with a SENT request, one active recipient and a grant.
   *
   * Two so that "cannot see the other tenant" is a real assertion rather than a
   * vacuous one.
   */
  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, USER);
    const tx = createTransactionManager(owner.db);

    for (const [ws, member, doc, digest] of [
      [WS_A, "mem_saa", DOC_A, DIGEST_A],
      [WS_B, "mem_sab", DOC_B, DIGEST_B],
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
          artifactType: "original", storageReference: `${ws}/a` as never,
          mediaType: "application/pdf", sizeBytes: 1024,
          digestAlgorithm: "sha-256", digest: "f".repeat(64) as never,
          pageCount: 5, rotatedPageCount: 0, createdAt: AT,
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

        const snapshot: NewSigningRequestSnapshot = {
          request: {
            signingRequestId: requestOf(ws), workspaceId: ws, documentId: doc,
            sourceArtifactId: `art_${doc}` as ArtifactId,
            sourcePreparationId: `prep_${doc}` as PreparationId,
            sourcePreparationRevision: 1, state: "draft",
            completionReadyAt: null, terminatedAt: null,
            terminationReason: null, cancellationNote: null,
            documentTitle: `Lease for ${ws}`, createdByUserId: USER,
            createdAt: AT, updatedAt: AT,
          },
          recipients: [{
            recipientId: recipientOf(ws), sourcePreparationRecipientId: null,
            name: "Juan dela Cruz", email: "Juan@Example.com",
            normalizedEmail: "juan@example.com", organization: null,
            type: "signer", isRequired: true, orderIndex: 0, routingOrder: 1,
          }],
          fields: [{
            fieldId: `srf_${ws}` as SigningRequestFieldId,
            sourcePreparationFieldId: null, type: "signature", pageNumber: 1,
            x: 0.1, y: 0.2, width: 0.3, height: 0.05, required: true,
            label: "Signature", layer: 0, recipientId: recipientOf(ws),
          }],
        };
        await uow.signingRequests.createSnapshot(snapshot);
        await uow.signingAccess.insertActivations({
          signingRequestId: requestOf(ws),
          activations: [
            { recipientId: recipientOf(ws), state: "active", activatedAt: AT },
          ],
          createdAt: AT,
        });
        await uow.signingAccess.insertGrant({
          grantId: grantOf(ws), workspaceId: ws,
          signingRequestId: requestOf(ws), recipientId: recipientOf(ws),
          credentialDigest: digest,
          createdAt: AT, expiresAt: AT + 14 * 24 * 3_600_000,
        });
        await uow.signingRequests.markSentIfDraft({
          signingRequestId: requestOf(ws), sentAt: AT,
        });
      });
    }
  });

  // ── The narrow path ───────────────────────────────────────────────────────

  describe("the credential resolves exactly one grant", () => {
    it("finds the grant its digest names, with its request and recipient", async () => {
      const resolved = await createTransactionManager(app.db)
        .runForSigningCredential(DIGEST_A,
          uow => uow.access.findByCredentialDigest(DIGEST_A));

      expect(resolved?.grantId).toBe(grantOf(WS_A));
      expect(resolved?.workspaceId).toBe(WS_A);
      expect(resolved?.signingRequestId).toBe(requestOf(WS_A));
      expect(resolved?.recipientId).toBe(recipientOf(WS_A));
      expect(resolved?.requestState).toBe("sent");
      expect(resolved?.documentTitle).toBe(`Lease for ${WS_A}`);
      expect(resolved?.activationState).toBe("active");
    });

    it("returns null for an unknown digest", async () => {
      const resolved = await createTransactionManager(app.db)
        .runForSigningCredential(UNKNOWN,
          uow => uow.access.findByCredentialDigest(UNKNOWN));
      expect(resolved).toBeNull();
    });

    it("cannot see the OTHER tenant's grant, even asking for it directly", async () => {
      // The policy matches on the SETTING, not on the argument. Setting A's
      // digest and querying B's returns nothing.
      const resolved = await createTransactionManager(app.db)
        .runForSigningCredential(DIGEST_A,
          uow => uow.access.findByCredentialDigest(DIGEST_B));
      expect(resolved).toBeNull();
    });

    it("cannot ENUMERATE grants", async () => {
      // The heart of the argument. Inside a credential transaction, a raw
      // unfiltered select over the whole table returns exactly one row.
      const rows = await app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.signing_access_digest', ${DIGEST_A}, true)`
          .execute(trx);
        return sql<{ grant_id: string }>`select grant_id from signing_access_grants`
          .execute(trx);
      });
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.grant_id).toBe(grantOf(WS_A));
    });

    it("cannot enumerate requests, recipients or activation rows", async () => {
      const counts = await app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.signing_access_digest', ${DIGEST_A}, true)`
          .execute(trx);
        return sql<{ requests: string; recipients: string; activations: string }>`
          select
            (select count(*) from signing_requests) as requests,
            (select count(*) from signing_request_recipients) as recipients,
            (select count(*) from signing_request_recipient_activation) as activations
        `.execute(trx);
      });
      // Two of everything exist. The credential sees one of each.
      expect(counts.rows[0]).toMatchObject({
        requests: "1", recipients: "1", activations: "1",
      });
    });

    it("sees NOTHING with no setting at all — fail closed", async () => {
      const rows = await app.db.transaction().execute(trx =>
        sql<{ total: string }>`select count(*) as total from signing_access_grants`
          .execute(trx));
      expect(Number(rows.rows[0]?.total)).toBe(0);
    });

    it("cannot see other rows of the SAME request", async () => {
      // A second recipient on request A. The credential names the first, and
      // must not see the second — a signer must not learn who else was asked.
      await createTransactionManager(owner.db).runForWorkspace(WS_A, async uow => {
        await sql`
          insert into signing_request_recipients (request_recipient_id,
            workspace_id, signing_request_id, name, email, normalized_email,
            recipient_type, is_required, order_index, routing_order, created_at)
          values ('srr_second', ${WS_A}, ${requestOf(WS_A)}, 'Second Party',
            'second@example.com', 'second@example.com', 'signer', true, 1, 1, now())
        `.execute(owner.db);
        void uow;
      });

      const rows = await app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.signing_access_digest', ${DIGEST_A}, true)`
          .execute(trx);
        return sql<{ request_recipient_id: string }>`
          select request_recipient_id from signing_request_recipients
        `.execute(trx);
      });
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.request_recipient_id).toBe(recipientOf(WS_A));
    });
  });

  // ── The path cannot write ─────────────────────────────────────────────────

  describe("the credential path is read-only", () => {
    it("cannot update the grant it resolved", async () => {
      // Every policy is FOR SELECT, so there is no policy permitting an UPDATE
      // and the row is invisible to one.
      const updated = await app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.signing_access_digest', ${DIGEST_A}, true)`
          .execute(trx);
        const result = await sql`
          update signing_access_grants set revoked_at = now()
          where grant_id = ${grantOf(WS_A)}
        `.execute(trx);
        return result.numAffectedRows;
      });
      expect(Number(updated ?? 0)).toBe(0);
    });

    it("cannot insert a session without entering the workspace", async () => {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.signing_access_digest', ${DIGEST_A}, true)`
          .execute(trx);
        await sql`
          insert into recipient_signing_sessions (signing_session_id, workspace_id,
            signing_request_id, request_recipient_id, source_grant_id,
            token_digest, csrf_token_digest, authentication_method,
            authenticated_at, created_at, expires_at)
          values ('rss_bad', ${WS_A}, ${requestOf(WS_A)}, ${recipientOf(WS_A)},
            ${grantOf(WS_A)}, ${"1".repeat(64)}, ${"2".repeat(64)}, 'link-only',
            now(), now(), now() + interval '1 hour')
        `.execute(trx);
      })).rejects.toThrow(/policy|violates/i);
    });
  });

  // ── The workspace transition ──────────────────────────────────────────────

  describe("entering the workspace", () => {
    const insertSession = (digest: SigningAccessDigest, ws: WorkspaceId) =>
      createTransactionManager(app.db).runForSigningCredential(digest, async uow => {
        const resolved = await uow.access.findByCredentialDigest(digest);
        if (resolved === null) throw new Error("unresolved");
        return uow.enterWorkspace(resolved.workspaceId, async inner => {
          await inner.recipientSessions.insert({
            signingSessionId: `rss_${ws}` as RecipientSigningSessionId,
            workspaceId: resolved.workspaceId,
            signingRequestId: resolved.signingRequestId,
            recipientId: resolved.recipientId,
            sourceGrantId: resolved.grantId,
            tokenDigest: `${ws.slice(-1)}`.repeat(64).slice(0, 64) as RecipientSessionDigest,
            csrfTokenDigest: "9".repeat(64) as RecipientCsrfDigest,
            authenticationMethod: "link-only",
            authenticatedAt: AT, createdAt: AT,
            expiresAt: AT + 8 * 3_600_000,
          });
          return resolved;
        });
      });

    it("writes a session once tenant context exists", async () => {
      const resolved = await insertSession(DIGEST_A, WS_A);
      expect(resolved.workspaceId).toBe(WS_A);

      const rows = await sql<{ total: string }>`
        select count(*) as total from recipient_signing_sessions
      `.execute(owner.db);
      expect(Number(rows.rows[0]?.total)).toBe(1);
    });

    it("refuses a session whose workspace differs from the resolved one", async () => {
      await expect(createTransactionManager(app.db).runForSigningCredential(
        DIGEST_A, async uow => uow.enterWorkspace(WS_A, inner =>
          inner.recipientSessions.insert({
            signingSessionId: "rss_x" as RecipientSigningSessionId,
            workspaceId: WS_B,
            signingRequestId: requestOf(WS_B),
            recipientId: recipientOf(WS_B),
            sourceGrantId: grantOf(WS_B),
            tokenDigest: "3".repeat(64) as RecipientSessionDigest,
            csrfTokenDigest: "4".repeat(64) as RecipientCsrfDigest,
            authenticationMethod: "link-only",
            authenticatedAt: AT, createdAt: AT, expiresAt: AT + 3_600_000,
          })),
      )).rejects.toThrow(/workspace/i);
    });
  });

  // ── The session realm ─────────────────────────────────────────────────────

  describe("the session credential path", () => {
    const SESSION_DIGEST = "7".repeat(64) as RecipientSessionDigest;

    beforeEach(async () => {
      await createTransactionManager(app.db).runForSigningCredential(
        DIGEST_A, async uow => {
          const resolved = await uow.access.findByCredentialDigest(DIGEST_A);
          if (resolved === null) throw new Error("unresolved");
          return uow.enterWorkspace(resolved.workspaceId, inner =>
            inner.recipientSessions.insert({
              signingSessionId: "rss_main" as RecipientSigningSessionId,
              workspaceId: resolved.workspaceId,
              signingRequestId: resolved.signingRequestId,
              recipientId: resolved.recipientId,
              sourceGrantId: resolved.grantId,
              tokenDigest: SESSION_DIGEST,
              csrfTokenDigest: "8".repeat(64) as RecipientCsrfDigest,
              authenticationMethod: "link-only",
              authenticatedAt: AT, createdAt: AT,
              expiresAt: AT + 8 * 3_600_000,
            }));
        });
    });

    it("resolves its own session", async () => {
      const session = await createTransactionManager(app.db)
        .runForRecipientSession(SESSION_DIGEST,
          uow => uow.session.findByTokenDigest(SESSION_DIGEST));
      expect(session?.signingSessionId).toBe("rss_main");
      expect(session?.authenticationMethod).toBe("link-only");
      expect(session?.sourceGrantId).toBe(grantOf(WS_A));
    });

    it("cannot enumerate sessions", async () => {
      const rows = await app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.recipient_session_digest', ${SESSION_DIGEST}, true)`
          .execute(trx);
        return sql<{ signing_session_id: string }>`
          select signing_session_id from recipient_signing_sessions
        `.execute(trx);
      });
      expect(rows.rows).toHaveLength(1);
    });

    it("sees nothing with no setting", async () => {
      const rows = await app.db.transaction().execute(trx =>
        sql<{ total: string }>`
          select count(*) as total from recipient_signing_sessions
        `.execute(trx));
      expect(Number(rows.rows[0]?.total)).toBe(0);
    });

    it("cannot resolve a session through the BOOTSTRAP realm's setting", async () => {
      // Three settings, three realms. Setting the access digest does not make
      // a session visible.
      const rows = await app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.signing_access_digest', ${DIGEST_A}, true)`
          .execute(trx);
        return sql<{ total: string }>`
          select count(*) as total from recipient_signing_sessions
        `.execute(trx);
      });
      expect(Number(rows.rows[0]?.total)).toBe(0);
    });
  });

  // ── Constraints and the runtime role ──────────────────────────────────────

  describe("constraints", () => {
    const rawSession = (over: string, values: string) =>
      owner.db.transaction().execute(trx => sql.raw(
        `insert into recipient_signing_sessions (signing_session_id, workspace_id,
           signing_request_id, request_recipient_id, source_grant_id,
           token_digest, csrf_token_digest, authentication_method,
           authenticated_at, created_at, expires_at${over})
         values ('rss_c', '${WS_A}', '${requestOf(WS_A)}', '${recipientOf(WS_A)}',
           '${grantOf(WS_A)}', '${"1".repeat(64)}', '${"2".repeat(64)}',
           'link-only', now(), now(), now() + interval '1 hour'${values})`,
      ).execute(trx));

    it("accepts a well-formed row, so the negatives mean something", async () => {
      await expect(rawSession("", "")).resolves.toBeDefined();
    });

    it("refuses equal session and CSRF digests", async () => {
      await expect(owner.db.transaction().execute(trx => sql`
        insert into recipient_signing_sessions (signing_session_id, workspace_id,
          signing_request_id, request_recipient_id, source_grant_id,
          token_digest, csrf_token_digest, authentication_method,
          authenticated_at, created_at, expires_at)
        values ('rss_same', ${WS_A}, ${requestOf(WS_A)}, ${recipientOf(WS_A)},
          ${grantOf(WS_A)}, ${"5".repeat(64)}, ${"5".repeat(64)}, 'link-only',
          now(), now(), now() + interval '1 hour')
      `.execute(trx))).rejects.toThrow(/check|violates/i);
    });

    it("refuses an unknown authentication method", async () => {
      await expect(owner.db.transaction().execute(trx => sql`
        insert into recipient_signing_sessions (signing_session_id, workspace_id,
          signing_request_id, request_recipient_id, source_grant_id,
          token_digest, csrf_token_digest, authentication_method,
          authenticated_at, created_at, expires_at)
        values ('rss_m', ${WS_A}, ${requestOf(WS_A)}, ${recipientOf(WS_A)},
          ${grantOf(WS_A)}, ${"6".repeat(64)}, ${"7".repeat(64)}, 'sms-otp',
          now(), now(), now() + interval '1 hour')
      `.execute(trx))).rejects.toThrow(/check|violates/i);
    });

    it("refuses a session bound to another request's recipient", async () => {
      await expect(owner.db.transaction().execute(trx => sql`
        insert into recipient_signing_sessions (signing_session_id, workspace_id,
          signing_request_id, request_recipient_id, source_grant_id,
          token_digest, csrf_token_digest, authentication_method,
          authenticated_at, created_at, expires_at)
        values ('rss_x', ${WS_A}, ${requestOf(WS_A)}, ${recipientOf(WS_B)},
          ${grantOf(WS_A)}, ${"a".repeat(64)}, ${"b".repeat(64)}, 'link-only',
          now(), now(), now() + interval '1 hour')
      `.execute(trx))).rejects.toThrow(/foreign key|violates/i);
    });
  });

  describe("the runtime role", () => {
    it("holds no BYPASSRLS and is not a superuser", async () => {
      const row = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`
        select rolbypassrls, rolsuper from pg_roles where rolname = 'lagda_app'
      `.execute(owner.db);
      expect(row.rows[0]?.rolbypassrls).toBe(false);
      expect(row.rows[0]?.rolsuper).toBe(false);
    });

    it("has no DELETE on recipient sessions", async () => {
      // A session that ended is revoked, not erased — the row records that
      // someone authenticated.
      const grants = await sql<{ privilege_type: string }>`
        select privilege_type from information_schema.role_table_grants
        where grantee = 'lagda_app' and table_name = 'recipient_signing_sessions'
      `.execute(owner.db);
      const held = grants.rows.map(row => row.privilege_type);
      expect(held).toContain("INSERT");
      expect(held).toContain("UPDATE");
      expect(held).not.toContain("DELETE");
    });
  });
});
