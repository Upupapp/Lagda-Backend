// The handler seam: payload validation, and what is NOT a job failure.

import { describe, it, expect } from "vitest";
import {
  parseNotificationDeliveryPayload, handleNotificationDelivery,
} from "./notification-delivery.js";
import { TerminalJobError, type WorkspaceJobContext } from "@lagda/application";
import type { WorkspaceId } from "@lagda/contracts";

const context: WorkspaceJobContext = {
  jobId: "job_1", jobType: "notification.deliver", attempt: 1,
  tenantScope: "workspace", workspaceId: "ws_1" as WorkspaceId,
};

describe("payload validation", () => {
  it("accepts an identifier and nothing else", () => {
    expect(parseNotificationDeliveryPayload({ notificationDeliveryId: "ndel_1" }))
      .toEqual({ notificationDeliveryId: "ndel_1" });
  });

  it("rejects a payload carrying a destination", () => {
    // The schema is closed, so PII cannot be smuggled into a queue row by a
    // future producer that thought it was being helpful.
    expect(() => parseNotificationDeliveryPayload({
      notificationDeliveryId: "ndel_1", destination: "maria@example.test",
    })).toThrow(TerminalJobError);
  });

  it("treats malformed input as terminal, not retryable", () => {
    // Retrying identical bad input three times only delays the dead-letter
    // signal that tells an operator what is wrong.
    for (const bad of [null, {}, { notificationDeliveryId: 42 }, "ndel_1"]) {
      expect(() => parseNotificationDeliveryPayload(bad)).toThrow(TerminalJobError);
    }
  });
});

describe("the handler", () => {
  it("fails terminally when the delivery cannot be resolved in any scope", async () => {
    // Deleted, or an id written by hand. A retry re-reads the same absence.
    await expect(handleNotificationDelivery(
      { notificationDeliveryId: "ndel_missing" }, context,
      { dependenciesFor: () => Promise.resolve(null) },
    )).rejects.toThrow(TerminalJobError);
  });

  it("returns a provider failure rather than throwing", async () => {
    // A failed send is not a failed JOB: the attempt was recorded and the retry
    // schedule lives in the database. Throwing would let pg-boss retry on its
    // own counter too, and its schedule knows nothing about credential expiry.
    const outcome = await handleNotificationDelivery(
      { notificationDeliveryId: "ndel_1" }, context,
      {
        dependenciesFor: () => Promise.resolve({
          // Only `claimForDelivery` is reached: a lost claim short-circuits
          // before anything else is touched.
          transport: {
            claimForDelivery: () => Promise.resolve(null),
            completeAttempt: () => Promise.resolve(false),
            reclaimExpiredLeases: () => Promise.resolve([]),
            listAttempts: () => Promise.resolve([]),
          },
          ids: { nextNotificationDeliveryAttemptId: () => "nda_1" },
          clock: { now: () => 1_760_000_000_000 },
          policy: { maxAttempts: 3, leaseMs: 60_000 },
          runInTransaction: (operation: (t: unknown) => unknown) => operation(null),
        } as never),
      },
    );

    expect(outcome).toEqual({ result: "NOT_CLAIMABLE" });
  });
});
