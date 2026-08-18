// Turning an invitation into a notification: what the intent carries, and what
// it must never carry.

import { describe, it, expect } from "vitest";
import {
  createInvitationNotificationProducer,
} from "./invitation-producer.js";
import { createTemplateRegistry } from "./template-registry.js";
import { ALL_TEMPLATES } from "./templates.js";
import type {
  NewNotificationIntent, NotificationIntentId, NotificationDeliveryId,
} from "../common/ports/notifications.js";
import type {
  WorkspaceId, UserId, WorkspaceInvitationId,
} from "@lagda/contracts";

const AT = 1_760_000_000_000;
const WORKSPACE = "ws_1" as WorkspaceId;
const INVITATION = "inv_1" as WorkspaceInvitationId;
const INVITER = "usr_1" as UserId;

function harness(over: {
  inviterName?: string | null;
  workspaceName?: string | null;
} = {}) {
  const created: NewNotificationIntent[] = [];

  const producer = createInvitationNotificationProducer({
    templates: createTemplateRegistry(ALL_TEMPLATES),
    ids: {
      nextNotificationIntentId: () => "nint_1" as NotificationIntentId,
      nextNotificationDeliveryId: () => "ndel_1" as NotificationDeliveryId,
    },
    clock: { now: () => AT },
  });

  const repositories = {
    notifications: {
      createIfAbsent: (intent: NewNotificationIntent) => {
        created.push(intent);
        return Promise.resolve({ outcome: "created" as const, intent: intent as never });
      },
    },
    workspaces: {
      find: () => Promise.resolve(
        over.workspaceName === null
          ? null
          : { workspaceId: WORKSPACE, name: over.workspaceName ?? "Reyes Legal", createdAt: AT }),
    },
    actorProfiles: {
      displayNameOf: () => Promise.resolve(
        over.inviterName === undefined ? "Paulo Reyes" : over.inviterName),
    },
  } as never;

  return { created, run: () => producer({
    invitationId: INVITATION,
    workspaceId: WORKSPACE,
    invitedByUserId: INVITER,
    inviteeEmail: "maria@example.test",
  }, repositories, null) };
}

describe("what the intent carries", () => {
  it("references the invitation, and carries no credential", async () => {
    // OD-184. A URL or a raw token here would have to live on an immutable
    // notification that could never clear it -- and would bake a hostname into
    // a durable row, stranding every unsent invitation the day the canonical
    // domain changed.
    const h = harness();

    await h.run();

    const intent = JSON.stringify(h.created[0]);
    expect(h.created[0]?.secretRef).toEqual({
      kind: "CHALLENGE", challengeId: INVITATION,
    });
    expect(intent).not.toContain("http");
  });

  it("freezes the names as they were when the invitation was made", async () => {
    // Read inside the caller's transaction, so a workspace renamed next month
    // does not rewrite the wording of mail already promised.
    const h = harness();

    await h.run();

    expect(h.created[0]?.templateInput).toEqual({
      inviterDisplayName: "Paulo Reyes",
      workspaceName: "Reyes Legal",
    });
  });

  it("uses the frozen destination rather than resolving one", async () => {
    // S22. The invitation row froze the address the inviter typed; a later
    // profile edit must not redirect a credential-bearing message.
    const h = harness();

    await h.run();

    expect(h.created[0]?.destination).toBe("maria@example.test");
  });
});

describe("degraded reads", () => {
  it("survives a deleted inviter without failing the invitation", async () => {
    // A missing account must not fail an invitation that is otherwise valid,
    // and must not leave the sentence half-written. The workspace name still
    // carries the meaning.
    const h = harness({ inviterName: null });

    await h.run();

    expect((h.created[0]?.templateInput as { inviterDisplayName: string })
      .inviterDisplayName).toBe("A workspace administrator");
  });

  it("survives an unreadable workspace", async () => {
    const h = harness({ workspaceName: null });

    await h.run();

    expect((h.created[0]?.templateInput as { workspaceName: string })
      .workspaceName).toBe("a LAGDA workspace");
  });
});

describe("policy", () => {
  it("is workspace-scoped, matching the policy table", async () => {
    // An invitation belongs to the workspace that made the offer, even though
    // the invitee is not yet a member -- revoking it is a workspace operation.
    const h = harness();

    await h.run();

    expect(h.created[0]?.scope).toEqual({ kind: "WORKSPACE", workspaceId: WORKSPACE });
  });
});
