// The gate: no identity route ships without a decision about its limit.

import { describe, it, expect } from "vitest";
import { IDENTITY_PATHS } from "../app/identity-routes.js";
import { IDENTITY_ROUTE_POLICIES } from "./identity-rate-limit.js";
import { RATE_LIMIT_POLICIES } from "@lagda/application";

describe("identity rate limits", () => {
  /**
   * Every path, not most of them.
   *
   * The defect this replaces was not a wrong limit -- it was ELEVEN routes
   * with no limit at all, in a file that mentioned rate limiting nowhere. A
   * new auth route is exactly the kind of thing that arrives without one, so
   * the table has to be checked against the paths rather than trusted.
   */
  it("covers every identity path", () => {
    const paths = Object.values(IDENTITY_PATHS);
    expect(paths.length).toBeGreaterThan(10);
    const missing = paths.filter((p) => IDENTITY_ROUTE_POLICIES[p] === undefined);
    expect(missing, "identity routes with no rate-limit decision").toEqual([]);
  });

  it("lists no path that is not a route", () => {
    const paths = new Set<string>(Object.values(IDENTITY_PATHS));
    const stale = Object.keys(IDENTITY_ROUTE_POLICIES).filter((p) => !paths.has(p));
    expect(stale, "a policy entry for a path that no longer exists").toEqual([]);
  });

  it("names only policies that exist", () => {
    for (const [path, policies] of Object.entries(IDENTITY_ROUTE_POLICIES)) {
      for (const id of [policies.ip, policies.account, policies.user]) {
        if (id === undefined) continue;
        expect(
          Object.keys(RATE_LIMIT_POLICIES), `${path} names an unknown policy`,
        ).toContain(id);
      }
    }
  });

  /**
   * The routes that take a password or a code must be limited by IP.
   *
   * Stated as a property rather than left to the table's contents, because the
   * table is the thing that could be edited wrongly. An account bucket alone
   * would let one source spray many addresses; these are the routes where that
   * is a credential-stuffing run.
   */
  it("limits every credential-accepting route by address", () => {
    for (const path of [
      IDENTITY_PATHS.signIn, IDENTITY_PATHS.register,
      IDENTITY_PATHS.resetPassword, IDENTITY_PATHS.mfaVerify,
      IDENTITY_PATHS.forgotPassword, IDENTITY_PATHS.verifyEmail,
    ]) {
      expect(IDENTITY_ROUTE_POLICIES[path]?.ip, `${path} has no IP limit`)
        .toBeDefined();
    }
  });

  /**
   * Sign-in and reset-request must ALSO have an account bucket.
   *
   * These are the two routes an attacker points at one victim from many
   * addresses -- password guessing and reset-mail flooding. An IP limit does
   * not touch either.
   */
  it("limits the per-victim routes by account too", () => {
    for (const path of [IDENTITY_PATHS.signIn, IDENTITY_PATHS.forgotPassword]) {
      expect(IDENTITY_ROUTE_POLICIES[path]?.account, `${path} has no account limit`)
        .toBeDefined();
    }
  });
});
