// A workflow template's field placements (060), against REAL PostgreSQL, as
// the RUNTIME role.
//
// What only this suite can prove:
//
//   1. RLS isolates fields the same way it isolates the template itself.
//   2. The CHECK constraints behave as migration 060 describes: geometry
//      must be positive-size and in-bounds, the field type is closed, the
//      page number is at least 1.
//   3. Deleting the template CASCADES to its fields — a real foreign key,
//      not an application-level cleanup that could be bypassed.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import type { NewWorkflowTemplate, WorkflowTemplateFieldRecord } from "@lagda/application";
import { type LagdaDatabase } from "./client/index.js";
import { createTransactionManager } from "./transactions/index.js";
import {
  createTestDatabase, createRuntimeRoleDatabase, truncateAll,
  hasIntegrationDatabase, seedUser,
} from "./testing/harness.js";

const AT = Date.parse("2026-09-22T09:00:00.000Z");
const USER = "usr_wtf" as UserId;
const WS_A = "ws_wtf_a" as WorkspaceId;
const WS_B = "ws_wtf_b" as WorkspaceId;

const SLOTS = [
  { slotId: "wfs_a", label: "Client", role: "signer", required: true, routingStep: 1, defaultAuthMethod: "none" },
] as const;

const FIELD: WorkflowTemplateFieldRecord = {
  fieldId: "wff_1" as WorkflowTemplateFieldRecord["fieldId"],
  slotId: "wfs_a", variableKey: null,
  type: "signature",
  pageNumber: 1,
  x: 0.1, y: 0.1, width: 0.2, height: 0.05,
  required: true,
  label: "Sign here",
  layer: 0,
};

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("workflow template fields (RLS, runtime role)", () => {
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

  const insertTemplate = (
    workspaceId: WorkspaceId, workflowTemplateId: string,
  ) => createTransactionManager(app.db).runForWorkspace(workspaceId, uow =>
    uow.workflowTemplates.insert({
      workflowTemplateId, workspaceId, name: workflowTemplateId,
      routingMode: "sequential",
      roleSlots: [...SLOTS] as NewWorkflowTemplate["roleSlots"],
      completionSettings: { notifySenderOnComplete: true },
      variables: [],
      createdBy: USER, createdAt: AT,
    }));

  const saveFields = (
    workspaceId: WorkspaceId, workflowTemplateId: string,
    fields: readonly WorkflowTemplateFieldRecord[],
  ) => createTransactionManager(app.db).runForWorkspace(workspaceId, uow =>
    uow.workflowTemplateFields.replaceAll(workflowTemplateId, fields, AT));

  // ── Tenancy ───────────────────────────────────────────────────────────────

  describe("row-level security", () => {
    it("hides another workspace's fields from a list", async () => {
      await insertTemplate(WS_A, "wft_a");
      await saveFields(WS_A, "wft_a", [FIELD]);

      const seen = await createTransactionManager(app.db)
        .runForWorkspace(WS_B, uow => uow.workflowTemplateFields.list("wft_a"));
      expect(seen).toHaveLength(0);
    });

    it("lets that same workspace see its OWN fields", async () => {
      await insertTemplate(WS_A, "wft_a");
      await saveFields(WS_A, "wft_a", [FIELD]);

      const seen = await createTransactionManager(app.db)
        .runForWorkspace(WS_A, uow => uow.workflowTemplateFields.list("wft_a"));
      expect(seen).toHaveLength(1);
    });

    it("has RLS enabled AND forced", async () => {
      const result = await owner.db.executeQuery<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        owner.db
          .selectFrom("pg_class" as never)
          .select(["relrowsecurity" as never, "relforcerowsecurity" as never])
          .where("relname" as never, "=", "workflow_template_fields" as never)
          .compile(),
      );
      expect(result.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });
  });

  // ── Constraints ──────────────────────────────────────────────────────────

  describe("constraints", () => {
    it("refuses a field type outside the closed set", async () => {
      await insertTemplate(WS_A, "wft_a");
      await expect(saveFields(WS_A, "wft_a", [
        { ...FIELD, type: "radio-group" as never },
      ])).rejects.toThrow();
    });

    it("refuses page 0", async () => {
      await insertTemplate(WS_A, "wft_a");
      await expect(saveFields(WS_A, "wft_a", [
        { ...FIELD, pageNumber: 0 },
      ])).rejects.toThrow();
    });

    it("refuses a zero-width rectangle", async () => {
      await insertTemplate(WS_A, "wft_a");
      await expect(saveFields(WS_A, "wft_a", [
        { ...FIELD, width: 0 },
      ])).rejects.toThrow();
    });

    it("refuses a rectangle that overflows the page", async () => {
      await insertTemplate(WS_A, "wft_a");
      await expect(saveFields(WS_A, "wft_a", [
        { ...FIELD, x: 0.9, width: 0.5 },
      ])).rejects.toThrow();
    });

    it("refuses a negative layer", async () => {
      await insertTemplate(WS_A, "wft_a");
      await expect(saveFields(WS_A, "wft_a", [
        { ...FIELD, layer: -1 },
      ])).rejects.toThrow();
    });
  });

  // ── Cascade ──────────────────────────────────────────────────────────────

  describe("deleting the template", () => {
    it("CASCADES to its fields — a real foreign key, not an application step", async () => {
      await insertTemplate(WS_A, "wft_a");
      await saveFields(WS_A, "wft_a", [FIELD]);

      await createTransactionManager(app.db)
        .runForWorkspace(WS_A, uow => uow.workflowTemplates.remove("wft_a"));

      // Read as the OWNER role, bypassing RLS, to confirm the row is truly
      // gone rather than merely invisible to the tenant that deleted it.
      const remaining = await owner.db
        .selectFrom("workflow_template_fields" as never)
        .selectAll()
        .where("workflow_template_id" as never, "=", "wft_a" as never)
        .execute();
      expect(remaining).toHaveLength(0);
    });
  });

  // ── Ordering ─────────────────────────────────────────────────────────────

  it("lists in deterministic order: page, then layer, then id", async () => {
    await insertTemplate(WS_A, "wft_a");
    await saveFields(WS_A, "wft_a", [
      { ...FIELD, fieldId: "wff_c" as never, pageNumber: 2, layer: 0 },
      { ...FIELD, fieldId: "wff_a" as never, pageNumber: 1, layer: 1 },
      { ...FIELD, fieldId: "wff_b" as never, pageNumber: 1, layer: 0 },
    ]);

    const listed = await createTransactionManager(app.db)
      .runForWorkspace(WS_A, uow => uow.workflowTemplateFields.list("wft_a"));

    expect(listed.map(f => f.fieldId)).toEqual(["wff_b", "wff_a", "wff_c"]);
  });
});
