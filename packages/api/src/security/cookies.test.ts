// The pre-auth cookie's Path, checked against what a browser does with it.
//
// A browser returns a cookie only to URLs under its Path, and it compares the
// Path with the URL IT requested. Behind a proxy that mounts this API under
// /api, the browser requests /api/auth/..., so a cookie scoped to /auth is
// never returned and the MFA ceremony cannot be finished.

import { describe, it, expect } from "vitest";
import type { ApiConfig } from "../config/index.js";
import { preAuthCookieOptions, clearPreAuthCookieOptions } from "./cookies.js";

const config = (preAuthCookiePath: string): ApiConfig => ({
  environment: "production",
  sessionCookieSecure: true,
  sessionCookieSameSite: "lax",
  preAuthCookiePath,
} as unknown as ApiConfig);

/** RFC 6265 §5.1.4 path-match. */
function browserSends(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

describe("the pre-auth cookie path", () => {
  it("is the configured one, for setting and for clearing", () => {
    expect(preAuthCookieOptions(config("/api/auth"), 600).path).toBe("/api/auth");
    expect(clearPreAuthCookieOptions(config("/api/auth")).path).toBe("/api/auth");
    expect(preAuthCookieOptions(config("/auth"), 600).path).toBe("/auth");
  });

  it("reaches the MFA verification route as the browser requests it behind /api", () => {
    const proxied = preAuthCookieOptions(config("/api/auth"), 600).path ?? "";
    expect(browserSends(proxied, "/api/auth/mfa/verifications")).toBe(true);
    // The defect this guards: /auth never matches a request under /api.
    expect(browserSends("/auth", "/api/auth/mfa/verifications")).toBe(false);
  });

  it("still does not reach application routes", () => {
    const proxied = preAuthCookieOptions(config("/api/auth"), 600).path ?? "";
    for (const path of ["/api/me", "/api/documents", "/api/workspaces/ws_1", "/api/authx"]) {
      expect(browserSends(proxied, path)).toBe(false);
    }
  });

  it("stays unreadable by script and short-lived", () => {
    const options = preAuthCookieOptions(config("/api/auth"), 600);
    expect(options.httpOnly).toBe(true);
    expect(options.maxAge).toBe(600);
  });
});
