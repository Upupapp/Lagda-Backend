// Session resolution and CSRF enforcement, as Fastify plugins.
//
// Two plugins, deliberately separate:
//
//   sessionResolution  — reads the cookie, resolves an actor, attaches context.
//                        NEVER rejects. Public routes must keep working.
//   requireSession     — refuses anonymous requests and enforces CSRF.
//                        Registered inside an ENCAPSULATED scope.
//
// The split is what makes "protected by default" structural. A developer adds a
// route inside the authenticated scope and it is protected because of where it
// lives, not because they remembered a per-route flag. BACKEND-11 already
// records the reason to prefer this: a `RouteMeta.status` field on 225 routes
// that nothing read drifted until three routes misreported themselves.

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { CSRF_TOKEN_HEADER } from "@lagda/contracts";
import type {
  AuthenticatedActor, SessionRecord, SessionRejection,
} from "@lagda/application";
import {
  AuthenticationRequiredError, CsrfValidationError, type SessionService,
} from "@lagda/application";
import { SESSION_COOKIE_NAME } from "./cookies.js";
import { withAddedContext } from "../observability/context.js";
import type { MetricsRecorder } from "../observability/metrics.js";
import { normalizeRoute } from "../observability/metrics.js";

/**
 * A request's authentication state.
 *
 * A discriminated union, not a nullable `user` field. `request.auth.actor` is
 * unreachable unless the status is `authenticated`, so a handler cannot read an
 * actor that is not there — and `(request as any).user` is never needed.
 */
export type RequestAuth =
  | { readonly status: "anonymous"; readonly rejection?: SessionRejection }
  | { readonly status: "authenticated"; readonly actor: AuthenticatedActor;
      readonly session: SessionRecord };

declare module "fastify" {
  interface FastifyRequest {
    /** Always present. `anonymous` until a session resolves. */
    auth: RequestAuth;
  }
}

/**
 * Per-request backing storage for the auth state.
 *
 * A symbol so it cannot collide with any other decorator or plugin property.
 */
const AUTH_STATE = Symbol("lagda.auth");
type AuthCarrier = { [AUTH_STATE]?: RequestAuth };

/** Methods that must not change state, and so need no CSRF token. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface SessionPluginOptions {
  readonly sessions: SessionService;
  readonly metrics: MetricsRecorder;
}

/**
 * Resolves a session if one is present. **Never rejects.**
 *
 * Registered globally so any route can inspect `request.auth`, while public
 * routes stay public. A resolver that threw would make every public endpoint
 * fail the moment a browser sent a stale cookie.
 */
export const sessionResolution: FastifyPluginAsync<SessionPluginOptions> = fp(
  // `fastify-plugin` requires an async signature even though the body only
  // registers hooks synchronously.
  // eslint-disable-next-line @typescript-eslint/require-await
  async (app: FastifyInstance, options: SessionPluginOptions) => {
    const { sessions, metrics } = options;

    // Getter AND setter, over per-request backing storage.
    //
    // A getter alone made `request.auth = …` throw on every request. A shared
    // default VALUE would be worse: one mutable object across concurrent
    // requests, so one user's actor could be read by another's handler.
    app.decorateRequest("auth", {
      getter(this: FastifyRequest): RequestAuth {
        return (this as AuthCarrier)[AUTH_STATE] ?? { status: "anonymous" };
      },
      setter(this: FastifyRequest, value: RequestAuth) {
        (this as AuthCarrier)[AUTH_STATE] = value;
      },
    });

    app.addHook("onRequest", async (request) => {
      const raw = request.cookies[SESSION_COOKIE_NAME];

      if (raw === undefined) {
        request.auth = { status: "anonymous" };
        return;
      }

      // NOT wrapped in try/catch. A repository failure means the database is
      // unavailable, and swallowing it here would silently downgrade every
      // request to anonymous during an outage — users mass-logged-out by a
      // database blip. The error handler maps it to 503 (INV-153).
      const resolution = await sessions.resolve(raw);

      if (resolution.outcome === "rejected") {
        request.auth = { status: "anonymous", rejection: resolution.reason };
        metrics.increment("security_events_total", {
          securityEvent: "session_invalid", result: resolution.reason,
          processRole: "api",
        });
        return;
      }

      request.auth = {
        status: "authenticated",
        actor: resolution.actor,
        session: resolution.session,
      };

      // Slides the idle window, at most once per interval. Failure is ignored
      // inside the service — a missed bookkeeping write must not fail a request.
      await sessions.touchIfDue(resolution.session);
    });

    // Enriches the log context AFTER resolution, so every later line in the
    // request carries the actor.
    //
    // This is LOGGING ONLY. Authorization reads `request.auth`, never the
    // observability store (INV-135).
    app.addHook("preHandler", (request, _reply, done) => {
      if (request.auth.status !== "authenticated") { done(); return; }
      withAddedContext(
        {
          userId: request.auth.actor.userId,
          actorType: "workspace-user",
          // `sessionId` is deliberately NOT logged. It is not a credential, but
          // it is a durable handle to one, and `userId` plus `requestId` already
          // answers every operational question.
        },
        () => { done(); },
      );
    });
  },
  { name: "lagda-session-resolution", fastify: "5.x" },
);

/**
 * Requires a session, and CSRF on state-changing methods.
 *
 * A PLAIN FUNCTION, not a plugin, and that distinction is load-bearing.
 *
 * Registering it with `scope.register(requireSession)` looked correct and
 * protected NOTHING: a plugin not wrapped in `fastify-plugin` gets its own
 * encapsulation context, so hooks it adds apply only to routes declared inside
 * *it* — not to sibling routes in the parent scope. Every protected route
 * answered 200 to an anonymous request, and the tests are what caught it.
 *
 * Wrapping it in `fastify-plugin` would have been worse: the hook would escape
 * to the root and protect `/health` too.
 *
 * Called directly on the scope, the hook belongs to that encapsulation context
 * and applies to every route in it:
 *
 *   app.register(async (scope) => {
 *     requireSession(scope, { sessions, metrics });
 *     scope.get("/documents", handler);   // protected because of WHERE it is
 *   });
 */
export function requireSession(
  app: FastifyInstance,
  options: SessionPluginOptions,
): void {
  const { sessions, metrics } = options;

  app.addHook("onRequest", (request, _reply, done) => {
    // OPTIONS is exempt. A CORS preflight carries no cookie and no CSRF token
    // by definition, and requiring either would break every cross-origin
    // request before it started.
    if (request.method === "OPTIONS") { done(); return; }

    if (request.auth.status !== "authenticated") {
      // ONE error for every rejection reason. Distinguishing "expired" from
      // "unknown" would tell an attacker which tokens exist.
      done(new AuthenticationRequiredError());
      return;
    }

    // GET and HEAD are exempt because they must not change state — the rule
    // BACKEND-03 already set, and the assumption CSRF exemption rests on. A
    // `GET /logout` would silently defeat this entire mechanism.
    if (SAFE_METHODS.has(request.method)) { done(); return; }

    try {
      sessions.validateCsrf(request.auth.session, readCsrfHeader(request));
      done();
    } catch (error) {
      metrics.increment("security_events_total", {
        securityEvent: "csrf_rejected", result: "rejected", processRole: "api",
      });
      // Route PATTERN and outcome only. Never the submitted token, never the
      // expected one — logging the expected value would publish the secret the
      // check exists to protect.
      request.log.warn(
        {
          event: "security.csrf_rejected",
          securityEvent: "csrf_rejected",
          route: normalizeRoute(request.routeOptions.url, request.url),
          method: request.method,
          result: "rejected",
        },
        "csrf validation failed",
      );
      done(error instanceof CsrfValidationError ? error : new CsrfValidationError());
    }
  });
}

function readCsrfHeader(request: FastifyRequest): string | undefined {
  const value = request.headers[CSRF_TOKEN_HEADER.toLowerCase()];
  if (typeof value === "string") return value;
  // An array means the header was sent twice. Ambiguous, so refused rather than
  // resolved by picking one — a request that supplies two different CSRF tokens
  // is not a request to interpret charitably.
  return undefined;
}
