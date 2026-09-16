// A local-disk capacity guard — for deployments self-hosting their
// S3-compatible store on the same machine the application runs on.
//
// ── Why this exists outside the ObjectStorage port ──────────────────────────
//
// A managed provider (AWS S3, Linode Object Storage, Cloudflare R2) has no
// meaningful "about to run out of disk" concept from the application's point
// of view — it is, for all practical purposes, unbounded. Only a self-hosted
// store sharing a disk with the API/worker/database has this problem, and it
// is a property of THAT disk, not of the object-storage protocol. Checking it
// through `ObjectStorage.getObject`/`headObject` would mean inventing a
// meaning for "free space" that every managed provider would have to fake.
//
// ── Why free bytes on a path, not the bucket's own usage ────────────────────
//
// The actual risk is the shared disk filling up entirely — which takes down
// Postgres, logs and the application itself, not just uploads (see the
// migration/deployment notes this was built alongside). So this checks
// REMAINING space on the filesystem the storage data directory lives on,
// which also naturally accounts for everything else on that same disk.

import { statfs } from "node:fs/promises";
import type { StorageCapacityChecker, StorageCapacityStatus } from "@lagda/application";

export interface DiskCapacityCheckerConfig {
  /** A path on the filesystem to check — typically the storage backend's own data directory. */
  readonly path: string;
  /** Below this many free bytes, `available` becomes false. */
  readonly minFreeBytes: number;
}

export function createDiskCapacityChecker(
  config: DiskCapacityCheckerConfig,
): StorageCapacityChecker {
  return {
    async check(): Promise<StorageCapacityStatus> {
      const stats = await statfs(config.path);
      const freeBytes = stats.bavail * stats.bsize;
      const totalBytes = stats.blocks * stats.bsize;
      return {
        available: freeBytes >= config.minFreeBytes,
        freeBytes,
        totalBytes,
      };
    },
  };
}
