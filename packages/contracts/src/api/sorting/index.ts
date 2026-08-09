// Sorting and free-text search primitives.

import { Type, type Static } from "@sinclair/typebox";

// ── Direction ────────────────────────────────────────────────────────────────

export const SortOrderSchema = Type.Union(
  [Type.Literal("asc"), Type.Literal("desc")],
  { title: "SortOrder", default: "desc" },
);
export type SortOrder = Static<typeof SortOrderSchema>;

export const SORT_ORDERS = ["asc", "desc"] as const;

// ── Sort keys ────────────────────────────────────────────────────────────────

/**
 * Builds a sort schema from an endpoint's own closed set of keys.
 *
 * There is deliberately no shared `sortBy: string`. A sort key that reaches a
 * repository as free text becomes `ORDER BY ${input}` — the shortest path from
 * a query parameter to SQL injection and to leaking column names. Each endpoint
 * declares what it supports:
 *
 *   const DocumentSort = sortSchema(["createdAt", "name", "status"]);
 *
 * Repositories then map those keys to explicit SQL expressions. The value from
 * the client never becomes an identifier.
 */
export const sortSchema = <const K extends readonly string[]>(keys: K) =>
  Type.Object(
    {
      sortBy: Type.Optional(Type.Union(keys.map(k => Type.Literal(k)))),
      sortOrder: Type.Optional(SortOrderSchema),
    },
    { additionalProperties: false },
  );

/**
 * Pagination and sorting interact: with a non-unique sort key, two pages can
 * repeat or skip a row. Repository implementations must append a unique tie
 * breaker — `ORDER BY createdAt DESC, id DESC`. Documented here because the
 * defect appears in the API and is fixed in persistence.
 */

// ── Free-text search ─────────────────────────────────────────────────────────

export const MAX_SEARCH_LENGTH = 200;

/**
 * `q` is the canonical search parameter.
 *
 * Bounded because an unbounded query is a cheap way to make the server do
 * expensive work. The value is DATA, never SQL: repositories use parameterized
 * queries, and no application code escapes search text by hand.
 */
export const SearchQuerySchema = Type.Object(
  {
    q: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_SEARCH_LENGTH })),
  },
  { title: "SearchQuery", additionalProperties: false },
);
export type SearchQuery = Static<typeof SearchQuerySchema>;

// ── Time filters ─────────────────────────────────────────────────────────────

/**
 * Explicit names over `from`/`to`, which never say which field they bound.
 * Inclusivity is stated per endpoint when the endpoint is implemented.
 */
export const TimeRangeFilterSchema = Type.Object(
  {
    createdAfter: Type.Optional(Type.String({ minLength: 1 })),
    createdBefore: Type.Optional(Type.String({ minLength: 1 })),
  },
  { title: "TimeRangeFilter", additionalProperties: false },
);
export type TimeRangeFilter = Static<typeof TimeRangeFilterSchema>;
