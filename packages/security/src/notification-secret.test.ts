// Resolving a credential a message must carry: what refuses, and why refusing
// is the safe direction.

import { describe, it, expect } from "vitest";
import {
  createSealedSecretResolver, createChallengeSecretResolver,
  createNotificationSecretResolver,
} from "./notification-secret.js";
import { createSecretBox, generateSecretBoxKey } from "./secret-box.js";
import type { NotificationSource } from "@lagda/application";

const KEY = generateSecretBoxKey();
const VERSION = "k1";
const box = createSecretBox({ keyBase64: KEY, keyVersion: VERSION });
const AT = 1_760_000_000_000;

const grantSource: NotificationSource =
  { kind: "SIGNING_ACCESS_GRANT", sourceId: "sag_1" };
const challengeSource: NotificationSource =
  { kind: "SECURITY_CHALLENGE", sourceId: "chal_1" };

const clock = { now: () => AT };
const lookup = (sealed: string | null) => ({
  SECURITY_CHALLENGE: {
    findSealedIfActive: () => Promise.resolve(
      sealed === null ? null : { sealed, keyVersion: VERSION }),
  },
});

describe("challenge credentials", () => {
  it("opens a credential the owning domain still considers usable", async () => {
    const resolver = createChallengeSecretResolver(
      KEY, VERSION, lookup(box.seal("reset-token")), clock);

    const resolution = await resolver.resolve(
      { kind: "CHALLENGE", challengeId: "chal_1" }, challengeSource);

    expect(resolution).toEqual({ status: "AVAILABLE", secret: "reset-token" });
  });

  it("refuses when the domain reports the credential is not usable", async () => {
    // Unknown, consumed, superseded and expired all arrive as null. The
    // renderer's next move is identical for all four, and telling it which
    // would hand it a lifecycle it has no use for.
    const resolver = createChallengeSecretResolver(
      KEY, VERSION, lookup(null), clock);

    const resolution = await resolver.resolve(
      { kind: "CHALLENGE", challengeId: "chal_1" }, challengeSource);

    expect(resolution).toEqual({ status: "UNUSABLE", reason: "SECRET_EXPIRED" });
  });

  it("refuses rather than degrading when no key is configured", async () => {
    // A deployment that cannot open credentials must not quietly deliver
    // messages without them -- an invitation with a missing link reads to a
    // recipient as a broken product, and to every metric as a success.
    const resolver = createChallengeSecretResolver(
      null, VERSION, lookup(box.seal("reset-token")), clock);

    const resolution = await resolver.resolve(
      { kind: "CHALLENGE", challengeId: "chal_1" }, challengeSource);

    expect(resolution.status).toBe("UNUSABLE");
  });

  it("refuses a ciphertext that will not open", async () => {
    // A rotated key with no re-seal, or a corrupt row. Neither is fixed by
    // retrying, so it stops the send rather than crashing a worker into a loop
    // against a row that will never open.
    const other = createSecretBox({ keyBase64: generateSecretBoxKey(), keyVersion: VERSION });
    const resolver = createChallengeSecretResolver(
      KEY, VERSION, lookup(other.seal("reset-token")), clock);

    const resolution = await resolver.resolve(
      { kind: "CHALLENGE", challengeId: "chal_1" }, challengeSource);

    expect(resolution.status).toBe("UNUSABLE");
  });

  it("will not answer for a SEALED reference", async () => {
    // Reaching here with the wrong kind is a composition error, not a runtime
    // condition, so it is reported as unusable rather than guessed at.
    const resolver = createChallengeSecretResolver(
      KEY, VERSION, lookup(box.seal("x")), clock);

    const resolution = await resolver.resolve(
      { kind: "SEALED", sealed: "v1.a.b.c" as never, keyVersion: VERSION },
      grantSource);

    expect(resolution.status).toBe("UNUSABLE");
  });
});

describe("dispatch by reference kind", () => {
  const always = (secret: string) => ({
    resolve: () => Promise.resolve({ status: "AVAILABLE" as const, secret }),
  });

  it("sends a SEALED reference to the sealed resolver", async () => {
    const resolver = createNotificationSecretResolver(
      always("from-sealed"), always("from-challenge"));

    const resolution = await resolver.resolve(
      { kind: "SEALED", sealed: "v1.a.b.c" as never, keyVersion: VERSION },
      grantSource);

    expect(resolution.secret).toBe("from-sealed");
  });

  it("sends a CHALLENGE reference to the challenge resolver", async () => {
    const resolver = createNotificationSecretResolver(
      always("from-sealed"), always("from-challenge"));

    const resolution = await resolver.resolve(
      { kind: "CHALLENGE", challengeId: "chal_1" }, challengeSource);

    expect(resolution.secret).toBe("from-challenge");
  });
});

describe("signing credentials", () => {
  it("checks validity BEFORE decrypting", async () => {
    // Decrypting first would put a live credential in memory in order to
    // discover it must not be used -- strictly worse than not touching it, and
    // it shows up in a heap dump.
    const order: string[] = [];
    const resolver = createSealedSecretResolver(KEY, VERSION, {
      isStillUsable: () => {
        order.push("validity");
        return Promise.resolve(false);
      },
    });

    await resolver.resolve(
      { kind: "SEALED", sealed: box.seal("link") as never, keyVersion: VERSION },
      grantSource);

    expect(order).toEqual(["validity"]);
  });
});

describe("dispatch by owning domain", () => {
  it("asks the domain the source names, not every domain in turn", async () => {
    // A resolver that tried each lookup would ask the reset table about an
    // invitation, and "not found" would be indistinguishable from "not yours".
    const asked: string[] = [];
    const named = (name: string) => ({
      findSealedIfActive: () => {
        asked.push(name);
        return Promise.resolve({ sealed: box.seal(name), keyVersion: VERSION });
      },
    });
    const resolver = createChallengeSecretResolver(KEY, VERSION, {
      SECURITY_CHALLENGE: named("reset"),
      WORKSPACE_INVITATION: named("invitation"),
    }, clock);

    const resolution = await resolver.resolve(
      { kind: "CHALLENGE", challengeId: "inv_1" },
      { kind: "WORKSPACE_INVITATION", sourceId: "inv_1" });

    expect(asked).toEqual(["invitation"]);
    expect(resolution.secret).toBe("invitation");
  });

  it("refuses a source kind this deployment wired no lookup for", async () => {
    // Same answer as an unconfigured key, and the same visible outcome: a
    // SUPPRESSED delivery rather than a message with a missing link.
    const resolver = createChallengeSecretResolver(KEY, VERSION, {}, clock);

    const resolution = await resolver.resolve(
      { kind: "CHALLENGE", challengeId: "chal_1" }, challengeSource);

    expect(resolution.status).toBe("UNUSABLE");
  });
});
