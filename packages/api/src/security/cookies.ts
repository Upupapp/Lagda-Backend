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

// ── Pre-authentication (BACKEND-23) ──────────────────────────────────────────

/**
 * A DISTINCT name from the session cookie.
 *
 * Overloading `lagda_session` with status-dependent meaning would push the
 * question "is this browser fully authenticated?" into every middleware that
 * reads it. A separate name makes a half-finished ceremony unmistakable: code
 * that looks for a session simply does not find one (§257).
 */
export const PRE_AUTH_COOKIE_NAME = "lagda_pre_auth";

/**
 * The path the pre-auth credential is scoped to.
 *
 * Browsers only send a cookie to paths beneath its `Path`, so this credential
 * is not even TRANSMITTED to `/documents`, `/workspaces` or `/profile`. That is
 * a stronger guarantee than rejecting it on arrival — a value that never
 * reaches a handler cannot be misread by one (§46, §258).
 */
const PRE_AUTH_PATH = "/auth";

export function preAuthCookieOptions(
  config: ApiConfig,
  maxAgeSeconds: number,
): CookieSerializeOptions {
  return {
    ...baseCookie(config),
    path: PRE_AUTH_PATH,
    // Carries a completed password proof. Never readable by script.
    httpOnly: true,
    // Short by construction — the caller passes the pending transaction's
    // remaining life, which is capped at 10 minutes and never extended.
    maxAge: maxAgeSeconds,
  };
}

export function clearPreAuthCookieOptions(config: ApiConfig): CookieSerializeOptions {
  // Same name, path and domain, or the browser keeps the original.
  return {
    ...baseCookie(config),
    path: PRE_AUTH_PATH,
    httpOnly: true,
    maxAge: 0,
    expires: new Date(0),
  };
}

// ── The recipient signing realm (BACKEND-34) ─────────────────────────────────
//
// A SECOND authentication realm, with its own names. The separation is not
// cosmetic: `requireSession` reads `lagda_session`, and a shared name would
// have it try to resolve a recipient credential as a user session — failing in
// a way that looks to the user like an expired login for an account they do
// not have.

/** The recipient's session credential. HttpOnly, never readable by script. */
export const RECIPIENT_SESSION_COOKIE_NAME = "lagda_signing_session";

/**
 * The recipient's CSRF token. NOT HttpOnly, by design.
 *
 * The same double-submit shape the workspace realm uses: the page must read it
 * to echo it in a header, and its protection comes from same-origin plus the
 * fact that a cross-site page cannot read it.
 */
export const RECIPIENT_CSRF_COOKIE_NAME = "lagda_signing_csrf";

/**
 * Path, and why it is not narrower.
 *
 * The pre-auth credential gets `Path=/auth`, which is stronger than rejecting
 * on arrival because the cookie is never TRANSMITTED elsewhere. The same trick
 * does not fit here: bootstrap lives at `/signing-access/bootstrap` and the
 * ceremony will live under `/signing`, so a path narrow enough to exclude one
 * excludes the other.
 *
 * Realm separation is therefore carried by the NAMES, which is what actually
 * prevents resolver confusion. If BACKEND-35 settles every recipient route
 * under a single prefix, narrowing this is one line and worth doing.
 */
const RECIPIENT_PATH = "/";

export function recipientSessionCookieOptions(
  config: ApiConfig,
  maxAgeSeconds: number,
): CookieSerializeOptions {
  return {
    ...baseCookie(config),
    path: RECIPIENT_PATH,
    httpOnly: true,
    maxAge: maxAgeSeconds,
  };
}

/** The CSRF twin, readable by the page that must echo it. */
export function recipientCsrfCookieOptions(
  config: ApiConfig,
  maxAgeSeconds: number,
): CookieSerializeOptions {
  return {
    ...baseCookie(config),
    path: RECIPIENT_PATH,
    // Readable, like the workspace realm's CSRF cookie and for the same reason.
    httpOnly: false,
    maxAge: maxAgeSeconds,
  };
}

/**
 * Clearing must mirror the setting options exactly.
 *
 * A `clearCookie` whose path or attributes differ writes a SECOND cookie rather
 * than removing the first, and the browser then sends both.
 */
export function clearRecipientSessionCookieOptions(
  config: ApiConfig,
): CookieSerializeOptions {
  return {
    ...baseCookie(config),
    path: RECIPIENT_PATH,
    httpOnly: true,
    maxAge: 0,
    expires: new Date(0),
  };
}

export function clearRecipientCsrfCookieOptions(
  config: ApiConfig,
): CookieSerializeOptions {
  return {
    ...baseCookie(config),
    path: RECIPIENT_PATH,
    httpOnly: false,
    maxAge: 0,
    expires: new Date(0),
  };
}
