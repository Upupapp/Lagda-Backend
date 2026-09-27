// 084. An account's notification preferences suppress OPTIONAL email only.
//
// The properties: a muted category stops the delivery at creation as
// SUPPRESSED / RECIPIENT_PREFERENCE while the intent still exists; nothing a
// preference row can say stops security or transactional mail; only an
// ACCOUNT audience is consulted; a replay does not re-decide a delivery.

import { describe, it, expect } from "vitest";
import type { UserId, WorkspaceId } from "@lagda/contracts";
import type {
  NotificationIntentId, NotificationDeliveryId, NotificationType,
  NotificationIntentRecord, NotificationDeliveryRecord,
} from "../common/ports/notifications.js";
import {
  NOTIFICATION_PREFERENCE_CATEGORIES, type NotificationPreferenceCategory,
} from "../common/ports/notification-preferences.js";
import { fakeNotifications, fakeTemplateRegistry } from "../test-support/fakes.js";
import { createNotificationIntent, type CreateNotificationIntentInput } from "./create-intent.js";
import {
  NOTIFICATION_PREFERENCE_CATEGORY_BY_TYPE, notificationPreferenceCategoryOf,
} from "./preferences.js";
import { NOTIFICATION_POLICIES } from "./policy.js";

const SENDER = "usr_sender" as UserId;
const WS = "ws_1" as WorkspaceId;

function world(muted: Record<string, readonly NotificationPreferenceCategory[]> = {}) {
  const store = {
    notificationIntents: new Map<string, NotificationIntentRecord>(),
    notificationDeliveries: new Map<string, NotificationDeliveryRecord>(),
    mutedNotificationCategories: new Map(
      Object.entries(muted).map(([userId, categories]) => [userId, new Set(categories)])),
  };
  const repository = fakeNotifications(store);
  const preferenceReads: { userId: string; category: string }[] = [];
  const notifications = {
    ...repository,
    isCategoryMutedBy: (userId: UserId, category: NotificationPreferenceCategory, trx: unknown) => {
      preferenceReads.push({ userId, category });
      return repository.isCategoryMutedBy(userId, category, trx);
    },
  };
  let n = 0;
  const run = createNotificationIntent({
    notifications, templates: fakeTemplateRegistry,
    ids: {
      nextNotificationIntentId: () => `nint_${String(++n)}` as NotificationIntentId,
      nextNotificationDeliveryId: () => `ndel_${String(n)}` as NotificationDeliveryId,
    },
    clock: { now: () => 1_700_000_000_000 },
  });
  return { store, run, preferenceReads };
}

const completed = (sourceId = "sreq_1"): CreateNotificationIntentInput => ({
  notificationType: "SIGNING_COMPLETED",
  sourceId,
  scope: { kind: "WORKSPACE", workspaceId: WS },
  audience: { kind: "USER", userId: SENDER },
  destination: "sender@example.test",
  templateInput: {
    recipientName: "Paulo", documentTitle: "Lease", workspaceName: "Reyes Legal", signerCount: 2,
  },
});

const joinRequested: CreateNotificationIntentInput = {
  notificationType: "WORKSPACE_JOIN_REQUESTED",
  sourceId: "jnot_1",
  scope: { kind: "WORKSPACE", workspaceId: WS },
  audience: { kind: "USER", userId: SENDER },
  destination: "sender@example.test",
  templateInput: {
    recipientName: "Paulo", requesterName: "Ana", requesterEmail: "ana@example.test",
    workspaceName: "Reyes Legal",
  },
};

const passwordReset: CreateNotificationIntentInput = {
  notificationType: "PASSWORD_RESET",
  sourceId: "chal_1",
  scope: { kind: "GLOBAL_USER", userId: SENDER },
  audience: { kind: "USER", userId: SENDER },
  destination: "sender@example.test",
  templateInput: { recipientName: "Paulo" },
  secretRef: { kind: "CHALLENGE", challengeId: "chal_1" },
};

const emailVerification: CreateNotificationIntentInput = {
  ...passwordReset,
  notificationType: "ACCOUNT_EMAIL_VERIFICATION",
  sourceId: "chal_2",
  secretRef: { kind: "CHALLENGE", challengeId: "chal_2" },
};

const joinDecided: CreateNotificationIntentInput = {
  notificationType: "WORKSPACE_JOIN_DECIDED",
  sourceId: "jreq_1",
  scope: { kind: "WORKSPACE", workspaceId: WS },
  audience: { kind: "USER", userId: SENDER },
  destination: "sender@example.test",
  templateInput: { recipientName: "Paulo", workspaceName: "Reyes Legal", approved: true },
};

describe("the category table", () => {
  it("maps SIGNING_COMPLETED and WORKSPACE_JOIN_REQUESTED, and nothing else today", () => {
    const mapped = Object.entries(NOTIFICATION_PREFERENCE_CATEGORY_BY_TYPE)
      .filter(([, category]) => category !== null);
    expect(Object.fromEntries(mapped)).toEqual({
      SIGNING_COMPLETED: "requestCompleted",
      WORKSPACE_JOIN_REQUESTED: "workspaceRequests",
    });
  });

  it("decides every notification type", () => {
    expect(Object.keys(NOTIFICATION_PREFERENCE_CATEGORY_BY_TYPE).sort())
      .toEqual(Object.keys(NOTIFICATION_POLICIES).sort());
  });

  it("never gives security or transactional mail a category", () => {
    const ALWAYS_SENT: readonly NotificationType[] = [
      "ACCOUNT_EMAIL_VERIFICATION", "PASSWORD_RESET", "SIGNING_INVITATION",
      "VERIFICATION_ACCESS_CODE", "FINAL_COPY_AVAILABLE", "WORKSPACE_JOIN_LINK",
      "WORKSPACE_JOIN_DECIDED", "WORKSPACE_INVITATION",
    ];
    for (const type of ALWAYS_SENT) expect(notificationPreferenceCategoryOf(type)).toBeNull();
  });

  it("maps only USER-audience types — a preference belongs to an account", () => {
    for (const [type, category] of Object.entries(NOTIFICATION_PREFERENCE_CATEGORY_BY_TYPE)) {
      if (category === null) continue;
      expect(NOTIFICATION_POLICIES[type as NotificationType].audienceKind).toBe("USER");
    }
  });
});

describe("suppression by category", () => {
  it("sends when the account has no preference row", async () => {
    const { run } = world();
    const result = await run(completed(), undefined);
    expect(result.outcome).toBe("CREATED");
    expect(result.delivery.state).toBe("PENDING");
  });

  it("suppresses a completion email when requestCompleted is off, keeping the intent", async () => {
    const { run, store } = world({ [SENDER]: ["requestCompleted"] });
    const result = await run(completed(), undefined);

    expect(result.delivery).toMatchObject({ state: "SUPPRESSED", failureCode: "RECIPIENT_PREFERENCE" });
    // Recorded, not dropped: the intent exists, its delivery is SUPPRESSED.
    expect(store.notificationIntents.size).toBe(1);
    expect([...store.notificationDeliveries.values()][0])
      .toMatchObject({ state: "SUPPRESSED", failureCode: "RECIPIENT_PREFERENCE" });
  });

  it("suppresses a join-request notice when workspaceRequests is off", async () => {
    const { run } = world({ [SENDER]: ["workspaceRequests"] });
    expect((await run(joinRequested, undefined)).delivery.state).toBe("SUPPRESSED");
  });

  it("a category switched off does not reach another category", async () => {
    const { run } = world({ [SENDER]: ["workspaceRequests", "signerActivity", "invitations"] });
    expect((await run(completed(), undefined)).delivery.state).toBe("PENDING");
  });

  it("is per account: another user's switch does not suppress this one", async () => {
    const { run } = world({ usr_other: ["requestCompleted"] });
    expect((await run(completed(), undefined)).delivery.state).toBe("PENDING");
  });

  it("a replay does not re-decide a delivery that already exists", async () => {
    const { run, store, preferenceReads } = world();
    await run(completed(), undefined);
    // The account switches the category off AFTER the first creation.
    store.mutedNotificationCategories.set(SENDER, new Set(["requestCompleted"]));
    const replay = await run(completed(), undefined);
    expect(replay.outcome).toBe("ALREADY_EXISTS");
    expect(replay.delivery.state).toBe("PENDING");
    expect(preferenceReads).toHaveLength(1);
  });
});

describe("never suppressing transactional mail", () => {
  const everythingOff = { [SENDER]: NOTIFICATION_PREFERENCE_CATEGORIES };

  for (const input of [passwordReset, emailVerification, joinDecided]) {
    it(`sends ${input.notificationType} with every switch off, without reading preferences`, async () => {
      const { run, preferenceReads } = world(everythingOff);
      const result = await run(input, undefined);
      expect(result.delivery.state).toBe("PENDING");
      expect(preferenceReads).toHaveLength(0);
    });
  }
});
