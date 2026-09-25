// Rate limits for the authentication surface.
//
// `identity-routes.ts` contained no rate-limiting code at all. Sign-in,
// registration, password reset and MFA verification were unthrottled, and
// eleven consecutive wrong passwords were answered eleven times with 401.
// The policies for all of it were already written and applied to nothing.
//
// ── Why one hook rather than a check in each handler ───────────────────────
//
// The nine other route modules call `checkSemanticLimits` inline, and that is
// right for them: each has one policy pair and the call sits next to the work
// it guards. The auth surface has eleven routes across five modules, and
// spreading the mapping over five files is how one of them ends up with no
// limit and nobody notices -- which is the state this file exists to end.
//
// Here the policy for every route is one table, readable in one screen, and a
// route with NO entry is visible as a gap rather than as an absence of code.
//
// ── Why a scope, and why not `applyIpRateLimit` ────────────────────────────
//
// `applyIpRateLimit` applies ONE policy set to every route in a scope. The auth
// policies are per-route -- `auth.signin.ip` is 5 in 15 minutes and
// `auth.register.ip` is not -- so a single set would either throttle sign-in at
// registration's rate or the reverse. It also cannot reach an account bucket,
// because it runs in `onRequest`, before a body exists.

import type { FastifyInstance } from "fastify";
import {
  normalizeEmail, policyById,
  type RateLimitCheck, type RateLimitPolicyId,
} from "@lagda/application";
import { checkSemanticLimits, type RateLimitOptions } from "./rate-limit-plugin.js";
import { IDENTITY_PATHS, ACCOUNT_RATE_LIMITED_PATHS } from "../app/identity-routes.js";

/**
 * The policies guarding one route.
 *
 * Both an IP and an ACCOUNT policy where the route accepts an address, because
 * they stop different attacks: the IP bucket stops one source spraying many
 * addresses, the account bucket stops many sources converging on one. Either
 * alone leaves the other attack unthrottled.
 */
interface RoutePolicies {
  readonly ip?: RateLimitPolicyId;
  readonly account?: RateLimitPolicyId;
  readonly user?: RateLimitPolicyId;
}

/**
 * Every identity route, and what limits it.
 *
 * Two entries are deliberately empty rather than missing, so that "this route
 * has no limit" is a decision recorded here rather than an oversight:
 *
 *   signOut   revokes the caller's OWN session and requires that session to
 *             do it. There is nothing to guess and nothing to enumerate.
 *   mfaConfirm shares `mfa.enroll.user` with the route that begins enrolment.
 *             The same ceremony, the same user, and confirm accepts a
 *             six-digit code -- so it needs a limit far more than begin does.
 */
const ROUTE_POLICIES: Readonly<Record<string, RoutePolicies>> = {
  [IDENTITY_PATHS.register]: {
    ip: "auth.register.ip", account: "auth.register.account",
  },
  [IDENTITY_PATHS.signIn]: {
    ip: "auth.signin.ip", account: "auth.signin.account",
  },
  [IDENTITY_PATHS.signOut]: {},
  [IDENTITY_PATHS.verifyEmail]: { ip: "verification.redeem.ip" },
  [IDENTITY_PATHS.resendVerification]: {
    ip: "verification.resend.ip", account: "verification.resend.account",
  },
  // Firebase-provider mode only (P2 migration) — registered as a route only
  // when that mode is active (see identity-routes.ts), but the completeness
  // gate scans this table unconditionally, so the entry must exist either way.
  [IDENTITY_PATHS.firebaseFinalizeVerification]: { ip: "verification.firebaseFinalize.ip" },
  [IDENTITY_PATHS.forgotPassword]: {
    ip: "auth.reset.request.ip", account: "auth.reset.request.account",
  },
  [IDENTITY_PATHS.resetPassword]: { ip: "auth.reset.submit.ip" },
  [IDENTITY_PATHS.mfaVerify]: { ip: "mfa.verify.ip" },
  [IDENTITY_PATHS.mfaEnroll]: { user: "mfa.enroll.user" },
  [IDENTITY_PATHS.mfaConfirm]: { user: "mfa.enroll.user" },
  [IDENTITY_PATHS.mfaDisable]: { user: "mfa.disable.user" },
  [ACCOUNT_RATE_LIMITED_PATHS.changePassword]: { user: "account.password.change.user" },
};

/** Exported for the completeness gate, not for callers. */
export const IDENTITY_ROUTE_POLICIES = ROUTE_POLICIES;

/**
 * The address the caller SUBMITTED, if the body carries one.
 *
 * Narrowed from `unknown` rather than cast: `request.body` is genuinely
 * unknown at this point, and a cast would assert a shape the route's schema
 * has not yet checked.
 */
function submittedEmail(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)["email"];
  return typeof value === "string" ? value : null;
}

/**
 * Installs the limits on every identity route in this scope.
 *
 * ── `preHandler`, and what that costs ──────────────────────────────────────
 *
 * Late enough that the body is parsed, which the account bucket needs. It is
 * also after schema validation, so a malformed payload is rejected without
 * consuming anyone's budget. That is the right trade: an attacker controls
 * their own payload and will send valid ones, while a client with a
 * serialization bug should not burn a limit it cannot see.
 */
export function applyIdentityRateLimits(
  app: FastifyInstance,
  options: RateLimitOptions,
): void {
  app.addHook("preHandler", async (request) => {
    const url = request.routeOptions.url;
    if (url === undefined) return;
    const policies = ROUTE_POLICIES[url];
    if (policies === undefined) return;

    const checks: RateLimitCheck[] = [];

    if (policies.ip !== undefined) {
      const ipAddress = request.ip;
      // Fastify's proxy-aware resolution, governed by TRUST_PROXY. With the
      // default -- trust nothing -- a spoofed `X-Forwarded-For` cannot select
      // a bucket, because this code never reads that header itself.
      if (typeof ipAddress === "string" && ipAddress !== "") {
        checks.push({
          policy: policyById(policies.ip),
          scope: { type: "ip", ipAddress },
        });
      }
    }

    if (policies.account !== undefined) {
      const raw = submittedEmail(request.body);
      const normalized = raw === null ? null : normalizeEmail(raw);
      // Keyed on the SUBMITTED address, and counted whether or not an account
      // exists. That is what stops the limit becoming an existence oracle: if
      // only real addresses were counted, the difference between 429 and 401
      // would answer "is this person a customer?" for anyone willing to send
      // a few requests. The scope is digested before storage, so the counter
      // table never holds the address itself.
      if (normalized !== null && normalized.outcome === "ok") {
        checks.push({
          policy: policyById(policies.account),
          scope: { type: "account", accountKey: normalized.normalized },
        });
      }
    }

    if (policies.user !== undefined) {
      const auth = request.auth;
      if (auth.status === "authenticated") {
        checks.push({
          policy: policyById(policies.user),
          scope: { type: "user", userId: auth.actor.userId },
        });
      }
    }

    await checkSemanticLimits(request, checks, options);
  });
}
