// 083. Verify Document access codes and grants on REAL PostgreSQL, as the
// runtime role: the store resolves across tenants only through 075's and
// 083's narrow realms, stores digests only, supersedes, caps attempts,
// expires, scopes grants, cannot delete, and the migration goes down and up.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type {
  DocumentId, UserId, VerificationId, WorkspaceId, WorkspaceMemberId, Sha256Digest,
} from "@lagda/contracts";
import type {
  ArtifactId, PreparationId, SigningRequestId, SigningRequestRecipientId, SealId,
  CompletionRunId, EvidenceEventId, NewSigningRequestSnapshot, VerificationAccessStore,
} from "@lagda/application";
import {
  requestVerificationAccessCode, createTemplateRegistry, ALL_TEMPLATES,
} from "@lagda/application";
import type { LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createVerificationAccessStore, findSealedVerificationAccessCode,
} from "./repositories/verification-access.js";
import { migrateDown, migrateToLatest, migrationStatus } from "./migrations/runner.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-09-26T07:00:00.000Z");
const USER = "usr_va" as UserId;
const WS_A = "ws_va_a" as WorkspaceId;
const WS_B = "ws_va_b" as WorkspaceId;
const EMAIL = "maria@example.com";
const HASH = (c: string) => c.repeat(64);

const suite = hasIntegrationDatabase() ? describe : describe.skip;

const verificationOf = (ws: WorkspaceId) =>
  (ws === WS_A ? "LAGDA-VER-2026-AAAAAAAAAA" : "LAGDA-VER-2026-BBBBBBBBBB") as VerificationId;
const requestOf = (ws: WorkspaceId) => `sr_${ws}` as SigningRequestId;
const recipientOf = (ws: WorkspaceId) => `srr_${ws}` as SigningRequestRecipientId;

suite("verification access (083, runtime role)", () => {
  let owner: LagdaDatabase;
  let app: LagdaDatabase;
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

  async function completeDocument(ws: WorkspaceId, member: string): Promise<void> {
    const tx = createTransactionManager(app.db);
    const doc = `doc_${ws}` as DocumentId;
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
      for (const [id, type, digest] of [
        [`art_o_${ws}`, "original", HASH("f")], [`art_s_${ws}`, "sealed", HASH("e")],
      ] as const) {
        await uow.artifacts.insert({
          artifactId: id as ArtifactId, workspaceId: ws, documentId: doc,
          artifactType: type, storageReference: `${ws}/${id}.pdf` as never,
          mediaType: "application/pdf", sizeBytes: 2048,
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
          signingRequestId: requestOf(ws), workspaceId: ws, documentId: doc,
          sourceArtifactId: `art_o_${ws}` as ArtifactId,
          sourcePreparationId: `prep_${ws}` as PreparationId,
          sourcePreparationRevision: 1, state: "draft",
          completionReadyAt: null, terminatedAt: null, expiresAt: null, completedAt: null,
          terminationReason: null, cancellationNote: null,
          documentTitle: `Lease for ${ws}`, createdByUserId: USER,
          createdAt: AT, updatedAt: AT,
        },
        // The SAME address on both tenants' documents: nothing may cross.
        recipients: [{
          recipientId: recipientOf(ws), sourcePreparationRecipientId: null,
          name: "Maria Santos", email: "Maria@Example.com",
          normalizedEmail: EMAIL, organization: null,
          type: "approver", isRequired: true, orderIndex: 0, routingOrder: 1,
        }],
        fields: [],
      };
      await uow.signingRequests.createSnapshot(snapshot);
      await uow.evidence.append({
        evidenceEventId: `ev_${ws}` as EvidenceEventId,
        signingRequestId: requestOf(ws) as never,
        recipientId: recipientOf(ws),
        eventType: "approval-completed", eventVersion: 1,
        actor: { type: "recipient", actorId: recipientOf(ws) },
        occurredAt: AT + 1000,
      });
      await uow.completion.ensureRun({
        completionRunId: `crun_${ws}` as CompletionRunId,
        signingRequestId: requestOf(ws), pipelineVersion: 1, createdAt: AT,
      });
      await uow.completion.recordCompletion({
        signingRequestId: requestOf(ws),
        completionRunId: `crun_${ws}` as CompletionRunId,
        mergedArtifactId: `art_o_${ws}` as ArtifactId,
        certificateArtifactId: `art_o_${ws}` as ArtifactId,
        finalArtifactId: `art_s_${ws}` as ArtifactId,
        completedAt: AT + 2000, sealScheme: "hash-evidence", sealVersion: 1,
        digestAlgorithm: "sha-256", pipelineVersion: 1,
      });
      await uow.finalizations.recordFinalization({
        seal: {
          sealId: `seal_${ws}` as SealId, workspaceId: ws, signingRequestId: requestOf(ws) as never,
          sealedArtifactId: `art_s_${ws}` as ArtifactId, sealScheme: "hash-evidence", sealVersion: 1,
          digestAlgorithm: "sha-256", originalDocumentHash: HASH("f") as Sha256Digest,
          signedDocumentHash: HASH("e") as Sha256Digest, sealedAt: AT + 2000,
        },
        verification: {
          verificationId: verificationOf(ws), workspaceId: ws, signingRequestId: requestOf(ws) as never,
          documentId: doc, sealId: `seal_${ws}` as SealId, completedAt: AT + 2000, participantCount: 1,
        },
      });
    });
    await sql`
      update signing_requests
         set state = 'completed', sent_at = to_timestamp(0),
             completion_ready_at = to_timestamp(0), completed_at = to_timestamp(0)
       where signing_request_id = ${requestOf(ws)}
    `.execute(owner.db);
  }

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, USER);
    await completeDocument(WS_A, "mem_vaa");
    await completeDocument(WS_B, "mem_vab");
    store = createVerificationAccessStore(app.db);
  });

  const notified: string[] = [];
  const issue = (over: { email?: string; id?: VerificationId; digest?: string; now?: number } = {}) => {
    const challengeId = `vac_${++seq}`;
    const now = over.now ?? AT + 10_000;
    return store.issueChallenge({
      verificationId: over.id ?? verificationOf(WS_A),
      normalizedEmail: over.email ?? EMAIL,
      challengeId,
      codeDigest: over.digest ?? HASH("1"),
      sealedCode: `sealed:${challengeId}`,
      sealedKeyVersion: "v1",
      now,
      expiresAt: now + 600_000,
    }, (target, _notifications, _trx) => {
      notified.push(`${target.workspaceId}:${target.requestRecipientId}`);
      return Promise.resolve();
    }).then(ok => ({ ok, challengeId }));
  };

  const redeem = (digestOk: boolean, over: { now?: number; id?: VerificationId } = {}) =>
    store.redeemChallenge({
      verificationId: over.id ?? verificationOf(WS_A),
      normalizedEmail: EMAIL,
      now: over.now ?? AT + 20_000,
      maxAttempts: 5,
      matches: () => digestOk,
      grant: { grantId: `vag_${++seq}`, tokenDigest: HASH(String(seq % 10)), expiresAt: AT + 1_820_000 },
    });

  const challenges = () => owner.db.selectFrom("verification_access_challenges").selectAll()
    .orderBy("created_at").orderBy("challenge_id").execute();

  it("stores a digest-only challenge in the document's own workspace, and notifies", async () => {
    notified.length = 0;
    const { ok } = await issue();
    expect(ok).toBe(true);
    expect(notified).toEqual([`${WS_A}:${recipientOf(WS_A)}`]);
    const [row] = await challenges();
    expect(row).toMatchObject({
      workspace_id: WS_A, verification_id: verificationOf(WS_A), normalized_email: EMAIL,
      code_digest: HASH("1"), attempts: 0, consumed_at: null, superseded_at: null,
    });
  });

  it("writes nothing for a non-participant or an unknown reference", async () => {
    expect((await issue({ email: "stranger@example.com" })).ok).toBe(false);
    expect((await issue({ id: "LAGDA-VER-2026-CCCCCCCCCC" as VerificationId })).ok).toBe(false);
    expect(await challenges()).toHaveLength(0);
  });

  it("a resend supersedes the live challenge and clears its sealed code", async () => {
    const first = await issue();
    const second = await issue();
    const rows = await challenges();
    const old = rows.find(r => r.challenge_id === first.challengeId);
    const live = rows.find(r => r.challenge_id === second.challengeId);
    expect(old?.superseded_at).not.toBeNull();
    expect(old?.sealed_code).toBeNull();
    expect(live?.superseded_at).toBeNull();
    // The worker can read only the live one.
    expect(await findSealedVerificationAccessCode(app.db, WS_A, first.challengeId, AT + 20_000, 5)).toBeNull();
    expect(await findSealedVerificationAccessCode(app.db, WS_A, second.challengeId, AT + 20_000, 5))
      .toEqual({ sealed: `sealed:${second.challengeId}`, keyVersion: "v1" });
    // And only inside its own workspace.
    expect(await findSealedVerificationAccessCode(app.db, WS_B, second.challengeId, AT + 20_000, 5)).toBeNull();
  });

  it("a wrong code spends an attempt; the fifth kills the challenge", async () => {
    const { challengeId } = await issue();
    for (let i = 0; i < 5; i++) expect((await redeem(false)).outcome).toBe("denied");
    const [row] = await challenges();
    expect(row?.attempts).toBe(5);
    expect(row?.sealed_code).toBeNull();
    expect((await redeem(true)).outcome).toBe("denied");
    expect(await findSealedVerificationAccessCode(app.db, WS_A, challengeId, AT + 20_000, 5)).toBeNull();
  });

  it("an expired challenge is denied", async () => {
    await issue();
    expect((await redeem(true, { now: AT + 10_000 + 600_000 })).outcome).toBe("denied");
  });

  it("a right code consumes the challenge and stores only the grant's digest", async () => {
    await issue();
    const result = await redeem(true);
    expect(result).toMatchObject({ outcome: "granted", target: {
      workspaceId: WS_A, requestRecipientId: recipientOf(WS_A), destination: "Maria@Example.com",
      recipientType: "approver", documentTitle: `Lease for ${WS_A}`,
    } });
    const [row] = await challenges();
    expect(row?.consumed_at).not.toBeNull();
    expect(row?.sealed_code).toBeNull();
    const grants = await owner.db.selectFrom("verification_access_grants").selectAll().execute();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ origin: "code", workspace_id: WS_A, user_id: null });
    expect(grants[0]?.token_digest).toMatch(/^[a-f0-9]{64}$/u);
    // Consumed: a second redemption finds no live challenge.
    expect((await redeem(true)).outcome).toBe("denied");
  });

  it("a grant resolves details and the document for its own reference only, until it expires", async () => {
    await issue();
    await redeem(true);
    const [grant] = await owner.db.selectFrom("verification_access_grants").selectAll().execute();
    const tokenDigest = grant!.token_digest;

    const details = await store.findDetails({ verificationId: verificationOf(WS_A), tokenDigest, now: AT + 30_000 });
    expect(details).toMatchObject({
      documentTitle: `Lease for ${WS_A}`, sealedDigest: HASH("e"),
      participants: [{ name: "Maria Santos", email: "Maria@Example.com", recipientType: "approver" }],
      events: [{ eventType: "approval-completed", recipientId: recipientOf(WS_A), occurredAt: AT + 1000 }],
    });
    expect(await store.findDocumentRef({ verificationId: verificationOf(WS_A), tokenDigest, now: AT + 30_000 }))
      .toEqual({ storageReference: `${WS_A}/art_s_${WS_A}.pdf`, mediaType: "application/pdf", sizeBytes: 2048 });

    // Another document's reference, an unknown digest, an expired grant: nothing.
    expect(await store.findDocumentRef({ verificationId: verificationOf(WS_B), tokenDigest, now: AT + 30_000 })).toBeNull();
    expect(await store.findDocumentRef({ verificationId: verificationOf(WS_A), tokenDigest: HASH("d"), now: AT + 30_000 })).toBeNull();
    expect(await store.findDetails({ verificationId: verificationOf(WS_A), tokenDigest, now: AT + 1_820_000 })).toBeNull();
  });

  it("a member grant is recorded against the account", async () => {
    const target = await store.issueMemberGrant({
      verificationId: verificationOf(WS_B), normalizedEmail: EMAIL, userId: USER, now: AT + 5000,
      grant: { grantId: "vag_member", tokenDigest: HASH("7"), expiresAt: AT + 1_805_000 },
    });
    expect(target?.workspaceId).toBe(WS_B);
    expect(await store.issueMemberGrant({
      verificationId: verificationOf(WS_B), normalizedEmail: "other@example.com", userId: USER, now: AT,
      grant: { grantId: "vag_member2", tokenDigest: HASH("8"), expiresAt: AT + 1_800_000 },
    })).toBeNull();
    const [row] = await owner.db.selectFrom("verification_access_grants").selectAll().execute();
    expect(row).toMatchObject({ origin: "member", user_id: USER, challenge_id: null });
  });

  it("the runtime role sees no rows without a realm, and cannot delete or truncate", async () => {
    await issue();
    await redeem(true);
    const bare = await app.db.transaction().execute(async trx => ({
      challenges: await trx.selectFrom("verification_access_challenges").selectAll().execute(),
      grants: await trx.selectFrom("verification_access_grants").selectAll().execute(),
    }));
    expect(bare).toEqual({ challenges: [], grants: [] });

    // Even inside the owning tenant.
    for (const table of ["verification_access_challenges", "verification_access_grants"]) {
      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        await sql`delete from ${sql.table(table)}`.execute(trx);
      })).rejects.toThrow(/permission denied/u);
      await expect(sql`truncate ${sql.table(table)}`.execute(app.db)).rejects.toThrow(/permission denied/u);
    }

    // Another tenant's context sees none of A's rows.
    const fromB = await app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.workspace_id', ${WS_B}, true)`.execute(trx);
      return trx.selectFrom("verification_access_challenges").selectAll().execute();
    });
    expect(fromB).toEqual([]);
  });

  it("refuses a raw code or token in the digest columns", async () => {
    await expect(issue({ digest: "123456" })).rejects.toThrow(/digest_shape/u);
  });

  it("the whole request path stores the notification intent under the new vocabulary", async () => {
    let n = 0;
    const result = await requestVerificationAccessCode(verificationOf(WS_A), " Maria@Example.com ", {
      store,
      crypto: {
        newCode: () => "123456",
        digestCode: () => HASH("2"),
        digestsEqual: (a, b) => a === b,
        sealCode: code => ({ sealed: `sealed:${code}`, keyVersion: "v1" }),
        issueGrantToken: () => ({ raw: "x", digest: HASH("3") }),
        digestGrantToken: () => null,
        nextChallengeId: () => "vac_full",
        nextGrantId: () => "vag_full",
      },
      clock: { now: () => AT + 10_000 },
      templates: createTemplateRegistry(ALL_TEMPLATES),
      ids: {
        nextNotificationIntentId: () => `nint_va_${++n}` as never,
        nextNotificationDeliveryId: () => `ndel_va_${++n}` as never,
      },
      storage: {} as never,
      currentAccount: () => Promise.resolve(null),
    });
    expect(result).toEqual({ sent: true, expiresInSeconds: 600 });
    const intents = await owner.db.selectFrom("notification_intents").selectAll().execute();
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      workspace_id: WS_A, notification_type: "VERIFICATION_ACCESS_CODE",
      source_kind: "VERIFICATION_ACCESS_CHALLENGE", source_id: "vac_full",
      audience_kind: "SIGNING_REQUEST_RECIPIENT", audience_recipient_id: recipientOf(WS_A),
    });
    expect(JSON.stringify(intents[0])).not.toContain("123456");
  });

  it("documents carry their own tenant's verification ID only", async () => {
    const tx = createTransactionManager(app.db);
    const docA = `doc_${WS_A}` as DocumentId;
    const docB = `doc_${WS_B}` as DocumentId;
    const fromA = await tx.runForWorkspace(WS_A, uow => uow.documents.verificationIdsFor([docA, docB]));
    expect([...fromA.entries()]).toEqual([[docA, verificationOf(WS_A)]]);
    expect((await tx.runForWorkspace(WS_A, uow => uow.documents.verificationIdsFor([]))).size).toBe(0);
  });

  it("widens the notification vocabulary", async () => {
    const rows = await sql<{ def: string }>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conname in ('notification_intents_type_check', 'notification_intents_source_kind_check')
    `.execute(owner.db);
    const defs = rows.rows.map(r => r.def).join(" ");
    expect(defs).toContain("VERIFICATION_ACCESS_CODE");
    expect(defs).toContain("VERIFICATION_ACCESS_CHALLENGE");
  });

  it("goes down when empty and back up", async () => {
    await truncateAll(owner);
    const down = await migrateDown(owner.db);
    expect(down.error).toBeUndefined();
    expect(down.applied).toEqual(["083_verification_access_codes"]);
    const gone = await sql<{ n: string }>`
      select count(*)::text as n from pg_tables
       where tablename in ('verification_access_challenges', 'verification_access_grants')
    `.execute(owner.db);
    expect(gone.rows[0]?.n).toBe("0");

    const up = await migrateToLatest(owner.db);
    expect(up.error).toBeUndefined();
    const status = await migrationStatus(owner.db);
    expect(status.every(s => s.applied)).toBe(true);
  });
});
