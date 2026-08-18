// Worker configuration: the bounds that stop a plausible value from being a
// silent outage.

import { describe, it, expect } from "vitest";
import { loadWorkerConfig, WorkerConfigError } from "./index.js";

/** A minimal environment. Every delivery key is absent unless a test adds it. */
const base = {} as NodeJS.ProcessEnv;

describe("delivery lease", () => {
  it("refuses a lease shorter than the provider call it protects", () => {
    // EMAIL_TIMEOUT_MS is capped at 30s. A lease below that reclaims a send
    // while it is still in flight, and the retry is a real duplicate of a
    // message the provider already has -- manufacturing the exact failure the
    // lease exists to prevent.
    expect(() => loadWorkerConfig({ ...base, DELIVERY_LEASE_MS: "30000" }))
      .toThrow(WorkerConfigError);
  });

  it("refuses a lease long enough to strand a crashed worker", () => {
    expect(() => loadWorkerConfig({ ...base, DELIVERY_LEASE_MS: "3600000" }))
      .toThrow(WorkerConfigError);
  });

  it("defaults to comfortably more than the provider timeout", () => {
    expect(loadWorkerConfig(base).deliveryLeaseMs).toBe(120_000);
  });
});

describe("attempt budget", () => {
  it("refuses zero attempts", () => {
    // Zero would make every delivery terminal on its first claim, which reads
    // in the data exactly like a provider rejecting everything.
    expect(() => loadWorkerConfig({ ...base, DELIVERY_MAX_ATTEMPTS: "0" }))
      .toThrow(WorkerConfigError);
  });

  it("refuses an unbounded-looking budget", () => {
    // S106. A large budget crossed with the backoff schedules sends of a
    // credential that has already expired.
    expect(() => loadWorkerConfig({ ...base, DELIVERY_MAX_ATTEMPTS: "50" }))
      .toThrow(WorkerConfigError);
  });
});

describe("dispatch cadence", () => {
  it("sweeps every minute by default, not hourly like cleanup", () => {
    // The two schedules look alike and are not. A security email waiting an
    // hour for a sweep is a login the user gave up on.
    expect(loadWorkerConfig(base).dispatchCron).toBe("* * * * *");
    expect(loadWorkerConfig(base).cleanupCron).toBe("0 * * * *");
  });

  it("rejects a cron expression that is not five fields", () => {
    expect(() => loadWorkerConfig({ ...base, DISPATCH_CRON: "* * * *" }))
      .toThrow(WorkerConfigError);
  });

  it("bounds the sweep batch", () => {
    expect(() => loadWorkerConfig({ ...base, DISPATCH_BATCH_SIZE: "0" }))
      .toThrow(WorkerConfigError);
  });
});

describe("link base", () => {
  it("rejects a base that is not an absolute URL", () => {
    // S147. Parsed at boot so a malformed base is a deployment error rather
    // than a broken signing link inside a real invitation.
    expect(() => loadWorkerConfig({ ...base, APP_BASE_URL: "app.lagda.test" }))
      .toThrow(WorkerConfigError);
  });

  it("accepts an absolute one", () => {
    expect(loadWorkerConfig({ ...base, APP_BASE_URL: "https://app.lagda.test" })
      .appBaseUrl).toBe("https://app.lagda.test");
  });

  it("is empty rather than defaulted when unset", () => {
    // No fallback host. A default would produce links pointing somewhere
    // nobody chose, in mail LAGDA signed.
    expect(loadWorkerConfig(base).appBaseUrl).toBe("");
  });
});

describe("the signing delivery key", () => {
  it("is null when unset rather than an empty string", () => {
    // Null is what makes the sealed resolver report UNUSABLE instead of
    // degrading: a deployment that cannot open credentials must not quietly
    // deliver messages without them.
    expect(loadWorkerConfig(base).signingDeliveryKey).toBeNull();
  });

  it("defaults its version rather than requiring one", () => {
    expect(loadWorkerConfig(base).signingDeliveryKeyVersion).toBe("v1");
  });
});
