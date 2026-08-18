// The failure classification, which is the part of a transport most likely to
// be wrong and least likely to be noticed.
//
// Every case here decides whether a security email is retried, abandoned, or
// duplicated. None of them needs a network or a Postmark account.

import { describe, it, expect } from "vitest";
import { createPostmarkEmailProvider } from "./postmark.js";
import { loadPostmarkConfig, EmailConfigError } from "./config.js";
import type { EmailMessage } from "@lagda/application";

const ENV = {
  POSTMARK_SERVER_TOKEN: "token-abc",
  POSTMARK_MESSAGE_STREAM: "outbound-transactional",
  EMAIL_FROM_ADDRESS: "no-reply@lagda.test",
  EMAIL_FROM_DISPLAY_NAME: "LAGDA",
};

const config = loadPostmarkConfig(ENV);

const message: EmailMessage = {
  destination: "maria@example.test",
  subject: "Paulo Reyes sent you \"Lease Agreement\" to sign",
  textBody: "Open the document: https://app.lagda.test/sign?token=abc",
  htmlBody: "<p>Open the document</p>",
};

/** A fetch that returns one canned response. */
const respondWith = (status: number, body: unknown) =>
  () => Promise.resolve(new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  }));

const send = (fetchImpl: typeof fetch) =>
  createPostmarkEmailProvider(config, fetchImpl).send(message);

describe("classification", () => {
  it("accepts a 200 with ErrorCode 0 and keeps the message reference", async () => {
    const result = await send(respondWith(200, { ErrorCode: 0, MessageID: "pm-1" }));

    expect(result.outcome).toBe("ACCEPTED");
    expect(result).toHaveProperty("providerMessageReference", "pm-1");
  });

  it("treats a timeout as AMBIGUOUS, not as failure", async () => {
    // The request may have left and been accepted. Calling it a failure invites
    // a duplicate; calling it success loses a security email silently.
    const result = await send(() => Promise.reject(new Error("aborted")));

    expect(result.outcome).toBe("AMBIGUOUS");
  });

  it("treats a 200 with an unparseable body as AMBIGUOUS", async () => {
    // There is no MessageID to reconcile against later, so acceptance cannot
    // be recorded honestly.
    const result = await send(() => Promise.resolve(
      new Response("not json", { status: 200 })));

    expect(result.outcome).toBe("AMBIGUOUS");
  });

  it("treats authentication failure as terminal", async () => {
    // A bad server token is a configuration problem. Retrying it three times
    // only delays the signal that tells an operator what is wrong.
    for (const status of [401, 403]) {
      expect((await send(respondWith(status, { ErrorCode: 10 }))).outcome)
        .toBe("FAILED_TERMINAL");
    }
  });

  it("treats rate limiting and provider faults as retryable", async () => {
    for (const status of [429, 500, 503]) {
      expect((await send(respondWith(status, { ErrorCode: 0 }))).outcome)
        .toBe("FAILED_RETRYABLE");
    }
  });

  it("treats an inactive recipient as terminal", async () => {
    // Postmark 406: previously hard-bounced or marked spam. It will not be
    // accepted however many times it is offered.
    expect((await send(respondWith(422, { ErrorCode: 406 }))).outcome)
      .toBe("FAILED_TERMINAL");
  });

  it("defaults an unrecognised error to retryable", async () => {
    // The safe default for security mail: a wrongly-retried message costs a
    // duplicate of a credential that still works; a wrongly-abandoned one is a
    // password reset that never arrives.
    expect((await send(respondWith(422, { ErrorCode: 999_999 }))).outcome)
      .toBe("FAILED_RETRYABLE");
  });
});

describe("the request", () => {
  const capture = async (): Promise<{ url: string; body: Record<string, unknown>;
    headers: Record<string, string>; }> => {
    let captured: { url: string; body: Record<string, unknown>;
      headers: Record<string, string>; } | undefined;
    await send((url, init) => {
      captured = {
        // Narrowed at the boundary: `fetch` accepts three input shapes and only
        // one is a string, so stringifying blindly could yield "[object Object]"
        // and make every assertion below vacuous.
        url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
        // The adapter always sends a JSON string; narrowing here keeps the
        // assertion honest if it ever stops doing so.
        body: JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as Record<string, unknown>,
        headers: (init?.headers ?? {}) as Record<string, string>,
      };
      return Promise.resolve(new Response(JSON.stringify({ ErrorCode: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    if (captured === undefined) throw new Error("fetch was not called");
    return captured;
  };

  it("disables link and open tracking explicitly", async () => {
    // Non-negotiable, and sent per message rather than trusted to the stream's
    // configuration. Link rewriting would replace the signing URL with
    // Postmark's, putting a third party between a signer and the document.
    const { body } = await capture();

    expect(body["TrackLinks"]).toBe("None");
    expect(body["TrackOpens"]).toBe(false);
  });

  it("takes the envelope from configuration, never from the message", async () => {
    const { body } = await capture();

    expect(body["From"]).toBe("LAGDA <no-reply@lagda.test>");
    expect(body["MessageStream"]).toBe("outbound-transactional");
  });

  it("sends the token as a header, never in the URL", async () => {
    // A token in a query string is a token in every proxy and access log.
    const { url, headers } = await capture();

    expect(url).not.toContain("token-abc");
    expect(headers["X-Postmark-Server-Token"]).toBe("token-abc");
  });
});

describe("configuration", () => {
  it("refuses to start without a server token", () => {
    const { POSTMARK_SERVER_TOKEN: _omitted, ...without } = ENV;
    expect(() => loadPostmarkConfig(without)).toThrow(EmailConfigError);
  });

  it("refuses to start without an explicit message stream", () => {
    // A security email inheriting a broadcast stream inherits a broadcast
    // reputation.
    const { POSTMARK_MESSAGE_STREAM: _omitted, ...without } = ENV;
    expect(() => loadPostmarkConfig(without)).toThrow(EmailConfigError);
  });

  it("rejects a display name carrying control characters", () => {
    // Header injection in the one field nobody checks, because it is
    // configuration rather than user input.
    expect(() => loadPostmarkConfig({
      ...ENV, EMAIL_FROM_DISPLAY_NAME: "LAGDA\r\nBcc: attacker@example.test",
    })).toThrow(EmailConfigError);
  });

  it("rejects a malformed from address", () => {
    expect(() => loadPostmarkConfig({ ...ENV, EMAIL_FROM_ADDRESS: "not-an-address" }))
      .toThrow(EmailConfigError);
  });

  it("bounds the timeout", () => {
    // A worker blocked on a provider holds a delivery claim, and a claim held
    // past its lease is reclaimed and retried.
    expect(() => loadPostmarkConfig({ ...ENV, EMAIL_TIMEOUT_MS: "600000" }))
      .toThrow(EmailConfigError);
  });

  it("omits reply-to when none is configured", () => {
    // A reply-to nobody reads invites a signer to reply with something urgent
    // into a mailbox with no owner.
    expect(loadPostmarkConfig(ENV).envelope.replyToAddress).toBeUndefined();
  });
});
