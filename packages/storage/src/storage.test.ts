// Storage unit tests: key construction, configuration, error mapping,
// redaction, and the in-memory implementation against the shared contract.
//
// Nothing here touches a network. The S3 adapter's real behaviour is proven in
// storage.integration.test.ts against a running S3-compatible service.

import { describe, it, expect } from "vitest";
import {
  toStorageObjectKey, InvalidStorageReferenceError, StorageError,
} from "@lagda/application";
import type { WorkspaceId, DocumentId } from "@lagda/contracts";
import { createStorageKeyStrategy } from "./s3/s3-key-strategy.js";
import { loadStorageConfig, describeStorageConfig, StorageConfigError } from "./s3/s3-config.js";
import { mapStorageError, isNotFound } from "./s3/s3-error-mapper.js";
import { createInMemoryObjectStorage } from "./testing/in-memory-object-storage.js";
import { runObjectStorageContract } from "./testing/storage-contract.js";

const WS = "ws_alpha" as WorkspaceId;
const DOC = "doc_1" as DocumentId;
const ART = "art_1";

// ── The shared contract, against the fake ───────────────────────────────────

let counter = 0;
runObjectStorageContract("in-memory", () => {
  const storage = createInMemoryObjectStorage();
  counter += 1;
  const run = counter;
  return {
    storage,
    ref: (zone, suffix) => ({
      zone,
      key: toStorageObjectKey(`test/${String(run)}/${suffix}`),
    }),
  };
});

// ── Key strategy ────────────────────────────────────────────────────────────

describe("storage key strategy", () => {
  const keys = createStorageKeyStrategy();

  it("builds a tenant-aware, artifact-addressed key", () => {
    const ref = keys.artifactKey({
      workspaceId: WS, documentId: DOC, artifactId: ART as never,
    });
    expect(ref.zone).toBe("artifacts");
    expect(ref.key).toBe("workspaces/ws_alpha/documents/doc_1/artifacts/art_1.pdf");
  });

  it("keys by ARTIFACT, not document, so a second artifact cannot overwrite the first", () => {
    // One document has original, sealed and completion-certificate artifacts.
    // Keying by document would make the sealed PDF replace the original.
    const original = keys.artifactKey({
      workspaceId: WS, documentId: DOC, artifactId: "art_original" as never,
    });
    const sealed = keys.artifactKey({
      workspaceId: WS, documentId: DOC, artifactId: "art_sealed" as never,
    });
    expect(original.key).not.toBe(sealed.key);
  });

  it("separates workspaces, so one tenant's key can never address another's", () => {
    const a = keys.artifactKey({
      workspaceId: "ws_a" as WorkspaceId, documentId: DOC, artifactId: ART as never,
    });
    const b = keys.artifactKey({
      workspaceId: "ws_b" as WorkspaceId, documentId: DOC, artifactId: ART as never,
    });
    expect(a.key).not.toBe(b.key);
    expect(a.key.startsWith("workspaces/ws_a/")).toBe(true);
    expect(b.key.startsWith("workspaces/ws_b/")).toBe(true);
  });

  it("puts quarantine in its own zone under an UPLOAD id, never an artifact id", () => {
    // Untrusted bytes must not carry an accepted artifact's identity before
    // anything has validated them (§163).
    const ref = keys.quarantineKey({ workspaceId: WS, uploadId: "upl_9" });
    expect(ref.zone).toBe("quarantine");
    expect(ref.key).toBe("quarantine/ws_alpha/uploads/upl_9");
  });

  it("REJECTS an identifier that would reshape the key", () => {
    // These identifiers are LAGDA-generated, so this is a bug guard rather
    // than an attack surface - but a segment containing a separator would
    // silently write into a different prefix.
    for (const bad of ["../../etc", "ws/../other", "ws a", "", "x".repeat(65), "/ws"]) {
      expect(() => keys.artifactKey({
        workspaceId: bad as WorkspaceId, documentId: DOC, artifactId: ART as never,
      })).toThrow(TypeError);
    }
  });

  it("contains NO customer filename anywhere in the key", () => {
    // A filename in the key publishes the subject of a legal document into
    // provider access logs and admin consoles (INV-209).
    const ref = keys.artifactKey({
      workspaceId: WS, documentId: DOC, artifactId: ART as never,
    });
    for (const fragment of ["Complaint", "confidential", ".docx", "Affidavit"]) {
      expect(ref.key).not.toContain(fragment);
    }
    // Only opaque identifiers and fixed structural words.
    expect(ref.key.replace(/[A-Za-z0-9._/-]/g, "")).toBe("");
  });
});

describe("storage key validation", () => {
  it("accepts a well-formed key", () => {
    expect(toStorageObjectKey("workspaces/ws_a/documents/d/artifacts/a.pdf")).toBeTruthy();
  });

  it("rejects traversal, empty segments, absolute paths and overlong keys", () => {
    for (const bad of [
      "", "/leading", "a//b", "a/../b", "trailing/", "a b", "a\u0000b", "a\u007fb",
      `a/${"x".repeat(600)}`, "../secret",
    ]) {
      expect(() => toStorageObjectKey(bad)).toThrow(InvalidStorageReferenceError);
    }
  });
});

// ── Configuration ───────────────────────────────────────────────────────────

const VALID_ENV = {
  OBJECT_STORAGE_REGION: "ap-southeast-1",
  OBJECT_STORAGE_BUCKET_ARTIFACTS: "lagda-artifacts",
  OBJECT_STORAGE_BUCKET_QUARANTINE: "lagda-quarantine",
  OBJECT_STORAGE_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKE",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "s3cr3t-fake-value-for-tests-only",
  OBJECT_STORAGE_ENDPOINT: "https://example-object-storage.invalid",
};

describe("storage configuration", () => {
  it("loads a valid configuration", () => {
    const config = loadStorageConfig(VALID_ENV);
    expect(config.region).toBe("ap-southeast-1");
    expect(config.buckets.artifacts).toBe("lagda-artifacts");
    expect(config.buckets.quarantine).toBe("lagda-quarantine");
  });

  it("names every missing setting without printing any value", () => {
    try {
      loadStorageConfig({ OBJECT_STORAGE_REGION: "x" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(StorageConfigError);
      const message = (error as Error).message;
      expect(message).toContain("OBJECT_STORAGE_SECRET_ACCESS_KEY");
      expect(message).toContain("OBJECT_STORAGE_BUCKET_ARTIFACTS");
      expect(message).not.toContain("s3cr3t");
    }
  });

  it("REFUSES a plaintext endpoint unless explicitly allowed outside production", () => {
    expect(() => loadStorageConfig({
      ...VALID_ENV, OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
    })).toThrow(/https/);

    // Allowed for a local S3-compatible service.
    expect(loadStorageConfig({
      ...VALID_ENV,
      OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
      OBJECT_STORAGE_ALLOW_INSECURE: "true",
    }).allowInsecureEndpoint).toBe(true);
  });

  it("REFUSES the insecure escape hatch in production, even when set", () => {
    // The flag cannot be left in a production environment file and quietly
    // take effect. Documents and signing evidence travel this connection.
    expect(() => loadStorageConfig({
      ...VALID_ENV,
      NODE_ENV: "production",
      OBJECT_STORAGE_ENDPOINT: "http://storage.internal",
      OBJECT_STORAGE_ALLOW_INSECURE: "true",
    })).toThrow(StorageConfigError);
  });

  it("rejects a non-numeric timeout rather than silently defaulting", () => {
    expect(() => loadStorageConfig({
      ...VALID_ENV, OBJECT_STORAGE_REQUEST_TIMEOUT_MS: "soon",
    })).toThrow(StorageConfigError);
  });

  it("NEVER exposes credentials in the loggable projection", () => {
    // An allowlist, not a redaction pass - a denylist leaks the first field
    // someone adds without thinking (INV-212).
    const described = describeStorageConfig(loadStorageConfig(VALID_ENV));
    const serialized = JSON.stringify(described);
    expect(serialized).not.toContain("s3cr3t");
    expect(serialized).not.toContain("AKIAFAKEFAKEFAKE");
    expect(serialized).not.toMatch(/secret|accessKey/i);
    // Still useful for diagnosis.
    expect(described["region"]).toBe("ap-southeast-1");
  });
});

// ── Error mapping ───────────────────────────────────────────────────────────

describe("provider error mapping", () => {
  it("maps by structured name and status, not by message text", () => {
    const cases: ReadonlyArray<readonly [object, string]> = [
      [{ name: "NoSuchKey", $metadata: { httpStatusCode: 404 } }, "object-not-found"],
      [{ name: "AccessDenied", $metadata: { httpStatusCode: 403 } }, "access-denied"],
      [{ name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } }, "object-already-exists"],
      [{ name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 } }, "unavailable"],
      [{ name: "TimeoutError" }, "timeout"],
      [{ code: "ECONNREFUSED" }, "unavailable"],
      [{ code: "ETIMEDOUT" }, "timeout"],
      [{ $metadata: { httpStatusCode: 500 } }, "unavailable"],
    ];
    for (const [raw, expected] of cases) {
      expect(mapStorageError(raw, "read-failed", "get").category).toBe(expected);
    }
  });

  it("falls back to the operation's own category for an unrecognised failure", () => {
    expect(mapStorageError({ name: "SomethingNew" }, "write-failed", "put").category)
      .toBe("write-failed");
  });

  it("classifies retryability deliberately", () => {
    // access-denied is a misconfiguration. Retrying it turns a clear failure
    // into a slow one and burns a job's attempt budget.
    expect(mapStorageError({ name: "AccessDenied" }, "read-failed", "get").retryable)
      .toBe(false);
    expect(mapStorageError({ name: "ServiceUnavailable" }, "read-failed", "get").retryable)
      .toBe(true);
    expect(mapStorageError({ name: "TimeoutError" }, "read-failed", "get").retryable)
      .toBe(true);
  });

  it("does NOT leak provider prose into the message", () => {
    // Provider text can carry a bucket name, a key, or a signed query string,
    // and this message reaches logs (§100).
    const mapped = mapStorageError({
      name: "AccessDenied",
      message: "Access Denied for https://bucket.example/key?X-Amz-Signature=deadbeef",
      $metadata: { httpStatusCode: 403, requestId: "req-123" },
    }, "read-failed", "get");

    expect(mapped.message).not.toContain("X-Amz-Signature");
    expect(mapped.message).not.toContain("bucket.example");
    // The request id IS kept - it is what a provider support ticket needs.
    expect(mapped.providerRequestId).toBe("req-123");
  });

  it("passes a LAGDA error through unchanged", () => {
    const original = new StorageError("integrity-mismatch", "bad digest");
    expect(mapStorageError(original, "read-failed", "get")).toBe(original);
  });

  it("recognises not-found without depending on wording", () => {
    expect(isNotFound({ name: "NoSuchKey" })).toBe(true);
    expect(isNotFound({ $metadata: { httpStatusCode: 404 } })).toBe(true);
    expect(isNotFound({ name: "AccessDenied" })).toBe(false);
    expect(isNotFound("a string")).toBe(false);
  });
});
