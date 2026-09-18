// Is a database failure worth retrying, or is the statement simply wrong?
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// Every completion step wraps its persistence transaction in one catch and
// recorded `database-unavailable` for whatever came out. That code is
// classified RETRYABLE, which is correct for an unreachable server and
// exactly wrong for a rejected statement: a CHECK constraint does not change
// its mind on the second attempt.
//
// Two real schema defects hid behind it. An `artifact_type` CHECK left over
// from migration 003 rejected every `merged-candidate` the field-merge step
// wrote, and a `verification_id` CHECK enforcing a superseded format
// rejected every identifier the generators mint. Both were deterministic,
// both reported as transient, and both sat in `waiting-retry` indefinitely
// while the log said "database-unavailable" — a message that sent the reader
// looking at the database's health instead of at the schema.
//
// ── The split is by SQLSTATE, not by message ───────────────────────────────
//
// PostgreSQL's SQLSTATE classes already encode exactly the distinction that
// matters, and they are a stable, bounded, documented vocabulary — unlike an
// error message, which is unbounded text that may quote the row it failed on
// (§129). The code and the constraint name are the only two things taken from
// the error, and both are schema identifiers rather than data, so both are
// safe to log and to persist.

/** The two codes this module chooses between. */
export type DatabaseFailureCode = "database-unavailable" | "database-rejected";

/**
 * What the caller may log or persist about a database failure.
 *
 * Bounded by construction: a five-character SQLSTATE and a constraint name.
 * Never a message, never a parameter, never a row value.
 */
export interface DatabaseFailureDiagnosis {
  readonly code: DatabaseFailureCode;
  /** The SQLSTATE, when the driver supplied one. */
  readonly sqlstate: string | null;
  /** The offending constraint, when the error named one. */
  readonly constraint: string | null;
}

/**
 * SQLSTATE classes that mean "the server, or this attempt, was unwell".
 *
 * Two-character CLASS prefixes, because the class is the part that carries
 * the meaning and enumerating every subtype would go stale:
 *
 *   08  connection exception
 *   53  insufficient resources (out of memory, disk, connections)
 *   57  operator intervention (shutdown, cannot connect now, cancelled)
 *   58  system error (file I/O)
 *   XX  internal error (corruption) — retried because a replica or a restart
 *       genuinely may answer, and because failing a completion terminally on
 *       a server-side anomaly is worse than attempting it again.
 */
const RETRYABLE_CLASSES = new Set(["08", "53", "57", "58", "XX"]);

/**
 * Individually retryable codes inside otherwise-terminal classes.
 *
 * `40001`/`40P01` are the concurrency pair — a serialization failure and a
 * deadlock are the canonical "run it again" outcomes, and class 40's other
 * members are not. `55P03` is a lock this attempt could not take.
 */
const RETRYABLE_CODES = new Set(["40001", "40P01", "55P03"]);

/**
 * SQLSTATE classes that mean "this statement is wrong".
 *
 *   22  data exception (value too long, invalid text representation)
 *   23  integrity constraint violation (CHECK, FK, NOT NULL, unique)
 *   42  syntax error or access rule violation (incl. 42501, insufficient
 *       privilege — a grant this deployment deliberately withholds is a
 *       decision, not an outage)
 *   0A  feature not supported
 *   21  cardinality violation
 */
const TERMINAL_CLASSES = new Set(["22", "23", "42", "0A", "21"]);

function stringField(source: object, field: string): string | null {
  if (!(field in source)) return null;
  const value = (source as Record<string, unknown>)[field];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Classifies a database error.
 *
 * Anything unrecognised — no SQLSTATE at all, or a class in neither set —
 * stays `database-unavailable`. That preserves the previous behaviour for
 * cases nobody has reasoned about yet: an unknown fault retried a bounded
 * number of times is recoverable, whereas an unknown fault failed terminally
 * abandons a legally significant document over something that might have
 * been a blip. The retry is bounded by the run's own attempt accounting, so
 * "retryable" is not "forever".
 */
/**
 * The bounded, log-safe half of a diagnosis, ready to spread into a step
 * result.
 *
 * The worker's job logger spreads a handler's result object into its
 * structured line, so returning these two fields from a failed step is what
 * puts the SQLSTATE and the constraint name in the log — and both are schema
 * identifiers rather than row data, which is why they may go there at all.
 * Absent keys rather than nulls, so a success line and a failure line with no
 * SQLSTATE do not carry empty columns.
 */
export function databaseFailureFields(
  diagnosis: DatabaseFailureDiagnosis,
): { sqlstate?: string; constraint?: string } {
  return {
    ...(diagnosis.sqlstate === null ? {} : { sqlstate: diagnosis.sqlstate }),
    ...(diagnosis.constraint === null ? {} : { constraint: diagnosis.constraint }),
  };
}

export function diagnoseDatabaseFailure(error: unknown): DatabaseFailureDiagnosis {
  if (typeof error !== "object" || error === null) {
    return { code: "database-unavailable", sqlstate: null, constraint: null };
  }

  const sqlstate = stringField(error, "code");
  const constraint = stringField(error, "constraint");

  if (sqlstate === null) {
    return { code: "database-unavailable", sqlstate: null, constraint };
  }

  const sqlclass = sqlstate.slice(0, 2);
  const rejected = RETRYABLE_CODES.has(sqlstate)
    ? false
    : TERMINAL_CLASSES.has(sqlclass) && !RETRYABLE_CLASSES.has(sqlclass);

  return {
    code: rejected ? "database-rejected" : "database-unavailable",
    sqlstate,
    constraint,
  };
}
