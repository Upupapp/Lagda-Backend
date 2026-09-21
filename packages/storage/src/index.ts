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

// Re-exported, not defined here any more.
//
// The double implements a port @lagda/application owns and holds no provider
// code, so it belongs beside the port (INV-005) — and defining it here closed
// a package cycle, since storage already depends on application. It is still
// exported from this package so a caller that already imports @lagda/storage
// does not have to add a second import to get the fake.
export {
  createInMemoryObjectStorage, collect, type InMemoryObjectStorage,
} from "@lagda/application/test-support";
export {
  ensureTestBuckets, testStorageConfig, samplePdf, TEST_BUCKETS,
} from "./testing/test-service.js";
export {
  createDiskCapacityChecker, type DiskCapacityCheckerConfig,
} from "./capacity/disk-capacity-checker.js";

// NOT exported here: `runObjectStorageContract`. It imports `vitest`, and
// anything this index re-exports is pulled in by every consumer - which put a
// test framework into production imports of @lagda/storage. Test files import
// it by path instead.
