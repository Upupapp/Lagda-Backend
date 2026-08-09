// Cross-cutting API contract behaviour.
//
// These assert what the schemas ACCEPT and REJECT, because that is what a type
// cannot express and what every endpoint will inherit.

import { describe, it, expect } from "vitest";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  ApiErrorSchema, ApiErrorDetailSchema, ApiErrorCodeSchema,
  API_ERROR_CODES, API_ERROR_CODE_VALUES, CODE_CATEGORY, CATEGORY_HTTP_STATUS,
  MAX_ERROR_DETAILS,
  PageRequestSchema, PageMetaSchema, PaginatedResponse,
  DEFAULT_PER_PAGE, MAX_PER_PAGE,
  SortOrderSchema, sortSchema, SearchQuerySchema, MAX_SEARCH_LENGTH,
  IdempotencyKeySchema, MAX_IDEMPOTENCY_KEY_LENGTH,
} from "./index.js";

describe("error envelope", () => {
  it("accepts a minimal error", () => {
    expect(Value.Check(ApiErrorSchema, {
      error: { code: "not_found", message: "The requested item could not be found." },
    })).toBe(true);
  });

  it("accepts validation details and a request id", () => {
    expect(Value.Check(ApiErrorSchema, {
      error: {
        code: "validation_error",
        message: "One or more fields contain invalid values.",
        details: [
          { field: "email", code: "validation_error", message: "Enter a valid email address." },
          { field: "recipients[0].email", code: "validation_error", message: "Enter a valid email address." },
        ],
        requestId: "req_abc123",
      },
    })).toBe(true);
  });

  it("requires a code and a message", () => {
    expect(Value.Check(ApiErrorSchema, { error: { message: "x" } })).toBe(false);
    expect(Value.Check(ApiErrorSchema, { error: { code: "not_found" } })).toBe(false);
  });

  it("rejects fields that would leak internals", () => {
    // No stack, no SQL, no route path — the envelope has no place to put them,
    // so a careless handler cannot smuggle one through.
    for (const leak of [{ stack: "Error: at db.query" }, { sql: "SELECT *" }, { path: "/srv/app/x.ts" }]) {
      expect(Value.Check(ApiErrorSchema, {
        error: { code: "internal_error", message: "Something went wrong.", ...leak },
      }), Object.keys(leak)[0]).toBe(false);
    }
  });

  it("caps the number of validation details", () => {
    const detail = { field: "a", code: "validation_error", message: "m" };
    const tooMany = Array.from({ length: MAX_ERROR_DETAILS + 1 }, () => detail);
    expect(Value.Check(ApiErrorSchema, {
      error: { code: "validation_error", message: "m", details: tooMany },
    })).toBe(false);
  });

  it("enforces lowercase snake_case codes", () => {
    // The handoff specifies this wire format. UPPER_SNAKE is the FRONTEND's
    // LagdaErrorCode, mapped on arrival — not what the server sends.
    for (const good of API_ERROR_CODE_VALUES) {
      expect(Value.Check(ApiErrorCodeSchema, good), good).toBe(true);
    }
    for (const bad of ["NOT_FOUND", "notFound", "not-found", "Not_Found", "1invalid", ""]) {
      expect(Value.Check(ApiErrorCodeSchema, bad), bad).toBe(false);
    }
  });

  it("rejects a detail that echoes a submitted secret", () => {
    // Not schema-enforceable — asserted as documentation of the rule, with the
    // shape that IS enforced: a detail carries field + code + message only, so
    // there is nowhere to attach the offending value.
    expect(Value.Check(ApiErrorDetailSchema, {
      field: "password", code: "validation_error",
      message: "Must be at least 12 characters.", value: "Secret123!",
    })).toBe(false);
  });
});

describe("error category mapping", () => {
  it("maps every common code to a category and a status", () => {
    for (const code of API_ERROR_CODE_VALUES) {
      const category = CODE_CATEGORY[code];
      expect(category, `${code} has no category`).toBeDefined();
      expect(CATEGORY_HTTP_STATUS[category!], `${category!} has no status`).toBeDefined();
    }
  });

  it("maps validation to 422, not 400", () => {
    // Handoff §26: validation_error → 422. 400 is for a request that cannot be
    // interpreted at all.
    expect(CATEGORY_HTTP_STATUS[CODE_CATEGORY[API_ERROR_CODES.validationError]!]).toBe(422);
  });

  it("keeps authentication and authorization distinct", () => {
    expect(CATEGORY_HTTP_STATUS[CODE_CATEGORY[API_ERROR_CODES.authRequired]!]).toBe(401);
    expect(CATEGORY_HTTP_STATUS[CODE_CATEGORY[API_ERROR_CODES.permissionDenied]!]).toBe(403);
  });

  it("maps expired and cancelled requests to 410, not 404", () => {
    // An expired signing request is not "not found" — the recipient screen
    // needs the difference to explain what happened.
    expect(CATEGORY_HTTP_STATUS[CODE_CATEGORY[API_ERROR_CODES.requestExpired]!]).toBe(410);
    expect(CATEGORY_HTTP_STATUS[CODE_CATEGORY[API_ERROR_CODES.requestCancelled]!]).toBe(410);
  });
});

describe("pagination", () => {
  it("accepts an empty request and applies documented defaults", () => {
    expect(Value.Check(PageRequestSchema, {})).toBe(true);
    expect(DEFAULT_PER_PAGE).toBe(20);
    expect(MAX_PER_PAGE).toBe(100);
  });

  it("rejects a page size beyond the maximum", () => {
    expect(Value.Check(PageRequestSchema, { perPage: MAX_PER_PAGE })).toBe(true);
    expect(Value.Check(PageRequestSchema, { perPage: MAX_PER_PAGE + 1 })).toBe(false);
    expect(Value.Check(PageRequestSchema, { perPage: 1000000 })).toBe(false);
  });

  it("rejects page 0 and negatives — pages are 1-indexed", () => {
    expect(Value.Check(PageRequestSchema, { page: 1 })).toBe(true);
    expect(Value.Check(PageRequestSchema, { page: 0 })).toBe(false);
    expect(Value.Check(PageRequestSchema, { page: -1 })).toBe(false);
  });

  it("rejects a non-integer page", () => {
    expect(Value.Check(PageRequestSchema, { page: 1.5 })).toBe(false);
    expect(Value.Check(PageRequestSchema, { page: "2" })).toBe(false);
  });

  it("uses the field names the frontend already consumes", () => {
    // perPage not pageSize, hasNextPage not hasMore, total not totalItems.
    const meta = { total: 42, page: 2, perPage: 20, hasNextPage: true };
    expect(Value.Check(PageMetaSchema, meta)).toBe(true);
    expect(Value.Check(PageMetaSchema, { totalItems: 42, page: 2, pageSize: 20, hasMore: true })).toBe(false);
  });

  it("represents an out-of-range page as an empty collection", () => {
    // 200 with items: [], not 404. The collection exists; the page is empty.
    const schema = PaginatedResponse(Type.Object({ id: Type.String() }));
    expect(Value.Check(schema, { items: [], total: 0, page: 99, perPage: 20, hasNextPage: false })).toBe(true);
    expect(Value.Check(schema, { items: null, total: 0, page: 1, perPage: 20, hasNextPage: false })).toBe(false);
  });
});

describe("sorting and search", () => {
  it("accepts only asc and desc", () => {
    expect(Value.Check(SortOrderSchema, "asc")).toBe(true);
    expect(Value.Check(SortOrderSchema, "desc")).toBe(true);
    for (const bad of ["ASC", "ascending", "up", "1"]) {
      expect(Value.Check(SortOrderSchema, bad), bad).toBe(false);
    }
  });

  it("restricts sort keys to an endpoint's whitelist", () => {
    // The rule that stops a query parameter becoming ORDER BY ${input}.
    const schema = sortSchema(["createdAt", "name"]);
    expect(Value.Check(schema, { sortBy: "createdAt", sortOrder: "desc" })).toBe(true);
    for (const bad of ["password_hash", "id; DROP TABLE documents", "createdat"]) {
      expect(Value.Check(schema, { sortBy: bad }), bad).toBe(false);
    }
  });

  it("bounds free-text search", () => {
    expect(Value.Check(SearchQuerySchema, { q: "agreement" })).toBe(true);
    expect(Value.Check(SearchQuerySchema, { q: "x".repeat(MAX_SEARCH_LENGTH) })).toBe(true);
    expect(Value.Check(SearchQuerySchema, { q: "x".repeat(MAX_SEARCH_LENGTH + 1) })).toBe(false);
    expect(Value.Check(SearchQuerySchema, { q: "" })).toBe(false);
  });
});

describe("unknown request fields are rejected (mass assignment)", () => {
  it("refuses an unexpected property on every request schema", () => {
    // §151/§152: an extra property must never silently become an accepted
    // input. `additionalProperties: false` is what makes a stale or hostile
    // client fail loudly instead of quietly setting something.
    expect(Value.Check(PageRequestSchema, { page: 1, isAdmin: true })).toBe(false);
    expect(Value.Check(SearchQuerySchema, { q: "x", workspaceId: "ws_other" })).toBe(false);
    expect(Value.Check(sortSchema(["createdAt"]), { sortBy: "createdAt", role: "owner" })).toBe(false);
  });
});

describe("headers", () => {
  it("bounds the idempotency key", () => {
    expect(Value.Check(IdempotencyKeySchema, "a".repeat(MAX_IDEMPOTENCY_KEY_LENGTH))).toBe(true);
    expect(Value.Check(IdempotencyKeySchema, "a".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1))).toBe(false);
    expect(Value.Check(IdempotencyKeySchema, "")).toBe(false);
  });
});
