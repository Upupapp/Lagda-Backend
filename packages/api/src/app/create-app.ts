// The Fastify app factory.
//
// Builds a fully configured instance and does NOT listen. That separation is
// what lets integration tests use `app.inject()` with no TCP port, no free-port
// races and no cleanup — and it is why importing this package cannot start a
// server (INV: no listen on import).

import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import cookie from "@fastify/cookie";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { ApiErrorSchema, REQUEST_ID_HEADER, type RequestId } from "@lagda/contracts";
import { RateLimitedError } from "@lagda/application";
import type { ApiConfig } from "../config/index.js";
import { buildLoggerOptions } from "../logging/index.js";
import {
  mapError, badRequest, payloadTooLarge, unsupportedMediaType, routeNotFound,
  validationFailed,
} from "../errors/index.js";
import { toValidationDetails } from "../errors/validation.js";
import { generateRequestId } from "../context/index.js";
import { withContext } from "../observability/context.js";
import {
  normalizeRoute, statusFamily, noopMetrics, type MetricsRecorder,
} from "../observability/metrics.js";
import { registerHealthRoutes } from "../routes/health.js";
import { registerReadinessRoutes } from "../routes/readiness.js";
import type { AppDependencies } from "./dependencies.js";
import { sessionResolution, requireSession } from "../security/session-plugin.js";
import { registerWorkspaceRoutes } from "../workspaces/workspace-routes.js";

export interface CreateAppOptions {
  readonly config: ApiConfig;
  readonly dependencies: AppDependencies;
  /**
   * Defaults to a no-op. There is no exporter yet (BACKEND-66), so the
   * instrumentation exists and is tested while collecting nothing — reported as
   * INSTRUMENTED_NO_EXPORTER rather than implied to be live.
   */
  readonly metrics?: MetricsRecorder;
}

/**
 * Translates the config's trust-proxy setting into Fastify's option.
 *
 * `true` is unreachable here by construction — the config parser rejects it —
 * so the permissive case cannot arrive by accident from an environment
 * variable.
 */
function toFastifyTrustProxy(config: ApiConfig): boolean | number | string[] {
  switch (config.trustProxy.mode) {
    case "none": return false;
    case "hops": return config.trustProxy.hops;
    case "addresses": return [...config.trustProxy.addresses];
  }
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const { config, dependencies } = options;
  const metrics = options.metrics ?? noopMetrics;

  // Annotated so TypeScript selects the default HTTP/1 server overload. Without
  // it, the options literal is structurally ambiguous and inference lands on the
  // HTTP/2-secure variant, whose request/reply types then fail everywhere.
  const serverOptions: FastifyServerOptions = {
    logger: buildLoggerOptions(config),
    // Server-generated, always. API_CONVENTIONS §9: "a client value is untrusted
    // input that flows into logs". Fastify would otherwise adopt an inbound
    // `request-id` header, which would let a client choose its own correlation
    // key — and inject CRLF into a response header while doing so.
    genReqId: () => generateRequestId(),
    requestIdHeader: false,
    trustProxy: toFastifyTrustProxy(config),
    bodyLimit: config.bodyLimitBytes,
    requestTimeout: config.requestTimeoutMs,
    // Fastify does not send X-Powered-By, and nothing here adds one.
    //
    // `requestIdLogLabel` and `disableRequestLogging` are NOT set: both are
    // deprecated in Fastify 5 and removed in 6, and each emitted a deprecation
    // warning on every boot. Request logging is on by default, and Fastify's
    // default request-id log key (`reqId`) is fine — the pino serializer in
    // logging/index.ts emits `requestId` explicitly, so log consumers see the
    // canonical name regardless. `logController` is not used because it demands
    // a full implementation of ten members to override one label.
    ajv: {
      customOptions: {
        // `removeAdditional: false` — unknown properties are REJECTED, not
        // stripped (API_CONVENTIONS §4). Stripping hides stale clients and
        // typos; rejecting is also the cheapest defence against mass assignment.
        removeAdditional: false,
        // Deliberate, bounded coercion: "10" becomes 10 for a numeric query
        // parameter, while "10abc" fails. Ajv's coercion is type-directed, not
        // JavaScript's `Number()`, so it does not silently accept garbage.
        coerceTypes: true,
        // Report every problem at once rather than one per round trip.
        allErrors: true,
      },
    },
  };

  const app = Fastify(serverOptions).withTypeProvider<TypeBoxTypeProvider>();

  // ── Plugin order matters ───────────────────────────────────────────────────
  //
  // 1. security headers  — applied to every response including errors and 404s
  // 2. CORS              — must run before routes so preflight is handled
  // 3. swagger           — must be registered before the routes it documents
  // 4. request context   — decorates the request for handlers
  // 5. routes
  // 6. error / not-found handlers
  //
  // Registered on the root instance so encapsulation does not hide them from
  // later route groups. BACKEND-13 adds cookie/session plugins between 3 and 5,
  // inside an encapsulated scope so public routes stay public.

  await app.register(helmet, {
    // This process serves JSON, never HTML. A CSP governs what a *document* may
    // load, and there is no document — so it would be a header nobody enforces.
    // If the API ever serves a rendered page, this is the line to revisit.
    contentSecurityPolicy: false,
    // HSTS belongs at the TLS-terminating proxy. Setting it here would have the
    // API asserting a transport guarantee it does not itself provide.
    hsts: false,
  });

  if (config.corsOrigins.length > 0) {
    await app.register(cors, {
      // A function, not a list, so a request with NO Origin header (curl,
      // server-to-server) is allowed through rather than being handed
      // `Access-Control-Allow-Origin: null`.
      origin(origin, callback) {
        if (origin === undefined) { callback(null, true); return; }
        // EXACT equality. Never `origin.includes("lagda.io")`, which admits
        // `lagda.io.attacker.example`.
        callback(null, config.corsOrigins.includes(origin));
      },
      // Required for the cookie sessions BACKEND-13 will add. Safe only because
      // the origin list is exact and `*` is rejected at config load.
      credentials: true,
      allowedHeaders: ["Content-Type", "X-CSRF-Token", "Idempotency-Key"],
      exposedHeaders: [REQUEST_ID_HEADER],
    });
  }

  // Cookie parsing, BEFORE session resolution — the resolver reads
  // `request.cookies`. Hand-parsing the Cookie header would get quoting and
  // multiple-cookie cases subtly wrong.
  await app.register(cookie);

  // Generation only — no UI, and no route is exposed. `app.swagger()` builds the
  // document from the route schemas already declared, which keeps route schemas
  // the single source of truth and makes a hand-written spec impossible to drift
  // from. Exposing it over HTTP is a separate decision (OD-029).
  await app.register(swagger, {
    // Without this, a schema registered as `$id: "ApiError"` is emitted into the
    // document as `def-0`, and every generated client would produce a type
    // called `Def0`. The resolver keeps the name we chose.
    refResolver: {
      buildLocalReference(json, _base, _fragment, i) {
        return typeof json["$id"] === "string" ? json["$id"] : `def-${String(i)}`;
      },
    },
    openapi: {
      info: { title: "LAGDA API", version: "0.0.0" },
      tags: [{ name: "System", description: "Process health. Not product API." }],
    },
  });

  // The canonical error schema, registered ONCE and referenced by `$ref`.
  // Copying it into every route is how twelve routes end up describing eleven
  // slightly different error shapes.
  app.addSchema({ $id: "ApiError", ...ApiErrorSchema });

  // ── Request context ────────────────────────────────────────────────────────

  app.decorateRequest("observed", null);

  app.addHook("onRequest", (request, reply, done) => {
    // Echoed on EVERY response — success, error and 404 alike. Support cannot
    // correlate a failure the user reports if the failing response is the one
    // response without an ID.
    void reply.header(REQUEST_ID_HEADER, request.id);

    // Establishes the observability context for the rest of this request's
    // async execution. `done()` is called INSIDE the store so everything
    // downstream inherits it.
    //
    // This context is for LOGGING. It is never read to decide what data may be
    // accessed — the unit of work binds workspace scope, and RLS reads the
    // transaction setting (INV-135).
    withContext({ requestId: request.id as RequestId }, () => { done(); });
  });

  // One completion record per request, with a normalized route so the metric
  // cannot grow a series per document ID.
  app.addHook("onResponse", (request, reply, done) => {
    const route = normalizeRoute(request.routeOptions.url, request.url);
    const labels = { method: request.method, route, processRole: "api" };

    metrics.increment("http_requests_total", {
      ...labels, statusFamily: statusFamily(reply.statusCode),
    });
    metrics.observe("http_request_duration_ms", reply.elapsedTime, labels);

    if (reply.statusCode >= 500) {
      metrics.increment("http_errors_total", { ...labels, errorCategory: "internal" });
    }
    done();
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const requestId = request.id as RequestId;

    // Fastify signals these structurally, via `validation` and `code`. Nothing
    // below reads an error message.
    if (error.validation) {
      // Through the SAME mapper as everything else, so there is one envelope
      // builder rather than a second one that drifts.
      const mapped = mapError(
        validationFailed(toValidationDetails(error.validation)), requestId,
      );
      request.log.info(
        { requestId, details: mapped.body.error.details?.length ?? 0 },
        "request validation failed",
      );
      void reply.status(mapped.status).send(mapped.body);
      return;
    }

    const translated = translateFastifyError(error);
    const mapped = mapError(translated ?? error, requestId);

    // `Retry-After` is transport metadata, and the canonical error envelope has
    // no field for it. The IP limiter sets it before throwing because it runs in
    // its own hook; a SEMANTIC limit is checked inside a handler, where the
    // throw unwinds past any header the handler might have set. Setting it here
    // means every rate-limited response carries it, whichever layer refused.
    if (error instanceof RateLimitedError) {
      void reply.header("Retry-After", String(error.retryAfterSeconds));
    }

    if (mapped.logLevel === "error") {
      // The full error, with stack and cause, goes to the LOG. The client gets
      // the generic body and the request ID that finds this line.
      request.log.error(
        { requestId, err: mapped.cause ?? error, route: request.routeOptions.url },
        "unhandled error",
      );
    } else {
      request.log.info(
        { requestId, status: mapped.status, code: mapped.body.error.code },
        "request failed",
      );
    }

    void reply.status(mapped.status).send(mapped.body);
  });

  app.setNotFoundHandler((request, reply) => {
    const mapped = mapError(routeNotFound(), request.id as RequestId);
    void reply.status(mapped.status).send(mapped.body);
  });

  // ── Routes ─────────────────────────────────────────────────────────────────
  //
  // No prefix. API_CONVENTIONS §12 declined URL versioning, and health probes
  // conventionally sit at the process root where an orchestrator expects them.

  // Resolves a session when a cookie is present and NEVER rejects, so public
  // routes stay public. Enforcement happens inside the authenticated scope.
  if (dependencies.sessions !== undefined) {
    await app.register(sessionResolution, {
      sessions: dependencies.sessions, metrics,
    });
  }

  await registerHealthRoutes(app);
  await registerReadinessRoutes(app, { databaseHealth: dependencies.databaseHealth });

  // ── The authenticated scope ────────────────────────────────────────────────
  //
  // BACKEND-25 is the first command to COMPOSE protected routes into the
  // running application. Seventeen auth and account routes were built by
  // BACKEND-19..24 and none was registered here (OD-069), which meant every
  // control they specify — the pre-auth refusal, CSRF, the rate limits — was
  // demonstrated against a test double rather than in an app a request flows
  // through. This scope is the structure that closes that, and the remaining
  // route modules plug into the same place.
  //
  // ── Why `requireSession` is CALLED, not registered ───────────────────────
  //
  // `scope.register(requireSession)` looks correct and protects NOTHING: a
  // plugin not wrapped in `fastify-plugin` gets its own encapsulation context,
  // so its hooks apply only to routes declared inside IT. Wrapping it in
  // `fastify-plugin` would be worse — the hook would escape to the root and
  // require a session on `/health`. Called directly on the scope, the hook
  // belongs to that context and covers every route in it.
  //
  // Protection is therefore a property of WHERE a route lives. A future
  // workspace route added inside this callback is authenticated and CSRF-
  // checked because of its position, not because anyone remembered a flag.
  if (dependencies.workspaces !== undefined) {
    const sessions = dependencies.sessions;
    if (sessions === undefined) {
      // Refusing to boot, rather than registering the routes unprotected. A
      // misconfiguration that silently disables authentication is the one
      // outcome worth crashing over.
      throw new Error(
        "workspace routes require a session service: refusing to register them unauthenticated.",
      );
    }
    const workspaces = dependencies.workspaces;
    const limiter = dependencies.limiter;

    // Not `async`: the body registers a hook and some routes synchronously, and
    // an `async` callback with nothing to await is a promise that exists only to
    // satisfy a signature. Fastify accepts any function returning one.
    await app.register(scope => {
      requireSession(scope, { sessions, metrics });

      registerWorkspaceRoutes(scope, {
        // Reads the state `requireSession` has already validated. It cannot be
        // reached with anything else: the hook rejects an anonymous or pre-auth
        // request before a handler runs, so `status === "authenticated"` here
        // is guaranteed rather than assumed — and the null branch stays as the
        // fail-closed answer if that ever stops being true.
        authenticatedUser: request => Promise.resolve(
          request.auth.status === "authenticated"
            ? {
                userId: request.auth.actor.userId,
                sessionId: request.auth.actor.sessionId,
              }
            : null,
        ),
        createWorkspaceDependencies: workspaces.create,
        listDependencies: workspaces.list,
        workspaceDependencies: workspaces.workspace,
        ...(limiter === undefined ? {} : { rateLimit: { limiter, metrics } }),
        metrics,
      });

      return Promise.resolve();
    });
  }

  // Deliberately NOT `await app.ready()`. Readying seals the instance, and a
  // sealed app cannot have routes added — which would make the factory
  // untestable for exactly the cases worth testing (strict validation, response
  // stripping, error mapping) without inventing product endpoints to probe.
  //
  // `inject()` and `listen()` both ready the instance themselves, so nothing is
  // skipped; the caller simply decides when the instance closes to extension.
  return app;
}

/**
 * Recognises Fastify's own failures by CODE, never by message.
 *
 * Returning `null` means "not one of ours" and the generic 500 path handles it,
 * which is the safe direction to fail.
 */
function translateFastifyError(error: { code?: string; statusCode?: number }): Error | null {
  switch (error.code) {
    case "FST_ERR_CTP_EMPTY_JSON_BODY":
    case "FST_ERR_CTP_INVALID_JSON_BODY":
      return badRequest("The request body is not valid JSON.");
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
    case "FST_ERR_CTP_INVALID_CONTENT_LENGTH":
      return unsupportedMediaType();
    case "FST_ERR_CTP_BODY_TOO_LARGE":
      return payloadTooLarge();
    default:
      return null;
  }
}
