// @lagda/contracts — the canonical contract boundary shared by the LAGDA
// frontend and backend.
//
// Root barrel for stable, commonly needed exports. Domains are also reachable
// by subpath (`@lagda/contracts/verification`) so a consumer can import one
// domain without pulling the rest.
//
// See README.md for what belongs here and, more importantly, what does not.

export * from "./ids/index.js";
export * from "./common/index.js";
export * from "./verification/index.js";
export * from "./workspaces/index.js";
export * from "./contacts/index.js";
export * from "./documents/index.js";
export * from "./preparation/index.js";

// Cross-cutting API conventions — errors, pagination, sorting, headers.
export * from "./api/index.js";
