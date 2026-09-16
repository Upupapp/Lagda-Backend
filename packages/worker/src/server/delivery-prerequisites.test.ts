// deliveryPrerequisites' own comment says the caller may assume "presence is
// already established" before calling loadPostmarkConfig, so that loader's
// throw (which takes the whole worker down, deliberately) is meant to mean
// "a value was set but is malformed" — never "a required var was never set at
// all." Before this fix, EMAIL_FROM_ADDRESS and POSTMARK_MESSAGE_STREAM were
// both required-for-presence by loadPostmarkConfig
// (packages/email/src/config.ts) but were never checked here, so a deployment
// that set only POSTMARK_SERVER_TOKEN would pass this gate and then crash the
// worker at boot instead of staying gracefully disabled.

import { describe, it, expect } from "vitest";
import { deliveryPrerequisites } from "./start-worker.js";
import { loadWorkerConfig } from "../config/index.js";

/** A minimal environment satisfying every OTHER worker config default. */
const base = {} as NodeJS.ProcessEnv;

const READY_ENV: NodeJS.ProcessEnv = {
  ...base,
  POSTMARK_SERVER_TOKEN: "test-token",
  EMAIL_FROM_ADDRESS: "notifications@example.test",
  POSTMARK_MESSAGE_STREAM: "outbound",
  SIGNING_DELIVERY_KEY: "dGVzdC1rZXk=",
  APP_BASE_URL: "https://app.example.test",
};

describe("deliveryPrerequisites", () => {
  it("reports nothing missing when every prerequisite is set", () => {
    expect(deliveryPrerequisites(loadWorkerConfig(READY_ENV), READY_ENV)).toEqual([]);
  });

  it("reports POSTMARK_SERVER_TOKEN missing on its own", () => {
    const env = { ...READY_ENV };
    delete env["POSTMARK_SERVER_TOKEN"];
    expect(deliveryPrerequisites(loadWorkerConfig(env), env)).toContain("POSTMARK_SERVER_TOKEN");
  });

  it("reports EMAIL_FROM_ADDRESS missing even when the token is set (the bug this fixes)", () => {
    const env = { ...READY_ENV };
    delete env["EMAIL_FROM_ADDRESS"];
    expect(deliveryPrerequisites(loadWorkerConfig(env), env)).toContain("EMAIL_FROM_ADDRESS");
  });

  it("reports POSTMARK_MESSAGE_STREAM missing even when the token is set", () => {
    const env = { ...READY_ENV };
    delete env["POSTMARK_MESSAGE_STREAM"];
    expect(deliveryPrerequisites(loadWorkerConfig(env), env)).toContain("POSTMARK_MESSAGE_STREAM");
  });

  it("reports SIGNING_DELIVERY_KEY missing", () => {
    const env = { ...READY_ENV };
    delete env["SIGNING_DELIVERY_KEY"];
    expect(deliveryPrerequisites(loadWorkerConfig(env), env)).toContain("SIGNING_DELIVERY_KEY");
  });

  it("reports APP_BASE_URL missing", () => {
    const env = { ...READY_ENV };
    delete env["APP_BASE_URL"];
    expect(deliveryPrerequisites(loadWorkerConfig(env), env)).toContain("APP_BASE_URL");
  });

  it("reports every missing prerequisite at once, not just the first", () => {
    expect(deliveryPrerequisites(loadWorkerConfig(base), base)).toEqual([
      "POSTMARK_SERVER_TOKEN",
      "EMAIL_FROM_ADDRESS",
      "POSTMARK_MESSAGE_STREAM",
      "SIGNING_DELIVERY_KEY",
      "APP_BASE_URL",
    ]);
  });
});
