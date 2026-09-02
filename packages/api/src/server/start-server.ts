// The production entry point.
//
// Explicit, and separate from `createApp` — importing the package must never
// open a listener. This is the only place in the package that reads the
// environment, constructs infrastructure, or binds a port.

import {
  createDatabase, loadDatabaseConfig, createTransactionManager,
  createSessionRepository, createRateLimitCounterRepository,
  type LagdaDatabase,
} from "@lagda/db";
import {
  createSessionService, createAbuseLimiter,
  createTemplateRegistry, ALL_TEMPLATES,
  type Clock, type NormalizedEmail, type UserId,
} from "@lagda/application";
import { createRateLimitScopeDigester } from "../security/rate-limit-plugin.js";
import { createInvitationTokenFactory } from "../security/invitation-token.js";
import { createInvitationLinkBuilder } from "../workspaces/invitation-link.js";
import { createSigningAccessTokenFactory } from "../security/signing-access-token.js";
import {
  createDeliverySecretSealer, createSigningLinkBuilder,
} from "../security/signing-delivery.js";
import {
  createSecurityTokenGenerator, createSecurityTokenDigester,
  createIdempotencyKeyDigester, createIdempotencyRecordIdGenerator,
} from "../security/crypto.js";
import { randomBytes } from "node:crypto";
import {
  createS3ObjectStorage, createStorageKeyStrategy, loadStorageConfig,
} from "@lagda/storage";
import { createClamAvScanner, loadScannerConfig } from "@lagda/scanning";
import { createPdfInspector, sha256 } from "@lagda/sealing";
import { createArgon2PasswordHasher } from "../security/password-hasher.js";
import { buildIdentity } from "./identity-composition.js";
import {
  createWorkspaceIdGenerator, createWorkspaceMemberIdGenerator,
  createContactIdGenerator, createDocumentIdGenerator, createFolderIdGenerator,
  createPreparationIdGenerator, createRecipientIdGenerator,
  createSigningRequestIdGenerator, createEvidenceEventIdGenerator,
  createOrganizationUnitIdGenerator, createWorkspaceInvitationIdGenerator,
  createSigningAccessIdGenerator, createNotificationIntentIdGenerator,
  createNotificationDeliveryIdGenerator, createArtifactIdGenerator, nextUploadId,
} from "../security/identifiers.js";
import { createProviderEventConfirmerFromEnv } from "@lagda/email";
import { loadApiConfig, type ApiConfig } from "../config/index.js";
import { createApp } from "../app/create-app.js";
import type { AppDependencies, WorkspaceDependencies } from "../app/dependencies.js";
import type { RequestAuth } from "../security/session-plugin.js";
import type { WorkspaceId, DocumentId } from "@lagda/contracts";
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
 * What one upload may be.
 *
 * 25 MB and 500 pages, matching the dev server so a document accepted in
 * development is not refused in production. The page bound exists because page
 * count is what preparation places fields against: a 5,000-page file is a
 * denial-of-service against the inspector, not a document anyone is signing.
 */
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const UPLOAD_MAX_PAGES = 500;

/** The shared idempotency slice every claiming group receives. */
interface IdempotencyComposition {
  readonly digester: ReturnType<typeof createIdempotencyKeyDigester>;
  readonly ids: ReturnType<typeof createIdempotencyRecordIdGenerator>;
  readonly clock: Clock;
  readonly policy: { readonly retentionMs: number };
}

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
export async function createProductionDependencies(
  database: LagdaDatabase,
  config: ApiConfig,
): Promise<AppDependencies> {
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
  const idempotency: IdempotencyComposition = {
    digester: createIdempotencyKeyDigester(),
    ids: createIdempotencyRecordIdGenerator(),
    clock,
    policy: { retentionMs: IDEMPOTENCY_RETENTION_MS },
  };

  // A valid Argon2id hash that authenticates nobody, computed once from a
  // secret nobody keeps. Login verifies against it when an account does not
  // exist, so a missing account costs the same time as a wrong password --
  // without it, response latency answers "does this address have an account?"
  //
  // This one await is why the composition root is async. Hard-coding a hash
  // would be faster and wrong: it has to carry THIS deployment's Argon2
  // parameters, or the timing it is there to equalise does not match.
  const dummyPasswordHash = await createArgon2PasswordHasher()
    .hash(randomBytes(32).toString("hex"));

  const workspaceIds = createWorkspaceIdGenerator();
  const memberIds = createWorkspaceMemberIdGenerator();
  const contactIds = createContactIdGenerator();
  const documentIds = createDocumentIdGenerator();
  const folderIds = createFolderIdGenerator();
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
    // The abuse limiter. Absent, the fourteen policies defined across the
    // codebase attached to nothing: nine route modules call
    // `checkSemanticLimits`, and every one of those calls was a no-op because
    // the option it reads was never supplied.
    //
    // Counters live in PostgreSQL rather than in memory, which is what makes
    // the limit hold across replicas. An in-process counter would multiply
    // every limit by the number of API processes -- and would reset each one
    // to zero on deploy, which is when an attacker is least likely to notice
    // and most likely to be running.
    limiter: createAbuseLimiter({
      counters: createRateLimitCounterRepository(database.db),
      digester: createRateLimitScopeDigester(),
      clock,
    }),
    sessions,
    workspaces: {
      create: () => ({ transactions, clock, workspaceIds, memberIds, idempotency }),
      list: () => ({ transactions }),
      workspace: () => ({ transactions }),
      contacts: () => ({ transactions, clock, ids: contactIds }),
      documents: () => ({ transactions, clock, ids: documentIds }),
      folders: () => ({ transactions, clock, ids: folderIds }),
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
      // The private audit trail for one signing request. It needs the
      // transaction manager and nothing else -- an earlier reading of this
      // called it request-scoped, which was wrong: the actor and the request
      // id belong to the use case's INPUT, not to its dependencies.
      audit: () => ({ transactions }),
      ...buildLinkedSurfaces({
        config, transactions, clock, idempotency, memberIds, database,
      }),
    },
    // Spread, so an unconfigured deployment has the key ABSENT rather than
    // present-and-undefined. Under `exactOptionalPropertyTypes` those are
    // different things, and here the difference is whether a route exists.
    ...buildIdentity(database, config, sessions, dummyPasswordHash),
    ...buildUpload(database, transactions, clock),
    ...buildProviderWebhook(database),
  };
}

/**
 * Document upload, if this deployment has somewhere to put bytes and something
 * to scan them with.
 *
 * ── Absent means the route does not exist ──────────────────────────────────
 *
 * Both loaders THROW when unconfigured, and that is the signal used here. The
 * alternative -- mounting the route and failing at the first upload -- gives a
 * user a working-looking control that rejects their document.
 *
 * ── There is no way to run this without a scanner ──────────────────────────
 *
 * `loadScannerConfig` says so in as many words: "Uploads require malware
 * scanning and there is no configuration that disables it." So a deployment
 * with object storage and no scanner gets NO upload route, rather than an
 * upload route that stores unscanned bytes. That is the right trade and it is
 * not this file's decision to revisit.
 */
function buildUpload(
  database: LagdaDatabase,
  transactions: ReturnType<typeof createTransactionManager>,
  clock: Clock,
): Pick<AppDependencies, "upload"> {
  let storageConfig;
  let scannerConfig;
  try {
    storageConfig = loadStorageConfig();
    scannerConfig = loadScannerConfig();
  } catch {
    // Names only are ever reported by those loaders, and neither value is
    // logged here: between them they read four secrets.
    return {};
  }

  const storage = createS3ObjectStorage(storageConfig);
  const keys = createStorageKeyStrategy();
  const inspector = createPdfInspector();
  const scanner = createClamAvScanner(scannerConfig);
  const artifactIds = createArtifactIdGenerator();

  return {
    upload: () => ({
      path: "/workspaces/:workspaceId/documents/:documentId/upload",
      limits: { maxBytes: UPLOAD_MAX_BYTES, maxPages: UPLOAD_MAX_PAGES },

      // Tenancy comes from the SESSION and the PATH, never from a multipart
      // field: a body field is chosen by the client, and letting it name the
      // tenant would be a complete tenancy bypass.
      resolveContext: (request) => {
        const auth: RequestAuth = request.auth;
        if (auth.status !== "authenticated") return null;
        const params = request.params as { workspaceId?: string; documentId?: string };
        if (!params.workspaceId || !params.documentId) return null;
        return {
          workspaceId: params.workspaceId as WorkspaceId,
          userId: auth.actor.userId,
          documentId: params.documentId as DocumentId,
        };
      },

      dependenciesFor: ({ workspaceId }) => ({
        storage, keys, inspector, scanner, clock,
        // The SEALER's digest, not a second one. An upload digest and a seal
        // digest are both digests of document bytes, and INV-080 exists so the
        // two cannot disagree.
        digestOf: sha256,
        newUploadId: () => nextUploadId() as never,
        newArtifactId: () => artifactIds.nextArtifactId(),

        /**
         * Each write in its OWN short transaction.
         *
         * The pipeline writes an upload row, then talks to object storage and
         * a virus scanner over the network, then writes again. Holding one
         * transaction across that would pin a database connection for the
         * length of a file transfer and a malware scan -- with a pool of ten,
         * a handful of concurrent uploads would starve every other request.
         *
         * Atomicity is only needed where two rows must agree, and that is
         * `commitAcceptance` below, which takes its own transaction.
         */
        uploads: {
          insert: (record) =>
            transactions.runForWorkspace(workspaceId, uow => uow.uploads.insert(record)),
          find: (uploadId) =>
            transactions.runForWorkspace(workspaceId, uow => uow.uploads.find(uploadId)),
          complete: (input) =>
            transactions.runForWorkspace(workspaceId, uow => uow.uploads.complete(input)),
        },

        /**
         * The write that makes the bytes real.
         *
         * ONE transaction: the artifact row and the upload's completion commit
         * together or not at all. Written separately, a crash between them
         * leaves either an artifact nothing points at or an upload marked
         * accepted with no artifact -- and the second is the one that makes
         * `saveDocumentPreparation` refuse a document that appears to have a
         * file.
         *
         * The upload-route test supplies `() => Promise.resolve()` here, which
         * type-checks and writes nothing. That double is why a fully tested
         * upload route once left every document without bytes, and it is named
         * in this repository's own request-typing test.
         */
        commitAcceptance: async (input) => {
          await transactions.runForWorkspace(workspaceId, async uow => {
            await uow.artifacts.insert(input.artifact);
            await uow.uploads.complete({
              uploadId: input.uploadId,
              status: "accepted",
              // THE ARTIFACT THIS UPLOAD PRODUCED. Its absence made every
              // upload fail at the last write: migration 006's CHECK says
              // `accepted` implies `accepted_artifact_id is not null`, and
              // this call omitted it while holding the id one line above.
              //
              // Nothing caught it because the in-memory upload repository
              // accepted a row the database refuses -- so the whole suite was
              // green and no document could ever have bytes. The fake enforces
              // the rule now, which is the part that stops it happening again.
              acceptedArtifactId: input.artifact.artifactId,
              digest: input.digest,
              detectedMediaType: input.detectedMediaType,
              scanOutcome: input.scanOutcome,
              scannedAt: input.scannedAt,
              completedAt: input.completedAt,
            });
          });
        },
      }),
    }),
  };
}

/**
 * The two surfaces that mint a link into the web application.
 *
 * Grouped because they share ONE precondition -- `APP_BASE_URL` -- and because
 * grouping makes the deployment story a single sentence: configure the app
 * origin and both appear, leave it unset and neither does.
 *
 * Send needs strictly more. Its sealer protects the recipient credential the
 * renderer later opens, and `createDeliverySecretSealer(null, ...)` returns a
 * sealer that REFUSES rather than storing a recoverable secret in the clear.
 * Composing it without a key would therefore mount a route that fails at every
 * use, which is the "exists but rejects everything" state this codebase
 * consistently declines to ship.
 */
function buildLinkedSurfaces(input: {
  config: ApiConfig;
  transactions: ReturnType<typeof createTransactionManager>;
  clock: Clock;
  idempotency: IdempotencyComposition;
  memberIds: ReturnType<typeof createWorkspaceMemberIdGenerator>;
  database: LagdaDatabase;
}): Partial<Pick<WorkspaceDependencies, "invitations" | "sendSigningRequest">> {
  const { config, transactions, clock, idempotency, memberIds, database } = input;
  const appBaseUrl = config.appBaseUrl;
  if (appBaseUrl === null) return {};

  const invitationTokens = createInvitationTokenFactory();

  /**
   * The caller's CURRENT canonical address.
   *
   * Read from the account at acceptance time, never from the session: a session
   * carries no email claim, and if it did it would be stale the moment the user
   * changed their address.
   */
  const currentNormalizedEmail = async (
    userId: UserId,
  ): Promise<NormalizedEmail | null> => {
    const row = await database.db.selectFrom("users").select("normalized_email")
      .where("user_id", "=", userId).executeTakeFirst();
    return (row?.normalized_email ?? null) as NormalizedEmail | null;
  };

  const invitations = {
    management: () => ({
      transactions, clock,
      invitationIds: createWorkspaceInvitationIdGenerator(),
      tokens: invitationTokens,
      links: createInvitationLinkBuilder({ appBaseUrl }),
      // Inviting the same address twice on a retry would send two credentials
      // and leave one of them unaccounted for.
      idempotency,
      // Optional in the port. Supplied only with a key, because the sealed
      // credential is what lets the worker render the invitation later; without
      // one the invitation still works, it simply cannot be re-rendered.
      ...(config.signingDeliveryKey === null ? {} : {
        sealer: createDeliverySecretSealer(
          config.signingDeliveryKey, config.signingDeliveryKeyVersion),
      }),
    }),
    redemption: () => ({
      transactions, clock, tokens: invitationTokens, memberIds,
      currentNormalizedEmail,
    }),
  };

  if (config.signingDeliveryKey === null) return { invitations };

  return {
    invitations,
    sendSigningRequest: () => ({
      transactions, clock,
      // Send mints a grant, appends evidence, and raises a notification intent
      // with its delivery. Four capabilities, composed by spread so none can be
      // changed without the others being seen.
      ids: {
        ...createSigningAccessIdGenerator(),
        ...createEvidenceEventIdGenerator(),
        ...createNotificationIntentIdGenerator(),
        ...createNotificationDeliveryIdGenerator(),
      },
      tokens: createSigningAccessTokenFactory(),
      sealer: createDeliverySecretSealer(
        config.signingDeliveryKey, config.signingDeliveryKeyVersion),
      links: createSigningLinkBuilder(appBaseUrl),
      // The real templates, the same set the worker renders from. A registry
      // built from a different list would let the API freeze a template version
      // the worker cannot resolve.
      templates: createTemplateRegistry(ALL_TEMPLATES),
      policy: { bootstrapLifetimeMs: config.signingAccessLifetimeMs },
      idempotency,
    }),
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
    dependencies: await createProductionDependencies(database, config),
  });

  // ── One warning, and why it is worth a line at boot ──────────────────────
  //
  // The auth surface is IP-limited now, and `request.ip` is Fastify's
  // proxy-aware resolution governed by TRUST_PROXY. Trusting nothing is the
  // correct DEFAULT -- it stops a client choosing its own bucket with a forged
  // X-Forwarded-For -- but behind a load balancer it means every request
  // reports the BALANCER's address, so every user in the world shares one
  // bucket and `auth.signin.ip` becomes a global cap of five sign-ins a
  // minute.
  //
  // A warning rather than a refusal: a deployment reached directly is a real
  // and correct configuration, and this cannot tell the two apart. What it can
  // do is make sure the failure is not diagnosed from scratch at 3am.
  if (config.environment === "production" && config.trustProxy.mode === "none") {
    app.log.warn(
      {
        event: "config.trust_proxy_unset",
        effect: "all clients share one rate-limit bucket",
      },
      "TRUST_PROXY is unset: if this API is behind a proxy, every client "
      + "appears as the proxy address and IP rate limits apply to the whole "
      + "deployment at once. Set a hop count or trusted addresses.",
    );
  }

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
