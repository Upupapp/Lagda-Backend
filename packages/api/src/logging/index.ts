// Pino configuration for the API process.
//
// Structured JSON, via Fastify's built-in Pino integration. No `console.log`
// anywhere — an unstructured line is invisible to log aggregation, and the one
// time it matters is during an incident.

import type { FastifyError, FastifyRequest, FastifyServerOptions } from "fastify";
import type { ApiConfig } from "../config/index.js";

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

export function buildLoggerOptions(config: ApiConfig): LoggerOptions {
  return {
    level: config.logLevel,
    redact: { paths: REDACTED_PATHS, remove: true },
    serializers: {
      // Explicit allowlists. Pino's DEFAULT request serializer includes the
      // full header set, and a default that logs everything is one new header
      // away from logging a credential.
      //
      // The request BODY is never serialized. It may contain passwords, OTPs,
      // signature images, field values and document content — and "we redact
      // the known-sensitive keys" fails the moment a new key appears.
      req(request: FastifyRequest) {
        const userAgent = request.headers["user-agent"];
        return {
          requestId: request.id,
          method: request.method,
          // The path only. A query string can carry a token in a shared link.
          url: request.url.split("?")[0] ?? request.url,
          ...(typeof userAgent === "string" ? { userAgent: userAgent.slice(0, 256) } : {}),
        };
      },
      res(reply: { statusCode: number }) {
        return { statusCode: reply.statusCode };
      },
      // Stack and cause stay in the LOG. They are never serialized into a
      // response — see errors/index.ts.
      err(error: FastifyError) {
        return {
          type: error.name,
          message: error.message,
          stack: error.stack ?? "",
          // Not `String(cause)`: an object cause renders as "[object Object]",
          // which destroys the one piece of context worth having in the log.
          ...(error.cause === undefined ? {} : { cause: describeCause(error.cause) }),
        };
      },
    },
  };
}
