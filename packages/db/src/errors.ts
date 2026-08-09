// PostgreSQL error classification.
//
// SQLSTATE codes, never message text. `err.message.includes("duplicate key")`
// breaks on a PostgreSQL upgrade or a non-English locale, and there is no
// warning when it does.
//
// This package may inspect SQLSTATE; application never does. BACKEND-08 turns
// these into the application's conflict errors per repository, where the
// constraint name says which business rule was violated.

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
