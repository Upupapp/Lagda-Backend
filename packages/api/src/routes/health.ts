// Liveness.
//
// "Is this process alive and able to serve HTTP?" — nothing more. It does NOT
// touch the database: an orchestrator restarting the API because PostgreSQL
// blipped turns a recoverable dependency failure into an outage, and restarting
// the process would not have fixed the database anyway.
//
// Readiness is the endpoint that answers the dependency question.

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";

const HealthResponse = Type.Object(
  { status: Type.Literal("ok") },
  {
    $id: "HealthResponse",
    additionalProperties: false,
    description: "Process liveness. Deliberately carries no environment detail.",
  },
);

export function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", {
    schema: {
      tags: ["System"],
      operationId: "getHealth",
      description: "Liveness probe. Does not check the database.",
      response: {
        200: HealthResponse,
        // `$ref` to the schema registered once on the instance. Copying the
        // envelope into each route is how twelve routes end up describing
        // eleven slightly different error shapes.
        500: { $ref: "ApiError#" },
      },
    },
    // Probes run every few seconds. Logging each one buries real traffic, and
    // failures still surface because errors are logged by the error handler.
    logLevel: "warn",
  }, (_request, reply) => {
    // No version, no NODE_ENV, no hostname, no dependency list. Every one of
    // those helps an attacker fingerprint the deployment, and none of them helps
    // the orchestrator decide whether to restart the process.
    void reply
      .header("Cache-Control", "no-store")
      .send({ status: "ok" as const });
  });

  return Promise.resolve();
}
