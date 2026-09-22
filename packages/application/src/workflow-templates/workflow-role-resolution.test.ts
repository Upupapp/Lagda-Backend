// Role resolution (migration 061): a slot may resolve to whoever currently
// holds a TITLE in an organization unit, instead of a sender typing a name
// and email by hand.
//
// The claims that carry weight:
//
//   THE UNIT MUST BE REAL, verified on WRITE (create/update), the same
//   two-pass shape `attachWorkflowTemplateDocument` uses for its own
//   cross-reference — an unrecognised or archived unit is refused before
//   anything is stored, not discovered at apply time.
//
//   RESOLUTION IS LIVE, not cached. `resolveWorkflowRoleAssignments` reads
//   the CURRENT title-holder every call — changing who holds a title
//   changes what a template resolves to, with no template edit required.
//
//   THREE STATES, not a nullable person: "manual" (no resolution
//   configured), "unresolved" (configured, nobody currently holds the
//   title), "resolved" (exactly one person, with their directory entry).

import { describe, it, expect } from "vitest";
import type {
  UserId, WorkspaceId, WorkspaceMemberId,
} from "@lagda/contracts";
import {
  createWorkflowTemplate, updateWorkflowTemplate,
  resolveWorkflowRoleAssignments,
  WorkflowTemplateMalformedError,
  type WorkflowTemplateDependencies, type WorkflowTemplateInput,
} from "./workflow-templates.js";
import { CreateWorkspace } from "../workspaces/create-workspace.js";
import { ResourceNotFoundError } from "../common/errors/index.js";
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import type { OrganizationUnitId, OrganizationUnitRecord } from "../organization/index.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialWorkflowTemplateIds, FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

const AT = Date.parse("2026-09-22T14:00:00.000Z");

const OWNER = "usr_owner" as UserId;
const SENDER = "usr_sender" as UserId;
const HEAD = "usr_head" as UserId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

const RECORDS_UNIT = "unit_records" as OrganizationUnitId;
const ARCHIVED_UNIT = "unit_archived" as OrganizationUnitId;

interface Harness {
  readonly store: InMemoryStore;
  readonly workspaceId: WorkspaceId;
  readonly deps: WorkflowTemplateDependencies;
}

async function harness(): Promise<Harness> {
  const store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);
  const clock = new FixedClock(AT);

  const created = await new CreateWorkspace({
    transactions, clock,
    workspaceIds: new SequentialWorkspaceIds(),
    memberIds: new SequentialMemberIds(),
    idempotency: {
      digester: createIdempotencyKeyDigester(),
      ids: createIdempotencyRecordIds(),
      clock,
      policy: { retentionMs: 86_400_000 },
    },
  }).execute({ actor: actor(OWNER), name: "Acme Legal" });

  store.memberships.push({
    memberId: "mem_sender" as WorkspaceMemberId, workspaceId: created.workspaceId,
    userId: SENDER, role: "sender", createdAt: AT + 1000,
  });
  store.memberships.push({
    memberId: "mem_head" as WorkspaceMemberId, workspaceId: created.workspaceId,
    userId: HEAD, role: "member", createdAt: AT + 1000,
  });

  const unit: OrganizationUnitRecord = {
    unitId: RECORDS_UNIT, workspaceId: created.workspaceId,
    parentUnitId: null, kind: "department", name: "Records",
    createdAt: AT, archivedAt: null,
  };
  store.organizationUnits.push(unit);
  store.organizationUnits.push({
    ...unit, unitId: ARCHIVED_UNIT, name: "Dissolved Office", archivedAt: AT,
  });

  return {
    store,
    workspaceId: created.workspaceId,
    deps: { transactions, clock, ids: new SequentialWorkflowTemplateIds() },
  };
}

/** Files HEAD into `unit`, holding `title` — direct store insert, the same
 *  shortcut `organization.test.ts`'s own harness takes for memberships. */
function makeHeadOf(h: Harness, unitId: OrganizationUnitId, title: string) {
  h.store.organizationUnitMembers.push({
    unitId, workspaceId: h.workspaceId, userId: HEAD, createdAt: AT, title,
  });
}

function templateWithResolution(
  over: Partial<{ unitId: string; title: string }> = {},
): WorkflowTemplateInput {
  return {
    name: "Onboarding",
    routingMode: "sequential",
    roleSlots: [
      {
        label: "Department Head", role: "approver", required: true,
        routingStep: 1, defaultAuthMethod: "none",
        resolution: {
          mode: "unit-title",
          unitId: over.unitId ?? RECORDS_UNIT,
          title: over.title ?? "Department Head",
        },
      },
    ],
    completionSettings: { notifySenderOnComplete: true },
  };
}

// ── Validation on write ─────────────────────────────────────────────────────

describe("a slot's resolution, validated on write", () => {
  it("accepts a resolution naming a real, live unit", async () => {
    const h = await harness();
    await expect(createWorkflowTemplate(
      actor(OWNER), h.workspaceId, templateWithResolution(), h.deps))
      .resolves.toBeDefined();
  });

  it("refuses a resolution naming a unit that does not exist", async () => {
    const h = await harness();
    await expect(createWorkflowTemplate(
      actor(OWNER), h.workspaceId,
      templateWithResolution({ unitId: "unit_missing" }), h.deps))
      .rejects.toBeInstanceOf(WorkflowTemplateMalformedError);
  });

  it("refuses a resolution naming an ARCHIVED unit", async () => {
    const h = await harness();
    await expect(createWorkflowTemplate(
      actor(OWNER), h.workspaceId,
      templateWithResolution({ unitId: ARCHIVED_UNIT }), h.deps))
      .rejects.toBeInstanceOf(WorkflowTemplateMalformedError);
  });

  it("refuses a resolution with an unknown mode", async () => {
    const h = await harness();
    const bad = {
      ...templateWithResolution(),
      roleSlots: [{
        label: "X", role: "approver", required: true, routingStep: 1,
        defaultAuthMethod: "none", resolution: { mode: "by-magic", unitId: RECORDS_UNIT, title: "X" },
      }],
    } as unknown as WorkflowTemplateInput;

    await expect(createWorkflowTemplate(actor(OWNER), h.workspaceId, bad, h.deps))
      .rejects.toBeInstanceOf(WorkflowTemplateMalformedError);
  });

  it("refuses a resolution with a blank title", async () => {
    const h = await harness();
    await expect(createWorkflowTemplate(
      actor(OWNER), h.workspaceId,
      templateWithResolution({ title: "   " }), h.deps))
      .rejects.toBeInstanceOf(WorkflowTemplateMalformedError);
  });

  it("does NOT require anyone to currently hold the title — a template may be authored ahead of staffing", async () => {
    const h = await harness();
    // Nobody has been made Department Head yet.
    await expect(createWorkflowTemplate(
      actor(OWNER), h.workspaceId, templateWithResolution(), h.deps))
      .resolves.toBeDefined();
  });

  it("checks resolutions on UPDATE too, not only on create", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(
      actor(OWNER), h.workspaceId,
      {
        name: "Onboarding", routingMode: "sequential",
        roleSlots: [{ label: "Signer", role: "signer", required: true, routingStep: 1, defaultAuthMethod: "none" }],
        completionSettings: { notifySenderOnComplete: true },
      }, h.deps);

    await expect(updateWorkflowTemplate(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      templateWithResolution({ unitId: "unit_missing" }), h.deps))
      .rejects.toBeInstanceOf(WorkflowTemplateMalformedError);
  });
});

// ── Resolving assignments ───────────────────────────────────────────────────

describe("resolveWorkflowRoleAssignments", () => {
  it("reports a slot with NO resolution as manual", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(
      actor(OWNER), h.workspaceId,
      {
        name: "Onboarding", routingMode: "sequential",
        roleSlots: [{ label: "Signer", role: "signer", required: true, routingStep: 1, defaultAuthMethod: "none" }],
        completionSettings: { notifySenderOnComplete: true },
      }, h.deps);

    const assignments = await resolveWorkflowRoleAssignments(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps);

    expect(assignments).toEqual([{ slotId: template.roleSlots[0]!.slotId, status: "manual" }]);
  });

  it("reports UNRESOLVED when nobody currently holds the title", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(
      actor(OWNER), h.workspaceId, templateWithResolution(), h.deps);

    const assignments = await resolveWorkflowRoleAssignments(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps);

    expect(assignments).toEqual([{ slotId: template.roleSlots[0]!.slotId, status: "unresolved" }]);
  });

  it("resolves to the current title-holder, with their directory entry", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(
      actor(OWNER), h.workspaceId, templateWithResolution(), h.deps);
    makeHeadOf(h, RECORDS_UNIT, "Department Head");

    const assignments = await resolveWorkflowRoleAssignments(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps);

    expect(assignments).toEqual([{
      slotId: template.roleSlots[0]!.slotId, status: "resolved",
      userId: HEAD, displayName: HEAD, email: `${HEAD}@fixture.invalid`,
    }]);
  });

  it("is LIVE — a title change is reflected without editing the template", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(
      actor(OWNER), h.workspaceId, templateWithResolution(), h.deps);

    const before = await resolveWorkflowRoleAssignments(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps);
    expect(before[0]?.status).toBe("unresolved");

    makeHeadOf(h, RECORDS_UNIT, "Department Head");

    const after = await resolveWorkflowRoleAssignments(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps);
    expect(after[0]?.status).toBe("resolved");
  });

  it("matches a title case- and whitespace-insensitively", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(
      actor(OWNER), h.workspaceId, templateWithResolution({ title: "  department head  " }), h.deps);
    makeHeadOf(h, RECORDS_UNIT, "Department Head");

    const assignments = await resolveWorkflowRoleAssignments(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps);
    expect(assignments[0]?.status).toBe("resolved");
  });

  it("resolves independently per slot when a template has more than one", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(
      actor(OWNER), h.workspaceId,
      {
        name: "Onboarding", routingMode: "sequential",
        roleSlots: [
          {
            label: "Department Head", role: "approver", required: true, routingStep: 1,
            defaultAuthMethod: "none",
            resolution: { mode: "unit-title", unitId: RECORDS_UNIT, title: "Department Head" },
          },
          { label: "New Hire", role: "signer", required: true, routingStep: 2, defaultAuthMethod: "none" },
        ],
        completionSettings: { notifySenderOnComplete: true },
      }, h.deps);
    makeHeadOf(h, RECORDS_UNIT, "Department Head");

    const assignments = await resolveWorkflowRoleAssignments(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps);

    expect(assignments.map(a => a.status)).toEqual(["resolved", "manual"]);
  });

  it("lets a SENDER resolve — the role the feature exists for", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(
      actor(OWNER), h.workspaceId, templateWithResolution(), h.deps);

    await expect(resolveWorkflowRoleAssignments(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps))
      .resolves.toBeDefined();
  });

  it("refuses a template id that does not exist", async () => {
    const h = await harness();
    await expect(resolveWorkflowRoleAssignments(
      actor(OWNER), h.workspaceId, "wft_missing", h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});
