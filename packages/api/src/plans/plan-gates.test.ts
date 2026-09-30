// Every plan gate names a route that exists: a typo would silently gate
// nothing. Read from the route modules' own source, like the architecture
// tests, so no app has to be composed.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PLAN_GATES } from "./plan-routes.js";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [readFileSync(path, "utf8")] : [];
  });
}

describe("plan gates", () => {
  const all = sources(join(import.meta.dirname, "..")).join("\n");

  it("names only routes that are registered", () => {
    for (const gate of PLAN_GATES) {
      const call = `app.${gate.method.toLowerCase()}(`;
      const literal = gate.url.replace("/workspaces/:workspaceId", "");
      const registered = all.includes(`${call}"${gate.url}"`) || all.includes(`${call}\`\${W}${literal}\``)
        || all.includes(`${call}"/workspaces/:workspaceId${literal}"`);
      expect(registered, `${gate.method} ${gate.url}`).toBe(true);
    }
  });

  it("keeps joining another workspace on the person's own plan", () => {
    const own = PLAN_GATES.filter(g => g.own === true).map(g => g.url).sort();
    expect(own).toEqual(["/invitations/accept", "/me/invitations/:invitationId/accept", "/workspace-join/requests"]);
    expect(PLAN_GATES.filter(g => g.own === true).every(g => g.minimum === "personal")).toBe(true);
  });
});
