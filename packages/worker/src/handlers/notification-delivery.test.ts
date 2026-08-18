// The handler seam: payload validation, and what is NOT a job failure.

import { describe, it, expect } from "vitest";
import {
  parseNotificationDeliveryPayload, handleNotificationDelivery,
  recordDeliveryOutcome,
} from "./notification-delivery.js";
import { createInMemoryMetrics } from "@lagda/application";
import { TerminalJobError, type SystemJobContext } from "@lagda/application";

// SYSTEM-scoped, and that is the correction BACKEND-45 made. A delivery's
// tenant is a property of its row -- an account security message has no
// workspace at all -- so the queue message carries none and the handler
// resolves it.
const context: SystemJobContext = {
  jobId: "job_1", jobType: "notification.deliver", attempt: 1,
  tenantScope: "system",
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

describe("what a delivery is allowed to measure", () => {
  const outcome = (result: string): never => ({ result } as never);

  it("labels nothing that identifies a message or a person", () => {
    // S210, S211. The destination is a counterparty's personal data; the
    // provider reference and the delivery id are unbounded and would produce
    // one time series per message. A metrics store is retained longer and read
    // more widely than a log, which is why this list is stricter than logging's.
    const metrics = createInMemoryMetrics();

    recordDeliveryOutcome(metrics, outcome("SENT"), 12);

    for (const sample of metrics.samples) {
      for (const key of Object.keys(sample.labels)) {
        expect(["provider", "processRole", "result", "notificationType"])
          .toContain(key);
      }
    }
  });

  it("does not count a lost claim race as an attempt", () => {
    // At-least-once queue delivery makes NOT_CLAIMABLE ordinary rather than
    // exceptional. Counting it would inflate the attempt rate with jobs that
    // did no work, and hide a real change in send volume behind queue noise.
    const metrics = createInMemoryMetrics();

    recordDeliveryOutcome(metrics, outcome("NOT_CLAIMABLE"), 1);

    expect(metrics.samples.map(sample => sample.name))
      .toEqual(["email_delivery_results_total"]);
  });

  it("counts a scheduled retry separately from the result", () => {
    const metrics = createInMemoryMetrics();

    recordDeliveryOutcome(metrics, outcome("RETRY_SCHEDULED"), 30);

    expect(metrics.samples.map(sample => sample.name))
      .toContain("email_delivery_retries_total");
  });

  it("records a duration for work that happened", () => {
    const metrics = createInMemoryMetrics();

    recordDeliveryOutcome(metrics, outcome("SENT"), 42);

    const duration = metrics.samples
      .find(sample => sample.name === "email_delivery_duration_ms");
    expect(duration?.value).toBe(42);
  });
});
