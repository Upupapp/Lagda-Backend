// A double is only worth its type check.
//
// `session-routes.test.ts` decorated `request.auth` through a cast:
//
//     (request as { auth?: unknown }).auth = { sessionId: "ses_1" };
//
// RequestAuth has never had a `sessionId`. The cast is what allowed the
// invention, and twenty-one tests then described a sign-out that did not
// exist -- one that revoked nothing, because the handler's real branch was
// never reached. The bug and its test agreed with each other and disagreed
// with the application.
//
// Casting `request` to a local object type erases exactly the check that would
// have caught it. `request.auth` is declared by module augmentation on
// FastifyRequest, so a direct assignment is already fully typed: the cast buys
// nothing except the ability to be wrong.
//
// WHAT THIS DOES NOT COVER, stated because the gap matters more than the rule:
// this catches a double with the WRONG SHAPE. It cannot catch a double with
// the right shape and no behaviour -- upload-route.test.ts's
// `commitAcceptance: () => Promise.resolve()` type-checks perfectly and is why
// a fully-tested upload route still left every document without bytes. That
// failure is not mechanically detectable; only asserting the EFFECT catches it.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `(request as { … })` and `(reply as { … })`. */
const CAST = /\((?:request|reply)\s+as\s+\{/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    // This file quotes the banned pattern to explain it, so it must not
    // police itself.
    else if (full.endsWith(".ts") && !full.endsWith("request-typing.test.ts")) out.push(full);
  }
  return out;
}

describe("request typing", () => {
  const files = sourceFiles(API_SRC);

  it("finds the sources to check", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("never casts a request or reply to a local shape", () => {
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        // Comments may quote the pattern -- explaining why it is banned is not
        // doing it.
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (CAST.test(line)) offenders.push(`${relative(API_SRC, file)}:${index + 1}`);
        CAST.lastIndex = 0;
      });
    }
    expect(
      offenders,
      "assign through the augmented FastifyRequest type instead — a cast here " +
      "is how a test double invents a field the application does not have",
    ).toEqual([]);
  });
});
