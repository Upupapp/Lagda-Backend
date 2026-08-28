// The production entry point.
//
// Explicit, and separate from `createApp` — importing the package must never
// open a listener. This is the only place in the package that reads the
// environment, constructs infrastructure, or binds a port.

import {
  createDatabase, loadDatabaseConfig, createTransactionManager,
  createSessionRepository,
  type LagdaDatabase,
} from "@lagda/db";
import { createSessionService, type Clock } from "@lagda/application";
import {
  createSecurityTokenGenerator, createSecurityTokenDigester,
  createIdempotencyKeyDigester, createIdempotencyRecordIdGenerator,
} from "../security/crypto.js";
import {
  createWorkspaceIdGenerator, createWorkspaceMemberIdGenerator,
  createContactIdGenerator, createDocumentIdGenerator,
  createPreparationIdGenerator, createRecipientIdGenerator,
  createSigningRequestIdGenerator, createEvidenceEventIdGenerator,
  createOrganizationUnitIdGenerator,
} from "../security/identifiers.js";
import { createProviderEventConfirmerFromEnv } from "@lagda/email";
import { loadApiConfig, type ApiConfig } from "../config/index.js";
import { createApp } from "../app/create-app.js";
import type { AppDependencies } from "../app/dependencies.js";
import { createShutdown, type ShutdownTarget } from "./shutdown.js";

/**
 * How long a settled idempotency record is kept.
 *
 * 24 hours, matching the window the API documents to clients. Not a config key
 * on purpose: the retention and the promise made to callers have to agree, and
 * an environment variable lets one deployment quietly answer differently from
 * the contract everyone else reads.
 */
const IDEMPOTENCY_RETENTION_MS = 24 * 3_600_000;

/**
 * Builds the real infrastructure.
 *
 * ── What changed, and why it could not have been done before ───────────────
 *
 * This supplied TWO of twelve groups: `databaseHealth`, and `providerWebhook`
 * when a credential existed. A deployment served /health, /ready and nothing
 * else -- no sign-in, no workspace, no document, no signing surface.
 *
 * The blocker was NOT that the wiring was unwritten. It was that most of what
 * the wiring needs had no production implementation to reach for: every domain
 * id generator existed only as a `Sequential*` fake in test-support. See
 * `../security/identifiers.ts`. The wiring below is possible because those now
 * exist, and it deliberately imports none of the doubles -- a rule the
 * identifier tests enforce against this file's source text.
 *
 * `NodeDocumentSealer` is still deliberately NOT constructed: no use case wired
 * here takes it, and instantiating a dependency because it is available is how
 * a process acquires a startup failure mode for a feature it does not have.
 */
export function createProductionDependencies(
  database: LagdaDatabase,
  config: ApiConfig,
): AppDependencies {
  // The REAL transaction manager, over the real pool. It is what composes the
  // twenty-odd scoped repositories into a unit of work and what applies the
  // tenant context every RLS policy reads -- which is why the repositories are
  // not exported individually and why no route can reach one directly.
  const transactions = createTransactionManager(database.db);
  const clock: Clock = { now: () => Date.now() };

  const sessions = createSessionService({
    sessions: createSessionRepository(database.db),
    tokens: createSecurityTokenGenerator(),
    digester: createSecurityTokenDigester(),
    clock,
    // From config, not literals. The dev server hard-codes these; a deployment
    // that cannot shorten its own session lifetime has no answer to an incident.
    policy: {
      absoluteLifetimeMs: config.sessionAbsoluteLifetimeMs,
      idleTimeoutMs: config.sessionIdleTimeoutMs,
      touchIntervalMs: config.sessionTouchIntervalMs,
    },
  });

  // ONE instance, shared by every group that claims a key. Building it per
  // request would be wrong even now that the record-id generator is stateless:
  // the claim has to commit on the SAME transaction as the mutation, and a
  // per-request object invites the reading that it is per-request state.
  const idempotency = {
    digester: createIdempotencyKeyDigester(),
    ids: createIdempotencyRecordIdGenerator(),
    clock,
    policy: { retentionMs: IDEMPOTENCY_RETENTION_MS },
  };

  const workspaceIds = createWorkspaceIdGenerator();
  const memberIds = createWorkspaceMemberIdGenerator();
  const contactIds = createContactIdGenerator();
  const documentIds = createDocumentIdGenerator();
  const preparationIds = createPreparationIdGenerator();
  const recipientIds = createRecipientIdGenerator();
  const unitIds = createOrganizationUnitIdGenerator();
  // Creating a signing request also APPENDS evidence, so the port asks for both
  // capabilities in one object. Composed by spread rather than by one class
  // implementing both, so neither can be changed without the other being seen.
  const signingRequestIds = {
    ...createSigningRequestIdGenerator(),
    ...createEvidenceEventIdGenerator(),
  };

  return {
    databaseHealth: {
      // `ping()` from BACKEND-06. The API writes no SQL of its own.
      isReachable: () => database.ping(),
    },
    sessions,
    workspaces: {
      create: () => ({ transactions, clock, workspaceIds, memberIds, idempotency }),
      list: () => ({ transactions }),
      workspace: () => ({ transactions }),
      contacts: () => ({ transactions, clock, ids: contactIds }),
      documents: () => ({ transactions, clock, ids: documentIds }),
      preparation: () => ({ transactions, clock, ids: preparationIds }),
      // Both generators: a recipient cannot exist without a preparation to hold
      // it, and the first recipient on a never-prepared document creates one.
      recipients: () => ({
        transactions, clock,
        ids: {
          nextRecipientId: () => recipientIds.nextRecipientId(),
          nextPreparationId: () => preparationIds.nextPreparationId(),
          nextPreparationFieldId: () => preparationIds.nextPreparationFieldId(),
        },
      }),
      signingRequests: () => ({
        transactions, clock, ids: signingRequestIds, idempotency,
      }),
      members: {
        administration: () => ({ transactions, clock }),
        access: () => ({ transactions }),
      },
      organization: () => ({ transactions, clock, unitIds }),
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
    dependencies: createProductionDependencies(database, config),
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
