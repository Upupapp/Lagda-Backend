// Building the transport from an environment: absent capability is ABSENT.

import { describe, it, expect } from "vitest";
import {
  createProviderEventConfirmerFromEnv, createEmailProviderFromEnv,
} from "./composition.js";
import { EmailConfigError } from "./config.js";

const configured = {
  POSTMARK_SERVER_TOKEN: "token",
  POSTMARK_MESSAGE_STREAM: "outbound",
  EMAIL_FROM_ADDRESS: "no-reply@lagda.test",
};

describe("the callback confirmer", () => {
  it("is null when no callback credential is set", () => {
    // Null rather than a confirmer that refuses everything. The caller's
    // correct response is to register no route, and an always-401 endpoint
    // still advertises that LAGDA has a webhook somewhere.
    expect(createProviderEventConfirmerFromEnv(configured)).toBeNull();
  });

  it("refuses a half-configured deployment loudly", () => {
    // A credential with no provider token authenticates callers and then fails
    // every confirmation lookup -- an endpoint that looks alive and can
    // establish nothing.
    expect(() => createProviderEventConfirmerFromEnv({
      POSTMARK_WEBHOOK_SECRET: "s3cret",
    })).toThrow(EmailConfigError);
  });

  it("builds one when everything it needs is present", () => {
    expect(createProviderEventConfirmerFromEnv({
      ...configured, POSTMARK_WEBHOOK_SECRET: "s3cret",
    })).not.toBeNull();
  });
});

describe("the send provider", () => {
  it("is null when the deployment cannot send", () => {
    // Same shape, same reason: a provider that rejected every send would burn
    // each delivery's attempt budget to discover what configuration knew.
    expect(createEmailProviderFromEnv({})).toBeNull();
  });

  it("builds one when a token is present", () => {
    expect(createEmailProviderFromEnv(configured)).not.toBeNull();
  });
});

describe("what a caller learns", () => {
  it("returns a plain function, naming no vendor in its type", () => {
    // The whole point of this module: a composition root asks whether the
    // environment has a callback and gets one or nothing. It never learns the
    // answer's brand, so INV-665 holds without an exemption.
    const confirm = createProviderEventConfirmerFromEnv({
      ...configured, POSTMARK_WEBHOOK_SECRET: "s3cret",
    });
    expect(typeof confirm).toBe("function");
    expect(confirm?.length).toBe(2);
  });
});
