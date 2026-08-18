// The provider callback route: what it refuses, what it accepts and drops, and
// what it refuses to tell the caller.

import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  registerProviderWebhookRoutes, presentedSecret,
} from "./provider-webhook-routes.js";
import type { WebhookOutcome } from "@lagda/email";

const AT = 1_760_000_000_000;

interface Harness {
  readonly app: FastifyInstance;
  readonly applied: unknown[];
  readonly presented: (string | null)[];
}

function harness(outcome: WebhookOutcome): Harness {
  const applied: unknown[] = [];
  const presented: (string | null)[] = [];
  const app = Fastify();

  registerProviderWebhookRoutes(app, {
    confirm: (secret, _body) => {
      presented.push(secret);
      return Promise.resolve(outcome);
    },
    eventDependencies: {
      transactions: {
        runGlobal: (operation: (uow: never) => Promise<unknown>) => operation({
          notificationDispatch: {
            findByProviderReference: () => Promise.resolve({
              notificationDeliveryId: "ndel_1", scope: { kind: "WORKSPACE", workspaceId: "ws_1" },
            }),
          },
        } as never),
        runForNotificationDelivery: (
          _scope: unknown, operation: (uow: never) => Promise<unknown>,
        ) => operation({
          notificationTransport: {
            applyConfirmedProviderEvent: (input: unknown) => {
              applied.push(input);
              return Promise.resolve(true);
            },
          },
        } as never),
      } as never,
      clock: { now: () => AT },
    },
  });

  return { app, applied, presented };
}

const basic = (password: string): string =>
  `Basic ${Buffer.from(`postmark:${password}`).toString("base64")}`;

describe("credential extraction", () => {
  it("takes the password half of a basic header", () => {
    expect(presentedSecret({ headers: { authorization: basic("s3cret") } }))
      .toBe("s3cret");
  });

  it("returns null for every malformed shape", () => {
    // No header, a different scheme, and no colon after decoding all reach the
    // same refusal. None of them is distinguished, because distinguishing them
    // tells a caller how close they got.
    for (const authorization of [
      undefined,
      "Bearer abc",
      `Basic ${Buffer.from("nocolon").toString("base64")}`,
    ]) {
      expect(presentedSecret({ headers: { authorization } })).toBeNull();
    }
  });

  it("keeps a password containing a colon intact", () => {
    // Split on the FIRST colon only. A generated secret may contain one, and
    // truncating it would refuse a correct credential.
    expect(presentedSecret({ headers: { authorization: basic("a:b:c") } }))
      .toBe("a:b:c");
  });

  it("compares nothing itself", async () => {
    // The route extracts and hands over; the confirmer compares, in fixed
    // time. Nothing here can leak a credential by timing because nothing here
    // looks at one.
    const h = harness({ result: "UNAUTHENTICATED" });
    await h.app.inject({
      method: "POST", url: "/webhooks/email",
      headers: { authorization: basic("wrong") }, payload: {},
    });
    expect(h.presented).toEqual(["wrong"]);
  });
});

describe("responses", () => {
  it("refuses an unauthenticated caller with a bare 401", async () => {
    const h = harness({ result: "UNAUTHENTICATED" });

    const response = await h.app.inject({
      method: "POST", url: "/webhooks/email", payload: {},
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toBe("");
    expect(h.applied).toEqual([]);
  });

  it("accepts and drops anything unusable", async () => {
    // S40, S125. A provider that receives an error retries, and retrying a
    // callback about a message LAGDA has never heard of achieves nothing but
    // load.
    const h = harness({ result: "IGNORED", reason: "no message reference" });

    const response = await h.app.inject({
      method: "POST", url: "/webhooks/email",
      headers: { authorization: basic("right") }, payload: { RecordType: "Open" },
    });

    expect(response.statusCode).toBe(204);
    expect(h.applied).toEqual([]);
  });

  it("returns no reason for an ignored callback", async () => {
    // The reason would tell a credential-holding caller which references LAGDA
    // recognises -- the oracle that binding by reference exists to avoid.
    const h = harness({ result: "IGNORED", reason: "unknown message reference" });

    const response = await h.app.inject({
      method: "POST", url: "/webhooks/email",
      headers: { authorization: basic("right") }, payload: {},
    });

    expect(response.body).toBe("");
  });

  it("applies a confirmed event and still says only 204", async () => {
    // A duplicate callback and a first-time one are the same event from the
    // provider's side. Distinguishing them in the response would leak delivery
    // state to whoever holds the webhook credential.
    const h = harness({
      result: "CONFIRMED", providerMessageReference: "pm-1", state: "DELIVERED",
    });

    const response = await h.app.inject({
      method: "POST", url: "/webhooks/email",
      headers: { authorization: basic("right") }, payload: { MessageID: "pm-1" },
    });

    expect(response.statusCode).toBe(204);
    expect(h.applied).toEqual([{
      notificationDeliveryId: "ndel_1", state: "DELIVERED", now: AT,
    }]);
  });
});

describe("the surface", () => {
  it("names no vendor in its path", async () => {
    // A provider name in a URL is the one piece of vendor coupling that cannot
    // be changed quietly: it is already configured in a third party's dashboard
    // and already taking traffic. A switch would mean coordinating a URL change
    // with a credential change mid-cutover, instead of pointing the new
    // provider at the same endpoint.
    const h = harness({ result: "UNAUTHENTICATED" });
    await h.app.ready();

    const paths = h.app.printRoutes({ commonPrefix: false }).toLowerCase();
    for (const vendor of ["postmark", "sendgrid", "mailgun", "ses", "resend"]) {
      expect(paths).not.toContain(vendor);
    }
  });

  it("exposes no route other than the callback", async () => {
    // One POST. No listing, no read-back, no way to ask what a reference
    // resolved to.
    const h = harness({ result: "UNAUTHENTICATED" });
    await h.app.ready();

    const paths = h.app.printRoutes({ commonPrefix: false });
    expect(paths).toContain("/webhooks/email");
    expect(paths).not.toContain("GET");
  });
});
