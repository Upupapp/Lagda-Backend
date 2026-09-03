// Every ON CONFLICT target must match a real unique index.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// `recordCompletion` targeted `ON CONFLICT (signing_request_id)` while the key
// was `PRIMARY KEY (workspace_id, signing_request_id)`. PostgreSQL requires an
// inference target to match a unique index EXACTLY, so the insert threw for
// every completion the pipeline ever tried to record -- and the comment beside
// it asserted a UNIQUE that does not exist.
//
// Nothing could have caught it earlier. A fake has no indexes, so the unit
// suite cannot refuse the statement; and the only path that reaches it is the
// completion pipeline, which no unit test drives end to end. The defect was
// invisible until an integration run.
//
// So this reads the REPOSITORIES and asks the DATABASE, rather than asserting a
// list someone has to remember to update. A new upsert against a compound key
// fails here on the day it is written.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sql } from "kysely";
import { createTestDatabase, hasIntegrationDatabase } from "./testing/harness.js";
import type { LagdaDatabase } from "./client/index.js";

const REPOSITORIES = join(import.meta.dirname, "repositories");

interface Upsert {
  readonly file: string;
  readonly table: string;
  readonly columns: readonly string[];
}

/**
 * Every `insertInto(...).onConflict(...)` pair in the repositories.
 *
 * Split on the insert rather than matched with one expression: a single regex
 * spanning both has to guess how much lies between them, and the amount varies
 * from one line to forty.
 */
function upserts(): readonly Upsert[] {
  const found: Upsert[] = [];
  for (const file of readdirSync(REPOSITORIES).filter(name => name.endsWith(".ts"))) {
    const source = readFileSync(join(REPOSITORIES, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    for (const chunk of source.split('.insertInto("').slice(1)) {
      const table = /^(\w+)"/.exec(chunk)?.[1];
      if (table === undefined) continue;
      // Only this statement's own conflict clause: stop at the next insert.
      const statement = chunk.split('.insertInto("')[0] ?? "";
      const target = /\.onConflict\([\s\S]{0,80}?\.(columns\(\[([\s\S]*?)\]\)|column\("(\w+)"\))/
        .exec(statement);
      if (target === null) continue;

      const columns = target[3] !== undefined
        ? [target[3]]
        : [...(target[2] ?? "").matchAll(/"(\w+)"/g)].map(m => m[1] ?? "");
      found.push({ file, table, columns });
    }
  }
  return found;
}

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("every ON CONFLICT target matches a unique index", () => {
  let database: LagdaDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  it("finds the upserts it means to check", () => {
    // A source-reading guard whose extraction returns nothing passes
    // everything. The count is a floor, not a fixture: adding an upsert should
    // not fail this.
    expect(upserts().length).toBeGreaterThanOrEqual(8);
  });

  it("matches each target to a unique index on the same table", async () => {
    const rows = await sql<{ tablename: string; indexdef: string }>`
      select tablename, indexdef from pg_indexes
      where schemaname = 'public' and indexdef like 'CREATE UNIQUE INDEX%'
    `.execute(database.db);

    /** Unique column SETS per table. Inference ignores order. */
    const uniques = new Map<string, string[][]>();
    for (const row of rows.rows) {
      const inside = /\(([^)]*)\)\s*$/.exec(row.indexdef)?.[1] ?? "";
      const columns = inside.split(",").map(c => c.trim()).filter(c => c.length > 0);
      uniques.set(row.tablename, [...(uniques.get(row.tablename) ?? []), columns]);
    }

    const mismatched: string[] = [];
    for (const upsert of upserts()) {
      const candidates = uniques.get(upsert.table) ?? [];
      const wanted = [...upsert.columns].sort().join(",");
      const matches = candidates.some(c => [...c].sort().join(",") === wanted);
      if (!matches) {
        mismatched.push(
          `${upsert.file}: ON CONFLICT (${upsert.columns.join(", ")}) on `
          + `"${upsert.table}" matches no unique index. Available: `
          + `${candidates.map(c => `(${c.join(", ")})`).join(" ") || "none"}`,
        );
      }
    }

    expect(mismatched).toEqual([]);
  });
});
