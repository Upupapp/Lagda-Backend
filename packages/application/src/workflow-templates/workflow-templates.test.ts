// Reusable workflow templates (migration 058).
//
// The claims that carry weight:
//
//   AUTHORIZATION. `manage_templates` governed nothing before this feature —
//   the role named for templates held no template capability at all. So the
//   gate is tested per role and per verb, not once: a `sender` reads and
//   cannot author, everyone outside the workspace sees a 404, and read is
//   genuinely separate from write.
//
//   MALFORMED SLOTS. `role_slots` is JSONB, so PostgreSQL guarantees only
//   "non-empty array". Every other rule lives in the application, on write AND
//   on read — a stored row with a bad slot must fail loudly rather than build
//   a document that routes to fewer people than the admin designed.
//
//   SNAPSHOT, NOT REFERENCE. Applying a template hands back its slots. Editing
//   the template afterwards must not change what a caller already resolved.

import { describe, it, expect } from "vitest";
import type { UserId, WorkspaceId, WorkspaceMemberId } from "@lagda/contracts";
import {
  createWorkflowTemplate, listWorkflowTemplates, getWorkflowTemplate,
  updateWorkflowTemplate, deleteWorkflowTemplate, resolveTemplateForApply,
  validateRoleSlots,
  WorkflowTemplateMalformedError, WorkflowTemplateNameTakenError,
  type WorkflowTemplateDependencies, type WorkflowTemplateInput,
} from "./workflow-templates.js";
import { CreateWorkspace } from "../workspaces/create-workspace.js";
import { ResourceNotFoundError } from "../common/errors/index.js";
// NOTE ON WHAT DENIAL LOOKS LIKE. `assertCapability` throws
// `ResourceNotFoundError("Workspace")`, not an authorization error — the
// deliberate hidden 404 this codebase uses everywhere, so "you are not a
// member" and "you may not do that" are one answer and neither can be used to
// probe for which workspaces exist.
import type { AuthenticatedActor, SessionId } from "../common/ports/session.js";
import {
  FixedClock, SequentialWorkspaceIds, SequentialMemberIds,
  SequentialWorkflowTemplateIds, FakeTransactionManager, InMemoryStore,
} from "../test-support/fakes.js";
import {
  createIdempotencyKeyDigester, createIdempotencyRecordIds,
} from "../test-support/idempotency-support.js";

const AT = Date.parse("2026-09-22T14:00:00.000Z");

const OWNER = "usr_owner" as UserId;
const ADMIN = "usr_admin" as UserId;
const SENDER = "usr_sender" as UserId;
const TEMPLATE_ADMIN = "usr_template" as UserId;
const MEMBER = "usr_member" as UserId;
const REVIEWER = "usr_reviewer" as UserId;
const AUDITOR = "usr_auditor" as UserId;
const OUTSIDER = "usr_outsider" as UserId;

const actor = (userId: UserId): AuthenticatedActor => ({
  actorType: "user", userId, sessionId: "ses_fixture" as SessionId,
});

interface Harness {
  readonly store: InMemoryStore;
  readonly workspaceId: WorkspaceId;
  readonly deps: WorkflowTemplateDependencies;
  /**
   * Creates a SECOND workspace in the same store.
   *
   * Shares this harness's id generator on purpose: a fresh
   * `SequentialWorkspaceIds` restarts at 1, so two workspaces built with
   * separate generators both become `ws_1` — which silently turns an
   * isolation test into a test that two names collide in one workspace.
   */
  readonly otherWorkspace: (owner: UserId) => Promise<WorkspaceId>;
}

async function harness(): Promise<Harness> {
  const store = new InMemoryStore();
  const transactions = new FakeTransactionManager(store);
  const clock = new FixedClock(AT);

  const workspaceIds = new SequentialWorkspaceIds();
  const memberIds = new SequentialMemberIds();

  const created = await new CreateWorkspace({
    transactions, clock,
    workspaceIds,
    memberIds,
    idempotency: {
      digester: createIdempotencyKeyDigester(),
      ids: createIdempotencyRecordIds(),
      clock,
      policy: { retentionMs: 86_400_000 },
    },
  }).execute({ actor: actor(OWNER), name: "Acme Legal" });

  for (const [key, userId, role] of [
    ["admin", ADMIN, "administrator"],
    ["sender", SENDER, "sender"],
    ["template", TEMPLATE_ADMIN, "template_administrator"],
    ["member", MEMBER, "member"],
    ["reviewer", REVIEWER, "reviewer"],
    ["auditor", AUDITOR, "auditor"],
  ] as const) {
    store.memberships.push({
      memberId: `mem_${key}` as WorkspaceMemberId,
      workspaceId: created.workspaceId,
      userId,
      role,
      createdAt: AT + 1000,
    });
  }

  return {
    store,
    workspaceId: created.workspaceId,
    deps: { transactions, clock, ids: new SequentialWorkflowTemplateIds() },
    otherWorkspace: async (owner: UserId) => {
      const other = await new CreateWorkspace({
        transactions, clock,
        workspaceIds, memberIds,
        idempotency: {
          digester: createIdempotencyKeyDigester(),
          ids: createIdempotencyRecordIds(),
          clock,
          policy: { retentionMs: 86_400_000 },
        },
      }).execute({ actor: actor(owner), name: "Other Firm" });
      return other.workspaceId;
    },
  };
}

/** Approval at step 1, two signers in parallel at step 2 — the product's example. */
const VALID: WorkflowTemplateInput = {
  name: "HR Onboarding",
  routingMode: "approval-based",
  roleSlots: [
    { label: "HR Approver", role: "approver", required: true, routingStep: 1, defaultAuthMethod: "none" },
    { label: "Employee", role: "signer", required: true, routingStep: 2, defaultAuthMethod: "none" },
    { label: "Manager", role: "signer", required: true, routingStep: 2, defaultAuthMethod: "none" },
  ],
  completionSettings: { notifySenderOnComplete: true },
};

// ── Authorization ────────────────────────────────────────────────────────────

describe("who may author a template", () => {
  it.each([
    ["owner", OWNER], ["administrator", ADMIN], ["template_administrator", TEMPLATE_ADMIN],
  ] as const)("%s may create one", async (_role, userId) => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(userId), h.workspaceId, VALID, h.deps);
    expect(template.name).toBe("HR Onboarding");
  });

  it.each([
    ["sender", SENDER], ["member", MEMBER], ["reviewer", REVIEWER], ["auditor", AUDITOR],
  ] as const)("%s may NOT create one", async (_role, userId) => {
    const h = await harness();
    await expect(createWorkflowTemplate(actor(userId), h.workspaceId, VALID, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("refuses an update and a delete to a sender, who may only read", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);

    await expect(updateWorkflowTemplate(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, VALID, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(deleteWorkflowTemplate(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);

    // ...and the template is still there, unchanged.
    const still = await getWorkflowTemplate(
      actor(OWNER), h.workspaceId, template.workflowTemplateId, h.deps);
    expect(still.name).toBe("HR Onboarding");
  });

  it("lets a sender READ and APPLY — the role the feature exists for at use time", async () => {
    const h = await harness();
    await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);

    const list = await listWorkflowTemplates(actor(SENDER), h.workspaceId, h.deps);
    expect(list).toHaveLength(1);

    const applied = await resolveTemplateForApply(
      actor(SENDER), h.workspaceId, list[0]!.workflowTemplateId, h.deps);
    expect(applied.roleSlots).toHaveLength(3);
  });

  it.each([
    ["member", MEMBER], ["reviewer", REVIEWER], ["auditor", AUDITOR],
  ] as const)("%s may not even read", async (_role, userId) => {
    const h = await harness();
    await expect(listWorkflowTemplates(actor(userId), h.workspaceId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("gives a non-member a 404, never an authorization error", async () => {
    // "This workspace is not yours" and "you may not do that here" are one
    // answer, so a caller cannot probe for which workspaces exist.
    const h = await harness();
    await expect(listWorkflowTemplates(actor(OUTSIDER), h.workspaceId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(createWorkflowTemplate(actor(OUTSIDER), h.workspaceId, VALID, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

// ── Workspace isolation ──────────────────────────────────────────────────────

describe("workspace isolation", () => {
  it("never returns another workspace's template", async () => {
    const h = await harness();
    const otherWorkspaceId = await h.otherWorkspace(OUTSIDER);
    expect(otherWorkspaceId).not.toBe(h.workspaceId);

    const mine = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);

    // The other workspace's owner cannot see it by listing...
    const theirList = await listWorkflowTemplates(actor(OUTSIDER), otherWorkspaceId, h.deps);
    expect(theirList).toHaveLength(0);

    // ...nor by naming its id directly, in their own workspace's scope.
    await expect(getWorkflowTemplate(
      actor(OUTSIDER), otherWorkspaceId, mine.workflowTemplateId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);

    // ...nor delete it.
    await expect(deleteWorkflowTemplate(
      actor(OUTSIDER), otherWorkspaceId, mine.workflowTemplateId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);

    // And it is still there afterwards.
    const still = await getWorkflowTemplate(
      actor(OWNER), h.workspaceId, mine.workflowTemplateId, h.deps);
    expect(still.workflowTemplateId).toBe(mine.workflowTemplateId);
  });

  it("lets two workspaces hold templates of the SAME name", async () => {
    // The unique index is per workspace. Two firms both having an "HR
    // Onboarding" is not a conflict.
    const h = await harness();
    const otherWorkspaceId = await h.otherWorkspace(OUTSIDER);

    await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);
    const theirs = await createWorkflowTemplate(
      actor(OUTSIDER), otherWorkspaceId, VALID, h.deps);
    expect(theirs.name).toBe("HR Onboarding");
  });
});

// ── Malformed slots ──────────────────────────────────────────────────────────

describe("a malformed template is refused, not half-applied", () => {
  const cases: [string, unknown][] = [
    ["missing entirely", undefined],
    ["not an array", { label: "x" }],
    ["empty", []],
    ["a slot that is not an object", ["signer"]],
    ["a slot with no label", [{ role: "signer", required: true, routingStep: 1, defaultAuthMethod: "none" }]],
    ["a blank label", [{ label: "   ", role: "signer", required: true, routingStep: 1, defaultAuthMethod: "none" }]],
    ["an unknown role", [{ label: "X", role: "notary", required: true, routingStep: 1, defaultAuthMethod: "none" }]],
    ["a non-boolean required", [{ label: "X", role: "signer", required: "yes", routingStep: 1, defaultAuthMethod: "none" }]],
    ["a zero routing step", [{ label: "X", role: "signer", required: true, routingStep: 0, defaultAuthMethod: "none" }]],
    ["a fractional routing step", [{ label: "X", role: "signer", required: true, routingStep: 1.5, defaultAuthMethod: "none" }]],
    ["an unknown auth method", [{ label: "X", role: "signer", required: true, routingStep: 1, defaultAuthMethod: "fingerprint" }]],
  ];

  it.each(cases)("refuses %s", (_name, roleSlots) => {
    expect(() => validateRoleSlots(roleSlots)).toThrow(WorkflowTemplateMalformedError);
  });

  it("refuses routing steps that skip a number", () => {
    // Steps 1 and 3 would produce recipients at routing orders 1 and 3, and
    // "step 2 has nobody in it" is not a question a template may ask.
    expect(() => validateRoleSlots([
      { label: "A", role: "signer", required: true, routingStep: 1, defaultAuthMethod: "none" },
      { label: "B", role: "signer", required: true, routingStep: 3, defaultAuthMethod: "none" },
    ])).toThrow(WorkflowTemplateMalformedError);
  });

  it("refuses a template where nobody can act", () => {
    // Viewers and carbon-copies hold no signing access, so this routes to an
    // empty audience and can never complete.
    expect(() => validateRoleSlots([
      { label: "Watcher", role: "viewer", required: false, routingStep: 1, defaultAuthMethod: "none" },
      { label: "Copy", role: "carbon-copy", required: false, routingStep: 1, defaultAuthMethod: "none" },
    ])).toThrow(WorkflowTemplateMalformedError);
  });

  it("accepts parallel slots — equal steps are the point, not a mistake", () => {
    const slots = validateRoleSlots([
      { label: "A", role: "signer", required: true, routingStep: 1, defaultAuthMethod: "none" },
      { label: "B", role: "signer", required: true, routingStep: 1, defaultAuthMethod: "none" },
    ]);
    expect(slots).toHaveLength(2);
  });

  it("refuses a malformed slot at the WRITE, so it is never stored", async () => {
    const h = await harness();
    await expect(createWorkflowTemplate(actor(OWNER), h.workspaceId, {
      ...VALID,
      roleSlots: [{ label: "X", role: "wizard", required: true, routingStep: 1, defaultAuthMethod: "none" }],
    }, h.deps)).rejects.toBeInstanceOf(WorkflowTemplateMalformedError);

    const list = await listWorkflowTemplates(actor(OWNER), h.workspaceId, h.deps);
    expect(list).toHaveLength(0);
  });

  it("refuses to APPLY a stored template whose slots went bad", async () => {
    // The row is corrupted behind the application's back — a hand-edited
    // column, a bad migration, an older writer. The apply path must refuse
    // rather than build a partial routing configuration.
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);

    const stored = h.store.workflowTemplates.find(
      t => t.workflowTemplateId === template.workflowTemplateId)!;
    (stored as { roleSlots: unknown }).roleSlots = [{ label: "X", role: "sorcerer" }];

    await expect(resolveTemplateForApply(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps))
      .rejects.toBeInstanceOf(WorkflowTemplateMalformedError);
  });

  it("refuses an unknown routing mode", async () => {
    const h = await harness();
    await expect(createWorkflowTemplate(
      actor(OWNER), h.workspaceId, { ...VALID, routingMode: "round-robin" }, h.deps))
      .rejects.toBeInstanceOf(WorkflowTemplateMalformedError);
  });

  it("refuses a blank name", async () => {
    const h = await harness();
    await expect(createWorkflowTemplate(
      actor(OWNER), h.workspaceId, { ...VALID, name: "   " }, h.deps))
      .rejects.toBeInstanceOf(WorkflowTemplateMalformedError);
  });
});

// ── Names ────────────────────────────────────────────────────────────────────

describe("names are unique per workspace", () => {
  it("refuses a duplicate, ignoring case and surrounding space", async () => {
    const h = await harness();
    await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);
    await expect(createWorkflowTemplate(
      actor(OWNER), h.workspaceId, { ...VALID, name: "  hr onboarding  " }, h.deps))
      .rejects.toBeInstanceOf(WorkflowTemplateNameTakenError);
  });

  it("lets a template keep its own name when updated", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);
    const updated = await updateWorkflowTemplate(
      actor(OWNER), h.workspaceId, template.workflowTemplateId,
      { ...VALID, routingMode: "sequential" }, h.deps);
    expect(updated.routingMode).toBe("sequential");
  });
});

// ── Snapshot, not reference ──────────────────────────────────────────────────

describe("applying a template takes a COPY", () => {
  it("does not change what a caller already resolved when the template is edited", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);

    const applied = await resolveTemplateForApply(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps);
    expect(applied.roleSlots).toHaveLength(3);

    // The admin rewrites the template completely afterwards.
    await updateWorkflowTemplate(actor(OWNER), h.workspaceId, template.workflowTemplateId, {
      name: "HR Onboarding",
      routingMode: "sequential",
      roleSlots: [
        { label: "Only Signer", role: "signer", required: true, routingStep: 1, defaultAuthMethod: "none" },
      ],
      completionSettings: { notifySenderOnComplete: false },
    }, h.deps);

    // What was already resolved is untouched.
    expect(applied.roleSlots).toHaveLength(3);
    expect(applied.routingMode).toBe("approval-based");
    expect(applied.completionSettings.notifySenderOnComplete).toBe(true);
  });

  it("hands back no template id, so a caller cannot store a live pointer", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);
    const applied = await resolveTemplateForApply(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps);

    expect(JSON.stringify(applied)).not.toContain(template.workflowTemplateId);
  });

  it("survives deleting the template it came from", async () => {
    const h = await harness();
    const template = await createWorkflowTemplate(actor(OWNER), h.workspaceId, VALID, h.deps);
    const applied = await resolveTemplateForApply(
      actor(SENDER), h.workspaceId, template.workflowTemplateId, h.deps);

    await deleteWorkflowTemplate(actor(OWNER), h.workspaceId, template.workflowTemplateId, h.deps);

    expect(applied.roleSlots).toHaveLength(3);
    await expect(getWorkflowTemplate(
      actor(OWNER), h.workspaceId, template.workflowTemplateId, h.deps))
      .rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});
