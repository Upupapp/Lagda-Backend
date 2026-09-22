// Workflow templates against REAL PostgreSQL, as the RUNTIME role.
//
// As `lagda_app`, not as the table owner — an owner bypasses RLS unless FORCE
// is set, and a suite that connected as `postgres` would pass while production
// leaked.
//
// What only this suite can prove:
//
//   1. Tenant isolation is PostgreSQL's, not a WHERE clause the repository
//      happens to include. The decisive test writes a row for workspace B
//      while the transaction is scoped to A and watches the database refuse.
//   2. The runtime role genuinely CAN delete a template — the one place this
//      schema departs from contacts, and a claim worth proving rather than
//      asserting in a comment.
//   3. The check constraints behave as migration 058 describes: the routing
//      mode is closed, a blank name is refused, and an empty slot array is
//      refused even though the application would have refused it first.
//   4. The name index is per workspace and case-insensitive.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "kysely";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type { NewWorkflowTemplate } from "@lagda/application";
import { type LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll,
  hasIntegrationDatabase, seedUser,
  withRawTenantTransaction, withRawGlobalTransaction,
} from "./testing/harness.js";

const AT = Date.parse("2026-09-22T09:00:00.000Z");
const USER = "usr_wft" as UserId;
const WS_A = "ws_wft_a" as WorkspaceId;
const WS_B = "ws_wft_b" as WorkspaceId;

const SLOTS = [
  { slotId: "wfs_a", label: "HR Approver", role: "approver", required: true, routingStep: 1, defaultAuthMethod: "none" },
  { slotId: "wfs_b", label: "Employee", role: "signer", required: true, routingStep: 2, defaultAuthMethod: "none" },
] as const;

const SETTINGS = { notifySenderOnComplete: true } as const;

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("workflow templates (RLS, runtime role)", () => {
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
    for (const [id, member] of [[WS_A, "mem_wa"], [WS_B, "mem_wb"]] as const) {
      await tx.runForWorkspace(id, async uow => {
        await uow.workspaces.insert({ workspaceId: id, name: `WS ${id}`, createdAt: AT });
        await uow.memberships.insert({
          memberId: member as WorkspaceMemberId, workspaceId: id,
          userId: USER, role: "owner", createdAt: AT,
        });
      });
    }
  });

  const insert = (
    workspaceId: WorkspaceId,
    workflowTemplateId: string,
    over: Partial<{ name: string; routingMode: NewWorkflowTemplate["routingMode"] }> = {},
  ) => createTransactionManager(app.db).runForWorkspace(workspaceId, uow =>
    uow.workflowTemplates.insert({
      workflowTemplateId,
      workspaceId,
      name: over.name ?? workflowTemplateId,
      routingMode: over.routingMode ?? "approval-based",
      roleSlots: [...SLOTS],
      completionSettings: SETTINGS,
      createdBy: USER,
      createdAt: AT,
    }));

  // ── Tenancy ───────────────────────────────────────────────────────────────

  describe("row-level security", () => {
    it("hides another workspace's template from a list", async () => {
      await insert(WS_A, "wft_a");
      const seen = await createTransactionManager(app.db)
        .runForWorkspace(WS_B, uow => uow.workflowTemplates.list());
      expect(seen).toHaveLength(0);
    });

    it("hides it from a direct lookup by id", async () => {
      // The id is not a secret. Knowing it must still not be enough.
      await insert(WS_A, "wft_a");
      const seen = await createTransactionManager(app.db)
        .runForWorkspace(WS_B, uow => uow.workflowTemplates.find("wft_a"));
      expect(seen).toBeNull();
    });

    // ── The tests above go through the repository, which carries its own
    //    `where workspace_id = scope` on every statement. They would ALL pass
    //    with the RLS policy dropped. That is the trap this block exists for:
    //    the queries below take a raw transaction and deliberately omit the
    //    predicate, so the only thing that can still refuse them is PostgreSQL.

    it("has RLS enabled AND forced, with a policy covering both arms", async () => {
      // The behavioural tests below would also pass if the table were simply
      // empty for the wrong reason. This one names the mechanism directly, so
      // a future migration that drops the policy or loses FORCE fails HERE,
      // with a message that says which, rather than somewhere downstream.
      //
      // FORCE matters specifically: without it the table OWNER bypasses the
      // policy, and migrations and admin scripts run as the owner.
      const flags = await sql<{
        relrowsecurity: boolean; relforcerowsecurity: boolean;
      }>`
        select relrowsecurity, relforcerowsecurity
        from pg_class where relname = 'workspace_workflow_templates'
      `.execute(owner.db);

      expect(flags.rows[0]?.relrowsecurity, "row level security is enabled").toBe(true);
      expect(flags.rows[0]?.relforcerowsecurity, "and FORCEd on the owner").toBe(true);

      const policies = await sql<{ policyname: string; qual: string; with_check: string }>`
        select policyname, qual, with_check
        from pg_policies where tablename = 'workspace_workflow_templates'
      `.execute(owner.db);

      expect(policies.rows).toHaveLength(1);
      // Both arms present: USING governs what is visible, WITH CHECK governs
      // what may be written. A policy with only USING would read safely and
      // still accept a row belonging to someone else.
      expect(policies.rows[0]?.qual).toContain("lagda_current_workspace()");
      expect(policies.rows[0]?.with_check).toContain("lagda_current_workspace()");
    });

    it("hides the row from a SELECT with no predicate at all", async () => {
      await insert(WS_A, "wft_a");

      const rows = await withRawTenantTransaction(app, WS_B, trx =>
        trx.selectFrom("workspace_workflow_templates").selectAll().execute());

      expect(rows).toEqual([]);
    });

    it("lets that same unpredicated SELECT see its OWN workspace", async () => {
      // Without this, the test above would pass just as well against an empty
      // table or a broken connection.
      await insert(WS_A, "wft_a");

      const rows = await withRawTenantTransaction(app, WS_A, trx =>
        trx.selectFrom("workspace_workflow_templates").selectAll().execute());

      expect(rows).toHaveLength(1);
    });

    it("refuses a raw INSERT naming another workspace (the WITH CHECK arm)", async () => {
      // The repository would have caught this before it reached the database.
      // Here nothing does but the policy.
      await expect(withRawTenantTransaction(app, WS_A, trx =>
        trx.insertInto("workspace_workflow_templates").values({
          workflow_template_id: "wft_raw",
          workspace_id: WS_B,
          name: "Smuggled",
          routing_mode: "sequential",
          role_slots: JSON.stringify(SLOTS),
          completion_notification_settings: JSON.stringify(SETTINGS),
          created_by: USER,
          created_at: new Date(AT),
          updated_at: new Date(AT),
        }).execute(),
      )).rejects.toThrow(/policy/i);
    });

    it("refuses a raw UPDATE with no workspace predicate", async () => {
      await insert(WS_A, "wft_a", { name: "Original" });

      const result = await withRawTenantTransaction(app, WS_B, trx =>
        trx.updateTable("workspace_workflow_templates")
          .set({ name: "Hijacked" })
          .executeTakeFirst());

      expect(Number(result.numUpdatedRows)).toBe(0);

      const still = await createTransactionManager(app.db)
        .runForWorkspace(WS_A, uow => uow.workflowTemplates.find("wft_a"));
      expect(still?.name).toBe("Original");
    });

    it("refuses a raw DELETE with no workspace predicate", async () => {
      await insert(WS_A, "wft_a");

      const result = await withRawTenantTransaction(app, WS_B, trx =>
        trx.deleteFrom("workspace_workflow_templates").executeTakeFirst());

      expect(Number(result.numDeletedRows)).toBe(0);

      const still = await createTransactionManager(app.db)
        .runForWorkspace(WS_A, uow => uow.workflowTemplates.find("wft_a"));
      expect(still).not.toBeNull();
    });

    it("fails CLOSED when no tenant context is set at all", async () => {
      // A code path that forgot to bind a workspace must see nothing, not
      // everything. `lagda_current_workspace()` returns no match, so the
      // policy excludes every row rather than admitting them.
      await insert(WS_A, "wft_a");
      await insert(WS_B, "wft_b");

      const rows = await withRawGlobalTransaction(app, trx =>
        trx.selectFrom("workspace_workflow_templates").selectAll().execute());

      expect(rows).toEqual([]);
    });

    it("refuses a row whose workspace differs from the bound scope", async () => {
      await expect(createTransactionManager(app.db).runForWorkspace(WS_A, uow =>
        uow.workflowTemplates.insert({
          workflowTemplateId: "wft_smuggled",
          workspaceId: WS_B,
          name: "Smuggled",
          routingMode: "sequential",
          roleSlots: [...SLOTS],
          completionSettings: SETTINGS,
          createdBy: USER,
          createdAt: AT,
        }),
      )).rejects.toThrow(/workspace/i);
    });

    it("cannot delete another workspace's template", async () => {
      await insert(WS_A, "wft_a");
      const removed = await createTransactionManager(app.db)
        .runForWorkspace(WS_B, uow => uow.workflowTemplates.remove("wft_a"));
      expect(removed).toBe(false);

      // Still there, in its own workspace.
      const still = await createTransactionManager(app.db)
        .runForWorkspace(WS_A, uow => uow.workflowTemplates.find("wft_a"));
      expect(still).not.toBeNull();
    });

    it("cannot update another workspace's template", async () => {
      await insert(WS_A, "wft_a", { name: "Original" });
      const changed = await createTransactionManager(app.db)
        .runForWorkspace(WS_B, uow => uow.workflowTemplates.update("wft_a", {
          name: "Hijacked",
          routingMode: "parallel",
          roleSlots: [...SLOTS],
          completionSettings: SETTINGS,
          updatedAt: AT + 1000,
        }));
      expect(changed).toBe(false);

      const still = await createTransactionManager(app.db)
        .runForWorkspace(WS_A, uow => uow.workflowTemplates.find("wft_a"));
      expect(still?.name).toBe("Original");
    });

    it("does not see another workspace's name when checking uniqueness", async () => {
      // Otherwise a workspace could discover that another one has a template
      // called "Project Falcon" by trying to create one.
      await insert(WS_A, "wft_a", { name: "Project Falcon" });
      const taken = await createTransactionManager(app.db)
        .runForWorkspace(WS_B, uow => uow.workflowTemplates.nameExists("Project Falcon", null));
      expect(taken).toBe(false);
    });
  });

  // ── The grants ────────────────────────────────────────────────────────────

  describe("the runtime role", () => {
    it("CAN delete a template — the one place this differs from contacts", async () => {
      await insert(WS_A, "wft_a");
      const removed = await createTransactionManager(app.db)
        .runForWorkspace(WS_A, uow => uow.workflowTemplates.remove("wft_a"));
      expect(removed).toBe(true);

      const gone = await createTransactionManager(app.db)
        .runForWorkspace(WS_A, uow => uow.workflowTemplates.find("wft_a"));
      expect(gone).toBeNull();
    });

    it("reports false rather than throwing when a delete matches nothing", async () => {
      const removed = await createTransactionManager(app.db)
        .runForWorkspace(WS_A, uow => uow.workflowTemplates.remove("wft_missing"));
      expect(removed).toBe(false);
    });
  });

  // ── Constraints ───────────────────────────────────────────────────────────

  describe("constraints", () => {
    it("refuses a routing mode outside the closed set", async () => {
      // The cast is the point of the test: TypeScript already forbids this,
      // and the question is whether PostgreSQL does too — for the day a value
      // arrives from a migration, a backfill or a psql session instead.
      const outside = "round-robin" as NewWorkflowTemplate["routingMode"];
      await expect(insert(WS_A, "wft_bad", { routingMode: outside }))
        .rejects.toThrow();
    });

    it("refuses a blank name", async () => {
      await expect(insert(WS_A, "wft_blank", { name: "   " })).rejects.toThrow();
    });

    it("refuses an empty slot array, even though the application refuses first", async () => {
      await expect(createTransactionManager(app.db).runForWorkspace(WS_A, uow =>
        uow.workflowTemplates.insert({
          workflowTemplateId: "wft_empty",
          workspaceId: WS_A,
          name: "Empty",
          routingMode: "sequential",
          roleSlots: [],
          completionSettings: SETTINGS,
          createdBy: USER,
          createdAt: AT,
        }),
      )).rejects.toThrow();
    });

    it("refuses a duplicate name in one workspace, ignoring case and space", async () => {
      await insert(WS_A, "wft_1", { name: "HR Onboarding" });
      await expect(insert(WS_A, "wft_2", { name: "  hr onboarding  " }))
        .rejects.toThrow();
    });

    it("allows the SAME name in two different workspaces", async () => {
      await insert(WS_A, "wft_a", { name: "HR Onboarding" });
      await insert(WS_B, "wft_b", { name: "HR Onboarding" });

      const inB = await createTransactionManager(app.db)
        .runForWorkspace(WS_B, uow => uow.workflowTemplates.list());
      expect(inB).toHaveLength(1);
    });
  });

  // ── Round trip ────────────────────────────────────────────────────────────

  describe("the JSONB columns", () => {
    it("returns slots and settings as structured data, not a string", async () => {
      await insert(WS_A, "wft_a");
      const row = await createTransactionManager(app.db)
        .runForWorkspace(WS_A, uow => uow.workflowTemplates.find("wft_a"));

      expect(Array.isArray(row?.roleSlots)).toBe(true);
      expect(row?.roleSlots).toEqual([...SLOTS]);
      expect(row?.completionSettings).toEqual(SETTINGS);
    });

    it("preserves slot ORDER, which is the routing the admin designed", async () => {
      await insert(WS_A, "wft_a");
      const row = await createTransactionManager(app.db)
        .runForWorkspace(WS_A, uow => uow.workflowTemplates.find("wft_a"));
      const slots = row?.roleSlots as typeof SLOTS;
      expect(slots[0]?.label).toBe("HR Approver");
      expect(slots[1]?.label).toBe("Employee");
    });
  });

  // ── The table is referenced by nothing outside its own child ─────────────

  it("is the target of no foreign key EXCEPT its own field placements (060), so a draft can never point back at it", async () => {
    // Migration 058's "snapshot, not reference" rule, asserted against the
    // live catalogue rather than trusted from a comment. The one allowed
    // exception is `workflow_template_fields`, 060's OWN child — its fields
    // are the template's own authoring content, cascade-deleted with it
    // (§060's header), not a draft or document holding a live pointer back.
    // A future FK from anything ELSE — a signing request, a preparation —
    // would let editing a template change a document already prepared from
    // it, exactly what this test still refuses.
    const referencing = await sql<{ table_name: string }>`
      select distinct tc.table_name
      from information_schema.table_constraints tc
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY'
        and ccu.table_name = 'workspace_workflow_templates'
        and tc.table_name != 'workflow_template_fields'
    `.execute(owner.db);

    expect(referencing.rows).toEqual([]);
  });
});
