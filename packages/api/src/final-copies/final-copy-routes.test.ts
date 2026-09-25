// POST /final-copies/download (073) through the real app: a valid link
// yields the sealed PDF; anything else is refused without a hint.

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { WorkspaceId, DocumentId, UserId } from "@lagda/contracts";
import { FakeTransactionManager, FixedClock } from "@lagda/application/test-support";
import { createApp } from "../app/create-app.js";
import { loadApiConfig } from "../config/index.js";

const AT = 1_760_000_000_000;
const WS = "ws_fc" as WorkspaceId;
const RAW = "t".repeat(43);
const DIGEST = "a".repeat(64);

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function build(): Promise<FastifyInstance> {
  const transactions = new FakeTransactionManager();
  const store = transactions.store;
  store.signingRequests.push({
    signingRequestId: "sr_1", workspaceId: WS, documentId: "doc_1" as DocumentId,
    sourceArtifactId: "art_1", sourcePreparationId: "prep_1", sourcePreparationRevision: 1,
    state: "completed", completionReadyAt: AT, completedAt: AT, expiresAt: null,
    terminatedAt: null, terminationReason: null, cancellationNote: null,
    documentTitle: "Office Lease.pdf", createdByUserId: "usr_1" as UserId,
    createdAt: AT, updatedAt: AT,
  } as never);
  store.seals.push({ workspaceId: WS, signingRequestId: "sr_1", sealedArtifactId: "art_sealed" } as never);
  store.artifacts.push({
    artifactId: "art_sealed", workspaceId: WS, documentId: "doc_1",
    artifactType: "sealed", storageReference: "k", mediaType: "application/pdf",
    sizeBytes: 3, digestAlgorithm: "sha-256", digest: "c".repeat(64),
    pageCount: 1, rotatedPageCount: 0, createdAt: AT,
  } as never);
  store.finalCopyGrants.push({
    grantId: "fcg_1", workspaceId: WS, signingRequestId: "sr_1", recipientId: "srr_1",
    credentialDigest: DIGEST, createdAt: AT, expiresAt: AT + 1_000_000, revokedAt: null,
  } as never);

  return createApp({
    config: loadApiConfig({ NODE_ENV: "test", API_PORT: "8080", LOG_LEVEL: "silent" }),
    dependencies: {
      databaseHealth: {
        isReachable: () => Promise.resolve(true),
        hasCurrentSchema: () => Promise.resolve(true),
      },
      finalCopies: () => ({
        transactions,
        clock: new FixedClock(AT),
        tokens: {
          issue: () => { throw new Error("not used"); },
          digest: (raw: string) => (raw === RAW ? DIGEST : raw.length === 43 ? "b".repeat(64) : null) as never,
        },
        storage: {
          getObject: () => Promise.resolve({
            ref: { zone: "artifacts", key: "k" }, sizeBytes: 3, mediaType: "application/pdf",
            // eslint-disable-next-line @typescript-eslint/require-await
            stream: (async function* () { yield new Uint8Array([37, 80, 68]); })(),
          }),
        } as never,
      }),
    },
  });
}

const post = (token: string) => app!.inject({
  method: "POST", url: "/final-copies/download", payload: { token },
});

describe("POST /final-copies/download", () => {
  it("streams the sealed PDF as an attachment named after the document", async () => {
    app = await build();
    const res = await post(RAW);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="Office Lease (signed).pdf"');
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.rawPayload.length).toBe(3);
  });

  it("refuses an unknown link with no detail", async () => {
    app = await build();
    const res = await post("u".repeat(43));
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("u".repeat(43));
  });

  it("refuses a malformed token before it reaches anything", async () => {
    app = await build();
    expect((await post("short")).statusCode).toBe(422);
  });
});
