// The public verification routes (BACKEND-42).
//
// These are the only endpoints in LAGDA reachable with no credential of any
// kind, so most of what matters is what they CANNOT do: hand over a document,
// reveal that a request exists, or cost an anonymous caller nothing to abuse.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Sha256Digest, VerificationId } from "@lagda/contracts";
import type { PublicVerificationProjection } from "@lagda/application";
import { createApp } from "../app/create-app.js";
import { loadApiConfig } from "../config/index.js";

const ID = "LAGDA-VER-2026-A7bK9mQ2xZ";
const FINAL_DIGEST = "d".repeat(64) as Sha256Digest;
const AT = Date.parse("2026-08-11T10:00:00.000Z");

const projection: PublicVerificationProjection = {
  verificationId: ID as VerificationId,
  completedAt: AT,
  participantCount: 2,
  signedDocumentHash: FINAL_DIGEST,
  originalDocumentHash: "a".repeat(64) as Sha256Digest,
  digestAlgorithm: "sha-256",
  sealScheme: "hash-evidence",
  sealVersion: 1,
};

let found: PublicVerificationProjection | null = projection;
const findByVerificationId = vi.fn(() => Promise.resolve(found));

async function buildApp(): Promise<FastifyInstance> {
  return createApp({
    config: loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
    dependencies: {
      databaseHealth: { isReachable: () => Promise.resolve(true) },
      publicVerification: () => ({ lookup: { findByVerificationId } }),
    },
  });
}

let app: FastifyInstance;
beforeEach(async () => {
  found = projection;
  findByVerificationId.mockClear();
  app = await buildApp();
});

describe("GET /public/verifications/:id", () => {
  it("answers a known reference with the public projection", async () => {
    const response = await app.inject({
      method: "GET", url: `/public/verifications/${ID}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body["verificationId"]).toBe(ID);
    expect(body["finalDocument"]).toMatchObject({
      digestAlgorithm: "sha-256", digest: FINAL_DIGEST,
    });
  });

  it("needs NO credential — no session, no cookie, no token", async () => {
    // Every other non-public route in this app answers 401 to this request.
    const response = await app.inject({
      method: "GET", url: `/public/verifications/${ID}`,
    });
    expect(response.statusCode).toBe(200);
  });

  it("sets no cookie", async () => {
    const response = await app.inject({
      method: "GET", url: `/public/verifications/${ID}`,
    });
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("is not cached", async () => {
    // A shared proxy holding verification responses is a privacy surface
    // nobody has reviewed (§113).
    const response = await app.inject({
      method: "GET", url: `/public/verifications/${ID}`,
    });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("answers 404 for an unknown reference", async () => {
    found = null;
    const response = await app.inject({
      method: "GET", url: `/public/verifications/${ID}`,
    });
    expect(response.statusCode).toBe(404);
  });

  it("answers a malformed reference IDENTICALLY to an unknown one", async () => {
    // §19/§106. Any observable difference is an oracle for which references
    // exist.
    found = null;
    const unknown = await app.inject({
      method: "GET", url: `/public/verifications/${ID}`,
    });
    const malformed = await app.inject({
      method: "GET", url: "/public/verifications/LAGDA-VER-2026-xx",
    });

    expect(malformed.statusCode).toBe(unknown.statusCode);
    expect(malformed.body).toBe(unknown.body);
  });

  it("never touches the database for a malformed reference", async () => {
    await app.inject({
      method: "GET", url: "/public/verifications/not-a-reference",
    });
    expect(findByVerificationId).not.toHaveBeenCalled();
  });

  it("leaks no internal identifier or storage metadata", async () => {
    const response = await app.inject({
      method: "GET", url: `/public/verifications/${ID}`,
    });

    // The whole wire body, because a nested field is what a shape assertion
    // misses and a public endpoint cannot take back.
    const wire = response.body.toLowerCase();
    for (const forbidden of [
      "workspace", "signingrequest", "documentid", "artifact", "completionrun",
      "sealid", "storage", "bucket", "s3", "recipient", "email",
    ]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it("makes no claim LAGDA cannot support", async () => {
    const response = await app.inject({
      method: "GET", url: `/public/verifications/${ID}`,
    });
    const wire = response.body.toLowerCase();
    for (const claim of [
      "pades", "x.509", "pnpki", "rfc 3161", "timestamp authority", "hsm",
      "notarized", "notarised", "legally binding", "identity verified",
    ]) {
      expect(wire).not.toContain(claim);
    }
  });
});

describe("the endpoints cannot hand over a document", () => {
  it("returns no bytes, URL or storage reference", async () => {
    const response = await app.inject({
      method: "GET", url: `/public/verifications/${ID}`,
    });
    const wire = response.body.toLowerCase();
    expect(wire).not.toContain("http");
    expect(wire).not.toContain("url");
    expect(wire).not.toContain("download");
    expect(response.headers["content-type"]).toContain("application/json");
  });

  it("exposes no download route under the public namespace", async () => {
    // A VerificationId is not a download credential (§6, §242). There is no
    // route that could treat it as one.
    for (const url of [
      `/public/verifications/${ID}/document`,
      `/public/verifications/${ID}/download`,
      `/public/verifications/${ID}/certificate`,
      `/public/verifications/${ID}/file`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
    }
  });

  it("exposes no listing or search route", async () => {
    for (const url of ["/public/verifications", "/public/verifications?q=a"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
    }
  });
});

describe("POST /public/verifications/:id/file-check", () => {
  const post = (body: Buffer, id = ID) => app.inject({
    method: "POST",
    url: `/public/verifications/${id}/file-check`,
    payload: body,
    headers: { "content-type": "application/octet-stream" },
  });

  it("reports a match when the bytes hash to the authoritative digest", async () => {
    // The fixture's authoritative digest is the SHA-256 of this exact payload.
    const bytes = Buffer.from("%PDF-1.7 the completed document");
    const { createHash } = await import("node:crypto");
    found = {
      ...projection,
      signedDocumentHash: createHash("sha256").update(bytes).digest("hex") as Sha256Digest,
    };

    const response = await post(bytes);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ matches: boolean }>().matches).toBe(true);
  });

  it("reports a mismatch with 200, not an error", async () => {
    // §168. The comparison succeeded; the bytes differ. An error status would
    // invite a UI to render a normal result as a failure.
    const response = await post(Buffer.from("a different document"));
    expect(response.statusCode).toBe(200);
    expect(response.json<{ matches: boolean }>().matches).toBe(false);
  });

  it("does not match on a single differing byte", async () => {
    const bytes = Buffer.from("%PDF-1.7 the completed document");
    const { createHash } = await import("node:crypto");
    found = {
      ...projection,
      signedDocumentHash: createHash("sha256").update(bytes).digest("hex") as Sha256Digest,
    };

    const altered = Buffer.from("%PDF-1.7 the completed documenT");
    expect((await post(altered)).json<{ matches: boolean }>().matches).toBe(false);
  });

  it("IGNORES a client-supplied digest", async () => {
    // §59/§234. A client hash is a claim about a file nobody checked. Sending
    // one alongside bytes that do not match must not produce a match.
    const response = await app.inject({
      method: "POST",
      url: `/public/verifications/${ID}/file-check`,
      payload: Buffer.from("wrong bytes"),
      headers: {
        "content-type": "application/octet-stream",
        "x-sha256": FINAL_DIGEST,
      },
    });
    expect(response.json<{ matches: boolean }>().matches).toBe(false);
  });

  it("resolves the reference BEFORE hashing an unknown one", async () => {
    // §159. An unknown reference must cost a row lookup, not a full-file hash.
    found = null;
    const response = await post(Buffer.alloc(1024, 0x41));
    expect(response.statusCode).toBe(404);
  });

  it("answers an unknown reference identically to the GET route", async () => {
    found = null;
    const check = await post(Buffer.from("x"));
    const lookup = await app.inject({
      method: "GET", url: `/public/verifications/${ID}`,
    });
    expect(check.body).toBe(lookup.body);
  });

  it("rejects a body over the limit", async () => {
    const response = await post(Buffer.alloc(26 * 1024 * 1024, 0x41));
    expect([413, 400]).toContain(response.statusCode);
  });

  it("returns no PII or internal identifiers", async () => {
    const wire = (await post(Buffer.from("x"))).body.toLowerCase();
    for (const forbidden of [
      "workspace", "recipient", "email", "storage", "bucket", "artifact",
    ]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it("is not cached", async () => {
    expect((await post(Buffer.from("x"))).headers["cache-control"]).toBe("no-store");
  });
});

describe("read-only", () => {
  it("offers no mutating verb on either route", async () => {
    // §96/§254. Verification changes no business state, and there is no verb
    // here that could.
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({
        method, url: `/public/verifications/${ID}`,
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it("does not accept POST on the lookup route", async () => {
    const response = await app.inject({
      method: "POST", url: `/public/verifications/${ID}`,
    });
    expect(response.statusCode).toBe(404);
  });
});
