// The webhook, which is the one place a stranger can reach this subsystem.

import { describe, it, expect } from "vitest";
import { createPostmarkEventConfirmer, credentialsMatch } from "./postmark-events.js";
import { loadPostmarkConfig } from "./config.js";

const config = loadPostmarkConfig({
  POSTMARK_SERVER_TOKEN: "token-abc",
  POSTMARK_MESSAGE_STREAM: "outbound-transactional",
  EMAIL_FROM_ADDRESS: "no-reply@lagda.test",
});

const SECRET = "webhook-secret";

const confirmer = (fetchImpl: typeof fetch) =>
  createPostmarkEventConfirmer({ config, fetchImpl, webhookSecret: SECRET });

const json = (status: number, body: unknown) =>
  () => Promise.resolve(new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  }));

const delivery = { RecordType: "Delivery", MessageID: "pm-1" };

describe("authentication", () => {
  it("rejects a missing or wrong credential without looking anything up", async () => {
    let looked = false;
    const watch = () => {
      looked = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };

    expect((await confirmer(watch)(null, delivery)).result).toBe("UNAUTHENTICATED");
    expect((await confirmer(watch)("wrong", delivery)).result).toBe("UNAUTHENTICATED");
    // Nothing is fetched for an unauthenticated caller, so the endpoint cannot
    // be used to make LAGDA issue arbitrary provider lookups.
    expect(looked).toBe(false);
  });

  it("compares credentials without a length shortcut", () => {
    // A wrong-length credential must not return faster than a wrong-value one.
    expect(credentialsMatch("short", SECRET)).toBe(false);
    expect(credentialsMatch(`${SECRET}x`, SECRET)).toBe(false);
    expect(credentialsMatch(SECRET, SECRET)).toBe(true);
  });
});

describe("confirmation", () => {
  it("confirms a delivery only when the provider's own record shows it", async () => {
    const result = await confirmer(json(200, {
      MessageEvents: [{ Type: "Delivered" }],
    }))(SECRET, delivery);

    expect(result).toEqual({
      result: "CONFIRMED", providerMessageReference: "pm-1", state: "DELIVERED",
    });
  });

  it("ignores a body the provider record does not corroborate", async () => {
    // The forged-webhook case. The caller claimed a delivery; Postmark's record
    // shows nothing, so nothing moves.
    const result = await confirmer(json(200, { MessageEvents: [] }))(SECRET, delivery);

    expect(result.result).toBe("IGNORED");
  });

  it("ignores an unknown message reference", async () => {
    // S40. A reference LAGDA was told about that Postmark does not recognise.
    const result = await confirmer(json(404, {}))(SECRET, delivery);

    expect(result.result).toBe("IGNORED");
  });

  it("ignores everything when the lookup itself fails", async () => {
    // A failed lookup proves nothing either way, so the delivery keeps whatever
    // state the send established.
    const result = await confirmer(() => Promise.reject(new Error("network")))(
      SECRET, delivery);

    expect(result.result).toBe("IGNORED");
  });

  it("prefers a bounce when the provider reports both", async () => {
    const result = await confirmer(json(200, {
      MessageEvents: [{ Type: "Delivered" }, { Type: "Bounced" }],
    }))(SECRET, delivery);

    expect(result).toMatchObject({ state: "BOUNCED" });
  });
});

describe("what is not actioned", () => {
  it("ignores record types LAGDA does not subscribe to", async () => {
    // Tracking is disabled, and a recipient's reading behaviour is not
    // something this product records.
    for (const RecordType of ["Open", "Click", "SpamComplaint", "SubscriptionChange"]) {
      const result = await confirmer(json(200, {
        MessageEvents: [{ Type: "Delivered" }],
      }))(SECRET, { RecordType, MessageID: "pm-1" });

      expect(result.result).toBe("IGNORED");
    }
  });

  it("ignores a body with no message reference", async () => {
    const result = await confirmer(json(200, {}))(SECRET, { RecordType: "Delivery" });

    expect(result.result).toBe("IGNORED");
  });

  it("never returns a state outside the confirmable pair", async () => {
    // A provider event may establish DELIVERED or BOUNCED and nothing else.
    // PROVIDER_ACCEPTED is established synchronously by the send call.
    const result = await confirmer(json(200, {
      MessageEvents: [{ Type: "Transient" }, { Type: "Opened" }],
    }))(SECRET, delivery);

    expect(result.result).toBe("IGNORED");
  });
});
