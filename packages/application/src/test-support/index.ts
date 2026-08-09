// Test doubles, on a SUBPATH rather than the package entry point.
//
// `@lagda/application/test-support` is importable from a test in any package;
// `@lagda/application` does not carry it. That separation is the point: a
// production module that reaches for `FakeTransactionManager` has to name the
// test-support path to do it, which is visible in a diff and caught in review.
//
// The behavioural repository CONTRACT stays on the entry point, because
// `@lagda/db` runs it as part of its own suite and it describes the ports
// rather than doubling them.

export * from "./fakes.js";
export * from "./idempotency-fake.js";
export * from "./idempotency-support.js";
