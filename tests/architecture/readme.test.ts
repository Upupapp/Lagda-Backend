// The README describes commands that exist, and every command it describes.
//
// ── Why this is a test ─────────────────────────────────────────────────────
//
// The commands table went stale silently: it listed nine scripts while
// `package.json` had twenty-one, and the prose beneath it stated that
// `dev:api` and `dev:worker` "do not exist" long after both did. Nothing was
// wrong with the code; the document simply stopped being true, and there was
// no way to notice except by reading both.
//
// A README that disagrees with the repository is worse than one that says
// nothing, because it is believed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readme = (): string => readFileSync(path.join(ROOT, "README.md"), "utf8");

const scripts = (): string[] => {
  const parsed = JSON.parse(
    readFileSync(path.join(ROOT, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  return Object.keys(parsed.scripts ?? {});
};

describe("the README's command table", () => {
  it("finds the scripts it means to check", () => {
    // A guard whose extraction returns nothing passes everything.
    expect(scripts().length).toBeGreaterThan(10);
  });

  /**
   * Every script is named somewhere in the README.
   *
   * Not "in the table" -- some are better explained in prose, and demanding a
   * row would push the document towards a shape that suits the test rather
   * than the reader. What must not happen is a script nobody can discover.
   */
  it("names every script in package.json", () => {
    const text = readme();
    const undocumented = scripts().filter(name => !text.includes(`npm run ${name}`));
    // `npm test` is invoked without `run`, so it is named differently.
    expect(undocumented.filter(name => name !== "test")).toEqual([]);
  });

  /**
   * And describes no script that has been removed.
   *
   * The reverse failure is quieter and lasts longer: a reader tries the
   * command, it fails, and they cannot tell whether they are holding it wrong.
   */
  it("describes no script that no longer exists", () => {
    const available = new Set(scripts());
    const mentioned = [...readme().matchAll(/`npm run ([a-z:]+)`/g)]
      .map(match => match[1] ?? "");
    const gone = [...new Set(mentioned)].filter(name => !available.has(name));
    expect(gone).toEqual([]);
  });
});
