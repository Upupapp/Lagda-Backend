// The production entry point.
//
// Explicit, and separate from `createApp` — importing the package must never
// open a listener. This is the only place in the package that reads the
// environment, constructs infrastructure, or binds a port.

import {
  createDatabase, loadDatabaseConfig, createTransactionManager,
  type LagdaDatabase,
} from "@lagda/db";
import { createProviderEventConfirmerFromEnv } from "@lagda/email";
import { loadApiConfig, type ApiConfig } from "../config/index.js";
import { createApp } from "../app/create-app.js";
import type { AppDependencies } from "../app/dependencies.js";
import { createShutdown, type ShutdownTarget } from "./shutdown.js";

/**
 * Builds the real infrastructure.
 *
 * Only what the API foundation actually needs. `NodeDocumentSealer` exists and
 * is deliberately NOT constructed: no use case takes it yet, and instantiating
 * a dependency because it is available is how a process acquires a startup
 * failure mode for a feature it does not have.
 */
export function createProductionDependencies(database: LagdaDatabase): AppDependencies {
  return {
    databaseHealth: {
      // `ping()` from BACKEND-06. The API writes no SQL of its own.
      isReachable: () => database.ping(),
    },
    // Spread, so an unconfigured deployment has the key ABSENT rather than
    // present-and-undefined. Under `exactOptionalPropertyTypes` those are
    // different things, and here the difference is whether a route exists.
    ...buildProviderWebhook(database),
  };
}

/**
 * The provider callback surface, if this deployment has a credential for it.
 *
 * ── Absent means the route does not exist ──────────────────────────────────
 *
 * Not "exists but rejects everything", and not "exists with authentication
 * disabled" — the second being the failure mode an `ENABLE_WEBHOOK` boolean
 * eventually produces, because a boolean can be set true by someone who has not
 * set the secret.
 *
 * The consequence of leaving it unconfigured is bounded and honest: `DELIVERED`
 * and `BOUNCED` stay unreachable, deliveries stop at `PROVIDER_ACCEPTED`, and
 * nothing anywhere claims otherwise.
 *
 * ── Why this package does not know the provider ────────────────────────────
 *
 * `@lagda/email` decides whether the environment has a callback credential and
 * what to build from it. This file learns only whether the answer was null.
 * That keeps two rules that both matter: no vendor name outside the adapter,
 * and no environment read outside the config loader.
 */
function buildProviderWebhook(
  database: LagdaDatabase,
): Pick<AppDependencies, "providerWebhook"> {
  const confirm = createProviderEventConfirmerFromEnv();
  if (confirm === null) return {};

  const transactions = createTransactionManager(database.db);
  return {
    providerWebhook: () => ({
      confirm,
      eventDependencies: { transactions, clock: { now: () => Date.now() } },
    }),
  };
}


export interface StartedServer {
  readonly config: ApiConfig;
  close(): Promise<void>;
}

export async function startServer(): Promise<StartedServer> {
  // 1. Configuration, validated. An invalid port or a wildcard CORS origin
  //    stops the process here rather than producing a subtly wrong server.
  const config = loadApiConfig();
  const databaseConfig = loadDatabaseConfig();

  // 2. Infrastructure. NO MIGRATIONS — BACKEND-06 made migration an explicit
  //    deployment step, and an API that migrates on boot means every replica
  //    races to alter the schema during a rolling deploy.
  const database = createDatabase(databaseConfig);

  // 3. A bounded connectivity check BEFORE listening. Better to fail the deploy
  //    than to join the load balancer and serve 503s to real users.
  const reachable = await database.ping();
  if (!reachable) {
    await database.close();
    throw new Error(
      `Database is not reachable at ${database.describe()}. Refusing to start.`,
    );
  }

  const app = await createApp({
    config,
    dependencies: createProductionDependencies(database),
  });

  await app.listen({ host: config.host, port: config.port });

  const targets: ShutdownTarget[] = [
    { name: "http", close: () => app.close() },
    { name: "database", close: () => database.close() },
  ];

  const shutdown = createShutdown({
    targets,
    timeoutMs: config.shutdownTimeoutMs,
    log: (message, detail) => { app.log.info(detail ?? {}, message); },
    exit: (code) => { process.exit(code); },
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      app.log.info({ signal }, "shutdown signal received");
      void shutdown().then(() => { process.exit(0); });
    });
  }

  // An unhandled rejection leaves the process in an unknown state. Logging and
  // continuing would mean serving traffic from a process that has already
  // failed in a way nobody understands.
  process.on("unhandledRejection", (reason: unknown) => {
    app.log.fatal({ err: reason }, "unhandled rejection; terminating");
    void shutdown().then(() => { process.exit(1); });
  });
  process.on("uncaughtException", (error: unknown) => {
    app.log.fatal({ err: error }, "uncaught exception; terminating");
    void shutdown().then(() => { process.exit(1); });
  });

  return { config, close: shutdown };
}
