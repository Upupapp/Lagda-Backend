// Is a database failure transient, or is the statement simply wrong?
//
// The distinction is the whole point. Every completion step used to record
// `database-unavailable` — retryable — for anything its persistence
// transaction threw, so two deterministic schema defects were retried
// indefinitely instead of failing loudly. These cases pin both directions,
// including the two SQLSTATEs that actually caused that outage.

import { describe, it, expect } from "vitest";
import { COMPLETION_FAILURE_CLASSIFICATION } from "@lagda/contracts";
import { diagnoseDatabaseFailure, databaseFailureFields } from "./database-failure.js";

/** A driver error, as `pg` shapes one. */
const pgError = (code: string, constraint?: string) =>
  Object.assign(new Error("db said no"), { code, ...(constraint === undefined ? {} : { constraint }) });

describe("transient failures stay retryable", () => {
  it.each([
    ["08006", "connection failure"],
    ["08003", "connection does not exist"],
    ["53300", "too many connections"],
    ["57P01", "admin shutdown"],
    ["57P03", "cannot connect now"],
    ["58030", "io error"],
    ["40001", "serialization failure"],
    ["40P01", "deadlock detected"],
    ["55P03", "lock not available"],
  ])("%s (%s) is database-unavailable", (sqlstate) => {
    const diagnosis = diagnoseDatabaseFailure(pgError(sqlstate));
    expect(diagnosis.code).toBe("database-unavailable");
    expect(COMPLETION_FAILURE_CLASSIFICATION[diagnosis.code]).toBe("retryable");
  });
});

describe("refused statements are terminal", () => {
  it.each([
    ["23514", "check violation"],
    ["23503", "foreign key violation"],
    ["23505", "unique violation"],
    ["23502", "not null violation"],
    ["22001", "string data right truncation"],
    ["42703", "undefined column"],
    ["42P01", "undefined table"],
    ["42601", "syntax error"],
    ["42501", "insufficient privilege"],
    ["0A000", "feature not supported"],
    ["21000", "cardinality violation"],
  ])("%s (%s) is database-rejected", (sqlstate) => {
    const diagnosis = diagnoseDatabaseFailure(pgError(sqlstate));
    expect(diagnosis.code).toBe("database-rejected");
    expect(COMPLETION_FAILURE_CLASSIFICATION[diagnosis.code]).toBe("terminal");
  });

  it("does not retry the two defects that caused the outage", () => {
    // Both were CHECK violations (23514) reported as `database-unavailable`:
    // the artifact_type constraint refusing `merged-candidate`, and the
    // verification_id constraint refusing the format both generators mint.
    // Either one now stops the run instead of parking it forever.
    for (const constraint of [
      "document_artifacts_type_check", "verification_records_format_check",
    ]) {
      const diagnosis = diagnoseDatabaseFailure(pgError("23514", constraint));
      expect(diagnosis.code).toBe("database-rejected");
      expect(COMPLETION_FAILURE_CLASSIFICATION[diagnosis.code]).toBe("terminal");
      expect(diagnosis.constraint).toBe(constraint);
    }
  });
});

describe("what it reports", () => {
  it("carries the SQLSTATE and the constraint, and nothing else", () => {
    const diagnosis = diagnoseDatabaseFailure(pgError("23514", "some_check"));
    expect(diagnosis).toEqual({
      code: "database-rejected", sqlstate: "23514", constraint: "some_check",
    });
    // The MESSAGE is deliberately absent: unbounded text that may quote the
    // row it failed on has no business in a log line (§129).
    expect(JSON.stringify(diagnosis)).not.toContain("db said no");
  });

  it("omits absent fields rather than emitting nulls", () => {
    expect(databaseFailureFields(diagnoseDatabaseFailure(pgError("23514", "c"))))
      .toEqual({ sqlstate: "23514", constraint: "c" });
    expect(databaseFailureFields(diagnoseDatabaseFailure(pgError("08006"))))
      .toEqual({ sqlstate: "08006" });
    expect(databaseFailureFields(diagnoseDatabaseFailure(new Error("no code"))))
      .toEqual({});
  });
});

describe("unrecognised failures keep the old, safer behaviour", () => {
  it.each([
    [new Error("no sqlstate at all")],
    [pgError("99999")],
    [pgError("")],
    ["a string, not an error"],
    [null],
    [undefined],
  ])("%s falls back to database-unavailable", (error) => {
    // Retryable rather than terminal for anything nobody has reasoned about:
    // an unknown fault retried a bounded number of times is recoverable,
    // whereas failing terminally abandons a legally significant document over
    // something that may have been a blip.
    expect(diagnoseDatabaseFailure(error).code).toBe("database-unavailable");
  });

  it("XX internal errors are retried, not abandoned", () => {
    // Corruption or a server-side anomaly may genuinely be answered by a
    // replica or a restart.
    expect(diagnoseDatabaseFailure(pgError("XX000")).code).toBe("database-unavailable");
  });
});

describe("the classification is total", () => {
  it("classifies every code this module can return", () => {
    // Guards the split itself: a code returned here but unclassified in the
    // contract would make `isRetryable` read `undefined` and silently treat
    // the failure as terminal.
    for (const code of ["database-unavailable", "database-rejected"] as const) {
      expect(COMPLETION_FAILURE_CLASSIFICATION[code]).toMatch(/^(retryable|terminal)$/);
    }
  });
});
