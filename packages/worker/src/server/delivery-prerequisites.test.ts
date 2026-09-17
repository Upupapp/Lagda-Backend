// deliveryPrerequisites' own comment says the caller may assume "presence is
// already established" before calling loadSmtpConfig, so that loader's
// throw (which takes the whole worker down, deliberately) is meant to mean
// "a value was set but is malformed" — never "a required var was never set at
// all." Every var loadSmtpConfig treats as required-for-presence
// (packages/email/src/config.ts) must be checked here too, or a deployment
// that set only SMTP_PASSWORD would pass this gate and then crash the
// worker at boot instead of staying gracefully disabled.

import { describe, it, expect } from "vitest";
import { deliveryPrerequisites } from "./start-worker.js";
import { loadWorkerConfig } from "../config/index.js";

/** A minimal environment satisfying every OTHER worker config default. */
const base = {} as NodeJS.ProcessEnv;

const READY_ENV: NodeJS.ProcessEnv = {
  ...base,
  SMTP_HOST: "smtp.gmass.co",
  SMTP_USERNAME: "gmass",
  SMTP_PASSWORD: "test-api-key",
  EMAIL_FROM_ADDRESS: "notifications@example.test",
  SIGNING_DELIVERY_KEY: "dGVzdC1rZXk=",
  APP_BASE_URL: "https://app.example.test",
};

describe("deliveryPrerequisites", () => {
  it("reports nothing missing when every prerequisite is set", () => {
    expect(deliveryPrerequisites(loadWorkerConfig(READY_ENV), READY_ENV)).toEqual([]);
  });

  it("reports SMTP_PASSWORD missing on its own", () => {
    const env = { ...READY_ENV };
    delete env["SMTP_PASSWORD"];
    expect(deliveryPrerequisites(loadWorkerConfig(env), env)).toContain("SMTP_PASSWORD");
  });

  it("reports SMTP_HOST missing even when the password is set", () => {
    const env = { ...READY_ENV };
    delete env["SMTP_HOST"];
    expect(deliveryPrerequisites(loadWorkerConfig(env), env)).toContain("SMTP_HOST");
  });

  it("reports SMTP_USERNAME missing even when the password is set", () => {
    const env = { ...READY_ENV };
    delete env["SMTP_USERNAME"];
    expect(deliveryPrerequisites(loadWorkerConfig(env), env)).toContain("SMTP_USERNAME");
  });

  it("reports EMAIL_FROM_ADDRESS missing even when the password is set (the bug this fixes)", () => {
    const env = { ...READY_ENV };
    delete env["EMAIL_FROM_ADDRESS"];
    expect(deliveryPrerequisites(loadWorkerConfig(env), env)).toContain("EMAIL_FROM_ADDRESS");
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
      "SMTP_PASSWORD",
      "SMTP_HOST",
      "SMTP_USERNAME",
      "EMAIL_FROM_ADDRESS",
      "SIGNING_DELIVERY_KEY",
      "APP_BASE_URL",
    ]);
  });
});
