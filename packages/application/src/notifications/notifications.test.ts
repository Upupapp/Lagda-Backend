// Creating notifications: the policy, the freeze, and the two kinds of repeat.

import { describe, it, expect } from "vitest";
import type {
  NotificationRepository, NewNotificationIntent, NotificationCreationResult,
  NotificationDeliveryRecord, NotificationIntentId, NotificationDeliveryId,
} from "../common/ports/notifications.js";
import type { SealedDeliverySecret } from "../common/ports/signing-access.js";
import type { SigningRequestRecipientId } from "../common/ports/signing-requests.js";
import {
  NOTIFICATION_TYPES, NOTIFICATION_CHANNELS, NOTIFICATION_DELIVERY_STATES,
  ATTEMPT_OUTCOMES,
} from "../common/ports/notifications.js";
import {
  ATTEMPT_OUTCOMES as CORE_ATTEMPT_OUTCOMES, deliveryStateForOutcome,
} from "@lagda/core";
import type { WorkspaceId, UserId } from "@lagda/contracts";
import { createTemplateRegistry } from "./template-registry.js";
import { ALL_TEMPLATES } from "./templates.js";
import { NOTIFICATION_POLICIES, policyFor } from "./policy.js";
import { createNotificationIntent, NotificationPolicyViolation } from "./create-intent.js";
import {
  reconcileNotificationDeliveries, RECONCILIATION_GRACE_MS,
} from "./reconciliation.js";

// ── A fake that enforces the one rule the real table enforces ────────────────
//
// Uniqueness on (sourceKind, sourceId, notificationType). Everything else about
// persistence is the integration suite's business; this exists so the use case
// can be tested without PostgreSQL.
function fakeRepository(): NotificationRepository & {
  readonly rows: Map<string, NotificationCreationResult>;
} {
  const rows = new Map<string, NotificationCreationResult>();

  return {
    rows,
    createIfAbsent(input: NewNotificationIntent) {
      const key = `${input.source.kind}|${input.source.sourceId}|${input.notificationType}`;
      const existing = rows.get(key);
      if (existing !== undefined) {
        return Promise.resolve({ ...existing, outcome: "ALREADY_EXISTS" as const });
      }

      const created: NotificationCreationResult = {
        outcome: "CREATED",
        intent: {
          notificationIntentId: input.notificationIntentId,
          scope: input.scope,
          notificationType: input.notificationType,
          source: input.source,
          audience: input.audience,
          template: input.template,
          locale: input.locale,
          templateInput: input.templateInput,
          ...(input.secretRef === undefined ? {} : { secretRef: input.secretRef }),
          createdAt: input.createdAt,
        },
        delivery: {
          notificationDeliveryId: input.notificationDeliveryId,
          notificationIntentId: input.notificationIntentId,
          channel: input.channel,
          destination: input.destination,
          state: "PENDING",
          createdAt: input.createdAt,
        },
      };
      rows.set(key, created);
      return Promise.resolve(created);
    },
    findIntentById: () => Promise.resolve(null),
    findDeliveryById: () => Promise.resolve(null),
    findPendingDeliveries: () => Promise.resolve([]),
    stopPendingDelivery: () => Promise.resolve(true),
  };
}

const templates = createTemplateRegistry(ALL_TEMPLATES);

const signingInvitation = {
  notificationType: "SIGNING_INVITATION" as const,
  sourceId: "grant_1",
  scope: { kind: "WORKSPACE" as const, workspaceId: "ws_1" as WorkspaceId },
  audience: {
    kind: "SIGNING_REQUEST_RECIPIENT" as const,
    signingRequestRecipientId: "srr_1" as SigningRequestRecipientId,
  },
  destination: "alice@example.test",
  templateInput: {
    recipientName: "Maria Santos",
    documentTitle: "Lease Agreement",
    senderDisplayName: "Paulo Reyes",
    workspaceName: "Reyes Legal",
  },
  secretRef: {
    kind: "SEALED" as const,
    sealed: "v1.aa.bb.cc" as SealedDeliverySecret,
    keyVersion: "k1",
  },
};

const passwordReset = {
  notificationType: "PASSWORD_RESET" as const,
  sourceId: "chal_1",
  scope: { kind: "GLOBAL_USER" as const, userId: "usr_1" as UserId },
  audience: { kind: "USER" as const, userId: "usr_1" as UserId },
  destination: "alice@example.test",
  templateInput: { recipientName: "Maria Santos" },
  secretRef: { kind: "CHALLENGE" as const, challengeId: "chal_1" },
};

const signingCompleted = {
  notificationType: "SIGNING_COMPLETED" as const,
  sourceId: "sreq_1",
  scope: { kind: "WORKSPACE" as const, workspaceId: "ws_1" as WorkspaceId },
  audience: { kind: "USER" as const, userId: "usr_1" as UserId },
  destination: "paulo@example.test",
  templateInput: {
    recipientName: "Paulo Reyes",
    documentTitle: "Lease Agreement",
    workspaceName: "Reyes Legal",
    signerCount: 2,
  },
  // No `secretRef`. The only type for which that is correct.
};

describe("the policy table", () => {
  it("declares a policy for every notification type", () => {
    // A `Record` over the closed union, so a missing entry is a compile error.
    // This asserts the runtime shape matches, which the compiler cannot.
    for (const type of NOTIFICATION_TYPES) {
      expect(NOTIFICATION_POLICIES[type].notificationType).toBe(type);
    }
    expect(Object.keys(NOTIFICATION_POLICIES)).toHaveLength(NOTIFICATION_TYPES.length);
  });

  it("registers a template for every policy", () => {
    // A policy naming copy that does not exist would fail at send time, when
    // the message is already owed to somebody.
    for (const type of NOTIFICATION_TYPES) {
      const policy = policyFor(type);
      expect(() => templates.currentVersion(policy.templateKey)).not.toThrow();
    }
  });

  it("uses EMAIL for every policy, the only channel that exists", () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(NOTIFICATION_CHANNELS as readonly string[])
        .toContain(policyFor(type).channel);
    }
  });

  it("scopes account security messages to the user, never a workspace", () => {
    // S46, S186. Filing a password reset under a workspace would leak it to
    // that workspace's admins and orphan it when the workspace is deleted.
    for (const type of ["PASSWORD_RESET", "ACCOUNT_EMAIL_VERIFICATION"] as const) {
      expect(policyFor(type).scopeKind).toBe("GLOBAL_USER");
    }
  });

  it("keys a signing invitation on the grant, not the request", () => {
    // S39. Keying on the request would collapse a five-recipient request into
    // one notification.
    expect(policyFor("SIGNING_INVITATION").sourceKind).toBe("SIGNING_ACCESS_GRANT");
  });

  it("references auth secrets by challenge and signing secrets sealed", () => {
    // S102, S233. Auth flows persist digests and never raw values; forcing them
    // to SEALED would start storing secrets that today are not stored at all.
    expect(policyFor("PASSWORD_RESET").secretKind).toBe("CHALLENGE");
    expect(policyFor("ACCOUNT_EMAIL_VERIFICATION").secretKind).toBe("CHALLENGE");
    expect(policyFor("SIGNING_INVITATION").secretKind).toBe("SEALED");
  });

  it("declares no account-login OTP type", () => {
    // Removed by BACKEND-45. BACKEND-16's own inventory found there is no
    // email-OTP login flow in the product: the factor is TOTP, computed from a
    // shared secret and never issued or delivered. The "Email OTP" the product
    // advertises is SIGNER authentication -- a recipient, not a user -- and it
    // would need its own type with its own audience and scope.
    expect(NOTIFICATION_TYPES as readonly string[]).not.toContain("MFA_OTP");
  });

  it("declares no reminder or expiration type", () => {
    // S229, S230. BACKEND-46 owns the policy that would produce them.
    for (const type of NOTIFICATION_TYPES as readonly string[]) {
      expect(type).not.toMatch(/REMINDER|EXPIR/u);
    }
  });
});

describe("creating an intent", () => {
  const create = (repository = fakeRepository()) => {
    let n = 0;
    return {
      repository,
      run: createNotificationIntent({
        notifications: repository, templates,
        ids: {
          nextNotificationIntentId: () => `nint_${++n}` as NotificationIntentId,
          nextNotificationDeliveryId: () => `ndel_${n}` as NotificationDeliveryId,
        },
        clock: { now: () => 1_700_000_000_000 },
      }),
    };
  };

  it("creates one intent with a PENDING delivery", () => {
    // S238.
    const { run } = create();
    return run(signingInvitation, undefined).then(result => {
      expect(result.outcome).toBe("CREATED");
      expect(result.delivery.state).toBe("PENDING");
      expect(result.delivery.destination).toBe("alice@example.test");
    });
  });

  it("freezes the template version at creation", () => {
    const { run } = create();
    return run(signingInvitation, undefined).then(result => {
      expect(result.intent.template).toEqual({ key: "signing-invitation", version: 1 });
      expect(result.intent.locale).toBe("en");
    });
  });

  it("returns the existing intent for a duplicated source", async () => {
    // S239. A replayed event must not produce a second message.
    const { run } = create();
    const first = await run(signingInvitation, undefined);
    const second = await run(signingInvitation, undefined);

    expect(second.outcome).toBe("ALREADY_EXISTS");
    expect(second.intent.notificationIntentId)
      .toBe(first.intent.notificationIntentId);
  });

  it("creates a distinct intent for a legitimate second occurrence", async () => {
    // S138, S140, S241. A new OTP challenge is a new source id, so it is a new
    // notification rather than a collision -- which is exactly why the logical
    // key is built on source identity and not on the user.
    const { run } = create();
    const first = await run(
      { ...passwordReset, sourceId: "chal_1" },
      undefined,
    );
    const second = await run(
      { ...passwordReset, sourceId: "chal_2" },
      undefined,
    );

    expect(first.outcome).toBe("CREATED");
    expect(second.outcome).toBe("CREATED");
    expect(second.intent.notificationIntentId)
      .not.toBe(first.intent.notificationIntentId);
  });

  it("creates a global-user intent with no workspace at all", async () => {
    // S273. No fake WorkspaceId anywhere in the record.
    const { run } = create();
    const result = await run(passwordReset, undefined);

    expect(result.intent.scope).toEqual({ kind: "GLOBAL_USER", userId: "usr_1" });
    expect(JSON.stringify(result.intent)).not.toContain("workspaceId");
  });

  it("rejects an audience that does not match the type", async () => {
    const { run } = create();
    await expect(run(
      { ...signingInvitation, audience: { kind: "USER", userId: "usr_1" as UserId } },
      undefined,
    )).rejects.toThrow(NotificationPolicyViolation);
  });

  it("rejects a workspace scope on an account security message", async () => {
    const { run } = create();
    await expect(run(
      {
        ...passwordReset,
        scope: { kind: "WORKSPACE", workspaceId: "ws_1" as WorkspaceId },
      },
      undefined,
    )).rejects.toThrow(NotificationPolicyViolation);
  });

  it("rejects a sealed secret where the policy expects a challenge", async () => {
    // Storing a raw-ish credential for a flow that only keeps digests would be
    // a silent weakening of that flow's posture.
    const { run } = create();
    await expect(run(
      {
        ...passwordReset,
        secretRef: {
          kind: "SEALED",
          sealed: "v1.aa.bb.cc" as SealedDeliverySecret,
          keyVersion: "k1",
        },
      },
      undefined,
    )).rejects.toThrow(NotificationPolicyViolation);
  });

  it("creates an intent with NO secret reference at all", async () => {
    // `SIGNING_COMPLETED` is the first type that carries no credential, and
    // the row must record that as absence rather than as a placeholder:
    // migration 030's `notification_intents_secret_ref_check` has an explicit
    // all-null branch, and a sentinel value would have to be mapped back to
    // NULL on the way in and out.
    const { run } = create();

    const result = await run(signingCompleted, undefined);

    expect(result.intent.secretRef).toBeUndefined();
    expect(JSON.stringify(result.intent)).not.toContain("secretRef");
  });

  it("rejects a credential offered for a type that carries none", async () => {
    // Would persist a secret on a row nothing will ever resolve or clear.
    const { repository, run } = create();

    await expect(run(
      {
        ...signingCompleted,
        secretRef: { kind: "CHALLENGE", challengeId: "chal_1" },
      },
      undefined,
    )).rejects.toThrow(NotificationPolicyViolation);
    expect(repository.rows.size).toBe(0);
  });

  it("rejects an OMITTED credential for a type that needs one", async () => {
    // The direction that matters more. Without this check, dropping the
    // `secretRef` from an invitation call site would produce a message whose
    // link is missing — discovered by the recipient, not by a test. Now it is
    // refused before the row exists.
    const { repository, run } = create();
    const { secretRef: _omitted, ...withoutSecret } = signingInvitation;

    await expect(run(withoutSecret as never, undefined))
      .rejects.toThrow(NotificationPolicyViolation);
    expect(repository.rows.size).toBe(0);
  });

  it("rejects a template input the template cannot render", async () => {
    // S244, and it fails before the row exists.
    const { repository, run } = create();
    await expect(run(
      { ...signingInvitation, templateInput: { recipientName: "Maria" } },
      undefined,
    )).rejects.toThrow();
    expect(repository.rows.size).toBe(0);
  });

  it("never persists a raw secret in the template input", async () => {
    // S253. The frozen model holds display data; the credential is referenced.
    const { run } = create();
    for (const input of [signingInvitation, passwordReset]) {
      const result = await run(input, undefined);
      const serialized = JSON.stringify(result.intent.templateInput);
      expect(serialized).not.toContain("v1.aa.bb.cc");
      expect(serialized).not.toContain("chal_1");
    }
  });
});

describe("reconciliation", () => {
  const stranded: NotificationDeliveryRecord = {
    notificationDeliveryId: "ndel_1" as NotificationDeliveryId,
    notificationIntentId: "nint_1" as NotificationIntentId,
    channel: "EMAIL",
    destination: "alice@example.test",
    state: "PENDING",
    createdAt: 0,
  };

  it("looks only past the grace period", async () => {
    // A sweep that reports healthy backlog as stranded is a sweep whose output
    // gets ignored.
    const now = 10_000_000_000;
    let observed = -1;
    const repository = { ...fakeRepository(),
      findPendingDeliveries: (olderThan: number) => {
        observed = olderThan;
        return Promise.resolve([]);
      } };

    await reconcileNotificationDeliveries(
      { notifications: repository, clock: { now: () => now } })();

    expect(observed).toBe(now - RECONCILIATION_GRACE_MS);
  });

  it("reports truncation rather than silently capping", async () => {
    // S: a truncated sweep that says nothing reads as "nothing more is wrong".
    const repository = { ...fakeRepository(),
      findPendingDeliveries: (_olderThan: number, limit: number) =>
        Promise.resolve(Array.from({ length: limit }, () => stranded)) };

    const report = await reconcileNotificationDeliveries(
      { notifications: repository, clock: { now: () => 10_000_000_000 } })();

    expect(report.truncated).toBe(true);
  });

  it("changes no state -- it recovers delivery, it does not resend", async () => {
    // S133. No intent is created, no credential minted, no row written.
    let mutations = 0;
    const repository = { ...fakeRepository(),
      findPendingDeliveries: () => Promise.resolve([stranded]),
      stopPendingDelivery: () => { mutations += 1; return Promise.resolve(true); },
      createIfAbsent: () => { mutations += 1; throw new Error("unreachable"); } };

    const report = await reconcileNotificationDeliveries(
      { notifications: repository, clock: { now: () => 10_000_000_000 } })();

    expect(report.stranded).toHaveLength(1);
    expect(mutations).toBe(0);
  });
});

describe("attempt vocabulary", () => {
  it("cannot drift from the domain's", () => {
    // The port re-declares these rather than importing from `@lagda/core`, so
    // an adapter need not depend on the domain package to name a value it
    // persists. That is only safe while the two lists agree.
    expect([...ATTEMPT_OUTCOMES]).toEqual([...CORE_ATTEMPT_OUTCOMES]);
  });

  it("maps every outcome to a state the delivery states declare", () => {
    for (const outcome of ATTEMPT_OUTCOMES) {
      expect(NOTIFICATION_DELIVERY_STATES as readonly string[])
        .toContain(deliveryStateForOutcome(outcome));
    }
  });
});
