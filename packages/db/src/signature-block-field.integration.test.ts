// 076, against the LIVE schema: every table that closes `field_type` over the
// vocabulary now admits `signature-block` and still refuses anything unknown.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "kysely";
import { PREPARATION_FIELD_TYPES } from "@lagda/contracts";
import type { LagdaDatabase } from "./client/index.js";
import { createTestDatabase, hasIntegrationDatabase } from "./testing/harness.js";

const suite = hasIntegrationDatabase() ? describe : describe.skip;

const CONSTRAINTS = [
  "preparation_fields_type_check",
  "signing_request_fields_type_check",
  "workflow_template_fields_type_check",
];

suite("signature-block field type (076)", () => {
  let db: LagdaDatabase;
  beforeAll(async () => { db = await createTestDatabase(); });
  afterAll(async () => { await db.close(); });

  it.each(CONSTRAINTS)("%s admits exactly the contract's field types", async name => {
    const { rows } = await sql<{ def: string }>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}
    `.execute(db.db);
    expect(rows).toHaveLength(1);
    const def = rows[0]!.def;
    for (const type of PREPARATION_FIELD_TYPES) expect(def).toContain(`'${type}'`);
    expect(def).toContain("'signature-block'");
  });

  it("still refuses an unknown type", async () => {
    const { rows } = await sql<{ def: string }>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'preparation_fields_type_check'
    `.execute(db.db);
    expect(rows[0]!.def).not.toContain("'radio-group'");
  });
});
