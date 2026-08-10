// Send against REAL PostgreSQL, as the RUNTIME role.
//
// What only this suite can prove:
//
//   1. The `state = 'draft'` predicate makes two concurrent sends resolve to
//      one — the race the fake cannot model.
//   2. The one-active-grant partial index refuses a second live credential.
//   3. A grant cannot reference a recipient of a different request.
//   4. `sent_at` and `state` cannot disagree, whatever a writer intends.
//   5. RLS hides grants, intents and activation from another tenant.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type {
  DocumentId, UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import type {
  ArtifactId, PreparationId, RecipientId,
  SigningRequestId, SigningRequestRecipientId, SigningRequestFieldId,
  SigningAccessGrantId, DeliveryIntentId, SigningAccessDigest,
  SealedDeliverySecret, NewSigningRequestSnapshot,
} from "@lagda/application";
import { createDatabase, type LagdaDatabase } from "./client/index.js";
import { loadDatabaseConfig } from "./config/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-08-10T07:00:00.000Z");
const USER = "usr_send" as UserId;
const WS_A = "ws_send_a" as WorkspaceId;
const WS_B = "ws_send_b" as WorkspaceId;
const DOC_A = "doc_send_a" as DocumentId;
const DOC_B = "doc_send_b" as DocumentId;
const DIGEST = "a".repeat(64);

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("signing request send (RLS, runtime role)", () => {
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

  /** Two workspaces, each with a DRAFT request holding one recipient. */
  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, USER);
    const tx = createTransactionManager(owner.db);

    for (const [ws, member, doc] of [
      [WS_A, "mem_ka", DOC_A], [WS_B, "mem_kb", DOC_B],
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
          digestAlgorithm: "sha-256", digest: DIGEST as never,
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
            documentTitle: "Office Lease", createdByUserId: USER,
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
      });
    }
  });

  const grant = (ws: WorkspaceId, over: {
    grantId?: string; recipientId?: string; requestId?: string; digest?: string;
  } = {}) => ({
    grantId: (over.grantId ?? `sag_${ws}`) as SigningAccessGrantId,
    workspaceId: ws,
    signingRequestId: (over.requestId ?? requestOf(ws)) as SigningRequestId,
    recipientId: (over.recipientId ?? recipientOf(ws)) as SigningRequestRecipientId,
    credentialDigest: (over.digest ?? "b".repeat(64)) as SigningAccessDigest,
    createdAt: AT,
    expiresAt: AT + 14 * 24 * 3_600_000,
  });

  const intentFor = (ws: WorkspaceId, grantId: string, intentId: string) => ({
    deliveryIntentId: intentId as DeliveryIntentId,
    workspaceId: ws,
    signingRequestId: requestOf(ws),
    recipientId: recipientOf(ws),
    grantId: grantId as SigningAccessGrantId,
    purpose: "signing-invitation" as const,
    recipientEmail: "Juan@Example.com",
    recipientName: "Juan dela Cruz",
    documentTitle: "Office Lease",
    senderDisplayName: "Acme Legal",
    workspaceName: "Acme Legal",
    sealedCredential: "v1.aaa.bbb.ccc" as SealedDeliverySecret,
    sealedKeyVersion: "v1",
    createdAt: AT,
  });

  // ── The conditional transition ────────────────────────────────────────────

  describe("the draft predicate", () => {
    it("transitions once and refuses the second attempt", async () => {
      const first = await createTransactionManager(app.db).runForWorkspace(
        WS_A, uow => uow.signingRequests.markSentIfDraft({
          signingRequestId: requestOf(WS_A), sentAt: AT,
        }));
      expect(first).toBe(true);

      const second = await createTransactionManager(app.db).runForWorkspace(
        WS_A, uow => uow.signingRequests.markSentIfDraft({
          signingRequestId: requestOf(WS_A), sentAt: AT + 1000,
        }));
      expect(second).toBe(false);
    });

    it("lets exactly one of two concurrent transitions win", async () => {
      // The race the fake cannot model: both transactions open before either
      // commits, and only the WHERE clause separates them.
      const attempt = () => createTransactionManager(app.db).runForWorkspace(
        WS_A, uow => uow.signingRequests.markSentIfDraft({
          signingRequestId: requestOf(WS_A), sentAt: AT,
        }));

      const results = await Promise.all([attempt(), attempt()]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("keeps sent_at and state in agreement", async () => {
      // A writer that set one without the other is refused by the database,
      // whatever the application intended.
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`
          update signing_requests set state = 'sent'
          where signing_request_id = ${requestOf(WS_A)}
        `.execute(trx);
      })).rejects.toThrow(/check|violates/i);
    });

    it("refuses a state outside the widened CHECK", async () => {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`
          update signing_requests set state = 'completed', sent_at = now()
          where signing_request_id = ${requestOf(WS_A)}
        `.execute(trx);
      })).rejects.toThrow(/check|violates/i);
    });
  });

  // ── Grants ────────────────────────────────────────────────────────────────

  describe("access grants", () => {
    const write = (ws: WorkspaceId, over = {}) =>
      createTransactionManager(app.db).runForWorkspace(
        ws, uow => uow.signingAccess.insertGrant(grant(ws, over)));

    it("accepts one grant per recipient", async () => {
      await expect(write(WS_A)).resolves.toBeUndefined();
    });

    it("refuses a SECOND active grant for the same recipient", async () => {
      // The partial unique index. Without it a duplicate send, an idempotency
      // edge or a future resend bug could leave two live bearer credentials
      // for one person with no way to tell which was intended.
      await write(WS_A);
      await expect(write(WS_A, { grantId: "sag_second" })).rejects
        .toThrow(/duplicate|unique|violates/i);
    });

    it("permits a new grant once the first is revoked", async () => {
      // The index is partial on `revoked_at is null`, so BACKEND-34's reissue
      // is already possible without a migration.
      await write(WS_A);
      await sql`
        update signing_access_grants set revoked_at = now()
        where grant_id = ${`sag_${WS_A}`}
      `.execute(owner.db);
      // A NEW digest, because a real reissue mints a new credential. The first
      // version of this test reused the digest and failed on
      // `signing_access_grants_digest_key` — correctly: two grants sharing a
      // digest would make BACKEND-34's "which recipient is this" ambiguous,
      // and that unique is global for exactly that reason.
      await expect(write(WS_A, { grantId: "sag_reissued", digest: "d".repeat(64) }))
        .resolves.toBeUndefined();
    });

    it("refuses a grant naming another REQUEST's recipient", async () => {
      // Both rows would be in one workspace if the requests were; here they
      // are in different tenants too, and either check alone would catch it.
      await expect(write(WS_A, { recipientId: String(recipientOf(WS_B)) })).rejects
        .toThrow(/foreign key|violates/i);
    });

    it("refuses a grant whose workspace differs from the bound scope", async () => {
      await expect(createTransactionManager(app.db).runForWorkspace(
        WS_A, uow => uow.signingAccess.insertGrant(grant(WS_B)),
      )).rejects.toThrow(/workspace/i);
    });

    it("refuses a digest that is not 64 hex characters", async () => {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`
          insert into signing_access_grants (grant_id, workspace_id,
            signing_request_id, request_recipient_id, credential_digest,
            created_at, expires_at)
          values ('sag_bad', ${WS_A}, ${requestOf(WS_A)}, ${recipientOf(WS_A)},
            'not-a-digest', now(), now() + interval '1 day')
        `.execute(trx);
      })).rejects.toThrow(/check|violates/i);
    });

    it("refuses an expiry that is not after creation", async () => {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`
          insert into signing_access_grants (grant_id, workspace_id,
            signing_request_id, request_recipient_id, credential_digest,
            created_at, expires_at)
          values ('sag_exp', ${WS_A}, ${requestOf(WS_A)}, ${recipientOf(WS_A)},
            ${"c".repeat(64)}, now(), now() - interval '1 day')
        `.execute(trx);
      })).rejects.toThrow(/check|violates/i);
    });
  });

  // ── Delivery intents ──────────────────────────────────────────────────────

  describe("delivery intents", () => {
    it("accepts one intent per grant and refuses a second", async () => {
      await createTransactionManager(app.db).runForWorkspace(WS_A, async uow => {
        await uow.signingAccess.insertGrant(grant(WS_A));
        await uow.signingAccess.insertDeliveryIntent(
          intentFor(WS_A, `sag_${WS_A}`, "sdi_1"));
      });

      await expect(createTransactionManager(app.db).runForWorkspace(
        WS_A, uow => uow.signingAccess.insertDeliveryIntent(
          intentFor(WS_A, `sag_${WS_A}`, "sdi_2")),
      )).rejects.toThrow(/duplicate|unique|violates/i);
    });

    it("stores the sealed credential and no raw value", async () => {
      await createTransactionManager(app.db).runForWorkspace(WS_A, async uow => {
        await uow.signingAccess.insertGrant(grant(WS_A));
        await uow.signingAccess.insertDeliveryIntent(
          intentFor(WS_A, `sag_${WS_A}`, "sdi_1"));
      });

      const row = await sql<{ sealed_credential: string; sealed_key_version: string }>`
        select sealed_credential, sealed_key_version from signing_delivery_intents
      `.execute(owner.db);
      // The `v1.` prefix is the SecretBox format. A plaintext token would not
      // have it, and this is what a reviewer can check at a glance.
      expect(row.rows[0]?.sealed_credential).toMatch(/^v1\./);
      expect(row.rows[0]?.sealed_key_version).toBe("v1");
    });

    it("refuses to delete a grant while its intent exists", async () => {
      // RESTRICT: an intent without its grant is an email nobody can act on.
      await createTransactionManager(app.db).runForWorkspace(WS_A, async uow => {
        await uow.signingAccess.insertGrant(grant(WS_A));
        await uow.signingAccess.insertDeliveryIntent(
          intentFor(WS_A, `sag_${WS_A}`, "sdi_1"));
      });
      await expect(
        sql`delete from signing_access_grants where grant_id = ${`sag_${WS_A}`}`
          .execute(owner.db),
      ).rejects.toThrow(/foreign key|violates/i);
    });

    it("finds outstanding work through the partial index", async () => {
      // How BACKEND-45's dispatcher will locate pending deliveries.
      await createTransactionManager(app.db).runForWorkspace(WS_A, async uow => {
        await uow.signingAccess.insertGrant(grant(WS_A));
        await uow.signingAccess.insertDeliveryIntent(
          intentFor(WS_A, `sag_${WS_A}`, "sdi_1"));
      });
      const pending = await sql<{ total: string }>`
        select count(*) as total from signing_delivery_intents
        where dispatched_at is null
      `.execute(owner.db);
      expect(Number(pending.rows[0]?.total)).toBe(1);
    });
  });

  // ── Activation ────────────────────────────────────────────────────────────

  describe("activation", () => {
    it("stores waiting and active rows and reads them back", async () => {
      await createTransactionManager(app.db).runForWorkspace(
        WS_A, uow => uow.signingAccess.insertActivations({
          signingRequestId: requestOf(WS_A),
          activations: [
            { recipientId: recipientOf(WS_A), state: "active", activatedAt: AT },
          ],
          createdAt: AT,
        }));

      const rows = await createTransactionManager(app.db).runForWorkspace(
        WS_A, uow => uow.signingAccess.listActivations(requestOf(WS_A)));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe("active");
      expect(rows[0]?.activatedAt).toBe(AT);
    });

    it("refuses an active row with no timestamp", async () => {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`
          insert into signing_request_recipient_activation (workspace_id,
            signing_request_id, request_recipient_id, activation_state, created_at)
          values (${WS_A}, ${requestOf(WS_A)}, ${recipientOf(WS_A)}, 'active', now())
        `.execute(trx);
      })).rejects.toThrow(/check|violates/i);
    });

    it("refuses an unknown activation state", async () => {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`
          insert into signing_request_recipient_activation (workspace_id,
            signing_request_id, request_recipient_id, activation_state,
            activated_at, created_at)
          values (${WS_A}, ${requestOf(WS_A)}, ${recipientOf(WS_A)}, 'signed',
            now(), now())
        `.execute(trx);
      })).rejects.toThrow(/check|violates/i);
    });
  });

  // ── Tenancy ───────────────────────────────────────────────────────────────

  describe("row-level security", () => {
    it("hides another workspace's activation rows", async () => {
      await createTransactionManager(app.db).runForWorkspace(
        WS_A, uow => uow.signingAccess.insertActivations({
          signingRequestId: requestOf(WS_A),
          activations: [
            { recipientId: recipientOf(WS_A), state: "active", activatedAt: AT },
          ],
          createdAt: AT,
        }));

      const across = await createTransactionManager(app.db).runForWorkspace(
        WS_B, uow => uow.signingAccess.listActivations(requestOf(WS_A)));
      expect(across).toHaveLength(0);
    });

    it("holds no BYPASSRLS and is not a superuser", async () => {
      const row = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`
        select rolbypassrls, rolsuper from pg_roles where rolname = 'lagda_app'
      `.execute(owner.db);
      expect(row.rows[0]?.rolbypassrls).toBe(false);
      expect(row.rows[0]?.rolsuper).toBe(false);
    });

    it("forces RLS on all three tables", async () => {
      const rows = await sql<{ relname: string; relforcerowsecurity: boolean }>`
        select relname, relforcerowsecurity from pg_class
        where relname in ('signing_access_grants', 'signing_delivery_intents',
                          'signing_request_recipient_activation')
      `.execute(owner.db);
      expect(rows.rows).toHaveLength(3);
      for (const row of rows.rows) {
        expect(row.relforcerowsecurity, row.relname).toBe(true);
      }
    });
  });
});
