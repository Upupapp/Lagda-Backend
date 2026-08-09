// Helpers for tests that need a real S3-compatible service.
//
// Bucket provisioning lives HERE so that tests outside this package never need
// the SDK. Keeping the import confined is the whole point of INV-203, and a
// test is not an exemption from it.

import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import type { S3StorageConfig } from "../s3/s3-config.js";

/** The buckets integration tests use. Dedicated and disposable — never a real one. */
export const TEST_BUCKETS = {
  artifacts: "lagda-test-artifacts",
  quarantine: "lagda-test-quarantine",
} as const;

/**
 * Configuration for a local S3-compatible service.
 *
 * Local-only credentials for a throwaway instance. Never real secrets, and
 * nothing here is valid against any deployed provider.
 */
export function testStorageConfig(
  endpoint: string, overrides: Partial<S3StorageConfig> = {},
): S3StorageConfig {
  return {
    endpoint,
    region: "us-east-1",
    buckets: TEST_BUCKETS,
    accessKeyId: "lagdatestkey",
    secretAccessKey: "lagdatestsecret",
    forcePathStyle: true,
    requestTimeoutMs: 15_000,
    maxAttempts: 2,
    allowInsecureEndpoint: true,
    ...overrides,
  };
}

/** Creates the test buckets. Idempotent: an existing bucket is not an error. */
export async function ensureTestBuckets(endpoint: string): Promise<void> {
  const client = new S3Client({
    endpoint, region: "us-east-1", forcePathStyle: true,
    credentials: { accessKeyId: "lagdatestkey", secretAccessKey: "lagdatestsecret" },
  });
  try {
    for (const bucket of Object.values(TEST_BUCKETS)) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch {
        // Present from an earlier run.
      }
    }
  } finally {
    client.destroy();
  }
}

/**
 * A small syntactically valid PDF. Synthetic - never a customer document.
 *
 * Lives here rather than in the contract suite because that file imports
 * `vitest`, and anything the package INDEX re-exports is pulled into every
 * consumer. Exporting the suite from the index dragged the test framework into
 * production imports of @lagda/storage.
 */
export function samplePdf(): Uint8Array {
  return new TextEncoder().encode(
    "%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  );
}
