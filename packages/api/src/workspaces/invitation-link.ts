// The invitation link builder.
//
// ── It has no request, and that is the design ──────────────────────────────
//
// Host-header injection works like this: an attacker sends
// `Host: attacker.example` with a request that triggers an email, the server
// builds a link from the inbound host, and LAGDA itself emails the victim a
// link pointing at the attacker — who then collects the credential.
//
// The defence is not to sanitize the header. It is for the builder to have no
// header in scope at all. This function takes a configured origin and a token;
// there is no request parameter, so `request.hostname` cannot be reached from
// here even by someone trying (§48, §226, §294).

import type { InvitationLinkBuilder } from "@lagda/application";

/**
 * Where the frontend serves the invitation page.
 *
 * Matches `AcceptInvitation.tsx`, which is routed at `/accept-invitation`.
 */
const INVITATION_PATH = "/accept-invitation";

/**
 * The query parameter carrying the credential.
 *
 * ── Why the token is in the URL at all ─────────────────────────────────────
 *
 * Because an email link is the only channel available: the recipient may have
 * no account, so there is nothing to authenticate them with beforehand. Every
 * emailed-credential flow has this shape, and password reset already does.
 *
 * The mitigations belong to the frontend and are recorded in
 * INVITATION_SECURITY.md: strip the token from the URL once captured, never put
 * a token-bearing URL into analytics, and POST it to the backend rather than
 * letting it ride in a second GET. The backend's part is that no route ever
 * accepts a token from a query string, so the credential never enters an access
 * log on this side (§49, §101, §313).
 */
const TOKEN_PARAM = "token";

export interface InvitationLinkConfig {
  /**
   * The configured application origin, e.g. `https://app.lagda.io`.
   *
   * Validated at construction rather than per call: a malformed origin is a
   * deployment error, and discovering it while composing an email is
   * discovering it in the worst place.
   */
  readonly appBaseUrl: string;
}

export function createInvitationLinkBuilder(
  config: InvitationLinkConfig,
): InvitationLinkBuilder {
  // Parsed once, at startup. `new URL` throws on a malformed base, so a
  // misconfigured deployment fails to boot rather than sending links nobody can
  // follow.
  const base = new URL(config.appBaseUrl);

  return {
    build(rawToken: string): string {
      const url = new URL(INVITATION_PATH, base);
      // `searchParams.set` percent-encodes. base64url needs no encoding, but
      // hand-concatenating would be the habit that breaks the first time a
      // token format changes.
      url.searchParams.set(TOKEN_PARAM, rawToken);
      return url.toString();
    },
  };
}
