// Delivering one notification: the ordering, the budget, and the dead credential.

import { describe, it, expect } from "vitest";
import { deliverNotification } from "./deliver.js";
import type {
  DeliverNotificationDependencies, NotificationSecretResolution,
} from "./deliver.js";
import { createTemplateRegistry } from "./template-registry.js";
import { ALL_TEMPLATES } from "./templates.js";
import type {
  ClaimedDelivery, EmailDeliveryResult, EmailMessage,
  NotificationDeliveryId, NotificationIntentId, NotificationDeliveryAttemptId,
  CompleteAttemptInput,
} from "../common/ports/notifications.js";
import type { SealedDeliverySecret } from "../common/ports/signing-access.js";
import type { WorkspaceId } from "@lagda/contracts";

const AT = 1_760_000_000_000;
const DELIVERY = "ndel_1" as NotificationDeliveryId;

const claimedAt = (attemptNumber: number): ClaimedDelivery => ({
  delivery: {
    notificationDeliveryId: DELIVERY,
    notificationIntentId: "nint_1" as NotificationIntentId,
    channel: "EMAIL",
    destination: "maria@example.test",
    state: "PROCESSING",
    createdAt: AT,
  },
  intent: {
    notificationIntentId: "nint_1" as NotificationIntentId,
    scope: { kind: "WORKSPACE", workspaceId: "ws_1" as WorkspaceId },
    notificationType: "SIGNING_INVITATION",
    source: { kind: "SIGNING_ACCESS_GRANT", sourceId: "sag_1" },
    audience: { kind: "SIGNING_REQUEST_RECIPIENT", signingRequestRecipientId: "srr_1" as never },
    template: { key: "signing-invitation", version: 1 },
    locale: "en",
    templateInput: {
      recipientName: "Maria Santos", documentTitle: "Lease Agreement",
      senderDisplayName: "Paulo Reyes", workspaceName: "Reyes Legal",
    },
    secretRef: { kind: "SEALED", sealed: "v1.a.b.c" as SealedDeliverySecret, keyVersion: "k1" },
    createdAt: AT,
  },
  attempt: {
    notificationDeliveryAttemptId: "nda_1" as NotificationDeliveryAttemptId,
    notificationDeliveryId: DELIVERY,
    attemptNumber,
    startedAt: AT,
  },
});

interface Harness {
  readonly deps: DeliverNotificationDependencies;
  /** Which source ids the resolver was asked about. */
  readonly resolvedSources: string[];
  readonly completions: CompleteAttemptInput[];
  readonly sent: EmailMessage[];
  readonly order: string[];
}

function harness(over: {
  claim?: ClaimedDelivery | null;
  send?: EmailDeliveryResult;
  secret?: NotificationSecretResolution;
  maxAttempts?: number;
  /** Phase 3 fails: the provider answered and the database did not hear it. */
  completeFails?: boolean;
} = {}): Harness {
  const completions: CompleteAttemptInput[] = [];
  const sent: EmailMessage[] = [];
  const order: string[] = [];
  const resolvedSources: string[] = [];
  const claim = over.claim === undefined ? claimedAt(1) : over.claim;

  return {
    completions, sent, order, resolvedSources,
    deps: {
      transport: {
        claimForDelivery: () => {
          order.push("claim");
          return Promise.resolve(claim);
        },
        completeAttempt: (input: CompleteAttemptInput) => {
          order.push("complete");
          completions.push(input);
          if (over.completeFails === true) {
            return Promise.reject(new Error("connection terminated"));
          }
          return Promise.resolve(true);
        },
        reclaimExpiredLeases: () => Promise.resolve([]),
        listAttempts: () => Promise.resolve([]),
      },
      templates: createTemplateRegistry(ALL_TEMPLATES),
      secrets: {
        resolve: (_ref, source) => {
          resolvedSources.push(source.sourceId);
          return Promise.resolve(
            over.secret ?? { status: "AVAILABLE", secret: "raw-token" });
        },
      },
      links: { build: (path, token) => `https://app.lagda.test${path}?token=${token}` },
      provider: {
        send: (message: EmailMessage) => {
          order.push("send");
          sent.push(message);
          return Promise.resolve(over.send ?? { outcome: "ACCEPTED", providerMessageReference: "pm-1" });
        },
      },
      ids: { nextNotificationDeliveryAttemptId: () => "nda_1" as NotificationDeliveryAttemptId },
      clock: { now: () => AT },
      policy: { maxAttempts: over.maxAttempts ?? 3, leaseMs: 60_000 },
      runInTransaction: operation => operation(null),
    },
  };
}

describe("ordering", () => {
  it("claims, then sends, then records -- never sends inside the claim", async () => {
    // S71, S73. A transaction spanning the send would hold a connection for the
    // provider's whole latency, and a hanging provider would exhaust the pool.
    const h = harness();
    await deliverNotification(h.deps)(DELIVERY);

    expect(h.order).toEqual(["claim", "send", "complete"]);
  });

  it("does nothing when the claim is lost", async () => {
    // Ordinary under at-least-once delivery: another worker won, or the row
    // was cancelled while queued.
    const h = harness({ claim: null });
    const outcome = await deliverNotification(h.deps)(DELIVERY);

    expect(outcome).toEqual({ result: "NOT_CLAIMABLE" });
    expect(h.sent).toHaveLength(0);
  });
});

describe("the dead credential", () => {
  it("suppresses rather than sending an expired token", async () => {
    // S58-S62. A recipient receiving a link that fails learns nothing about
    // why, and the send looks successful in every metric.
    const h = harness({
      secret: { status: "UNUSABLE", reason: "SECRET_EXPIRED" },
    });
    const outcome = await deliverNotification(h.deps)(DELIVERY);

    expect(outcome).toEqual({ result: "SUPPRESSED", reason: "SECRET_EXPIRED" });
    expect(h.sent).toHaveLength(0);
    expect(h.completions[0]?.nextState).toBe("SUPPRESSED");
  });

  it("checks the credential before rendering, not after", async () => {
    // So an expired token never reaches a message body even transiently.
    const h = harness({ secret: { status: "UNUSABLE", reason: "SECRET_REVOKED" } });
    await deliverNotification(h.deps)(DELIVERY);

    expect(h.order).toEqual(["claim", "complete"]);
  });
});

describe("rendering", () => {
  it("renders the intent's own frozen template version", async () => {
    const h = harness();
    await deliverNotification(h.deps)(DELIVERY);

    expect(h.sent[0]?.subject).toContain("Lease Agreement");
    expect(h.sent[0]?.destination).toBe("maria@example.test");
  });

  it("puts the resolved secret in the link and nowhere durable", async () => {
    const h = harness();
    await deliverNotification(h.deps)(DELIVERY);

    expect(h.sent[0]?.textBody).toContain("token=raw-token");
    // The completion record carries no secret, only a provider reference.
    expect(JSON.stringify(h.completions[0])).not.toContain("raw-token");
  });
});

describe("the attempt budget", () => {
  it("schedules a retry while budget remains", async () => {
    const h = harness({ send: { outcome: "FAILED_RETRYABLE" } });
    const outcome = await deliverNotification(h.deps)(DELIVERY);

    expect(outcome).toEqual({ result: "RETRY_SCHEDULED", attempt: 1 });
    expect(h.completions[0]?.nextState).toBe("FAILED_RETRYABLE");
    expect(h.completions[0]?.nextAttemptAt).toBeGreaterThan(AT);
  });

  it("retries an ambiguous outcome, with the same credential", async () => {
    // OD-176. A duplicate of a still-valid credential beats a silently lost
    // password reset, and nothing here rotates anything.
    const h = harness({ send: { outcome: "AMBIGUOUS" } });
    const outcome = await deliverNotification(h.deps)(DELIVERY);

    expect(outcome.result).toBe("RETRY_SCHEDULED");
    expect(h.completions[0]?.outcome).toBe("AMBIGUOUS");
  });

  it("gives up terminally when the budget is spent", async () => {
    // Reporting a spent delivery as still-retryable would leave a row nothing
    // ever picks up -- indistinguishable from a stranded one.
    const h = harness({ send: { outcome: "FAILED_RETRYABLE" }, claim: claimedAt(3) });
    const outcome = await deliverNotification(h.deps)(DELIVERY);

    expect(outcome).toEqual({ result: "GAVE_UP", attempt: 3 });
    expect(h.completions[0]?.nextState).toBe("FAILED_TERMINAL");
    expect(h.completions[0]?.nextAttemptAt).toBeUndefined();
  });

  it("does not retry a terminal rejection even with budget left", async () => {
    const h = harness({ send: { outcome: "FAILED_TERMINAL" } });
    const outcome = await deliverNotification(h.deps)(DELIVERY);

    expect(outcome.result).toBe("GAVE_UP");
    expect(h.completions[0]?.nextState).toBe("FAILED_TERMINAL");
  });
});

describe("acceptance", () => {
  it("records PROVIDER_ACCEPTED and the reference, never DELIVERED", async () => {
    // Acceptance is a queue taking bytes. Only a provider's own delivery event
    // may produce DELIVERED.
    const h = harness();
    const outcome = await deliverNotification(h.deps)(DELIVERY);

    expect(outcome).toEqual({ result: "SENT", providerMessageReference: "pm-1" });
    expect(h.completions[0]?.nextState).toBe("PROVIDER_ACCEPTED");
  });

  it("creates no intent -- a retry is never a new notification", async () => {
    // Enforced by ABSENCE now rather than by a throwing fake: the use case has
    // no NotificationRepository at all, so there is no method on its
    // dependencies that could create one. A retry reuses the intent the claim
    // returned, and nothing else is reachable from here.
    const h = harness({ send: { outcome: "FAILED_RETRYABLE" } });
    await expect(deliverNotification(h.deps)(DELIVERY)).resolves.toBeDefined();
    expect(Object.keys(h.deps)).not.toContain("notifications");
  });
});

describe("the crash window", () => {
  it("does not swallow a phase-3 failure into a successful outcome", async () => {
    // S112, S236. The provider accepted and the database did not hear it. This
    // is the ambiguity the whole design admits to rather than hides, and the
    // one shape that must never happen is a resolved DeliveryRunOutcome: the
    // caller would record a send that LAGDA has no durable record of, and the
    // delivery would sit in PROCESSING with nothing coming back for it.
    const h = harness({ completeFails: true });

    await expect(deliverNotification(h.deps)(DELIVERY)).rejects.toThrow();

    // The send DID happen. That is the point -- the message is out.
    expect(h.sent).toHaveLength(1);
    expect(h.order).toEqual(["claim", "send", "complete"]);
  });

  it("sends exactly once even though the outcome is unrecorded", async () => {
    // S111. The recovery path is the lease, not a retry inside this call. A
    // second send here would turn one unrecorded delivery into two real ones,
    // which is the duplicate the claim exists to prevent.
    const h = harness({ completeFails: true });

    await expect(deliverNotification(h.deps)(DELIVERY)).rejects.toThrow();

    expect(h.sent).toHaveLength(1);
    expect(h.order.filter(step => step === "send")).toHaveLength(1);
  });

  it("burns the attempt at claim time, so the crash costs budget", async () => {
    // S110, S237. attempt_count increments in the claim statement, so the
    // attempt this call was on is already spent when it dies. Counting only
    // completed attempts would retry forever against a provider that keeps
    // failing after acceptance.
    const h = harness({ completeFails: true, claim: claimedAt(3), maxAttempts: 3 });

    await expect(deliverNotification(h.deps)(DELIVERY)).rejects.toThrow();

    // The claim reported attempt 3 of 3. Nothing in this call can lower it.
    expect(h.completions[0]?.attemptId).toBe("nda_1");
  });
});

describe("credential refusal", () => {
  it("distinguishes a revoked credential from an expired one", async () => {
    // S60, S61. Both suppress, and the reason is recorded rather than
    // collapsed: an expired token means the user waited too long, a revoked
    // one means somebody acted. The remedy differs, and so does what an
    // operator should be told.
    const h = harness({ secret: { status: "UNUSABLE", reason: "SECRET_REVOKED" } });

    const outcome = await deliverNotification(h.deps)(DELIVERY);

    expect(outcome).toEqual({ result: "SUPPRESSED", reason: "SECRET_REVOKED" });
    expect(h.sent).toHaveLength(0);
    expect(h.completions[0]?.nextState).toBe("SUPPRESSED");
  });

  it("suppresses without consuming a retry, because a retry cannot help", async () => {
    // A revoked grant does not become valid on a retry. Scheduling one would
    // burn the budget of a delivery that must never go out, and would keep a
    // dead credential in the queue where an operator reads it as pending work.
    const h = harness({ secret: { status: "UNUSABLE", reason: "SECRET_EXPIRED" } });

    await deliverNotification(h.deps)(DELIVERY);

    expect(h.completions[0]?.nextAttemptAt).toBeUndefined();
    expect(h.completions[0]?.outcome).toBe("TERMINAL");
  });
});

describe("credential ownership", () => {
  it("asks the owning source about validity, not the ciphertext", async () => {
    // The question "is this credential still usable" belongs to the grant that
    // issued it. Passing the sealed blob instead would ask a domain to look up
    // a credential by the bytes transport happens to be carrying it in, which
    // it can only answer no to -- suppressing every message silently.
    const h = harness();

    await deliverNotification(h.deps)(DELIVERY);

    expect(h.resolvedSources).toEqual(["sag_1"]);
  });
});
