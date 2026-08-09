// @lagda/storage — the object storage adapter.
//
// The AWS SDK is imported by exactly two files in this package (the adapter and
// the test-service helper) and appears in no exported type. A composition root
// wires `createS3ObjectStorage` and hands the result to application code as an
// `ObjectStorage` (INV-203).

export { createS3ObjectStorage } from "./s3/s3-object-storage.js";
export { createStorageKeyStrategy } from "./s3/s3-key-strategy.js";
export {
  loadStorageConfig, describeStorageConfig, StorageConfigError,
  type S3StorageConfig,
} from "./s3/s3-config.js";
export { mapStorageError, isNotFound } from "./s3/s3-error-mapper.js";

// ── Test support ────────────────────────────────────────────────────────────
//
// Exported so other packages can test AGAINST storage without reaching for the
// SDK. Keeping bucket provisioning behind this boundary is what lets the import
// ban stay absolute rather than "absolute except in tests".

export {
  createInMemoryObjectStorage, collect, type InMemoryObjectStorage,
} from "./testing/in-memory-object-storage.js";
export {
  runObjectStorageContract, samplePdf, type ContractHarness,
} from "./testing/storage-contract.js";
export {
  ensureTestBuckets, testStorageConfig, TEST_BUCKETS,
} from "./testing/test-service.js";
