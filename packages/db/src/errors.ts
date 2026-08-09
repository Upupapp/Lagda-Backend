// PostgreSQL error classification and translation.
//
// SQLSTATE codes, never message text. `err.message.includes("duplicate key")`
// breaks on a PostgreSQL upgrade or a non-English locale, and there is no
// warning when it does.
//
// This package may inspect SQLSTATE; application never does. What crosses the
// boundary is a LAGDA-owned error whose meaning does not depend on the driver.

interface PostgresError {
  readonly code?: string;
  readonly constraint?: string;
}

function sqlstate(error: unknown): PostgresError {
  if (typeof error !== "object" || error === null) return {};
  const { code, constraint } = error as Record<string, unknown>;
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof constraint === "string" ? { constraint } : {}),
  };
}

/** 23505 — a unique constraint. The authority on race-sensitive uniqueness. */
export const isUniqueViolation = (error: unknown, constraint?: string): boolean => {
  const e = sqlstate(error);
  return e.code === "23505" && (constraint === undefined || e.constraint === constraint);
};

/** 23503 — a foreign key. Also what catches a cross-tenant compound reference. */
export const isForeignKeyViolation = (error: unknown, constraint?: string): boolean => {
  const e = sqlstate(error);
  return e.code === "23503" && (constraint === undefined || e.constraint === constraint);
};

/** 23514 — a CHECK constraint. A value the schema refuses to hold. */
export const isCheckViolation = (error: unknown, constraint?: string): boolean => {
  const e = sqlstate(error);
  return e.code === "23514" && (constraint === undefined || e.constraint === constraint);
};

/** 40001 / 40P01 — serialization failure and deadlock. Retryable, elsewhere. */
export const isTransientConflict = (error: unknown): boolean => {
  const code = sqlstate(error).code;
  return code === "40001" || code === "40P01";
};

// ── LAGDA-owned persistence errors ───────────────────────────────────────────

/** Base for persistence conditions the application may reasonably handle. */
export abstract class PersistenceError extends Error {
  abstract readonly kind: string;
  constructor(message: string, readonly constraint?: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A uniqueness rule was violated.
 *
 * Carries the CONSTRAINT NAME, not the offending value — the value is often
 * user data, and an error message is a poor place for it. The constraint name
 * is what tells a caller which business rule was broken.
 */
export class UniqueConstraintViolation extends PersistenceError {
  readonly kind = "unique_violation" as const;
}

export class ForeignKeyConstraintViolation extends PersistenceError {
  readonly kind = "foreign_key_violation" as const;
}

export class CheckConstraintViolation extends PersistenceError {
  readonly kind = "check_violation" as const;
}

/**
 * Retryable contention. Retry policy belongs to the transaction or worker
 * layer — a repository that retried internally could repeat a non-idempotent
 * business operation.
 */
export class TransientPersistenceConflict extends PersistenceError {
  readonly kind = "transient_conflict" as const;
}

/**
 * A repository bound to one workspace was handed a record belonging to another.
 *
 * A programmer error, not a client one. It is raised before the write so the
 * problem is named, rather than surfacing as an RLS policy violation from
 * three layers down.
 */
export class WorkspaceScopeMismatchError extends Error {
  constructor(entity: string, scope: string, actual: string) {
    super(
      `${entity} belongs to workspace ${actual} but the unit of work is scoped ` +
      `to ${scope}. The workspace is never rewritten to match.`,
    );
    this.name = "WorkspaceScopeMismatchError";
  }
}

/**
 * Maps a driver error to a LAGDA-owned one, or rethrows it unchanged.
 *
 * **Unknown errors are NOT downgraded into expected conflicts.** A connection
 * failure or a timeout must stay an infrastructure failure: reporting it as
 * "not found" or "conflict" would tell a caller the data is absent when the
 * database is simply unreachable.
 */
export function translatePersistenceError(error: unknown): unknown {
  const { constraint } = sqlstate(error);
  if (isUniqueViolation(error)) {
    return new UniqueConstraintViolation(
      `Unique constraint violated${constraint ? `: ${constraint}` : ""}.`, constraint,
    );
  }
  if (isForeignKeyViolation(error)) {
    return new ForeignKeyConstraintViolation(
      `Foreign key constraint violated${constraint ? `: ${constraint}` : ""}.`, constraint,
    );
  }
  if (isCheckViolation(error)) {
    return new CheckConstraintViolation(
      `Check constraint violated${constraint ? `: ${constraint}` : ""}.`, constraint,
    );
  }
  if (isTransientConflict(error)) {
    return new TransientPersistenceConflict("Transaction conflicted; retry may succeed.");
  }
  // Deliberately unchanged. See the note above.
  return error;
}
