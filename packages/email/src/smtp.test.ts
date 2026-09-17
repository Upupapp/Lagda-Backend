// The failure classification, which is the part of a transport most likely to
// be wrong and least likely to be noticed.
//
// Every case here decides whether a security email is retried, abandoned, or
// duplicated. None of them needs a network or a real SMTP relay.

import { describe, it, expect } from "vitest";
import { createSmtpEmailProvider, type SmtpSender } from "./smtp.js";
import { loadSmtpConfig, EmailConfigError } from "./config.js";
import type { EmailMessage } from "@lagda/application";

const ENV = {
  SMTP_HOST: "smtp.gmass.co",
  SMTP_PORT: "587",
  SMTP_USERNAME: "gmass",
  SMTP_PASSWORD: "api-key-abc",
  EMAIL_FROM_ADDRESS: "no-reply@lagda.test",
  EMAIL_FROM_DISPLAY_NAME: "LAGDA",
};

const config = loadSmtpConfig(ENV);

const message: EmailMessage = {
  destination: "maria@example.test",
  subject: "Paulo Reyes sent you \"Lease Agreement\" to sign",
  textBody: "Open the document: https://app.lagda.test/sign?token=abc",
  htmlBody: "<p>Open the document</p>",
};

function fakeSender(impl: SmtpSender["sendMail"]): SmtpSender {
  return { sendMail: impl };
}

function smtpError(over: { code?: string; responseCode?: number }): Error {
  return Object.assign(new Error("smtp failure"), over);
}

const send = (sender: SmtpSender) => createSmtpEmailProvider(config, sender).send(message);

describe("classification", () => {
  it("accepts a successful send and keeps the message reference", async () => {
    const result = await send(fakeSender(() => Promise.resolve({ messageId: "<abc@gmass>" })));

    expect(result.outcome).toBe("ACCEPTED");
    expect(result).toHaveProperty("providerMessageReference", "<abc@gmass>");
  });

  it("accepts a send with no message id, omitting the reference", async () => {
    const result = await send(fakeSender(() => Promise.resolve({})));

    expect(result.outcome).toBe("ACCEPTED");
    expect(result).not.toHaveProperty("providerMessageReference");
  });

  it("treats a connection failure as retryable — nothing was ever sent", async () => {
    for (const code of ["ECONNECTION", "ECONNREFUSED", "EDNS"]) {
      const result = await send(fakeSender(() => Promise.reject(smtpError({ code }))));
      expect(result.outcome).toBe("FAILED_RETRYABLE");
    }
  });

  it("treats a bad credential as terminal", async () => {
    // Retrying the same password three times only delays the signal that
    // something is misconfigured.
    const result = await send(fakeSender(() => Promise.reject(smtpError({ code: "EAUTH" }))));
    expect(result.outcome).toBe("FAILED_TERMINAL");
  });

  it("treats a timeout or reset mid-conversation as AMBIGUOUS, not as failure", async () => {
    // The message may have left and been accepted. Calling it a failure
    // invites a duplicate; calling it success loses a security email
    // silently.
    for (const code of ["ETIMEDOUT", "ESOCKET", "ECONNRESET"]) {
      const result = await send(fakeSender(() => Promise.reject(smtpError({ code }))));
      expect(result.outcome).toBe("AMBIGUOUS");
    }
  });

  it("treats a permanent (5xx) SMTP reply as terminal", async () => {
    const result = await send(fakeSender(() => Promise.reject(smtpError({ responseCode: 550 }))));
    expect(result.outcome).toBe("FAILED_TERMINAL");
  });

  it("treats a transient (4xx) SMTP reply as retryable", async () => {
    const result = await send(fakeSender(() => Promise.reject(smtpError({ responseCode: 450 }))));
    expect(result.outcome).toBe("FAILED_RETRYABLE");
  });

  it("defaults an unrecognised error to retryable", async () => {
    // The safe default for security mail: a wrongly-retried message costs a
    // duplicate of a credential that still works; a wrongly-abandoned one is
    // a password reset that never arrives.
    const result = await send(fakeSender(() => Promise.reject(new Error("unrecognized"))));
    expect(result.outcome).toBe("FAILED_RETRYABLE");
  });
});

describe("the request", () => {
  const capture = async () => {
    let captured: Parameters<SmtpSender["sendMail"]>[0] | undefined;
    await send(fakeSender((options) => {
      captured = options;
      return Promise.resolve({ messageId: "<x@gmass>" });
    }));
    if (captured === undefined) throw new Error("sendMail was not called");
    return captured;
  };

  it("takes the envelope from configuration, never from the message", async () => {
    const options = await capture();

    expect(options.from).toEqual({ name: "LAGDA", address: "no-reply@lagda.test" });
    expect(options.to).toBe("maria@example.test");
    expect(options.subject).toBe(message.subject);
    expect(options.text).toBe(message.textBody);
    expect(options.html).toBe(message.htmlBody);
  });

  it("omits reply-to when none is configured", async () => {
    const options = await capture();
    expect(options.replyTo).toBeUndefined();
  });

  it("includes reply-to when configured", async () => {
    const withReply = loadSmtpConfig({ ...ENV, EMAIL_REPLY_TO_ADDRESS: "support@lagda.test" });
    let captured: Parameters<SmtpSender["sendMail"]>[0] | undefined;
    await createSmtpEmailProvider(withReply, fakeSender((options) => {
      captured = options;
      return Promise.resolve({});
    })).send(message);

    expect(captured?.replyTo).toBe("support@lagda.test");
  });
});

describe("configuration", () => {
  it("refuses to start without a password", () => {
    const { SMTP_PASSWORD: _omitted, ...without } = ENV;
    expect(() => loadSmtpConfig(without)).toThrow(EmailConfigError);
  });

  it("refuses to start without a host", () => {
    const { SMTP_HOST: _omitted, ...without } = ENV;
    expect(() => loadSmtpConfig(without)).toThrow(EmailConfigError);
  });

  it("refuses to start without a username", () => {
    const { SMTP_USERNAME: _omitted, ...without } = ENV;
    expect(() => loadSmtpConfig(without)).toThrow(EmailConfigError);
  });

  it("defaults the port to 587", () => {
    const { SMTP_PORT: _omitted, ...without } = ENV;
    expect(loadSmtpConfig(without).port).toBe(587);
  });

  it("infers implicit TLS only for port 465", () => {
    expect(loadSmtpConfig(ENV).secure).toBe(false);
    expect(loadSmtpConfig({ ...ENV, SMTP_PORT: "465" }).secure).toBe(true);
  });

  it("honors an explicit SMTP_SECURE override", () => {
    expect(loadSmtpConfig({ ...ENV, SMTP_SECURE: "true" }).secure).toBe(true);
    expect(loadSmtpConfig({ ...ENV, SMTP_PORT: "465", SMTP_SECURE: "false" }).secure).toBe(false);
  });

  it("rejects a display name carrying control characters", () => {
    // Header injection in the one field nobody checks, because it is
    // configuration rather than user input.
    expect(() => loadSmtpConfig({
      ...ENV, EMAIL_FROM_DISPLAY_NAME: "LAGDA\r\nBcc: attacker@example.test",
    })).toThrow(EmailConfigError);
  });

  it("rejects a malformed from address", () => {
    expect(() => loadSmtpConfig({ ...ENV, EMAIL_FROM_ADDRESS: "not-an-address" }))
      .toThrow(EmailConfigError);
  });

  it("bounds the timeout", () => {
    // A worker blocked on a provider holds a delivery claim, and a claim held
    // past its lease is reclaimed and retried.
    expect(() => loadSmtpConfig({ ...ENV, EMAIL_TIMEOUT_MS: "600000" }))
      .toThrow(EmailConfigError);
  });

  it("omits reply-to when none is configured", () => {
    expect(loadSmtpConfig(ENV).envelope.replyToAddress).toBeUndefined();
  });
});
