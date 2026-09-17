// Building the transport from an environment: absent capability is ABSENT.

import { describe, it, expect } from "vitest";
import {
  createProviderEventConfirmerFromEnv, createEmailProviderFromEnv,
} from "./composition.js";

const configured = {
  SMTP_HOST: "smtp.gmass.co",
  SMTP_USERNAME: "gmass",
  SMTP_PASSWORD: "api-key-abc",
  EMAIL_FROM_ADDRESS: "no-reply@lagda.test",
};

describe("the callback confirmer", () => {
  it("is always null — SMTP has no provider callback mechanism", () => {
    // Postmark confirmed delivery/bounce via a signed webhook plus an
    // API lookup; plain SMTP has neither. This stays null unconditionally
    // rather than becoming a stub that authenticates callers and confirms
    // nothing — see composition.ts's own comment.
    expect(createProviderEventConfirmerFromEnv(configured)).toBeNull();
    expect(createProviderEventConfirmerFromEnv({})).toBeNull();
  });
});

describe("the send provider", () => {
  it("is null when the deployment cannot send", () => {
    // Same shape, same reason: a provider that rejected every send would burn
    // each delivery's attempt budget to discover what configuration knew.
    expect(createEmailProviderFromEnv({})).toBeNull();
  });

  it("builds one when a password is present", () => {
    expect(createEmailProviderFromEnv(configured)).not.toBeNull();
  });
});
