// Template content autosave (088) against REAL PostgreSQL, as the RUNTIME role.
//
// What only this suite can prove:
//
//   1. The draft, its revision and the generated marker PERSIST through the
//      real repository, and a generate supersedes the draft.
//   2. The optimistic-concurrency check is ONE conditional UPDATE: two saves
//      racing from the same base cannot both win.
//   3. RLS still covers the new columns — a save scoped to another workspace
//      touches nothing, and an unpredicated raw UPDATE cannot reach it either.
//   4. The CHECK constraints hold, TRUNCATE is not the runtime role's, and the
//      migration goes down and back up, backfilling an already-generated row.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { UserId, WorkspaceId, WorkspaceMemberId, FlowDocument } from "@lagda/contracts";
import { type LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import { migrateDown, migrateToLatest, migrationStatus } from "./migrations/runner.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll,
  hasIntegrationDatabase, seedUser, withRawTenantTransaction,
} from "./testing/harness.js";

const AT = Date.parse("2026-09-27T09:00:00.000Z");
const USER = "usr_wftc" as UserId;
const WS_A = "ws_wftc_a" as WorkspaceId;
const WS_B = "ws_wftc_b" as WorkspaceId;

const SLOTS = [
  { slotId: "wfs_a", label: "Employee", role: "signer", required: true, routingStep: 1, defaultAuthMethod: "none" },
] as const;

const doc = (text: string): FlowDocument => ({
  kind: "flowDocument",
  content: [{ kind: "paragraph", content: [{ kind: "text", text }] }],
});

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("workflow template content autosave (088, runtime role)", () => {
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
    for (const [id, member] of [[WS_A, "mem_wca"], [WS_B, "mem_wcb"]] as const) {
      await tx.runForWorkspace(id, async uow => {
        await uow.workspaces.insert({ workspaceId: id, name: `WS ${id}`, createdAt: AT });
        await uow.memberships.insert({
          memberId: member as WorkspaceMemberId, workspaceId: id,
          userId: USER, role: "owner", createdAt: AT,
        });
      });
    }
  });

  const tx = () => createTransactionManager(app.db);

  const insert = (workspaceId: WorkspaceId, workflowTemplateId: string) =>
    tx().runForWorkspace(workspaceId, uow => uow.workflowTemplates.insert({
      workflowTemplateId, workspaceId, name: workflowTemplateId,
      routingMode: "sequential", roleSlots: [...SLOTS],
      completionSettings: { notifySenderOnComplete: true }, variables: [],
      createdBy: USER, createdAt: AT,
    }));

  const find = (workspaceId: WorkspaceId, id: string) =>
    tx().runForWorkspace(workspaceId, uow => uow.workflowTemplates.find(id));

  const save = (workspaceId: WorkspaceId, id: string, text: string, baseRevision: number | null, savedAt = AT + 1_000) =>
    tx().runForWorkspace(workspaceId, uow => uow.workflowTemplates.saveDraftContent(id, {
      document: doc(text), baseRevision, savedAt,
    }));

  it("starts at revision 0 with no draft, never generated, saved at creation", async () => {
    await insert(WS_A, "wft_1");
    const row = await find(WS_A, "wft_1");
    expect(row).toMatchObject({
      draftContent: null, contentRevision: 0, contentGeneratedRevision: null, contentSavedAt: AT,
    });
  });

  it("persists a draft without touching content, page count or updatedAt", async () => {
    await insert(WS_A, "wft_1");
    const saved = await save(WS_A, "wft_1", "typed", 0, AT + 5_000);
    expect(saved).toEqual({ kind: "saved", contentRevision: 1, contentGeneratedRevision: null });

    const row = await find(WS_A, "wft_1");
    expect(row?.draftContent).toEqual(doc("typed"));
    expect(row?.content).toEqual({ kind: "flowDocument", content: [] });
    expect(row?.contentRevision).toBe(1);
    expect(row?.contentSavedAt).toBe(AT + 5_000);
    expect(row?.contentPageCount).toBe(0);
    expect(row?.updatedAt).toBe(AT);
  });

  it("refuses a stale base with the current revision, and an unknown id as not-found", async () => {
    await insert(WS_A, "wft_1");
    await save(WS_A, "wft_1", "one", 0);
    expect(await save(WS_A, "wft_1", "two", 0)).toEqual({ kind: "conflict", currentRevision: 1 });
    expect((await find(WS_A, "wft_1"))?.draftContent).toEqual(doc("one"));
    expect(await save(WS_A, "wft_missing", "x", null)).toEqual({ kind: "not-found" });
    // No base: unconditional.
    expect(await save(WS_A, "wft_1", "three", null)).toMatchObject({ kind: "saved", contentRevision: 2 });
  });

  it("lets exactly ONE of two racing saves from the same base win", async () => {
    await insert(WS_A, "wft_1");
    const results = await Promise.all([
      save(WS_A, "wft_1", "tab one", 0),
      save(WS_A, "wft_1", "tab two", 0),
    ]);
    const kinds = results.map(r => r.kind).sort();
    expect(kinds).toEqual(["conflict", "saved"]);
    expect((await find(WS_A, "wft_1"))?.contentRevision).toBe(1);
  });

  it("a generate supersedes the draft, bumps the revision and marks it generated", async () => {
    await insert(WS_A, "wft_1");
    await save(WS_A, "wft_1", "draft", 0);
    await tx().runForWorkspace(WS_A, uow => uow.workflowTemplates.saveContent("wft_1", {
      document: doc("rendered"), pageCount: 2, updatedAt: AT + 9_000,
    }));

    const row = await find(WS_A, "wft_1");
    expect(row).toMatchObject({
      draftContent: null, content: doc("rendered"), contentPageCount: 2,
      contentRevision: 2, contentGeneratedRevision: 2, contentSavedAt: AT + 9_000,
    });

    // A draft after it leaves the generated marker behind.
    expect(await save(WS_A, "wft_1", "edited", 2)).toEqual({
      kind: "saved", contentRevision: 3, contentGeneratedRevision: 2,
    });
  });

  it("does not reach another workspace's template — through the repository or raw SQL", async () => {
    await insert(WS_A, "wft_1");
    expect(await save(WS_B, "wft_1", "hijack", null)).toEqual({ kind: "not-found" });

    // No predicate at all: only RLS can refuse this.
    const result = await withRawTenantTransaction(app, WS_B, trx =>
      trx.updateTable("workspace_workflow_templates")
        .set({ draft_content: JSON.stringify(doc("hijack")), content_revision: 99 })
        .executeTakeFirst());
    expect(Number(result.numUpdatedRows)).toBe(0);

    const row = await find(WS_A, "wft_1");
    expect(row).toMatchObject({ draftContent: null, contentRevision: 0 });
  });

  it("enforces the CHECK constraints", async () => {
    await insert(WS_A, "wft_1");
    const attempt = (set: Record<string, unknown>) => withRawTenantTransaction(app, WS_A, trx =>
      trx.updateTable("workspace_workflow_templates").set(set as never)
        .where("workflow_template_id", "=", "wft_1").execute());

    await expect(attempt({ draft_content: JSON.stringify([1, 2]) })).rejects.toThrow();
    await expect(attempt({ content_revision: -1 })).rejects.toThrow();
    await expect(attempt({ content_generated_revision: 1 })).rejects.toThrow();
    await expect(attempt({ content_saved_at: null })).rejects.toThrow();
  });

  it("keeps RLS forced and TRUNCATE away from the runtime role", async () => {
    const flags = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      select relrowsecurity, relforcerowsecurity
        from pg_class where relname = 'workspace_workflow_templates'
    `.execute(owner.db);
    expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const privileges = await sql<{ truncate: boolean; update: boolean; delete: boolean }>`
      select has_table_privilege('lagda_app', 'workspace_workflow_templates', 'TRUNCATE') as truncate,
             has_table_privilege('lagda_app', 'workspace_workflow_templates', 'UPDATE') as update,
             has_table_privilege('lagda_app', 'workspace_workflow_templates', 'DELETE') as delete
    `.execute(owner.db);
    // DELETE stays: templates are really deleted (058).
    expect(privileges.rows[0]).toEqual({ truncate: false, update: true, delete: true });
  });

  it("goes down and back up, backfilling an already-generated template", async () => {
    await insert(WS_A, "wft_generated");
    await insert(WS_A, "wft_plain");

    // Later migrations (092 … 089) come off first; they are empty here.
    for (const name of ["092_contact_deletion", "091_contact_connections", "090_user_notification_states", "089_invitation_inbox"]) {
      const later = await migrateDown(owner.db);
      expect(later.error).toBeUndefined();
      expect(later.applied).toEqual([name]);
    }
    const down = await migrateDown(owner.db);
    expect(down.error).toBeUndefined();
    expect(down.applied).toEqual(["088_workflow_template_content_autosave"]);

    const columns = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
       where table_name = 'workspace_workflow_templates'
         and column_name in ('draft_content', 'content_revision', 'content_saved_at', 'content_generated_revision')
    `.execute(owner.db);
    expect(columns.rows).toEqual([]);

    // A row generated before 088 existed.
    await sql`
      update workspace_workflow_templates
         set content_page_count = 3, updated_at = ${new Date(AT + 60_000)}
       where workflow_template_id = 'wft_generated'
    `.execute(owner.db);

    const up = await migrateToLatest(owner.db);
    expect(up.error).toBeUndefined();
    expect((await migrationStatus(owner.db)).every(s => s.applied)).toBe(true);

    expect(await find(WS_A, "wft_generated")).toMatchObject({
      draftContent: null, contentRevision: 0, contentGeneratedRevision: 0, contentSavedAt: AT + 60_000,
    });
    expect(await find(WS_A, "wft_plain")).toMatchObject({
      contentRevision: 0, contentGeneratedRevision: null, contentSavedAt: AT,
    });
  });
});
