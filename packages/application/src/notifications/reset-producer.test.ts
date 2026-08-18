// The account-scoped producer: what it points at, and what it must not become.

import { describe, it, expect } from "vitest";
import { createResetNotificationProducer } from "./reset-producer.js";
import { createTemplateRegistry } from "./template-registry.js";
import { ALL_TEMPLATES } from "./templates.js";
import type {
  NewNotificationIntent, NotificationIntentId, NotificationDeliveryId,
} from "../common/ports/notifications.js";
import type { PasswordResetChallengeId } from "../common/ports/auth.js";
import type { UserId } from "@lagda/contracts";

const AT = 1_760_000_000_000;
const USER = "usr_1" as UserId;
const CHALLENGE = "prc_1" as PasswordResetChallengeId;

function harness() {
  const created: NewNotificationIntent[] = [];
  const producer = createResetNotificationProducer({
    templates: createTemplateRegistry(ALL_TEMPLATES),
    ids: {
      nextNotificationIntentId: () => "nint_1" as NotificationIntentId,
      nextNotificationDeliveryId: () => "ndel_1" as NotificationDeliveryId,
    },
    clock: { now: () => AT },
  });
  const notifications = {
    createIfAbsent: (intent: NewNotificationIntent) => {
      created.push(intent);
      return Promise.resolve({ outcome: "created" as const, intent: intent as never });
    },
  } as never;

  return {
    created,
    run: (over: { displayName?: string | null } = {}) => producer({
      challengeId: CHALLENGE,
      userId: USER,
      destination: "maria@example.test",
      displayName: over.displayName === undefined ? "Maria" : over.displayName,
    }, notifications, null),
  };
}

describe("scope", () => {
  it("is GLOBAL_USER, never a workspace", async () => {
    // A password reset is a fact about a PERSON. Filing it under a workspace
    // would leak it to that workspace's administrators and orphan it when the
    // workspace was deleted.
    const h = harness();

    await h.run();

    expect(h.created[0]?.scope).toEqual({ kind: "GLOBAL_USER", userId: USER });
  });
});

describe("what it carries", () => {
  it("points at the challenge and holds no credential", async () => {
    const h = harness();

    await h.run();

    expect(h.created[0]?.secretRef).toEqual({
      kind: "CHALLENGE", challengeId: CHALLENGE,
    });
    expect(JSON.stringify(h.created[0])).not.toContain("http");
  });

  it("keys the intent on the CHALLENGE, so a rotation is a new message", async () => {
    // A replayed request supersedes the old challenge and mints a new one --
    // a different source, and therefore correctly a different notification
    // rather than a duplicate suppressed by the logical key.
    const h = harness();

    await h.run();

    expect(h.created[0]?.source).toEqual({
      kind: "SECURITY_CHALLENGE", sourceId: CHALLENGE,
    });
  });

  it("mails the account's own address, not the form that resolved it", async () => {
    // Normalisation means the typed address and the account's canonical one
    // can differ. Mail goes to the account.
    const h = harness();

    await h.run();

    expect(h.created[0]?.destination).toBe("maria@example.test");
  });

  it("greets an account with no display name without leaving a gap", async () => {
    const h = harness();

    await h.run({ displayName: null });

    expect((h.created[0]?.templateInput as { recipientName: string }).recipientName)
      .toBe("there");
  });
});
