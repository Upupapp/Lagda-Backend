// The workspace usage summary on real PostgreSQL, as the runtime role.
//
// Two workspaces with deliberately different rows, so every count is proved
// to be the asking workspace's own: a predicate that leaked across tenants
// would change a number here. And the repository is also run for workspace A
// from INSIDE workspace B's tenant context, where row-level security alone
// must hide every row of A.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { DocumentId, UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import {
  getWorkspaceUsage,
  type ArtifactId, type PreparationId, type AuthenticatedActor, type SessionId,
} from "@lagda/application";
import { FixedClock } from "@lagda/application/test-support";
import type { LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import { createScopedWorkspaceUsageRepository } from "./repositories/workspace-usage.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll,
  hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const NOW = Date.parse("2026-09-26T10:00:00.000Z");
const SEPT = new Date("2026-09-05T08:00:00.000Z");
const AUG = new Date("2026-08-20T08:00:00.000Z");
const OCT = new Date("2026-10-01T00:00:00.000Z"); // the first instant AFTER the period
const OWNER = "usr_usage_owner" as UserId;
const MEMBER = "usr_usage_member" as UserId;
const OUTSIDER = "usr_usage_outsider" as UserId;
const WS_A = "ws_usage_a" as WorkspaceId;
const WS_B = "ws_usage_b" as WorkspaceId;
const DIGEST = "e".repeat(64);

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_usage" as SessionId,
});

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("workspace usage (runtime role)", () => {
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

  /** A document, with one artifact of `size` bytes and a preparation. */
  const seedDocument = async (
    ws: WorkspaceId, documentId: string, createdAt: Date, size: number,
  ) => {
    await createTransactionManager(owner.db).runForWorkspace(ws, async uow => {
      await uow.documents.insert({
        documentId: documentId as DocumentId, workspaceId: ws, title: "Lease",
        originalFilename: null, createdByUserId: OWNER, createdAt: createdAt.getTime(),
      });
      await uow.artifacts.insert({
        artifactId: `art_${documentId}` as ArtifactId, workspaceId: ws,
        documentId: documentId as DocumentId, artifactType: "original",
        storageReference: `${ws}/${documentId}/art` as never,
        mediaType: "application/pdf", sizeBytes: size,
        digestAlgorithm: "sha-256", digest: DIGEST as never,
        pageCount: 1, rotatedPageCount: 0, createdAt: createdAt.getTime(),
      });
      await uow.preparations.insert({
        preparationId: `prep_${documentId}` as PreparationId, workspaceId: ws,
        documentId: documentId as DocumentId, sourceArtifactId: `art_${documentId}`,
        createdAt: createdAt.getTime(),
      });
    });
  };

  /** A signing request in a given state, written raw: this suite counts, it does not send. */
  const seedRequest = async (
    ws: WorkspaceId, id: string, documentId: string,
    state: string, at: { sent?: Date; completed?: Date; terminated?: Date } = {},
  ) => {
    await owner.db.insertInto("signing_requests").values({
      signing_request_id: id, workspace_id: ws, document_id: documentId,
      source_artifact_id: `art_${documentId}`, source_preparation_id: `prep_${documentId}`,
      source_preparation_revision: 1, state, document_title: "Lease",
      created_by_user_id: OWNER, created_at: AUG, updated_at: AUG,
      sent_at: at.sent ?? null,
      completed_at: at.completed ?? null,
      completion_ready_at: state === "completion-ready" ? (at.sent ?? SEPT) : null,
      terminated_at: at.terminated ?? null,
      termination_reason: at.terminated === undefined ? null : state,
    }).execute();
  };

  const seedContact = async (
    ws: WorkspaceId, id: string, scope: "workspace" | "personal",
    ownerUserId: UserId | null, archived = false,
  ) => {
    await owner.db.insertInto("contacts").values({
      contact_id: id, workspace_id: ws, name: "Maria", email: `${id}@example.test`,
      normalized_contact_email: `${id}@example.test`, phone: null, organization: null, title: null,
      created_at: AUG, updated_at: AUG, archived_at: archived ? SEPT : null,
      scope, owner_user_id: ownerUserId, note: null,
    }).execute();
  };

  const seedTemplate = async (ws: WorkspaceId, id: string) => {
    await owner.db.insertInto("workspace_workflow_templates").values({
      workflow_template_id: id, workspace_id: ws, name: `NDA ${id}`, routing_mode: "parallel",
      role_slots: JSON.stringify([{ slotId: "s1", label: "Signer" }]),
      completion_notification_settings: JSON.stringify({}),
      created_by: OWNER, created_at: AUG, updated_at: AUG,
      document_id: null, source_artifact_id: null,
      variables: JSON.stringify([]), content_blocks: JSON.stringify([]),
      content_page_count: 0, content: JSON.stringify({ kind: "flowDocument", content: [] }),
    }).execute();
  };

  beforeEach(async () => {
    await truncateAll(owner);
    for (const user of [OWNER, MEMBER, OUTSIDER]) await seedUser(owner, user);

    const tx = createTransactionManager(owner.db);
    await tx.runForWorkspace(WS_A, async uow => {
      await uow.workspaces.insert({ workspaceId: WS_A, name: "A Legal", createdAt: NOW });
      await uow.memberships.insert({
        memberId: "mem_ua_owner" as WorkspaceMemberId, workspaceId: WS_A,
        userId: OWNER, role: "owner", createdAt: NOW,
      });
      await uow.memberships.insert({
        memberId: "mem_ua_member" as WorkspaceMemberId, workspaceId: WS_A,
        userId: MEMBER, role: "member", createdAt: NOW,
      });
    });
    await tx.runForWorkspace(WS_B, async uow => {
      await uow.workspaces.insert({ workspaceId: WS_B, name: "B Legal", createdAt: NOW });
      await uow.memberships.insert({
        memberId: "mem_ub_outsider" as WorkspaceMemberId, workspaceId: WS_B,
        userId: OUTSIDER, role: "owner", createdAt: NOW,
      });
    });

    // ── Workspace A ──────────────────────────────────────────────────────
    await seedDocument(WS_A, "doc_a1", SEPT, 1000);   // this month
    await seedDocument(WS_A, "doc_a2", AUG, 500);     // last month
    await seedDocument(WS_A, "doc_a3", SEPT, 250);    // this month, then deleted
    await seedDocument(WS_A, "doc_a4", OCT, 1);       // next month (boundary)
    await owner.db.updateTable("documents").set({ deleted_at: SEPT })
      .where("document_id", "=", "doc_a3").execute();

    await seedRequest(WS_A, "sr_a_draft", "doc_a1", "draft");
    await seedRequest(WS_A, "sr_a_sent", "doc_a1", "sent", { sent: SEPT });
    await seedRequest(WS_A, "sr_a_partial", "doc_a1", "partially-completed", { sent: SEPT });
    await seedRequest(WS_A, "sr_a_ready", "doc_a2", "completion-ready", { sent: AUG });
    await seedRequest(WS_A, "sr_a_done_sept", "doc_a2", "completed", { sent: AUG, completed: SEPT });
    await seedRequest(WS_A, "sr_a_done_aug", "doc_a2", "completed", { sent: AUG, completed: AUG });
    await seedRequest(WS_A, "sr_a_declined", "doc_a1", "declined", { sent: SEPT, terminated: SEPT });

    await seedContact(WS_A, "con_a_shared", "workspace", null);
    await seedContact(WS_A, "con_a_archived", "workspace", null, true);
    await seedContact(WS_A, "con_a_mine", "personal", OWNER);
    await seedContact(WS_A, "con_a_theirs", "personal", MEMBER);

    await seedTemplate(WS_A, "wft_a1");
    await seedTemplate(WS_A, "wft_a2");

    // ── Workspace B ──────────────────────────────────────────────────────
    await seedDocument(WS_B, "doc_b1", SEPT, 7);
    await seedRequest(WS_B, "sr_b_sent", "doc_b1", "sent", { sent: SEPT });
    await seedContact(WS_B, "con_b_shared", "workspace", null);
  });

  const deps = () => ({ transactions: createTransactionManager(app.db), clock: new FixedClock(NOW) });

  it("counts workspace A's own rows for the current UTC month", async () => {
    const usage = await getWorkspaceUsage(actor(OWNER), WS_A, deps());
    expect(usage).toEqual({
      period: {
        start: Date.parse("2026-09-01T00:00:00.000Z"),
        end: Date.parse("2026-10-01T00:00:00.000Z") - 1,
      },
      // a1, a2, a4 live; a1 and a3 created in September (a4 is October's).
      documents: { total: 3, uploadedThisMonth: 2 },
      signingRequests: {
        sentThisMonth: 3,        // sent, partial, declined
        sentTotal: 6,            // every one but the draft
        inProgress: 3,           // sent, partial, completion-ready
        completedThisMonth: 1,
        completedTotal: 2,
      },
      members: 2,
      templates: 2,
      // Shared + the owner's own personal; not archived, not the member's personal.
      contacts: 2,
      verificationsThisMonth: 0,
      storageBytes: 1000 + 500 + 250 + 1,
    });
  });

  it("counts the caller's own personal contacts, not another member's", async () => {
    expect((await getWorkspaceUsage(actor(MEMBER), WS_A, deps())).contacts).toBe(2);
  });

  it("counts workspace B's own rows, untouched by A's", async () => {
    const usage = await getWorkspaceUsage(actor(OUTSIDER), WS_B, deps());
    expect(usage).toMatchObject({
      documents: { total: 1, uploadedThisMonth: 1 },
      signingRequests: {
        sentThisMonth: 1, sentTotal: 1, inProgress: 1, completedThisMonth: 0, completedTotal: 0,
      },
      members: 1, templates: 0, contacts: 1, storageBytes: 7,
    });
  });

  it("refuses a caller who is not a member of the workspace", async () => {
    await expect(getWorkspaceUsage(actor(OUTSIDER), WS_A, deps())).rejects.toThrow();
  });

  it("row-level security alone hides A from a transaction in B's tenant context", async () => {
    const counts = await app.db.transaction().execute(async trx => {
      await sql`select set_config('lagda.workspace_id', ${WS_B}, true)`.execute(trx);
      return createScopedWorkspaceUsageRepository(trx, WS_A).summarize({
        periodStart: Date.parse("2026-09-01T00:00:00.000Z"),
        periodEndExclusive: Date.parse("2026-10-01T00:00:00.000Z"),
        callerUserId: OWNER,
      });
    });
    expect(counts).toEqual({
      documents: { total: 0, uploadedThisMonth: 0 },
      signingRequests: { sentThisMonth: 0, sentTotal: 0, inProgress: 0, completedThisMonth: 0, completedTotal: 0 },
      members: 0, templates: 0, contacts: 0, storageBytes: 0,
    });
  });
});
