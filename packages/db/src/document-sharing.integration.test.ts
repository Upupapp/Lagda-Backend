// 087. Document sharing on REAL PostgreSQL, as the runtime role: the owner,
// recipient and requester use cases end to end; the two recipient realms in
// both directions (a recipient reads its own rows across tenants and nobody
// else's; a tenant never reads another's); the signed-in no-code unlock for
// owner / administrator / participant / accepted share / approved request;
// the enumeration-neutral public code flow; the in-app feed; CHECKs, no
// DELETE/TRUNCATE, the vocabularies, and the migration's down/up.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type {
  DocumentId, UserId, VerificationId, WorkspaceId, WorkspaceMemberId, Sha256Digest,
} from "@lagda/contracts";
import type {
  ArtifactId, PreparationId, SigningRequestId, SigningRequestRecipientId, SealId,
  CompletionRunId, EvidenceEventId, NewSigningRequestSnapshot, VerificationAccessStore,
  DocumentSharingDependencies, VerificationAccessDependencies, AuthenticatedActor, SessionId,
} from "@lagda/application";
import {
  createTemplateRegistry, ALL_TEMPLATES,
  createDocumentShare, updateDocumentShare, removeDocumentShare, listDocumentShares,
  listSharedWithMe, actOnSharedDocument, getSharedDocumentDetails, openSharedDocument,
  getSharedDocumentLogo, requestDocumentAccess, approveAccessRequest, rejectAccessRequest,
  withdrawAccessRequestRejection, deleteAccessRequest, listAccessRequests, listSharedByMe,
  getMyDocumentAccess, requestVerificationAccessCode, redeemVerificationAccessCode,
  grantMemberVerificationAccess, DocumentShareExistsError,
} from "@lagda/application";
import { createInMemoryObjectStorage } from "@lagda/application/test-support";
import type { LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import { createVerificationAccessStore } from "./repositories/verification-access.js";
import { createVerificationAccessThrottle } from "./repositories/verification-throttle.js";
import { createNotificationFeedRepository } from "./repositories/notification-feed.js";
import { shareRecipientDigestSql } from "./repositories/document-sharing.js";
import { migrateDown, migrateToLatest, migrationStatus } from "./migrations/runner.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-09-27T12:00:00.000Z");
const HASH = (c: string) => c.repeat(64);
/** A distinct 64-hex stand-in per first character — the throttle stores digests only. */
const hexOf = (value: string) => HASH((value.charCodeAt(0) % 16).toString(16));
const WS_A = "ws_ds_a" as WorkspaceId;
const WS_B = "ws_ds_b" as WorkspaceId;
const VID_A = "LAGDA-VER-2026-DSAAAAAAAA" as VerificationId;
const VID_B = "LAGDA-VER-2026-DSBBBBBBBB" as VerificationId;

const SENDER = "usr_ds_sender" as UserId;      // sent A's signing request: A's owner
const ADMIN = "usr_ds_admin" as UserId;        // administrator of A
const COLLEAGUE = "usr_ds_colleague" as UserId; // sender in A, no authority over the document
const BOB = "usr_ds_bob" as UserId;            // owner of B and B's document
const MARIA = "usr_ds_maria" as UserId;        // participant of A (and B)
const JUAN = "usr_ds_juan" as UserId;          // outsider, verified
const EVE = "usr_ds_eve" as UserId;            // outsider, verified
const ANA = "usr_ds_ana" as UserId;            // outsider, NOT verified

const EMAILS: Record<string, string> = {
  [SENDER]: "sender@example.com", [ADMIN]: "admin@example.com", [COLLEAGUE]: "colleague@example.com",
  [BOB]: "bob@example.com", [MARIA]: "maria@example.com", [JUAN]: "juan@example.com",
  [EVE]: "eve@example.com", [ANA]: "ana@example.com",
};
const VERIFIED = [SENDER, ADMIN, COLLEAGUE, BOB, MARIA, JUAN, EVE];

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("document sharing (087, runtime role)", () => {
  let owner: LagdaDatabase;
  let app: LagdaDatabase;
  let deps: DocumentSharingDependencies;
  let store: VerificationAccessStore;
  let seq = 0;

  beforeAll(async () => {
    owner = await createTestDatabase();
    app = await createRuntimeRoleDatabase(owner);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
  });

  async function completeDocument(
    ws: WorkspaceId, vid: VerificationId, creator: UserId, members: readonly [UserId, string][],
  ): Promise<void> {
    const tx = createTransactionManager(app.db);
    const doc = `doc_${ws}` as DocumentId;
    const request = `sr_${ws}` as SigningRequestId;
    const recipient = `srr_${ws}` as SigningRequestRecipientId;
    await tx.runForWorkspace(ws, async uow => {
      await uow.workspaces.insert({ workspaceId: ws, name: `Workspace ${ws}`, createdAt: AT });
      for (const [userId, role] of members) {
        await uow.memberships.insert({
          memberId: `mem_${ws}_${userId}` as WorkspaceMemberId, workspaceId: ws, userId,
          role: role as never, createdAt: AT,
        });
      }
      await uow.documents.insert({
        documentId: doc, workspaceId: ws, title: "Office Lease",
        originalFilename: null, createdByUserId: creator, createdAt: AT,
      });
      for (const [id, type, digest] of [
        [`art_o_${ws}`, "original", HASH("f")], [`art_s_${ws}`, "sealed", HASH("e")],
      ] as const) {
        await uow.artifacts.insert({
          artifactId: id as ArtifactId, workspaceId: ws, documentId: doc,
          artifactType: type, storageReference: `${ws}/${id}.pdf` as never,
          mediaType: "application/pdf", sizeBytes: 15,
          digestAlgorithm: "sha-256", digest: digest as never,
          pageCount: 1, rotatedPageCount: 0, createdAt: AT,
        });
      }
      await uow.preparations.insert({
        preparationId: `prep_${ws}` as PreparationId, workspaceId: ws,
        documentId: doc, sourceArtifactId: `art_o_${ws}`, createdAt: AT,
      });
      const snapshot: NewSigningRequestSnapshot = {
        request: {
          signingRequestId: request, workspaceId: ws, documentId: doc,
          sourceArtifactId: `art_o_${ws}` as ArtifactId,
          sourcePreparationId: `prep_${ws}` as PreparationId,
          sourcePreparationRevision: 1, state: "draft",
          completionReadyAt: null, terminatedAt: null, expiresAt: null, completedAt: null,
          terminationReason: null, cancellationNote: null,
          documentTitle: `Lease ${ws}`, createdByUserId: creator,
          createdAt: AT, updatedAt: AT,
        },
        recipients: [{
          recipientId: recipient, sourcePreparationRecipientId: null,
          name: "Maria Santos", email: "Maria@Example.com", normalizedEmail: "maria@example.com",
          organization: null, type: "signer", isRequired: true, orderIndex: 0, routingOrder: 1,
        }],
        fields: [],
      };
      await uow.signingRequests.createSnapshot(snapshot);
      await uow.evidence.append({
        evidenceEventId: `ev_${ws}` as EvidenceEventId, signingRequestId: request as never,
        recipientId: recipient, eventType: "signature-completed", eventVersion: 1,
        actor: { type: "recipient", actorId: recipient }, occurredAt: AT + 1000,
      });
      await uow.completion.ensureRun({
        completionRunId: `crun_${ws}` as CompletionRunId, signingRequestId: request,
        pipelineVersion: 1, createdAt: AT,
      });
      await uow.completion.recordCompletion({
        signingRequestId: request, completionRunId: `crun_${ws}` as CompletionRunId,
        mergedArtifactId: `art_o_${ws}` as ArtifactId, certificateArtifactId: `art_o_${ws}` as ArtifactId,
        finalArtifactId: `art_s_${ws}` as ArtifactId, completedAt: AT + 2000,
        sealScheme: "hash-evidence", sealVersion: 1, digestAlgorithm: "sha-256", pipelineVersion: 1,
      });
      await uow.finalizations.recordFinalization({
        seal: {
          sealId: `seal_${ws}` as SealId, workspaceId: ws, signingRequestId: request as never,
          sealedArtifactId: `art_s_${ws}` as ArtifactId, sealScheme: "hash-evidence", sealVersion: 1,
          digestAlgorithm: "sha-256", originalDocumentHash: HASH("f") as Sha256Digest,
          signedDocumentHash: HASH("e") as Sha256Digest, sealedAt: AT + 2000,
        },
        verification: {
          verificationId: vid, workspaceId: ws, signingRequestId: request as never,
          documentId: doc, sealId: `seal_${ws}` as SealId, completedAt: AT + 2000, participantCount: 1,
        },
      });
      await uow.branding.saveSettings({ senderDisplayName: null, footerTagline: null, primaryColor: "#0A0B0C" }, AT);
      await uow.branding.saveLogo({ bytes: new Uint8Array([137, 80, 78, 71]), width: 4, height: 4, digest: HASH("c") }, AT);
    });
    await sql`
      update signing_requests
         set state = 'completed', sent_at = to_timestamp(0),
             completion_ready_at = to_timestamp(0), completed_at = to_timestamp(0)
       where signing_request_id = ${request}
    `.execute(owner.db);
  }

  beforeEach(async () => {
    await truncateAll(owner);
    for (const userId of Object.keys(EMAILS)) {
      await seedUser(owner, userId, { email: EMAILS[userId] ?? "" });
    }
    await owner.db.updateTable("users").set({ email_verified_at: new Date(AT) })
      .where("user_id", "in", VERIFIED).execute();
    await completeDocument(WS_A, VID_A, SENDER, [
      [SENDER, "sender"], [ADMIN, "administrator"], [COLLEAGUE, "sender"],
    ]);
    await completeDocument(WS_B, VID_B, BOB, [[BOB, "owner"]]);

    const storage = createInMemoryObjectStorage();
    for (const ws of [WS_A, WS_B]) {
      await storage.putObject({
        ref: { zone: "artifacts", key: `${ws}/art_s_${ws}.pdf` as never },
        content: { kind: "bytes", bytes: new TextEncoder().encode(`%PDF sealed ${ws}`) },
        mediaType: "application/pdf",
      });
    }
    deps = {
      transactions: createTransactionManager(app.db),
      clock: { now: () => AT + 10_000 },
      ids: {
        nextDocumentShareId: () => `dsh_it_${++seq}` as never,
        nextDocumentAccessRequestId: () => `dar_it_${++seq}` as never,
      },
      templates: createTemplateRegistry(ALL_TEMPLATES),
      notificationIds: {
        nextNotificationIntentId: () => `nint_ds_${++seq}` as never,
        nextNotificationDeliveryId: () => `ndel_ds_${++seq}` as never,
      },
      storage,
      currentAccount: async userId => {
        const row = await owner.db.selectFrom("users")
          .select(["email", "normalized_email", "email_verified_at", "display_name"])
          .where("user_id", "=", userId).executeTakeFirst();
        return row === undefined ? null : {
          email: row.email, normalizedEmail: row.normalized_email,
          emailVerified: row.email_verified_at !== null, displayName: row.display_name,
        };
      },
    };
    store = createVerificationAccessStore(app.db);
  });

  const share = (email: string, by: UserId = SENDER, ws: WorkspaceId = WS_A) =>
    createDocumentShare(actor(by), ws, `doc_${ws}`, { email, fullName: null }, deps);

  const intents = () => owner.db.selectFrom("notification_intents")
    .innerJoin("notification_deliveries", "notification_deliveries.notification_intent_id",
      "notification_intents.notification_intent_id")
    .select([
      "notification_intents.notification_type", "notification_intents.audience_kind",
      "notification_intents.audience_user_id", "notification_intents.workspace_id",
      "notification_deliveries.state", "notification_deliveries.failure_code",
    ])
    .orderBy("notification_intents.created_at").orderBy("notification_intents.notification_intent_id")
    .execute();

  it("a share reaches its recipient across tenants by VERIFIED address, and nobody else", async () => {
    await share("Juan@Example.com");
    await share("ana@example.com");
    await share("juan@example.com", BOB, WS_B);

    const juan = await listSharedWithMe(JUAN, "pending", deps);
    expect(juan.map(i => [i.verificationId, i.branding.displayName, i.branding.primaryColor]).sort()).toEqual([
      [VID_A, `Workspace ${WS_A}`, "#0A0B0C"], [VID_B, `Workspace ${WS_B}`, "#0A0B0C"],
    ]);
    expect(juan[0]?.progress).toEqual({ participants: 1, completed: 1 });
    expect(await listSharedWithMe(EVE, "pending", deps)).toEqual([]);
    // Unverified: the realm is never opened for an address.
    expect(await listSharedWithMe(ANA, "pending", deps)).toEqual([]);
    // EVE cannot act on JUAN's share by id.
    const juanShare = juan.find(i => i.verificationId === VID_A)!;
    await expect(actOnSharedDocument(EVE, juanShare.id, "accept", deps)).rejects.toThrow(/not found/u);
    // The recipient gets the owner workspace's logo without being a member.
    expect(await getSharedDocumentLogo(JUAN, juanShare.id, deps)).toMatchObject({ digest: HASH("c") });
  });

  it("the recipient realms read only the caller's own rows, and cannot write without a tenant", async () => {
    await share("juan@example.com");
    await share("eve@example.com");
    await share("juan@example.com", BOB, WS_B);
    await requestDocumentAccess(EVE, VID_B, {}, deps);

    const asRealm = <T>(settings: Record<string, unknown>, run: (trx: never) => Promise<T>) =>
      app.db.transaction().execute(async trx => {
        for (const [name, value] of Object.entries(settings)) {
          await sql`select set_config(${name}, ${value}, true)`.execute(trx);
        }
        return run(trx as never);
      });

    const juanSees = await app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.document_share_recipient', ${shareRecipientDigestSql("juan@example.com")}, true)`.execute(trx);
      return trx.selectFrom("document_shares").select(["workspace_id", "normalized_email"]).orderBy("workspace_id").execute();
    });
    expect(juanSees).toEqual([
      { workspace_id: WS_A, normalized_email: "juan@example.com" },
      { workspace_id: WS_B, normalized_email: "juan@example.com" },
    ]);
    // The realm is FOR SELECT: an update from it reaches no row.
    const moved = await app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.document_share_recipient', ${shareRecipientDigestSql("juan@example.com")}, true)`.execute(trx);
      return sql`update document_shares set status = 'accepted'`.execute(trx);
    });
    expect(Number(moved.numAffectedRows ?? 0n)).toBe(0);

    const eveRequests = await asRealm({ "lagda.document_access_requester": EVE }, trx =>
      (trx as unknown as typeof app.db).selectFrom("document_access_requests").select("requester_user_id").execute());
    expect(eveRequests).toEqual([{ requester_user_id: EVE }]);
    const juanRequests = await asRealm({ "lagda.document_access_requester": JUAN }, trx =>
      (trx as unknown as typeof app.db).selectFrom("document_access_requests").selectAll().execute());
    expect(juanRequests).toEqual([]);

    // Tenant B sees none of A's shares; no context sees nothing at all.
    const fromB = await asRealm({ "lagda.workspace_id": WS_B }, trx =>
      (trx as unknown as typeof app.db).selectFrom("document_shares").select("workspace_id").execute());
    expect(fromB).toEqual([{ workspace_id: WS_B }]);
    expect(await app.db.selectFrom("document_shares").selectAll().execute()).toEqual([]);
    expect(await app.db.selectFrom("document_access_requests").selectAll().execute()).toEqual([]);
  });

  it("the runtime role cannot delete or truncate; the tables refuse bad shapes", async () => {
    await share("juan@example.com");
    for (const table of ["document_shares", "document_access_requests"]) {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`delete from ${sql.table(table)}`.execute(trx);
      })).rejects.toThrow(/permission denied/u);
      await expect(sql`truncate ${sql.table(table)}`.execute(app.db)).rejects.toThrow(/permission denied/u);
    }
    // A second live share for the same address is refused by the index too.
    await expect(owner.db.insertInto("document_shares").values({
      share_id: "dsh_raw", workspace_id: WS_A, document_id: `doc_${WS_A}`, signing_request_id: `sr_${WS_A}`,
      verification_id: VID_A, email: "juan@example.com", normalized_email: "juan@example.com",
      recipient_email_digest: HASH("a"), full_name: null, status: "pending", shared_by_user_id: SENDER,
      recipient_user_id: null, replaces_share_id: null, removed_by: null, removed_by_user_id: null,
      created_at: new Date(AT), updated_at: new Date(AT), responded_at: null, removed_at: null,
      recipient_deleted_at: null,
    }).execute()).rejects.toThrow(/document_shares_one_live/u);
    await expect(share("juan@example.com")).rejects.toBeInstanceOf(DocumentShareExistsError);
    // An accepted share must say who answered.
    await expect(sql`update document_shares set status = 'accepted'`.execute(owner.db))
      .rejects.toThrow(/document_shares_answered_shape/u);
  });

  it("every share transition, with in-app notices and the activity log", async () => {
    const created = await share("juan@example.com");
    await actOnSharedDocument(JUAN, created.shareId, "reject", deps);
    await actOnSharedDocument(JUAN, created.shareId, "withdraw-rejection", deps);
    await actOnSharedDocument(JUAN, created.shareId, "accept", deps);

    const details = await getSharedDocumentDetails(JUAN, created.shareId, deps);
    expect(details.participants).toEqual([expect.objectContaining({ maskedEmail: "M•••@Example.com", status: "signed" })]);
    const pdf = await openSharedDocument(JUAN, created.shareId, deps);
    const chunks: Uint8Array[] = [];
    for await (const chunk of pdf.stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe(`%PDF sealed ${WS_A}`);

    await actOnSharedDocument(JUAN, created.shareId, "remove-access", deps);
    await expect(openSharedDocument(JUAN, created.shareId, deps)).rejects.toThrow(/not found/u);

    const second = await share("juan@example.com");
    await actOnSharedDocument(JUAN, second.shareId, "reject", deps);
    await actOnSharedDocument(JUAN, second.shareId, "delete", deps);
    const ownerView = await listDocumentShares(actor(SENDER), WS_A, `doc_${WS_A}`, deps);
    expect(ownerView.shares.map(s => [s.status, s.removedBy, s.recipientDeleted])).toEqual([
      ["rejected", null, true], ["removed", "recipient", false],
    ]);

    expect((await intents()).map(i => [i.notification_type, i.audience_user_id, i.failure_code])).toEqual([
      ["DOCUMENT_SHARE_RECEIVED", JUAN, "IN_APP_ONLY"],
      ["DOCUMENT_SHARE_REJECTED", SENDER, "IN_APP_ONLY"],
      ["DOCUMENT_SHARE_ACCEPTED", SENDER, "IN_APP_ONLY"],
      ["DOCUMENT_SHARE_RECEIVED", JUAN, "IN_APP_ONLY"],
      ["DOCUMENT_SHARE_REJECTED", SENDER, "IN_APP_ONLY"],
    ]);
    const log = await owner.db.selectFrom("workspace_activity_events").select(["action", "actor_user_id"])
      .where("workspace_id", "=", WS_A).orderBy("occurred_at").orderBy("recorded_at").execute();
    expect(log.map(l => l.action)).toEqual(expect.arrayContaining([
      "document_share.created", "document_share.rejected", "document_share.rejection_withdrawn",
      "document_share.accepted", "document_share.access_removed", "document_share.deleted",
    ]));
  });

  it("the account's own feed lists the in-app notices from another workspace", async () => {
    await share("juan@example.com");
    const feed = await createNotificationFeedRepository(app.db).listForUser(JUAN, 50);
    expect(feed.map(n => n.notificationType)).toEqual(["DOCUMENT_SHARE_RECEIVED"]);
    expect(await createNotificationFeedRepository(app.db).listForUser(EVE, 50)).toEqual([]);
  });

  it("editing the address ends the old share and starts a pending one", async () => {
    const first = await share("juan@example.com");
    await actOnSharedDocument(JUAN, first.shareId, "accept", deps);
    const moved = await updateDocumentShare(actor(ADMIN), WS_A, `doc_${WS_A}`, first.shareId,
      { email: "eve@example.com", fullName: "Eve" }, deps);
    expect(moved.previous).toMatchObject({ status: "removed", removedBy: "email-changed" });
    expect(moved.share).toMatchObject({ email: "eve@example.com", fullName: "Eve", status: "pending", replacesShareId: first.shareId });
    expect(await listSharedWithMe(JUAN, "accepted", deps)).toEqual([]);
    expect((await listSharedWithMe(EVE, "pending", deps)).map(i => i.id)).toEqual([moved.share.shareId]);
    await removeDocumentShare(actor(SENDER), WS_A, `doc_${WS_A}`, moved.share.shareId, deps);
    expect(await listSharedWithMe(EVE, "pending", deps)).toEqual([]);
  });

  it("access requests: request across tenants, decide, and every transition", async () => {
    const request = await requestDocumentAccess(JUAN, VID_A, { note: "Tenant" }, deps);
    expect(await getMyDocumentAccess(JUAN, VID_A, deps)).toMatchObject({ relation: "request-pending" });
    await rejectAccessRequest(actor(SENDER), WS_A, request.requestId, deps);
    await withdrawAccessRequestRejection(actor(ADMIN), WS_A, request.requestId, deps);
    await approveAccessRequest(actor(SENDER), WS_A, request.requestId, deps);
    const [item] = await listSharedWithMe(JUAN, "accepted", deps);
    expect(item).toMatchObject({ id: request.requestId, kind: "access-request", branding: { primaryColor: "#0A0B0C" } });
    await expect(openSharedDocument(JUAN, request.requestId, deps)).resolves.toMatchObject({ mediaType: "application/pdf" });

    const second = await requestDocumentAccess(EVE, VID_A, {}, deps);
    await rejectAccessRequest(actor(SENDER), WS_A, second.requestId, deps);
    await deleteAccessRequest(actor(SENDER), WS_A, second.requestId, deps);
    expect((await listAccessRequests(actor(SENDER), WS_A, {}, deps)).map(r => r.requestId)).toEqual([request.requestId]);
    expect(await listAccessRequests(actor(COLLEAGUE), WS_A, {}, deps)).toEqual([]);
    expect(await getMyDocumentAccess(EVE, VID_A, deps)).toMatchObject({ relation: "none", canRequestAccess: true });

    const [shared] = await listSharedByMe(actor(SENDER), WS_A, {}, deps);
    expect(shared).toMatchObject({ approvedRequests: 1 });

    expect((await intents()).map(i => [i.notification_type, i.audience_user_id, i.workspace_id])).toEqual([
      ["DOCUMENT_ACCESS_REQUESTED", SENDER, WS_A],
      ["DOCUMENT_ACCESS_REJECTED", JUAN, WS_A],
      ["DOCUMENT_ACCESS_APPROVED", JUAN, WS_A],
      ["DOCUMENT_ACCESS_REQUESTED", SENDER, WS_A],
      ["DOCUMENT_ACCESS_REJECTED", EVE, WS_A],
    ]);
  });

  it("my-access names only the caller's own relation", async () => {
    expect((await getMyDocumentAccess(SENDER, VID_A, deps)).relation).toBe("owner");
    expect((await getMyDocumentAccess(ADMIN, VID_A, deps)).relation).toBe("admin");
    expect((await getMyDocumentAccess(MARIA, VID_A, deps)).relation).toBe("participant");
    expect((await getMyDocumentAccess(COLLEAGUE, VID_A, deps)).relation).toBe("none");
    expect((await getMyDocumentAccess(BOB, VID_A, deps)).relation).toBe("none");
    expect((await getMyDocumentAccess(BOB, VID_B, deps)).relation).toBe("owner");
    expect((await getMyDocumentAccess(JUAN, "LAGDA-VER-2026-NOPENOPENO", deps)).relation).toBe("none");
  });

  describe("Verify Document unlock", () => {
    const verification = (): VerificationAccessDependencies => ({
      store,
      crypto: {
        newCode: () => "123456",
        digestCode: (_challengeId, code) => HASH(code.charAt(0)),
        digestsEqual: (a, b) => a === b,
        sealCode: code => ({ sealed: `sealed:${code}`, keyVersion: "v1" }),
        issueGrantToken: () => ({ raw: `tok_${String(seq)}`, digest: HASH(String(++seq % 10)) }),
        digestGrantToken: raw => HASH(raw.slice(-1)),
        nextChallengeId: () => `vac_ds_${++seq}`,
        nextGrantId: () => `vag_ds_${++seq}`,
        throttleKeys: (vid, email) => ({ pairKey: hexOf(email), verificationKey: hexOf(vid) }),
      },
      clock: { now: () => AT + 20_000 },
      templates: createTemplateRegistry(ALL_TEMPLATES),
      ids: {
        nextNotificationIntentId: () => `nint_v_${++seq}` as never,
        nextNotificationDeliveryId: () => `ndel_v_${++seq}` as never,
      },
      storage: deps.storage,
      currentAccount: async userId => {
        const account = await deps.currentAccount(userId as UserId);
        return account === null ? null : { normalizedEmail: account.normalizedEmail, emailVerified: account.emailVerified };
      },
      throttle: createVerificationAccessThrottle(app.db),
    });

    it("signed in: owner, administrator, participant, accepted share and approved request need no code", async () => {
      const shared = await share("juan@example.com");
      const asked = await requestDocumentAccess(EVE, VID_A, {}, deps);
      // Not yet: a pending share and a pending request admit nobody.
      expect((await grantMemberVerificationAccess(JUAN, VID_A, verification())).outcome).toBe("denied");
      expect((await grantMemberVerificationAccess(EVE, VID_A, verification())).outcome).toBe("denied");
      await actOnSharedDocument(JUAN, shared.shareId, "accept", deps);
      await approveAccessRequest(actor(SENDER), WS_A, asked.requestId, deps);

      const results: Record<string, string> = {};
      for (const userId of [SENDER, ADMIN, MARIA, JUAN, EVE, COLLEAGUE, BOB, ANA]) {
        const result = await grantMemberVerificationAccess(userId, VID_A, verification());
        results[userId] = result.outcome === "granted" ? result.recipientType : "denied";
      }
      expect(results).toEqual({
        [SENDER]: "owner", [ADMIN]: "administrator", [MARIA]: "signer",
        [JUAN]: "shared", [EVE]: "shared", [COLLEAGUE]: "denied", [BOB]: "denied", [ANA]: "denied",
      });
      const bases = await owner.db.selectFrom("verification_access_grants")
        .select(["access_basis", "user_id"]).orderBy("created_at").orderBy("grant_id").execute();
      expect(bases.map(b => b.access_basis).sort()).toEqual(
        ["access-request", "document-owner", "participant", "share", "workspace-administrator"]);
    });

    it("a removed share ends the grant it gave on the grant's next use", async () => {
      const shared = await share("juan@example.com");
      await actOnSharedDocument(JUAN, shared.shareId, "accept", deps);
      const granted = await grantMemberVerificationAccess(JUAN, VID_A, verification());
      expect(granted.outcome).toBe("granted");
      const token = granted.outcome === "granted" ? granted.accessToken : "";
      const grant = await owner.db.selectFrom("verification_access_grants").select("token_digest").executeTakeFirstOrThrow();
      expect(await store.findDetails({ verificationId: VID_A, tokenDigest: grant.token_digest, now: AT + 30_000 })).not.toBeNull();
      await removeDocumentShare(actor(SENDER), WS_A, `doc_${WS_A}`, shared.shareId, deps);
      expect(await store.findDetails({ verificationId: VID_A, tokenDigest: grant.token_digest, now: AT + 30_000 })).toBeNull();
      expect(token).not.toBe("");
    });

    it("public code: identical answers; a code only for participants, accepted shares and approved requests", async () => {
      const accepted = await share("juan@example.com");
      await actOnSharedDocument(JUAN, accepted.shareId, "accept", deps);
      await share("ana@example.com"); // pending: not on the list
      const approved = await requestDocumentAccess(EVE, VID_A, {}, deps);
      await approveAccessRequest(actor(SENDER), WS_A, approved.requestId, deps);
      const before = (await intents()).length;

      const answers = [];
      for (const email of ["maria@example.com", "Juan@Example.com", "eve@example.com", "ana@example.com", "stranger@example.com"]) {
        answers.push(await requestVerificationAccessCode(VID_A, email, verification()));
      }
      for (const answer of answers) expect(answer).toEqual({ sent: true, expiresInSeconds: 600 });

      const challenges = await owner.db.selectFrom("verification_access_challenges")
        .select(["normalized_email", "request_recipient_id", "share_id", "access_request_id"])
        .orderBy("normalized_email").execute();
      expect(challenges).toEqual([
        { normalized_email: "eve@example.com", request_recipient_id: null, share_id: null, access_request_id: approved.requestId },
        { normalized_email: "juan@example.com", request_recipient_id: null, share_id: accepted.shareId, access_request_id: null },
        { normalized_email: "maria@example.com", request_recipient_id: `srr_${WS_A}`, share_id: null, access_request_id: null },
      ]);
      const codes = (await intents()).slice(before);
      expect(codes.map(c => [c.notification_type, c.audience_kind, c.audience_user_id, c.state])).toEqual([
        ["VERIFICATION_ACCESS_CODE", "SIGNING_REQUEST_RECIPIENT", null, "PENDING"],
        ["SHARED_DOCUMENT_ACCESS_CODE", "USER", JUAN, "PENDING"],
        ["SHARED_DOCUMENT_ACCESS_CODE", "USER", EVE, "PENDING"],
      ]);
      // The emailed code for a share is not in the account's in-app feed.
      expect((await createNotificationFeedRepository(app.db).listForUser(JUAN, 50)).map(n => n.notificationType))
        .not.toContain("SHARED_DOCUMENT_ACCESS_CODE");

      const redeemed = await redeemVerificationAccessCode(VID_A, "juan@example.com", "123456", verification());
      expect(redeemed).toMatchObject({ outcome: "granted", recipientType: "shared" });
      const wrong = await redeemVerificationAccessCode(VID_A, "ana@example.com", "123456", verification());
      expect(wrong).toEqual({ outcome: "denied" });
    });
  });

  it("widens the notification and activity vocabularies", async () => {
    const rows = await sql<{ def: string }>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conname in ('notification_intents_type_check', 'notification_intents_source_kind_check',
                         'workspace_activity_events_action_check')
    `.execute(owner.db);
    const defs = rows.rows.map(r => r.def).join(" ");
    for (const value of [
      "DOCUMENT_SHARE_RECEIVED", "DOCUMENT_SHARE_ACCEPTED", "DOCUMENT_SHARE_REJECTED",
      "DOCUMENT_ACCESS_REQUESTED", "DOCUMENT_ACCESS_APPROVED", "DOCUMENT_ACCESS_REJECTED",
      "SHARED_DOCUMENT_ACCESS_CODE", "DOCUMENT_SHARE", "DOCUMENT_ACCESS_REQUEST",
      "document_share.created", "access_request.access_removed",
    ]) {
      expect(defs).toContain(value);
    }
  });

  it("goes down when empty and back up", async () => {
    await truncateAll(owner);
    const reverted: string[] = [];
    while (!reverted.includes("087_document_sharing")) {
      const down = await migrateDown(owner.db);
      expect(down.error).toBeUndefined();
      expect(down.applied).toHaveLength(1);
      reverted.push(...down.applied);
    }
    const gone = await sql<{ n: string }>`
      select count(*)::text as n from pg_tables
       where tablename in ('document_shares', 'document_access_requests')
    `.execute(owner.db);
    expect(gone.rows[0]?.n).toBe("0");
    const up = await migrateToLatest(owner.db);
    expect(up.error).toBeUndefined();
    expect((await migrationStatus(owner.db)).every(s => s.applied)).toBe(true);
  });
});
