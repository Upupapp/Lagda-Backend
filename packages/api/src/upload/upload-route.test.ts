// The multipart boundary.
//
// What matters here is not the pipeline — that is tested separately — but the
// ORDER: nothing expensive may run before the request has proved who it is.
// Every test below therefore asserts about what did NOT happen as much as what
// did.

import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import type { DocumentId, Sha256Digest, WorkspaceId } from "@lagda/contracts";
import type {
  ObjectStorage, UploadDependencies, UploadId, ArtifactId,
} from "@lagda/application";
import { registerUploadRoute, STATUS_BY_REASON } from "./upload-route.js";

const WS = "ws_alpha" as WorkspaceId;
const PDF = "%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";

const sha256 = (bytes: Uint8Array): Sha256Digest =>
  createHash("sha256").update(bytes).digest("hex") as Sha256Digest;

// eslint-disable-next-line @typescript-eslint/require-await
async function* one(bytes: Uint8Array): AsyncGenerator<Uint8Array> { yield bytes; }

interface Built {
  readonly app: FastifyInstance;
  readonly puts: string[];
  readonly scans: number[];
  /** Which trusted context the pipeline was built for, per request. */
  readonly contexts: { workspaceId: string; userId: string }[];
}

async function build(options: {
  authorized?: boolean;
  maxBytes?: number;
} = {}): Promise<Built> {
  const app = Fastify({ logger: false });
  const puts: string[] = [];
  const scans: number[] = [];
  const contexts: { workspaceId: string; userId: string }[] = [];

  const storage: ObjectStorage = {
    putObject(input) {
      puts.push(input.ref.zone);
      return Promise.resolve({ ref: input.ref, sizeBytes: 0 });
    },
    getObject: ref => Promise.resolve({
      ref, sizeBytes: PDF.length, mediaType: "application/pdf",
      stream: one(new TextEncoder().encode(PDF)),
    }),
    headObject: () => Promise.resolve(null),
    deleteObject: () => Promise.resolve(),
  };

  const dependenciesFor = (context: { workspaceId: WorkspaceId; userId: string }):
  UploadDependencies => {
    contexts.push({ workspaceId: context.workspaceId, userId: context.userId });
    return {
    storage,
    keys: {
      artifactKey: ({ workspaceId, documentId, artifactId }) => ({
        zone: "artifacts",
        key: `workspaces/${workspaceId}/documents/${documentId}/artifacts/${artifactId}.pdf` as never,
      }),
      quarantineKey: ({ workspaceId, uploadId }) => ({
        zone: "quarantine",
        key: `quarantine/${workspaceId}/uploads/${uploadId}` as never,
      }),
    },
    inspector: {
      inspect: () => Promise.resolve({
        outcome: "ok", detectedMediaType: "application/pdf",
        pageCount: 1, pageSizes: [{ width: 612, height: 792 }],
      }),
    },
    scanner: {
      scan: (input) => {
        scans.push(input.byteSize);
        return Promise.resolve({ outcome: "clean" });
      },
      isAvailable: () => Promise.resolve(true),
    },
    uploads: {
      insert: () => Promise.resolve(),
      find: () => Promise.resolve(null),
      complete: () => Promise.resolve(),
    },
    commitAcceptance: () => Promise.resolve(),
    newUploadId: () => "upl_1" as UploadId,
    newArtifactId: () => "art_1" as ArtifactId,
      clock: { now: () => 0 },
      digestOf: sha256,
    };
  };

  await registerUploadRoute(app, {
    path: "/test/uploads",
    limits: { maxBytes: options.maxBytes ?? 1024 * 1024, maxPages: 100 },
    dependenciesFor,
    resolveContext: (_request: FastifyRequest) =>
      options.authorized === false
        ? null
        : { workspaceId: WS, userId: "usr_1", documentId: "doc_1" as DocumentId },
  });
  await app.ready();
  return { app, puts, scans, contexts };
}

/** A minimal multipart body. Hand-built so the exact bytes are controlled. */
function multipart(parts: {
  files?: { name: string; filename: string; type: string; body: string }[];
  fields?: { name: string; value: string }[];
}): { payload: Buffer; headers: Record<string, string> } {
  const boundary = "----LagdaTestBoundary";
  const chunks: string[] = [];
  for (const field of parts.fields ?? []) {
    chunks.push(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${field.name}"\r\n\r\n`
      + `${field.value}\r\n`);
  }
  for (const file of parts.files ?? []) {
    chunks.push(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n`
      + `Content-Type: ${file.type}\r\n\r\n`
      + `${file.body}\r\n`);
  }
  chunks.push(`--${boundary}--\r\n`);
  return {
    payload: Buffer.from(chunks.join(""), "binary"),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

const onePdf = (body = PDF, filename = "contract.pdf"): ReturnType<typeof multipart> =>
  multipart({ files: [{ name: "file", filename, type: "application/pdf", body }] });

describe("upload route", () => {
  it("accepts one valid file and returns no internal details", async () => {
    const { app } = await build();
    const { payload, headers } = onePdf();
    const response = await app.inject({
      method: "POST", url: "/test/uploads", payload, headers,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<Record<string, unknown>>();
    expect(body["artifactId"]).toBe("art_1");
    expect(body["pageCount"]).toBe(1);

    // NOTHING internal escapes: no quarantine key, no bucket, no storage
    // reference, no scanner output (§249).
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      "quarantine", "bucket", "lagda-test", "storageReference", "s3", "X-Amz-",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    await app.close();
  });

  it("REFUSES an unauthorized caller without reading the body", async () => {
    // The decisive ordering assertion: authorization runs before a single byte
    // is quarantined, or LAGDA becomes a free scanning service (§191).
    const { app, puts, scans } = await build({ authorized: false });
    const { payload, headers } = onePdf();
    const response = await app.inject({
      method: "POST", url: "/test/uploads", payload, headers,
    });

    expect(response.statusCode).toBe(403);
    expect(puts).toHaveLength(0);
    expect(scans).toHaveLength(0);
    await app.close();
  });

  it("REJECTS a request carrying more than one file", async () => {
    // An ignored second file is content the user believes was received.
    const { app, puts } = await build();
    const body = multipart({
      files: [
        { name: "file", filename: "a.pdf", type: "application/pdf", body: PDF },
        { name: "extra", filename: "b.pdf", type: "application/pdf", body: PDF },
      ],
    });
    const response = await app.inject({
      method: "POST", url: "/test/uploads", payload: body.payload, headers: body.headers,
    });

    // The SPECIFIC refusal, not merely "some 4xx". Asserting `>= 400` passed
    // even with the explicit check removed, because the plugin's files-limit
    // fired instead - a green test for a guarantee that was gone.
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("TOO_MANY_FILES");
    // And the second file never became an accepted artifact.
    expect(puts.filter(zone => zone === "artifacts")).toHaveLength(0);
    await app.close();
  });

  it("REJECTS a multipart body with no file", async () => {
    const { app, puts } = await build();
    const body = multipart({ fields: [{ name: "title", value: "no file here" }] });
    const response = await app.inject({
      method: "POST", url: "/test/uploads", payload: body.payload, headers: body.headers,
    });

    expect(response.statusCode).toBe(422);
    expect(puts).toHaveLength(0);
    await app.close();
  });

  it("REJECTS an abusive number of fields", async () => {
    const { app } = await build();
    const body = multipart({
      fields: Array.from({ length: 200 }, (_, i) => ({
        name: `f${String(i)}`, value: "x",
      })),
      files: [{ name: "file", filename: "a.pdf", type: "application/pdf", body: PDF }],
    });
    const response = await app.inject({
      method: "POST", url: "/test/uploads", payload: body.payload, headers: body.headers,
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    await app.close();
  });

  it("REJECTS a body larger than the limit with 413", async () => {
    const { app } = await build({ maxBytes: 1024 });
    const { payload, headers } = onePdf("A".repeat(5000));
    const response = await app.inject({
      method: "POST", url: "/test/uploads", payload, headers,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("FILE_TOO_LARGE");
    await app.close();
  });

  it("REJECTS a JSON body with an unsupported-media-type error", async () => {
    // A multipart-only endpoint must say so rather than failing obscurely.
    const { app } = await build();
    const response = await app.inject({
      method: "POST", url: "/test/uploads",
      payload: JSON.stringify({ hello: "world" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(415);
    await app.close();
  });

  it("IGNORES a workspaceId field in the body", async () => {
    // The tenancy bypass this route must not have. A body field is chosen by
    // the client; the workspace comes from the authenticated context (INV-224).
    const { app, contexts } = await build();
    const body = multipart({
      fields: [
        { name: "workspaceId", value: "ws_attacker" },
        { name: "userId", value: "usr_attacker" },
      ],
      files: [{ name: "file", filename: "a.pdf", type: "application/pdf", body: PDF }],
    });
    const response = await app.inject({
      method: "POST", url: "/test/uploads", payload: body.payload, headers: body.headers,
    });

    expect(response.statusCode).toBe(201);
    // The pipeline was built for the AUTHENTICATED workspace, never the body's.
    expect(contexts).toEqual([{ workspaceId: WS, userId: "usr_1" }]);
    await app.close();
  });

  it("maps every rejection reason to a distinct, safe status", () => {
    // Statuses drive client behaviour: 413 means shrink it, 415 means wrong
    // type, 503 means try again later. Collapsing them loses that.
    const expected: Record<string, number> = {
      "file-too-large": 413,
      "unsupported-file-type": 415,
      "malformed-pdf": 422,
      "malware-detected": 422,
      "scan-unavailable": 503,
      "storage-failure": 503,
    };
    for (const [reason, status] of Object.entries(expected)) {
      expect(STATUS_BY_REASON[reason as keyof typeof STATUS_BY_REASON]).toBe(status);
    }
  });
});

