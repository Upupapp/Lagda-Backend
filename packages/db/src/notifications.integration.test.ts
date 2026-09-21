// Notifications against REAL PostgreSQL, as the runtime role.
//
// What only this suite can prove:
//
//   1. Two concurrent creations for one source resolve to ONE intent — the
//      race `createIfAbsent`'s ON CONFLICT exists for, and the one a fake
//      cannot model because it has no second connection.
//   2. The scope CHECK refuses a row that is both workspace- and user-scoped,
//      and one that is neither.
//   3. RLS hides a workspace's notifications from another tenant, and hides a
//      global account notification from every workspace.
//   4. The audience CHECK refuses a kind that disagrees with its column.
//   5. An intent cannot be UPDATEd at all — the grant is not there.
//   6. A frozen destination survives an unrelated profile change, because
//      nothing re-reads it.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type {
  NotificationIntentId, NotificationDeliveryId, NewNotificationIntent,
  NotificationDeliveryAttemptId, SigningRequestRecipientId,
  ArtifactId, PreparationId, SigningRequestId, NewSigningRequestSnapshot,
} from "@lagda/application";
import type { DocumentId } from "@lagda/contracts";
import {
  NOTIFICATION_TYPES, NOTIFICATION_SOURCE_KINDS,
  createCompletionNotificationProducer, createTemplateRegistry, ALL_TEMPLATES,
} from "@lagda/application";

/** Feeds the deterministic-but-unique ids the boundary tests mint. */
let minted = 0;
import { type LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import { createNotificationRepository } from "./repositories/notifications.js";
import {
  createNotificationTransportRepository,
} from "./repositories/notification-transport.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll, hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-08-18T07:00:00.000Z");
const USER = "usr_notify" as UserId;
const WS_A = "ws_na" as WorkspaceId;
const WS_B = "ws_nb" as WorkspaceId;
const DOC = "doc_na" as DocumentId;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

/** Deterministic ids, so a conflict is visible rather than hidden by a UUID. */
const ids = (prefix: string) => ({
  notificationIntentId: `nint_${prefix}` as NotificationIntentId,
  notificationDeliveryId: `ndel_${prefix}` as NotificationDeliveryId,
  createdAt: AT,
});

const workspaceIntent = (
  sourceId: string,
  prefix: string,
  destination = "alice@example.test",
): NewNotificationIntent => ({
  ...ids(prefix),
  scope: { kind: "WORKSPACE", workspaceId: WS_A },
  notificationType: "SIGNING_INVITATION",
  source: { kind: "SIGNING_ACCESS_GRANT", sourceId },
  audience: {
    kind: "SIGNING_REQUEST_RECIPIENT",
    signingRequestRecipientId: "srr_a" as SigningRequestRecipientId,
  },
  template: { key: "signing-invitation", version: 1 },
  locale: "en",
  templateInput: {
    recipientName: "Maria Santos", documentTitle: "Lease Agreement",
    senderDisplayName: "Paulo Reyes", workspaceName: "Reyes Legal",
  },
  secretRef: { kind: "SEALED", sealed: "v1.aa.bb.cc" as never, keyVersion: "k1" },
  channel: "EMAIL",
  destination,
});

const globalIntent = (sourceId: string, prefix: string): NewNotificationIntent => ({
  ...ids(prefix),
  scope: { kind: "GLOBAL_USER", userId: USER },
  notificationType: "PASSWORD_RESET",
  source: { kind: "SECURITY_CHALLENGE", sourceId },
  audience: { kind: "USER", userId: USER },
  template: { key: "password-reset", version: 1 },
  locale: "en",
  templateInput: { recipientName: "Maria Santos" },
  secretRef: { kind: "CHALLENGE", challengeId: sourceId },
  channel: "EMAIL",
  destination: "alice@example.test",
});

/**
 * A completion notification, which is unlike both fixtures above:
 * workspace-scoped but addressed to a USER, and carrying NO secret at all.
 *
 * `sourceId` is the SIGNING REQUEST -- the key on which
 * `notification_intents_logical_key` guarantees exactly one completion
 * notification per request.
 */
const completionIntent = (
  sourceId: string,
  prefix: string,
): NewNotificationIntent => ({
  ...ids(prefix),
  scope: { kind: "WORKSPACE", workspaceId: WS_A },
  notificationType: "SIGNING_COMPLETED",
  source: { kind: "SIGNING_REQUEST", sourceId },
  audience: { kind: "USER", userId: USER },
  template: { key: "signing-completed", version: 1 },
  locale: "en",
  templateInput: {
    recipientName: "Paulo Reyes", documentTitle: "Lease Agreement",
    workspaceName: "Reyes Legal", signerCount: 2,
  },
  // No `secretRef`. The property this fixture exists to exercise.
  channel: "EMAIL",
  destination: "paulo@example.test",
});

suite("notifications (RLS, runtime role)", () => {
  let owner: LagdaDatabase;
  let app: LagdaDatabase;

  beforeAll(async () => {
    owner = await createTestDatabase();
    app = await createRuntimeRoleDatabase(owner);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
  });

  beforeEach(async () => {
    await truncateAll(owner);
    await seedUser(owner, USER);
    const tx = createTransactionManager(owner.db);
    for (const [ws, member] of [[WS_A, "mem_na"], [WS_B, "mem_nb"]] as const) {
      await tx.runForWorkspace(ws, async uow => {
        await uow.workspaces.insert({ workspaceId: ws, name: `WS ${ws}`, createdAt: AT });
        await uow.memberships.insert({
          memberId: member as WorkspaceMemberId, workspaceId: ws,
          userId: USER, role: "owner", createdAt: AT,
        });
      });
    }

    // ── The recipient the audience POINTS AT ────────────────────────────────
    //
    // `workspaceIntent` names `srr_a`, and migration 032 made
    // `audience_recipient_id` a real foreign key to
    // `signing_request_recipients` -- correcting migration 030, which shipped
    // it as a bare column. This suite predates that and never seeded one, so
    // every workspace-scoped case has failed on the FK since 032. Nobody saw
    // it because the integration suite had no database to run against.
    //
    // A whole signing request has to exist for the recipient to hang off:
    // document, artifact, preparation, then the snapshot.
    await tx.runForWorkspace(WS_A, async uow => {
      await uow.documents.insert({
        documentId: DOC, workspaceId: WS_A, title: "Lease Agreement",
        originalFilename: null, createdByUserId: USER, createdAt: AT,
      });
      await uow.artifacts.insert({
        artifactId: "art_na" as ArtifactId, workspaceId: WS_A, documentId: DOC,
        artifactType: "original", storageReference: "ws/a" as never,
        mediaType: "application/pdf", sizeBytes: 1024,
        digestAlgorithm: "sha-256", digest: "c".repeat(64) as never,
        pageCount: 1, rotatedPageCount: 0, createdAt: AT,
      });
      await uow.preparations.insert({
        preparationId: "prep_na" as PreparationId, workspaceId: WS_A,
        documentId: DOC, sourceArtifactId: "art_na", createdAt: AT,
      });

      const snapshot: NewSigningRequestSnapshot = {
        request: {
          signingRequestId: "sr_na" as SigningRequestId, workspaceId: WS_A,
          documentId: DOC, sourceArtifactId: "art_na" as ArtifactId,
          sourcePreparationId: "prep_na" as PreparationId,
          sourcePreparationRevision: 1, state: "draft",
          completionReadyAt: null, expiresAt: null, completedAt: null,
          terminatedAt: null, terminationReason: null, cancellationNote: null,
          documentTitle: "Lease Agreement", createdByUserId: USER,
          createdAt: AT, updatedAt: AT,
        },
        recipients: [{
          recipientId: "srr_a" as SigningRequestRecipientId,
          sourcePreparationRecipientId: null,
          name: "Maria Santos", email: "maria@example.test",
          normalizedEmail: "maria@example.test", organization: null,
          type: "signer", isRequired: true, orderIndex: 0, routingOrder: 1,
        }],
        fields: [],
      };
      await uow.signingRequests.createSnapshot(snapshot);
    });
  });

  /** Runs inside a workspace RLS context on the runtime-role connection. */
  const inWorkspace = async <T>(
    workspaceId: WorkspaceId,
    prefix: string,
    body: (repository: ReturnType<typeof createNotificationRepository>) => Promise<T>,
  ): Promise<T> =>
    app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.workspace_id', ${workspaceId}, true)`.execute(trx);
      return body(createNotificationRepository(trx));
    });

  /** Runs inside a user RLS context — no workspace at all. */
  const asUser = async <T>(
    userId: UserId,
    prefix: string,
    body: (repository: ReturnType<typeof createNotificationRepository>) => Promise<T>,
  ): Promise<T> =>
    app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.user_id', ${userId}, true)`.execute(trx);
      return body(createNotificationRepository(trx));
    });

  describe("logical idempotency", () => {
    it("resolves two CONCURRENT creations for one source to one intent", async () => {
      // S240, and the reason `createIfAbsent` is ON CONFLICT rather than
      // read-then-insert: both transactions read "absent" under a check-then-
      // write and both insert.
      const [first, second] = await Promise.all([
        inWorkspace(WS_A, "a", r => r.createIfAbsent(workspaceIntent("grant_1", "a"), null)),
        inWorkspace(WS_A, "b", r => r.createIfAbsent(workspaceIntent("grant_1", "b"), null)),
      ]);

      const outcomes = [first.outcome, second.outcome].sort();
      expect(outcomes).toEqual(["ALREADY_EXISTS", "CREATED"]);
      expect(first.intent.notificationIntentId)
        .toBe(second.intent.notificationIntentId);

      const rows = await owner.db.selectFrom("notification_intents")
        .select("notification_intent_id").execute();
      expect(rows).toHaveLength(1);
    });

    it("creates a distinct intent for a new source occurrence", async () => {
      // S138, S241. A second OTP challenge is a new source id.
      await asUser(USER, "a", r => r.createIfAbsent(globalIntent("chal_1", "a"), null));
      await asUser(USER, "b", r => r.createIfAbsent(globalIntent("chal_2", "b"), null));

      const rows = await owner.db.selectFrom("notification_intents")
        .select("notification_intent_id").execute();
      expect(rows).toHaveLength(2);
    });

    it("permits one delivery per intent and channel", async () => {
      // S195. The UNIQUE is what stops one decision producing two messages.
      const created = await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(workspaceIntent("grant_1", "a"), null));

      await expect(owner.db.insertInto("notification_deliveries").values({
        notification_delivery_id: "ndel_dup",
        notification_intent_id: created.intent.notificationIntentId,
        workspace_id: WS_A, user_id: null, channel: "EMAIL",
        destination: "alice@example.test", state: "PENDING",
        failure_code: null, created_at: new Date(AT),
      }).execute()).rejects.toThrow();
    });
  });

  describe("scope", () => {
    it("stores a global account notification with no workspace", async () => {
      // S273. No fake tenant, and the row is still readable by its owner.
      const created = await asUser(USER, "a",
        r => r.createIfAbsent(globalIntent("chal_1", "a"), null));

      expect(created.intent.scope).toEqual({ kind: "GLOBAL_USER", userId: USER });

      const row = await owner.db.selectFrom("notification_intents")
        .selectAll()
        .where("notification_intent_id", "=", created.intent.notificationIntentId)
        .executeTakeFirstOrThrow();
      expect(row.workspace_id).toBeNull();
      expect(row.user_id).toBe(USER);
    });

    it("refuses a row that claims both scopes", async () => {
      await expect(owner.db.insertInto("notification_intents").values({
        notification_intent_id: "nint_both",
        workspace_id: WS_A, user_id: USER,
        notification_type: "PASSWORD_RESET",
        source_kind: "SECURITY_CHALLENGE", source_id: "chal_x",
        audience_kind: "USER", audience_user_id: USER,
        audience_recipient_id: null, audience_invitation_id: null,
        template_key: "password-reset", template_version: 1, locale: "en",
        template_input: JSON.stringify({ recipientName: "M" }),
        secret_ref_kind: "CHALLENGE", sealed_secret: null,
        sealed_key_version: null, challenge_id: "chal_x",
        created_at: new Date(AT),
      }).execute()).rejects.toThrow();
    });

    it("refuses an audience kind that disagrees with its column", async () => {
      await expect(owner.db.insertInto("notification_intents").values({
        notification_intent_id: "nint_mismatch",
        workspace_id: WS_A, user_id: null,
        notification_type: "SIGNING_INVITATION",
        source_kind: "SIGNING_ACCESS_GRANT", source_id: "grant_x",
        // Claims USER while carrying a recipient id.
        audience_kind: "USER", audience_user_id: null,
        audience_recipient_id: "srr_a", audience_invitation_id: null,
        template_key: "signing-invitation", template_version: 1, locale: "en",
        template_input: JSON.stringify({}),
        secret_ref_kind: null, sealed_secret: null,
        sealed_key_version: null, challenge_id: null,
        created_at: new Date(AT),
      }).execute()).rejects.toThrow();
    });
  });

  describe("tenant isolation", () => {
    it("hides one workspace's notifications from another", async () => {
      const created = await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(workspaceIntent("grant_1", "a"), null));

      const seen = await inWorkspace(WS_B, "b",
        r => r.findIntentById(created.intent.notificationIntentId));

      expect(seen).toBeNull();
    });

    it("hides a global account notification from every workspace", async () => {
      // The two RLS predicates are disjoint: a workspace admin must not learn
      // that one of their members requested a password reset.
      const created = await asUser(USER, "a",
        r => r.createIfAbsent(globalIntent("chal_1", "a"), null));

      const seen = await inWorkspace(WS_A, "b",
        r => r.findIntentById(created.intent.notificationIntentId));

      expect(seen).toBeNull();
    });

    it("hides a workspace notification from a user context", async () => {
      const created = await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(workspaceIntent("grant_1", "a"), null));

      const seen = await asUser(USER, "b",
        r => r.findIntentById(created.intent.notificationIntentId));

      expect(seen).toBeNull();
    });
  });

  describe("audience integrity", () => {
    it("refuses an audience recipient from another workspace", async () => {
      // The compound FK is what makes a cross-tenant audience a constraint
      // violation rather than a review item (S272).
      await expect(owner.db.insertInto("notification_intents").values({
        notification_intent_id: "nint_crosstenant",
        workspace_id: WS_B, user_id: null,
        notification_type: "SIGNING_INVITATION",
        source_kind: "SIGNING_ACCESS_GRANT", source_id: "grant_x",
        audience_kind: "SIGNING_REQUEST_RECIPIENT", audience_user_id: null,
        // A recipient that exists, but in WS_A.
        audience_recipient_id: "srr_a", audience_invitation_id: null,
        template_key: "signing-invitation", template_version: 1, locale: "en",
        template_input: JSON.stringify({}),
        secret_ref_kind: null, sealed_secret: null,
        sealed_key_version: null, challenge_id: null,
        created_at: new Date(AT),
      }).execute()).rejects.toThrow(/foreign key|violates/iu);
    });

    it("refuses to delete a recipient with an outstanding notification", async () => {
      // RESTRICT. This restores, indirectly, what the retired table's grant FK
      // gave: the credential and the message carrying it cannot be separated.
      await inWorkspace(WS_A, "a", r => r.createIfAbsent(workspaceIntent("grant_1", "a"), null));

      await expect(
        sql`delete from signing_request_recipients where request_recipient_id = 'srr_a'`
          .execute(owner.db),
      ).rejects.toThrow(/foreign key|violates/iu);
    });
  });

  describe("immutability", () => {
    it("refuses an UPDATE on an intent under the runtime role", async () => {
      // S55. The grant was never issued, so immutability is enforced by
      // PostgreSQL rather than by every future writer remembering.
      const created = await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(workspaceIntent("grant_1", "a"), null));

      await expect(app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`.execute(trx);
        return sql`
          update notification_intents set locale = 'xx'
          where notification_intent_id = ${created.intent.notificationIntentId}
        `.execute(trx);
      })).rejects.toThrow();
    });

    it("keeps a destination frozen against an unrelated profile change", async () => {
      // S248, S250. Nothing re-reads the address, so nothing can redirect it.
      const created = await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(workspaceIntent("grant_1", "a", "alice@example.test"), null));

      await owner.db.updateTable("users")
        .set({ email: "changed@example.test", normalized_email: "changed@example.test" })
        .where("user_id", "=", USER).execute();

      const delivery = await inWorkspace(WS_A, "b",
        r => r.findDeliveryById(created.delivery.notificationDeliveryId));

      expect(delivery?.destination).toBe("alice@example.test");
    });
  });

  describe("claiming (BACKEND-45)", () => {
    const claimIn = async <T>(
      workspaceId: WorkspaceId,
      body: (repo: ReturnType<typeof createNotificationTransportRepository>) => Promise<T>,
    ): Promise<T> =>
      app.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${workspaceId}, true)`.execute(trx);
        return body(createNotificationTransportRepository(trx));
      });

    const claim = (attemptId: string, now = AT) => ({
      notificationDeliveryId: "ndel_a" as NotificationDeliveryId,
      attemptId: attemptId as NotificationDeliveryAttemptId,
      now,
      leaseMs: 60_000,
    });

    it("lets exactly one of two CONCURRENT workers claim a delivery", async () => {
      // S66, S128. The race a fake cannot model, and the reason the claim is
      // one conditional UPDATE rather than a read followed by a write.
      await inWorkspace(WS_A, "a", r => r.createIfAbsent(workspaceIntent("grant_1", "a"), null));

      const [first, second] = await Promise.all([
        claimIn(WS_A, r => r.claimForDelivery(claim("nda_1"), null)),
        claimIn(WS_A, r => r.claimForDelivery(claim("nda_2"), null)),
      ]);

      expect([first, second].filter(result => result !== null)).toHaveLength(1);
    });

    it("refuses to claim a cancelled delivery", async () => {
      const created = await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(workspaceIntent("grant_1", "a"), null));
      await inWorkspace(WS_A, "b", r => r.stopPendingDelivery(
        created.delivery.notificationDeliveryId, "CANCELLED", "SOURCE_CANCELLED", null));

      expect(await claimIn(WS_A, r => r.claimForDelivery(claim("nda_1"), null))).toBeNull();
    });

    it("burns an attempt on claim, not on completion", async () => {
      // A crash mid-send still consumes the budget. The alternative retries
      // forever against a provider that keeps timing out.
      await inWorkspace(WS_A, "a", r => r.createIfAbsent(workspaceIntent("grant_1", "a"), null));
      const claimed = await claimIn(WS_A, r => r.claimForDelivery(claim("nda_1"), null));

      expect(claimed?.attempt.attemptNumber).toBe(1);
      const row = await owner.db.selectFrom("notification_deliveries")
        .select(["attempt_count", "state"]).executeTakeFirstOrThrow();
      expect(row.attempt_count).toBe(1);
      expect(row.state).toBe("PROCESSING");
    });

    it("refuses a second completion of one attempt", async () => {
      // A retried job whose first pass succeeded after the connection dropped
      // must not write a second outcome over the first.
      await inWorkspace(WS_A, "a", r => r.createIfAbsent(workspaceIntent("grant_1", "a"), null));
      await claimIn(WS_A, r => r.claimForDelivery(claim("nda_1"), null));

      const complete = {
        notificationDeliveryId: "ndel_a" as NotificationDeliveryId,
        attemptId: "nda_1" as NotificationDeliveryAttemptId,
        outcome: "ACCEPTED" as const,
        providerMessageReference: "ref-1",
        nextState: "PROVIDER_ACCEPTED" as const,
        now: AT + 1_000,
      };

      expect(await claimIn(WS_A, r => r.completeAttempt(complete, null))).toBe(true);
      expect(await claimIn(WS_A, r => r.completeAttempt(complete, null))).toBe(false);
    });

    it("reclaims a lease its worker died holding", async () => {
      // S109. A process that dies between claim and completion leaves a row no
      // queue job revisits; the lease is what makes that recoverable.
      await inWorkspace(WS_A, "a", r => r.createIfAbsent(workspaceIntent("grant_1", "a"), null));
      await claimIn(WS_A, r => r.claimForDelivery(claim("nda_1"), null));

      const reclaimed = await claimIn(WS_A,
        r => r.reclaimExpiredLeases(AT + 120_000, 10, null));

      expect(reclaimed).toHaveLength(1);
      const row = await owner.db.selectFrom("notification_deliveries")
        .select(["state", "claim_expires_at"]).executeTakeFirstOrThrow();
      // FAILED_RETRYABLE, not PENDING: the attempt was made and its budget
      // consumed, and calling it pending would present a crashed send as work
      // that had never been tried.
      expect(row.state).toBe("FAILED_RETRYABLE");
      expect(row.claim_expires_at).toBeNull();
    });

    it("leaves a live lease alone", async () => {
      await inWorkspace(WS_A, "a", r => r.createIfAbsent(workspaceIntent("grant_1", "a"), null));
      await claimIn(WS_A, r => r.claimForDelivery(claim("nda_1"), null));

      expect(await claimIn(WS_A, r => r.reclaimExpiredLeases(AT + 1_000, 10, null)))
        .toHaveLength(0);
    });
  });

  describe("stopping a pending delivery", () => {
    it("cancels a PENDING delivery and refuses a second stop", async () => {
      const created = await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(workspaceIntent("grant_1", "a"), null));

      const first = await inWorkspace(WS_A, "b", r => r.stopPendingDelivery(
        created.delivery.notificationDeliveryId, "CANCELLED", "SOURCE_CANCELLED", null));
      const second = await inWorkspace(WS_A, "c", r => r.stopPendingDelivery(
        created.delivery.notificationDeliveryId, "CANCELLED", "SOURCE_CANCELLED", null));

      expect(first).toBe(true);
      // Conditional on still being PENDING, so it is not idempotently "true".
      expect(second).toBe(false);
    });

    it("finds a stranded PENDING delivery for reconciliation", async () => {
      // S262. The lost-enqueue case: the row exists and nothing will pick it up.
      await inWorkspace(WS_A, "a", r => r.createIfAbsent(workspaceIntent("grant_1", "a"), null));

      const stranded = await inWorkspace(WS_A, "b",
        r => r.findPendingDeliveries(AT + 1, 10));

      expect(stranded).toHaveLength(1);
      expect(stranded[0]?.state).toBe("PENDING");
    });
  });

  // -- The completion notification (BACKEND-38 Phase 2) ----------------------
  //
  // Every test here runs on the RUNTIME-ROLE connection, which is the lesson
  // migration 048 taught at production's expense: 047's suite connected as the
  // schema OWNER, owners are not subject to grants, and so a table the runtime
  // role could not read at all passed every test. This phase creates no new
  // table -- but it writes a new SHAPE of row through the same grants and the
  // same RLS policies, and only a runtime-role connection proves those admit
  // it.

  describe("completion notification", () => {
    it("accepts the new type and source kind through the CHECKs", async () => {
      // Migration 049 widened `notification_intents_type_check` and
      // `notification_intents_source_kind_check` by one value each. Asserted
      // by inserting, not by reading `pg_constraint`: a CHECK that parses is
      // not the same as a CHECK that admits the row the application writes.
      const result = await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(completionIntent("sr_na", "a"), null));

      expect(result.outcome).toBe("CREATED");

      const row = await owner.db.selectFrom("notification_intents")
        .select(["notification_type", "source_kind", "source_id", "template_key"])
        .executeTakeFirstOrThrow();
      expect(row.notification_type).toBe("SIGNING_COMPLETED");
      expect(row.source_kind).toBe("SIGNING_REQUEST");
      expect(row.source_id).toBe("sr_na");
      // No CHECK constrains the template key -- the registry in code is the
      // authority -- so this asserts the column round-trips, nothing more.
      expect(row.template_key).toBe("signing-completed");
    });

    it("persists an ABSENT secret as three NULL columns", async () => {
      // The all-null branch of `notification_intents_secret_ref_check`, which
      // migration 030 already permitted and nothing had ever used. If this
      // failed, the "optional rather than a NONE sentinel" decision would be
      // wrong and a schema change would be required after all.
      await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(completionIntent("sr_na", "a"), null));

      const row = await owner.db.selectFrom("notification_intents")
        .select([
          "secret_ref_kind", "sealed_secret", "sealed_key_version", "challenge_id",
        ])
        .executeTakeFirstOrThrow();

      expect(row.secret_ref_kind).toBeNull();
      expect(row.sealed_secret).toBeNull();
      expect(row.sealed_key_version).toBeNull();
      expect(row.challenge_id).toBeNull();
    });

    it("reads back with no secretRef rather than an empty one", async () => {
      // `deliverNotification` branches on `intent.secretRef === undefined` to
      // skip secret resolution entirely. If the repository mapped three NULLs
      // to a partially-populated object instead of absence, delivery would
      // call the resolver with a ref naming no credential.
      const created = await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(completionIntent("sr_na", "a"), null));

      expect(created.intent.secretRef).toBeUndefined();
    });

    it("admits a USER audience on a WORKSPACE-scoped row", async () => {
      // A new COMBINATION rather than a new value, and therefore worth
      // asserting: `notification_intents_audience_match` constrains only the
      // audience columns and `notification_intents_scope_check` only the scope
      // columns, so the two are independent -- but nothing had ever written a
      // row that relied on that independence.
      await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(completionIntent("sr_na", "a"), null));

      const row = await owner.db.selectFrom("notification_intents")
        .select([
          "audience_kind", "audience_user_id", "audience_recipient_id",
          "workspace_id", "user_id",
        ])
        .executeTakeFirstOrThrow();

      expect(row.audience_kind).toBe("USER");
      expect(row.audience_user_id).toBe(USER);
      expect(row.audience_recipient_id).toBeNull();
      // Workspace-scoped: filed under the tenant whose document it describes.
      expect(row.workspace_id).toBe(WS_A);
      expect(row.user_id).toBeNull();
    });

    it("resolves two CONCURRENT completion notifications to ONE", async () => {
      // THE test for this phase, and the reason the source key is the request
      // rather than the completion run.
      //
      // Phase 1 made a completion run re-drivable, so two workers can be
      // finalizing the same request at the same instant -- one re-driven from
      // the retry sweep, one from the original enqueue. Under a
      // read-then-insert both would read "absent" and both would insert, and
      // the sender would receive two emails saying the same document was
      // signed.
      //
      // `createIfAbsent` is INSERT ... ON CONFLICT DO NOTHING against
      // `notification_intents_logical_key`, so the second is refused by the
      // index itself. Two real connections, so this is a genuine race and not
      // a fake's interleaving.
      const [first, second] = await Promise.all([
        inWorkspace(WS_A, "a",
          r => r.createIfAbsent(completionIntent("sr_na", "a"), null)),
        inWorkspace(WS_A, "b",
          r => r.createIfAbsent(completionIntent("sr_na", "b"), null)),
      ]);

      expect([first.outcome, second.outcome].sort())
        .toEqual(["ALREADY_EXISTS", "CREATED"]);
      expect(first.intent.notificationIntentId)
        .toBe(second.intent.notificationIntentId);

      const intents = await owner.db.selectFrom("notification_intents")
        .select("notification_intent_id").execute();
      expect(intents).toHaveLength(1);

      // And exactly one delivery, which is what actually becomes an email.
      // One intent with two deliveries would still send twice.
      const deliveries = await owner.db.selectFrom("notification_deliveries")
        .select("notification_delivery_id").execute();
      expect(deliveries).toHaveLength(1);
    });

    it("does not collide with the INVITATION for the same request", async () => {
      // The logical key is (source_kind, source_id, notification_type), so a
      // completion notification and an invitation are distinct rows even when
      // the source ids coincide. Worth asserting, because a key of source_id
      // alone would silently suppress one of them.
      await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(workspaceIntent("sr_na", "a"), null));
      const completion = await inWorkspace(WS_A, "b",
        r => r.createIfAbsent(completionIntent("sr_na", "b"), null));

      expect(completion.outcome).toBe("CREATED");
      const rows = await owner.db.selectFrom("notification_intents")
        .select("notification_type").orderBy("notification_type").execute();
      expect(rows.map(row => row.notification_type))
        .toEqual(["SIGNING_COMPLETED", "SIGNING_INVITATION"]);
    });

    it("hides a completion notification from another tenant", async () => {
      // It is workspace-scoped, so the ordinary tenant policy applies. Not
      // taken on faith just because the other fixtures are covered: this row
      // has a USER audience, and a policy written against the audience rather
      // than the scope would leak it.
      await inWorkspace(WS_A, "a",
        r => r.createIfAbsent(completionIntent("sr_na", "a"), null));

      const fromB = await inWorkspace(WS_B, "b",
        r => r.findPendingDeliveries(AT + 1, 10));

      expect(fromB).toHaveLength(0);
    });

    it("keeps the TypeScript vocabulary and the CHECKs in step", async () => {
      // A drift guard, in the shape migration 044's regression test took.
      //
      // The failure it prevents: somebody adds a `NotificationType`, writes a
      // policy and a template, and forgets the migration. Everything compiles,
      // every unit test passes, and the first production send fails on a CHECK
      // constraint with the message already owed to somebody.
      //
      // So every value the code believes in is inserted for real. Reading
      // `pg_constraint` and comparing strings would be the weaker test: it
      // would pass against a constraint whose spelling matched but whose
      // semantics did not.
      const rejected: string[] = [];
      for (const [index, type] of NOTIFICATION_TYPES.entries()) {
        const attempt = await owner.db.transaction().execute(async trx => {
          await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`
            .execute(trx);
          // `notification_type` is the column under test; the rest of the row
          // is held at values the other CHECKs accept so that a failure can
          // only be the type check.
          return sql`
            insert into notification_intents (
              notification_intent_id, workspace_id, notification_type,
              source_kind, source_id, audience_kind, audience_user_id,
              template_key, template_version, locale, template_input,
              created_at
            ) values (
              ${'nint_v' + String(index)}, ${WS_A}, ${type},
              'SIGNING_REQUEST', ${'src_v' + String(index)}, 'USER', ${USER},
              'signing-completed', 1, 'en', ${'{}'},
              now()
            )
          `.execute(trx).then(() => null, (error: unknown) => String(error));
        });
        if (attempt !== null) rejected.push(`${type}: ${attempt}`);
      }
      expect(rejected).toEqual([]);

      // The same in the other direction for source kinds.
      const rejectedSources: string[] = [];
      for (const [index, kind] of NOTIFICATION_SOURCE_KINDS.entries()) {
        const attempt = await owner.db.transaction().execute(async trx => {
          await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`
            .execute(trx);
          return sql`
            insert into notification_intents (
              notification_intent_id, workspace_id, notification_type,
              source_kind, source_id, audience_kind, audience_user_id,
              template_key, template_version, locale, template_input,
              created_at
            ) values (
              ${'nint_s' + String(index)}, ${WS_A}, 'SIGNING_COMPLETED',
              ${kind}, ${'src_s' + String(index)}, 'USER', ${USER},
              'signing-completed', 1, 'en', ${'{}'},
              now()
            )
          `.execute(trx).then(() => null, (error: unknown) => String(error));
        });
        if (attempt !== null) rejectedSources.push(`${kind}: ${attempt}`);
      }
      expect(rejectedSources).toEqual([]);
    });

    it("still refuses a type the code does not know", async () => {
      // The other half of the drift guard. If 049 had dropped the CHECK
      // instead of widening it, every test above would pass and the column
      // would accept anything.
      const failure = await owner.db.transaction().execute(async trx => {
        await sql`select set_config('lagda.workspace_id', ${WS_A}, true)`
          .execute(trx);
        return sql`
          insert into notification_intents (
            notification_intent_id, workspace_id, notification_type,
            source_kind, source_id, audience_kind, audience_user_id,
            template_key, template_version, locale, template_input,
            created_at
          ) values (
            'nint_bogus', ${WS_A}, 'SIGNING_ALMOST_COMPLETED',
            'SIGNING_REQUEST', 'src_bogus', 'USER', ${USER},
            'signing-completed', 1, 'en', '{}', now()
          )
        `.execute(trx).then(() => null, (error: unknown) => error);
      }).catch((error: unknown) => error);

      expect(String(failure)).toMatch(/notification_intents_type_check/u);
    });
  });

  // -- The transaction boundary --------------------------------------------
  //
  // The two properties BACKEND-38 Phase 2 has to hold simultaneously, proven
  // against real PostgreSQL through the REAL producer and a REAL workspace
  // transaction rather than a fake:
  //
  //   1. A successful completion notification must never exist for a signing
  //      request whose finalization transaction ultimately rolled back.
  //   2. A committed transaction must not lose the notification merely because
  //      an email provider later failed.
  //
  // Those pull in opposite directions, and the resolution is that what the
  // transaction writes is an INTENT, not an email. (1) holds because the
  // intent shares the transaction. (2) holds because nothing in that
  // transaction talks to a provider, so there is no provider failure it could
  // be sensitive to -- transport is a separate, separately-retried process
  // reading the committed row.
  //
  // `runForWorkspace` is the same transaction helper `final-seal.ts` uses, and
  // the producer is the same function it calls, so what is exercised here is
  // the real composition and not a restatement of it.

  describe("transaction boundary", () => {
    const produce = createCompletionNotificationProducer({
      templates: createTemplateRegistry(ALL_TEMPLATES),
      ids: {
        nextNotificationIntentId: () => `nint_${String(minted++)}` as NotificationIntentId,
        nextNotificationDeliveryId: () => `ndel_${String(minted++)}` as NotificationDeliveryId,
      },
      clock: { now: () => AT },
    });

    /** The producer's input, as `final-seal.ts` assembles it. */
    const input = {
      signingRequestId: "sr_na" as SigningRequestId,
      workspaceId: WS_A,
      senderUserId: USER,
      senderEmail: "sender@example.test",
      documentTitle: "Lease Agreement",
      signerCount: 2,
    };

    /**
     * Runs the producer in a real workspace transaction on the runtime-role
     * connection, optionally failing AFTER it -- which is what a refused
     * `markCompleted` or any later statement in the finalization transaction
     * amounts to.
     */
    const finalize = async (options: { thenFail: boolean }): Promise<void> => {
      const transactions = createTransactionManager(app.db);
      await transactions.runForWorkspace(WS_A, async uow => {
        await produce(input, {
          notifications: uow.notifications,
          workspaces: uow.workspaces,
          actorProfiles: uow.actorProfiles,
        }, uow);
        if (options.thenFail) {
          // Stands in for the real transaction's own later failure. The
          // producer has already returned successfully at this point, so the
          // intent row EXISTS inside the transaction -- which is precisely
          // the state the rollback has to undo.
          throw new Error("finalization failed after the intent was written");
        }
      });
    };

    // `destination` lives on the DELIVERY, not the intent -- the intent holds
    // the audience (an identity), and the address is transport's business.
    const intentRows = () => owner.db.selectFrom("notification_intents")
      .select(["notification_intent_id", "notification_type"])
      .execute();

    it("writes the intent when the transaction COMMITS", async () => {
      await finalize({ thenFail: false });

      const rows = await intentRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.notification_type).toBe("SIGNING_COMPLETED");
    });

    it("leaves NO intent when the transaction rolls back", async () => {
      // The requirement stated as a test. Note what is being ruled out: not
      // "the producer refused", but "the producer succeeded and the row still
      // does not exist". A notification claiming a document was signed, for a
      // request that never completed, is a lie the system must not be able to
      // tell.
      await expect(finalize({ thenFail: true }))
        .rejects.toThrow("finalization failed");

      expect(await intentRows()).toHaveLength(0);
      // And no orphaned delivery either -- both rows are written by the same
      // `createIfAbsent` call and must roll back together.
      const deliveries = await owner.db.selectFrom("notification_deliveries")
        .select("notification_delivery_id").execute();
      expect(deliveries).toHaveLength(0);
    });

    it("produces exactly ONE intent when a rolled-back attempt is retried", async () => {
      // The Phase 1 interaction, and the sequence a real retryable failure
      // takes: the run fails after the intent was written, parks in
      // `waiting-retry`, the sweep re-drives it, and the second attempt
      // succeeds. The sender must receive one email, not zero and not two.
      await expect(finalize({ thenFail: true })).rejects.toThrow();
      await finalize({ thenFail: false });

      expect(await intentRows()).toHaveLength(1);
    });

    it("produces exactly ONE intent when a COMMITTED run is re-driven", async () => {
      // The other Phase 1 interaction: the run committed but its outcome was
      // lost, so the sweep re-drives it and the finalization transaction runs
      // again. `createIfAbsent`'s ON CONFLICT against the logical key is what
      // makes the second pass a no-op -- not a check in the producer.
      await finalize({ thenFail: false });
      await finalize({ thenFail: false });
      await finalize({ thenFail: false });

      const rows = await intentRows();
      expect(rows).toHaveLength(1);

      const deliveries = await owner.db.selectFrom("notification_deliveries")
        .select("notification_delivery_id").execute();
      expect(deliveries).toHaveLength(1);
    });

    it("addresses the SENDER's account, not a recipient of the request", async () => {
      // `sr_na`'s only recipient is maria@example.test. A completion
      // notification that reused the recipient's address -- the address every
      // other notification about this request uses -- would tell the
      // counterparty about the sender's document and tell the sender nothing.
      await finalize({ thenFail: false });

      const delivery = await owner.db.selectFrom("notification_deliveries")
        .select("destination").executeTakeFirstOrThrow();
      expect(delivery.destination).toBe("sender@example.test");
      expect(delivery.destination).not.toBe("maria@example.test");
    });

    it("leaves a delivery PENDING for transport to pick up later", async () => {
      // Property (2). The transaction commits having contacted no provider, so
      // the message survives a provider that is down at this instant: the row
      // is PENDING and the dispatch sweep owns it from here.
      await finalize({ thenFail: false });

      const delivery = await owner.db.selectFrom("notification_deliveries")
        .select(["state", "attempt_count", "destination"])
        .executeTakeFirstOrThrow();

      expect(delivery.state).toBe("PENDING");
      expect(delivery.attempt_count).toBe(0);
      expect(delivery.destination).toBe("sender@example.test");
    });

    it("becomes DISPATCHABLE work the sweep can find across tenants", async () => {
      // The last link in the chain, and the one that turns property (2) from a
      // claim into a fact. A committed intent only survives a provider outage
      // if something outside the workspace is looking for it: a completion
      // happens in a worker with no tenant context, and
      // `notification_deliveries` cannot be scanned across tenants without
      // BYPASSRLS.
      //
      // Migration 034's trigger is unconditional on insert, so it indexes this
      // row like any other — but "unconditional" was read, not proven, and a
      // delivery that never reached the index would sit forever while every
      // other test in this file still passed.

      // Asserted through the repository the sweep actually calls, not by
      // reading the column. `next_attempt_at` is NULL on a never-attempted
      // delivery, so a test that checked for a due DATE would have failed
      // while the system worked — and one that checked the row merely exists
      // would pass even if `listDue` filtered it out. What matters is that
      // the sweep RETURNS it.
      await finalize({ thenFail: false });

      const due = await createTransactionManager(app.db)
        .runGlobal(uow => uow.notificationDispatch.listDue(AT + 1, 10));

      expect(due).toHaveLength(1);
      // Scoped to the workspace, and found with NO tenant context at all —
      // the index carries no policy, which is the whole reason it exists: a
      // completion happens in a worker that has no workspace in hand.
      expect(due[0]?.scope).toEqual({ kind: "WORKSPACE", workspaceId: WS_A });

      const row = await owner.db.selectFrom("notification_dispatch_index")
        .select(["state", "next_attempt_at"]).executeTakeFirstOrThrow();
      expect(row.state).toBe("PENDING");
      // NULL is what "never attempted" looks like, and `listDue` treats it as
      // due immediately rather than coalescing it to an epoch date.
      expect(row.next_attempt_at).toBeNull();
    });

    it("leaves no dispatchable work when the transaction rolls back", async () => {
      // The index is maintained by a trigger, and a trigger fires inside the
      // statement's transaction — so it must roll back with it. If it did not,
      // the sweep would find a row pointing at a delivery that does not exist.
      await expect(finalize({ thenFail: true })).rejects.toThrow();

      const indexed = await owner.db.selectFrom("notification_dispatch_index")
        .select("notification_delivery_id").execute();
      expect(indexed).toHaveLength(0);
    });

    it("writes nothing a sender is not entitled to see", async () => {
      // The disclosure check, against the row as actually persisted. None of
      // the signer's bearer token, session credentials, raw signature data or
      // the counterparty's address belongs in a message to the sender.
      await finalize({ thenFail: false });

      const row = await owner.db.selectFrom("notification_intents")
        .selectAll().executeTakeFirstOrThrow();
      const delivery = await owner.db.selectFrom("notification_deliveries")
        .selectAll().executeTakeFirstOrThrow();
      // Both rows, because the address is on one and the payload on the other.
      const serialized = JSON.stringify(row) + JSON.stringify(delivery);

      expect(row.secret_ref_kind).toBeNull();
      expect(row.sealed_secret).toBeNull();
      expect(row.challenge_id).toBeNull();
      // The recipient's address appears nowhere in the intent.
      expect(serialized).not.toContain("maria@example.test");
      // No URL, so no hostname is frozen onto a durable row (S147).
      expect(serialized).not.toContain("http");
    });
  });
});
