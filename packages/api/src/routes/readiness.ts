// Readiness.
//
// "Should this process receive application traffic?" — which, unlike liveness,
// genuinely depends on the database. A process that is alive but cannot reach
// PostgreSQL should be taken out of the load-balancer rotation, not restarted.

import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { DatabaseHealth } from "../app/dependencies.js";

const ReadinessResponse = Type.Object(
  { status: Type.Union([Type.Literal("ready"), Type.Literal("not-ready")]) },
  {
    $id: "ReadinessResponse",
    additionalProperties: false,
    description:
      "Readiness. Reports WHETHER dependencies are available, never which one "
      + "failed or why — that detail is an internal-topology disclosure on an "
      + "unauthenticated endpoint.",
  },
);

export interface ReadinessDependencies {
  readonly databaseHealth: DatabaseHealth;
}

export function registerReadinessRoutes(
  app: FastifyInstance,
  dependencies: ReadinessDependencies,
): Promise<void> {
  app.get("/ready", {
    schema: {
      tags: ["System"],
      operationId: "getReadiness",
      description: "Readiness probe. Checks required infrastructure.",
      response: {
        200: ReadinessResponse,
        503: ReadinessResponse,
        500: { $ref: "ApiError#" },
      },
    },
    logLevel: "warn",
  }, async (_request, reply) => {
    // The port resolves false rather than throwing, so a database outage cannot
    // turn this route into a 500 carrying a driver message.
    const reachable = await dependencies.databaseHealth.isReachable();

    // 503, not a 200 with `{"status":"not-ready"}`. An orchestrator reads the
    // STATUS CODE; a body-only signal means every probe passes forever.
    void reply
      .status(reachable ? 200 : 503)
      .header("Cache-Control", "no-store")
      .send({ status: reachable ? ("ready" as const) : ("not-ready" as const) });
  });

  return Promise.resolve();
}
