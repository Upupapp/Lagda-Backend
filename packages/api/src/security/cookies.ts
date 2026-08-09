// Cookie policy. Every attribute is a decision with a reason.

import type { CookieSerializeOptions } from "@fastify/cookie";
import type { ApiConfig } from "../config/index.js";

/**
 * The session credential. HttpOnly — JavaScript must never read it.
 *
 * Product-specific rather than `session` or `auth`: a generic name collides
 * with other cookies on a shared host and tells an attacker nothing less.
 */
export const SESSION_COOKIE_NAME = "lagda_session";

/**
 * The CSRF token. **Deliberately readable by JavaScript.**
 *
 * The frontend must read it to put it in `X-CSRF-Token`, so `httpOnly` would
 * make the whole mechanism unusable. It is NOT an authentication credential:
 * holding it grants nothing, because the server checks it against the session's
 * stored digest. Named so nobody mistakes it for the session.
 */
export const CSRF_COOKIE_NAME = "lagda_csrf";

/**
 * Attributes shared by both cookies.
 *
 * **SameSite=Lax**, and this is the decision OD-028 appeared to block.
 *
 * It does not, and the reason is worth stating: SameSite is evaluated per
 * *site* (registrable domain), not per *origin*. `app.lagda.io` calling
 * `api.lagda.io` is SAME-SITE, so Lax sends the cookie under both candidate
 * deployments — same-origin and subdomain-split. Only a frontend on a
 * genuinely different registrable domain would need `None`, and that is not a
 * deployment anyone has proposed.
 *
 * `Strict` was rejected: it withholds the cookie on top-level navigation from
 * an external link, so following a signing invitation from an email would land
 * a signed-in user on a page that thinks they are logged out.
 *
 * **Domain is host-only** — the attribute is not set at all. `Domain=.lagda.io`
 * would send the session cookie to every subdomain, including any future
 * marketing or status host, widening the blast radius of an XSS on a page that
 * has nothing to do with signing.
 */
function baseCookie(config: ApiConfig): CookieSerializeOptions {
  return {
    // The whole API. A narrower path would simply break requests, since a
    // session applies to every authenticated endpoint.
    path: "/",
    sameSite: config.sessionCookieSameSite,
    // Secure in production, always. Relaxed ONLY when a development
    // configuration says so — never inferred from the request, which would
    // trust a forwarded protocol header (see TRUST_PROXY.md).
    secure: config.sessionCookieSecure,
    // No `domain` key: host-only, deliberately.
  };
}

export function sessionCookieOptions(
  config: ApiConfig,
  maxAgeSeconds: number,
): CookieSerializeOptions {
  return {
    ...baseCookie(config),
    // Non-negotiable. The single control that stops XSS from stealing the
    // session outright.
    httpOnly: true,
    maxAge: maxAgeSeconds,
  };
}

export function csrfCookieOptions(
  config: ApiConfig,
  maxAgeSeconds: number,
): CookieSerializeOptions {
  return {
    ...baseCookie(config),
    // FALSE on purpose — see CSRF_COOKIE_NAME. This is the one cookie the
    // frontend is meant to read.
    httpOnly: false,
    maxAge: maxAgeSeconds,
  };
}

/**
 * Options for clearing a cookie.
 *
 * A browser matches a deletion to an existing cookie by name, path and domain.
 * Clearing with different attributes silently leaves the original in place —
 * which would mean a logout that appears to work and leaves the credential in
 * the browser. Derived from the same base so they cannot drift apart.
 */
export function clearCookieOptions(config: ApiConfig): CookieSerializeOptions {
  return { ...baseCookie(config), httpOnly: true, maxAge: 0, expires: new Date(0) };
}

export function clearCsrfCookieOptions(config: ApiConfig): CookieSerializeOptions {
  return { ...baseCookie(config), httpOnly: false, maxAge: 0, expires: new Date(0) };
}
