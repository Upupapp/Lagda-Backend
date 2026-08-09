// Pagination — page-based, exactly as already specified.
//
// NOT a design decision. `backend-integration-handoff.md` §27 states:
//
//   ?page=1&perPage=20  (default perPage 20, max 100)
//   { items, total, page, perPage, hasNextPage }
//
// and the frontend's `PaginatedResult<T>` in `models/errors.ts` matches it
// field for field. Both sides already agree, so this preserves the contract
// rather than replacing it. Cursor pagination would scale better and is the
// wrong choice here: it would break an agreement that already exists, for a
// volume problem nobody has measured.
//
// (Correcting the BACKEND-02 report, which said no pagination convention
// existed to inherit. §27 specifies one; the earlier scan missed it.)

import { Type, type Static } from "@sinclair/typebox";

export const DEFAULT_PAGE = 1;
export const DEFAULT_PER_PAGE = 20;
export const MAX_PER_PAGE = 100;

// ── Request ──────────────────────────────────────────────────────────────────

/**
 * Query parameters arrive as strings, so both fields coerce. Coercion is
 * deliberate and narrow: `"20"` becomes 20, while `"20abc"` is rejected rather
 * than silently becoming 20 — a parse that discards trailing characters turns a
 * client bug into a plausible-looking result.
 *
 * Bounds are enforced here, not left to the caller. `perPage=1000000` is a
 * valid number and an invalid request.
 */
export const PageRequestSchema = Type.Object(
  {
    page: Type.Optional(
      Type.Integer({ minimum: 1, default: DEFAULT_PAGE, description: "1-indexed." }),
    ),
    perPage: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_PER_PAGE, default: DEFAULT_PER_PAGE }),
    ),
  },
  { title: "PageRequest", additionalProperties: false },
);
export type PageRequest = Static<typeof PageRequestSchema>;

// ── Response metadata ────────────────────────────────────────────────────────

/**
 * Field names are the handoff's and the frontend's. `perPage` — not `pageSize`.
 * `hasNextPage` — not `hasMore`. `total` — not `totalItems`.
 *
 * `total` is kept even though an exact count can get expensive at volume,
 * because the frontend already relies on it. Removing it is a product decision,
 * not a contract cleanup.
 */
export const PageMetaSchema = Type.Object(
  {
    total: Type.Integer({ minimum: 0 }),
    page: Type.Integer({ minimum: 1 }),
    perPage: Type.Integer({ minimum: 1, maximum: MAX_PER_PAGE }),
    hasNextPage: Type.Boolean(),
  },
  { title: "PageMeta", additionalProperties: false },
);
export type PageMeta = Static<typeof PageMetaSchema>;

/**
 * A paginated response for a given item schema.
 *
 * Flat — `{ items, total, page, perPage, hasNextPage }` — matching
 * `PaginatedResult<T>` rather than nesting metadata under `pagination`. The
 * frontend already destructures this shape; nesting would be a rename dressed
 * as an improvement.
 *
 * A page beyond the end returns **200 with an empty `items` array**, not 404.
 * The collection exists; the page is simply empty.
 */
export const PaginatedResponse = <T extends import("@sinclair/typebox").TSchema>(
  itemSchema: T,
) =>
  Type.Object(
    {
      items: Type.Array(itemSchema),
      total: Type.Integer({ minimum: 0 }),
      page: Type.Integer({ minimum: 1 }),
      perPage: Type.Integer({ minimum: 1, maximum: MAX_PER_PAGE }),
      hasNextPage: Type.Boolean(),
    },
    { additionalProperties: false },
  );
