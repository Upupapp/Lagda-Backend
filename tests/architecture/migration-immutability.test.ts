// An applied migration is history, and history does not change.
//
// This exists because the rule was broken here, and the feedback arrived at
// the worst possible moment. A column was added by editing migration 051 —
// which production had already run. The file changed; the database did not.
// Every test passed, the build passed, and the failure would have been a
// runtime error on the first real request, looking like a code bug rather
// than a schema that was never created.
//
// A test cannot know which migrations a given database has run. What it CAN
// know is which ones are old enough that some database somewhere has almost
// certainly run them — and for those, an edit is a mistake worth blocking
// before it reaches a deploy.

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const MIGRATIONS = path.resolve(process.cwd(), "packages/db/src/migrations");

/**
 * Migrations up to and including this one have shipped.
 *
 * Raised deliberately, as part of a deploy, never casually — the number is a
 * claim that every database in existence has already run these.
 */
const LAST_SHIPPED = 51;

function migrationNumber(file: string): number | null {
  const match = /^(\d{3})_/.exec(file);
  return match === null ? null : Number(match[1]);
}

describe("shipped migrations are immutable", () => {
  it("has not modified any migration at or below the shipped mark", () => {
    // Compared against the default branch rather than the working tree, so a
    // local edit is caught before it becomes a commit someone deploys.
    let changed: string[] = [];
    try {
      const output = execSync(
        "git diff --name-only origin/master -- packages/db/src/migrations",
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      );
      changed = output.split("\n").filter(line => line.trim().length > 0);
    } catch {
      // No git, no origin, or a shallow checkout: skip rather than fail. A
      // guard that breaks CI when it cannot see history teaches people to
      // delete it.
      return;
    }

    const violations = changed
      .map(file => path.basename(file))
      .filter(file => {
        const number = migrationNumber(file);
        return number !== null && number <= LAST_SHIPPED;
      });

    expect(violations, [
      "These migrations have already run somewhere. Editing the file does not",
      "change the database — it only changes what a fresh one would get.",
      "Add a new migration instead.",
    ].join(" ")).toEqual([]);
  });

  it("numbers every migration uniquely and contiguously", () => {
    // Two migrations sharing a number is a merge that silently dropped one.
    const numbers = readdirSync(MIGRATIONS)
      .filter(file => /^\d{3}_.*\.ts$/.test(file) && !file.endsWith(".test.ts"))
      .map(migrationNumber)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);

    expect(new Set(numbers).size).toBe(numbers.length);
    for (let index = 1; index < numbers.length; index++) {
      expect(numbers[index]).toBe((numbers[index - 1] ?? 0) + 1);
    }
  });
});
