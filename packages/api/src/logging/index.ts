// Pino configuration for the API process.
//
// Structured JSON, via Fastify's built-in Pino integration. No `console.log`
// anywhere — an unstructured line is invisible to log aggregation, and the one
// time it matters is during an incident.

import type { FastifyError, FastifyServerOptions } from "fastify";
import type { ApiConfig } from "../config/index.js";
import { redactLogObject, scrubSecretsFromText } from "./redaction.js";
import { currentContext, type ProcessRole } from "../observability/context.js";

/**
 * Header and field paths that must never reach a log.
 *
 * `remove: true` rather than a `[Redacted]` placeholder: the placeholder still
 * proves the header was present, and for `set-cookie` that is a signal worth
 * denying. Removal also keeps log volume down.
 *
 * These are PATHS into Pino's serialized object, so they must match the shape
 * the serializers below produce.
 */
// Kept as a FIRST pass. Pino's path redaction is cheap and handles the common
// header shapes, but it cannot express "any key named `token`, at any depth" —
// a probe proved a top-level `password` and a three-level-deep `token` both got
// through. The deep walk in `formatters.log` is what actually holds; this
// remains because defence in depth costs nothing here.
const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['set-cookie']",
  "req.headers['x-csrf-token']",
  "res.headers['set-cookie']",
  // Defence in depth. Bodies are not serialized at all (see below), but if a
  // future debug path ever logs one, these are the fields that must not survive.
  "*.password",
  "*.otp",
  "*.token",
  "*.secret",
  "*.signature",
];

type LoggerOptions = NonNullable<Exclude<FastifyServerOptions["logger"], boolean | undefined>>;

/** A readable, bounded rendering of an error cause of unknown shape. */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === "object" && cause !== null) {
    try {
      return JSON.stringify(cause).slice(0, 512);
    } catch {
      return "[unserializable cause]";
    }
  }
  return String(cause);
}

export interface LoggerContext {
  readonly service: string;
  readonly processRole: ProcessRole;
  readonly environment: string;
}

/** One service name for the whole backend. Packages are modules, not services. */
export const SERVICE_NAME = "lagda-backend";

export function buildLoggerOptions(
  config: ApiConfig,
  processRole: ProcessRole = "api",
): LoggerOptions {
  return {
    level: config.logLevel,
    redact: { paths: REDACTED_PATHS, remove: true },
    // Stamped on every line, so a log aggregator can separate the API from the
    // worker and the migration runner without inferring it from the message.
    base: {
      service: SERVICE_NAME,
      processRole,
      environment: config.environment,
    },
    // Scrubs the MESSAGE, which `formatters.log` never sees.
    //
    // Found by probing: Fastify sets `msg` to `error.message` when it logs an
    // unhandled error, and a driver message routinely embeds the connection
    // string. The object was clean and the message published the password.
    hooks: {
      logMethod(args: unknown[], method: (...a: unknown[]) => void): void {
        const scrubbed = args.map(arg =>
          typeof arg === "string" ? scrubSecretsFromText(arg) : arg,
        );
        method.apply(this, scrubbed);
      },
    },
    formatters: {
      /**
       * The redaction that holds, plus ambient context.
       *
       * Runs on the merged object for every line, AFTER the serializers below —
       * so it sees the final shape rather than a path guessed in advance.
       */
      log(object: Record<string, unknown>): Record<string, unknown> {
        const context = currentContext();
        return redactLogObject({
          ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
          ...(context.workspaceId === undefined ? {} : { workspaceId: context.workspaceId }),
          ...(context.userId === undefined ? {} : { userId: context.userId }),
          ...(context.actorType === undefined ? {} : { actorType: context.actorType }),
          ...(context.operation === undefined ? {} : { operation: context.operation }),
          ...object,
        });
      },
    },
    serializers: {
      // Explicit allowlists. Pino's DEFAULT request serializer includes the
      // full header set, and a default that logs everything is one new header
      // away from logging a credential.
      //
      // The request BODY is never serialized. It may contain passwords, OTPs,
      // signature images, field values and document content — and "we redact
      // the known-sensitive keys" fails the moment a new key appears.
      //
      // DEFENSIVE ABOUT ITS INPUT, deliberately. Fastify hands this serializer
      // different shapes depending on the log site — a `FastifyRequest` at some,
      // the raw `IncomingMessage` at others, where `id` is absent and `headers`
      // may be undefined. The first version read `request.headers["user-agent"]`
      // unguarded and **threw inside the logger**, failing the request.
      //
      // It went unnoticed through BACKEND-11 because the test configuration runs
      // at `silent`, so serializers never executed. A serializer that can throw
      // turns a log line into an outage.
      req(incoming: unknown) {
        const request = (incoming ?? {}) as {
          id?: unknown; method?: unknown; url?: unknown;
          headers?: Record<string, unknown>;
          raw?: { url?: unknown; method?: unknown; headers?: Record<string, unknown> };
        };
        // Falls back to `raw`. Fastify does not always pass a full
        // `FastifyRequest` here — at `incomingRequest` the method and URL were
        // both undefined, which silently produced `"url":""` on every line.
        const raw = request.raw ?? {};
        const headers = request.headers ?? raw.headers ?? {};
        const userAgent = headers["user-agent"];
        const method = typeof request.method === "string" ? request.method : raw.method;
        const url = typeof request.url === "string"
          ? request.url
          : (typeof raw.url === "string" ? raw.url : "");
        return {
          ...(typeof request.id === "string" ? { requestId: request.id } : {}),
          ...(typeof method === "string" ? { method } : {}),
          // The PATH only. A query string can carry a token in a shared link, a
          // verification ID, or a free-text search containing a client name.
          url: url.split("?")[0] ?? url,
          // The user-agent itself is NOT logged: high-cardinality, identifying,
          // and §61 says not on every request. Its presence is recorded because
          // "no user-agent at all" is a useful signal, and it costs nothing.
          ...(typeof userAgent === "string" && userAgent.length > 0
            ? { userAgentPresent: true }
            : {}),
        };
      },
      res(reply: { statusCode?: number }) {
        return { statusCode: reply.statusCode ?? 0 };
      },
      // Stack and cause stay in the LOG. They are never serialized into a
      // response — see errors/index.ts.
      err(error: FastifyError) {
        return {
          type: error.name,
          // Scrubbed: a driver error message routinely contains the connection
          // string, and field-based redaction cannot reach inside a message.
          message: scrubSecretsFromText(error.message),
          stack: error.stack === undefined ? "" : scrubSecretsFromText(error.stack),
          // Not `String(cause)`: an object cause renders as "[object Object]",
          // which destroys the one piece of context worth having in the log.
          ...(error.cause === undefined ? {} : { cause: describeCause(error.cause) }),
        };
      },
    },
  };
}
