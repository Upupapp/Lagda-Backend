// The email-gated document view routes (OD-135).
//
// Same posture as the plain lookup's own route tests: no credential is ever
// presented, so what matters is what an anonymous caller CANNOT learn — and
// that the document only ever streams after a real match.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app/create-app.js";
import { loadApiConfig } from "../config/index.js";

const ID = "LAGDA-VER-2026-A7bK9mQ2xZ";
const bytes = new TextEncoder().encode("%PDF-1.7 fixture");

let match: { documentTitle: string; recipientType: string } | null = {
  documentTitle: "Office Lease", recipientType: "approver",
};
let ref: { storageReference: string; mediaType: string; sizeBytes: number } | null = {
  storageReference: "ws/doc/art.pdf", mediaType: "application/pdf", sizeBytes: bytes.byteLength,
};

const findMatch = vi.fn(() => Promise.resolve(match));
const findDocumentRef = vi.fn(() => Promise.resolve(ref));
const getObject = vi.fn(() => Promise.resolve({
  ref: { zone: "artifacts" as const, key: "k" as never },
  sizeBytes: bytes.byteLength, mediaType: "application/pdf",
  // eslint-disable-next-line @typescript-eslint/require-await
  stream: (async function* () { yield bytes; })(),
}));

async function buildApp(): Promise<FastifyInstance> {
  return createApp({
    config: loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
    dependencies: {
      databaseHealth: {
        isReachable: () => Promise.resolve(true),
        hasCurrentSchema: () => Promise.resolve(true),
      },
      publicParticipantAccess: () => ({
        participants: { findMatch, findDocumentRef },
        storage: { getObject } as never,
      }),
    },
  });
}

let app: FastifyInstance;
beforeEach(async () => {
  match = { documentTitle: "Office Lease", recipientType: "approver" };
  ref = { storageReference: "ws/doc/art.pdf", mediaType: "application/pdf", sizeBytes: bytes.byteLength };
  findMatch.mockClear();
  findDocumentRef.mockClear();
  getObject.mockClear();
  app = await buildApp();
});

describe("POST /public/verifications/:id/access", () => {
  const post = (email: string) => app.inject({
    method: "POST", url: `/public/verifications/${ID}/access`, payload: { email },
  });

  it("grants access and names the role, on a real match", async () => {
    const response = await post("maria@example.com");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      outcome: "granted", documentTitle: "Office Lease", recipientType: "approver",
    });
  });

  it("denies with no detail when the email does not match", async () => {
    match = null;
    const response = await post("stranger@example.com");
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain("stranger@example.com");
  });

  it("denies identically for an unknown reference and a non-match — no oracle", async () => {
    match = null;
    const knownRef = await post("stranger@example.com");
    const unknownApp = await buildApp();
    const unknownRef = await unknownApp.inject({
      method: "POST", url: "/public/verifications/LAGDA-VER-2026-000000000/access",
      payload: { email: "stranger@example.com" },
    });
    expect(knownRef.statusCode).toBe(unknownRef.statusCode);
    expect(knownRef.json()).toEqual(unknownRef.json());
  });

  it("needs no credential and sets no cookie", async () => {
    const response = await post("maria@example.com");
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("is never cached", async () => {
    const response = await post("maria@example.com");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects a malformed body at the schema", async () => {
    const response = await app.inject({
      method: "POST", url: `/public/verifications/${ID}/access`, payload: {},
    });
    expect(response.statusCode).toBe(422);
    expect(findMatch).not.toHaveBeenCalled();
  });

  it("does not exist without publicParticipantAccess configured", async () => {
    const bare = await createApp({
      config: loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      dependencies: {
        databaseHealth: {
          isReachable: () => Promise.resolve(true),
          hasCurrentSchema: () => Promise.resolve(true),
        },
      },
    });
    const response = await bare.inject({
      method: "POST", url: `/public/verifications/${ID}/access`,
      payload: { email: "maria@example.com" },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("POST /public/verifications/:id/document", () => {
  const post = (email: string) => app.inject({
    method: "POST", url: `/public/verifications/${ID}/document`, payload: { email },
  });

  it("streams the sealed PDF on a real match", async () => {
    const response = await post("maria@example.com");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.rawPayload.length).toBe(bytes.byteLength);
  });

  it("re-checks the match itself, independent of /access", async () => {
    // Nothing was ever exchanged between the two calls; the route re-derives
    // its own answer.
    const response = await post("maria@example.com");
    expect(response.statusCode).toBe(200);
    expect(findDocumentRef).toHaveBeenCalledWith(ID, "maria@example.com");
  });

  it("denies with no detail on a non-match, and touches no storage", async () => {
    ref = null;
    const response = await post("stranger@example.com");
    expect(response.statusCode).toBe(401);
    expect(getObject).not.toHaveBeenCalled();
  });

  it("is never cached and sets no cookie", async () => {
    const response = await post("maria@example.com");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
});
