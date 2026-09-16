// Real `statfs` against real paths — no mock filesystem. The one thing worth
// proving is the threshold arithmetic, which a fake stat object can get
// wrong in a way that looks right.

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { createDiskCapacityChecker } from "./disk-capacity-checker.js";

describe("createDiskCapacityChecker", () => {
  it("reports available when the threshold is trivially low", async () => {
    const checker = createDiskCapacityChecker({ path: tmpdir(), minFreeBytes: 1 });
    const status = await checker.check();
    expect(status.available).toBe(true);
    expect(status.freeBytes).toBeGreaterThan(0);
    expect(status.totalBytes).toBeGreaterThan(0);
  });

  it("reports unavailable when the threshold exceeds any real disk", async () => {
    const checker = createDiskCapacityChecker({
      path: tmpdir(),
      // No real machine has an exabyte free. If this ever fails, buy a
      // lottery ticket.
      minFreeBytes: Number.MAX_SAFE_INTEGER,
    });
    const status = await checker.check();
    expect(status.available).toBe(false);
  });

  it("rejects for a path that does not exist", async () => {
    const checker = createDiskCapacityChecker({
      path: "/definitely/not/a/real/path/lagda-test",
      minFreeBytes: 1,
    });
    await expect(checker.check()).rejects.toBeDefined();
  });
});
