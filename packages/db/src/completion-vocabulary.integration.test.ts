// Every completion vocabulary, checked against the LIVE database CHECK.
//
// ── The defect that made this necessary ────────────────────────────────────
//
// Migration 026 added `step-not-implemented` to `COMPLETION_FAILURE_CODES` and
// widened the STEP check — and never touched the FAILURE CODE check. Nothing
// noticed, because a bounded vocabulary lives in TWO places and only one of them
// is typechecked: `COMPLETION_FAILURE_CLASSIFICATION` is a frozen total `Record`,
// so adding a code without CLASSIFYING it is a compile error, while adding one
// without WIDENING ITS CHECK was nothing at all.
//
// It was not latent. `processCompletionRun` writes `step-not-implemented` on its
// only reachable path, so the first completion attempt against real PostgreSQL
// would have raised 23514 instead of parking the run for retry. The unit suite
// runs against fakes and could not see it.
//
// So this suite compares the TypeScript constant to what the database actually
// admits, by reading `pg_constraint` — not by reading the migration source,
// which is the artefact that was wrong. Adding a vocabulary member without a
// migration now fails here.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "kysely";
import {
  COMPLETION_FAILURE_CODES, COMPLETION_RUN_STATES, COMPLETION_STEPS,
  COMPLETION_STEP_STATES,
} from "@lagda/contracts";
import type { LagdaDatabase } from "./client/index.js";
import { createTestDatabase, hasIntegrationDatabase } from "./testing/harness.js";

const suite = hasIntegrationDatabase() ? describe : describe.skip;

suite("completion vocabularies match the live database", () => {
  let owner: LagdaDatabase;

  beforeAll(async () => {
    owner = await createTestDatabase();
  });

  afterAll(async () => {
    await owner?.close();
  });

  /**
   * The definition of every CHECK constraint on a table.
   *
   * Read from `pg_constraint` rather than parsed out of the migration file. The
   * migration is the thing that was wrong, so trusting it here would build the
   * guard on top of the defect it exists to catch.
   */
  async function checkDefinitions(table: string): Promise<string> {
    const result = await sql<{ definition: string }>`
      select pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conrelid = ${table}::regclass
         and contype = 'c'
    `.execute(owner.db);
    return result.rows.map((row) => row.definition).join("\n");
  }

  it("admits every COMPLETION_FAILURE_CODES value on the runs table", async () => {
    const definitions = await checkDefinitions("signing_request_completion_runs");
    const missing = COMPLETION_FAILURE_CODES.filter(
      (code) => !definitions.includes(`'${code}'`),
    );
    // `step-not-implemented` was in this list before migration 027.
    expect(missing).toEqual([]);
  });

  it("admits every COMPLETION_FAILURE_CODES value on the steps table", async () => {
    const definitions = await checkDefinitions("signing_request_completion_steps");
    const missing = COMPLETION_FAILURE_CODES.filter(
      (code) => !definitions.includes(`'${code}'`),
    );
    expect(missing).toEqual([]);
  });

  it("admits every COMPLETION_STEPS value", async () => {
    const steps = await checkDefinitions("signing_request_completion_steps");
    const runs = await checkDefinitions("signing_request_completion_runs");
    expect(COMPLETION_STEPS.filter((step) => !steps.includes(`'${step}'`))).toEqual([]);
    // The run names the step it failed at, so it carries the vocabulary too.
    expect(COMPLETION_STEPS.filter((step) => !runs.includes(`'${step}'`))).toEqual([]);
  });

  it("admits every run and step state", async () => {
    const runs = await checkDefinitions("signing_request_completion_runs");
    const steps = await checkDefinitions("signing_request_completion_steps");
    expect(COMPLETION_RUN_STATES.filter((s) => !runs.includes(`'${s}'`))).toEqual([]);
    expect(COMPLETION_STEP_STATES.filter((s) => !steps.includes(`'${s}'`))).toEqual([]);
  });

  it("admits the merged-candidate artifact kind", async () => {
    const definitions = await checkDefinitions("document_artifacts");
    expect(definitions).toContain("'merged-candidate'");
  });

  it("REFUSES a code outside the vocabulary — the negative control", async () => {
    // Without this the checks above would pass just as happily against a table
    // with no CHECK at all, or against a `substring` match that finds anything.
    const definitions = await checkDefinitions("signing_request_completion_runs");
    expect(definitions).not.toContain("'not-a-real-failure-code'");
    expect(definitions).toContain("failure_code");
  });

  it("DETECTS a narrowed CHECK — the detector's own self-test", async () => {
    // The check above only proves the detector reports nothing when nothing is
    // wrong. This proves it reports something when something IS.
    //
    // It has to narrow the constraint HERE rather than by rolling migration 027
    // back, and that distinction cost a wrong conclusion once: `migrateDown`
    // followed by a re-run looks like a clean negative control, but
    // `createTestDatabase()` calls `migrateToLatest` in `beforeAll`, so the
    // suite silently repaired the very thing it was supposed to observe and
    // reported six passes. A rollback outside the process proves nothing about
    // a suite that migrates on entry.
    const constraint = "signing_request_completion_runs_code_check";
    const withoutOneCode = COMPLETION_FAILURE_CODES.filter(
      (code) => code !== "step-not-implemented",
    );

    try {
      await sql`
        alter table signing_request_completion_runs
          drop constraint if exists ${sql.raw(constraint)}
      `.execute(owner.db);
      await sql`
        alter table signing_request_completion_runs
          add constraint ${sql.raw(constraint)}
          check (failure_code is null or failure_code in (${sql.join(
            withoutOneCode.map((code) => sql.lit(code)),
          )}))
      `.execute(owner.db);

      const definitions = await checkDefinitions("signing_request_completion_runs");
      const missing = COMPLETION_FAILURE_CODES.filter(
        (code) => !definitions.includes(`'${code}'`),
      );
      // Exactly migration 026's defect, reproduced deliberately.
      expect(missing).toEqual(["step-not-implemented"]);
    } finally {
      // DDL, so there is no transaction to roll back. Restoring in `finally`
      // is what stops a failed assertion from leaving the database narrowed for
      // every suite that runs after this one.
      await sql`
        alter table signing_request_completion_runs
          drop constraint if exists ${sql.raw(constraint)}
      `.execute(owner.db);
      await sql`
        alter table signing_request_completion_runs
          add constraint ${sql.raw(constraint)}
          check (failure_code is null or failure_code in (${sql.join(
            COMPLETION_FAILURE_CODES.map((code) => sql.lit(code)),
          )}))
      `.execute(owner.db);
    }
  });

  it("left the constraint intact after the self-test", async () => {
    // Ordering-dependent by design: it runs after the mutation above and proves
    // the `finally` actually restored things, rather than trusting that it did.
    const definitions = await checkDefinitions("signing_request_completion_runs");
    const missing = COMPLETION_FAILURE_CODES.filter(
      (code) => !definitions.includes(`'${code}'`),
    );
    expect(missing).toEqual([]);
  });
});
