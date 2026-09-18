// Building first-party URLs for a message body.
//
// ── Why this is here and not in a composition root ─────────────────────────
//
// It is pure: a configured base in, a string out, no I/O and no environment
// read. Both process roles need it — the API when a link is built during a
// request, the worker when a queued message is rendered hours later — and
// putting it in either package would make the other import something it must
// not. `@lagda/api` would drag Fastify into the worker; `@lagda/worker` would
// drag pg-boss into the API.
//
// ── The rule it exists to keep (S147) ──────────────────────────────────────
//
// The base comes from CONFIGURATION and from nowhere else. Never a `Host`
// header, never `X-Forwarded-Host`, never `request.hostname`. A link built from
// an inbound header is a link an attacker chose, sent by LAGDA, over LAGDA's
// reputation, carrying a real credential to a real counterparty. This function
// takes no request and cannot see one.

import type { NotificationLinkBuilder } from "./deliver.js";

/**
 * @param appBaseUrl parsed once, at construction, so a malformed base is a
 *   boot-time configuration error rather than a first-send failure.
 */
export function createNotificationLinkBuilder(
  appBaseUrl: string,
): NotificationLinkBuilder {
  const base = new URL(appBaseUrl);
  const root = base.pathname.replace(/\/+$/u, "");

  return {
    build: (path: string, token: string): string => {
      const url = new URL(base);
      // The credential is a PATH SEGMENT, not a query parameter. A query string
      // is far more likely to survive into a referrer, an access log or an
      // analytics payload, and the recipient realm strips the segment from the
      // address bar as soon as it has exchanged it.
      url.pathname = `${root}/${path.replace(/^\/+|\/+$/gu, "")}/`
        + encodeURIComponent(token);
      return url.toString();
    },

    buildPath: (path: string): string => {
      const url = new URL(base);
      // Same configured base, same trimming, no credential appended. Nothing
      // here is secret, so nothing here needs the path-segment treatment
      // above — but the base still comes only from configuration (S147).
      url.pathname = `${root}/${path.replace(/^\/+|\/+$/gu, "")}`;
      return url.toString();
    },
  };
}
