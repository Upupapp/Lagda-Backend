// OpenAPI emitter — the contract, as a build artifact.
//
//   node --experimental-strip-types infra/emit-openapi.ts [outfile]
//
// `createApp` already registers @fastify/swagger for generation only. This
// boots the app far enough for the plugin to walk the registered route schemas,
// writes the document, and closes.
//
// NO ROUTE IS EXPOSED. OD-029 -- whether to serve the document over HTTP --
// stays open and is not prejudged by this: a build artifact is not an endpoint.
//
// The document is what the frontend generates its client from, so a route whose
// schema changes shows up there as a compile error rather than as a runtime
// surprise. That is the entire point of emitting it.

import { writeFileSync } from "node:fs";
import { createApp, loadApiConfig } from "@lagda/api";

const outfile = process.argv[2] ?? "openapi.json";

// Boot-only configuration. Nothing here reaches a real service: the port is
// never listened on, and the only dependency the app needs to become ready is a
// database-health probe, which is answered without a database.
const config = loadApiConfig({
  NODE_ENV: "test",
  API_PORT: "8080",
  LOG_LEVEL: "silent",
});

/**
 * A registration-time placeholder.
 *
 * Route modules are REGISTERED here, never served, so these objects exist only
 * to satisfy composition. Any actual call throws instead of returning a
 * plausible-looking value -- a stub that quietly answers would let this script
 * emit a document describing behaviour nobody verified.
 */
function stub<T>(name: string): T {
  return new Proxy({}, {
    get(_target, property) {
      // Must not look like a promise, or `await` on it would hang.
      if (property === "then") return undefined;
      return () => {
        throw new Error(
          `openapi emitter: ${name}.${String(property)}() was called. ` +
          `This script registers routes to read their schemas; it does not serve them.`,
        );
      };
    },
  }) as T;
}

// Routes register only when their dependency group is supplied -- absent means
// "not composed", which is how the app keeps an unwired route from looking
// mounted. So every group has to be present here or the emitted contract is
// silently partial: with health and readiness alone it describes 2 paths.
const app = await createApp({
  config,
  dependencies: {
    databaseHealth: { isReachable: () => Promise.resolve(true) },
    sessions: stub("sessions"),
    limiter: stub("limiter"),
    signingAccess: () => stub("signingAccess"),
    publicVerification: () => stub("publicVerification"),
    signingCeremony: () => stub("signingCeremony"),
    signingSubmission: () => stub("signingSubmission"),
    signingDecline: () => stub("signingDecline"),
    workspaces: {
      create: () => stub("workspaces.create"),
      list: () => stub("workspaces.list"),
      workspace: () => stub("workspaces.workspace"),
      invitations: {
        management: () => stub("workspaces.invitations.management"),
        redemption: () => stub("workspaces.invitations.redemption"),
      },
      members: {
        administration: () => stub("workspaces.members.administration"),
        access: () => stub("workspaces.members.access"),
      },
      contacts: () => stub("workspaces.contacts"),
      documents: () => stub("workspaces.documents"),
      preparation: () => stub("workspaces.preparation"),
      recipients: () => stub("workspaces.recipients"),
      signingRequests: () => stub("workspaces.signingRequests"),
      sendSigningRequest: () => stub("workspaces.sendSigningRequest"),
      cancelSigningRequest: () => stub("workspaces.cancelSigningRequest"),
    },
  },
});

await app.ready();

const document = app.swagger();
const paths = Object.keys((document as { paths?: Record<string, unknown> }).paths ?? {});

if (paths.length <= 2) {
  console.error(JSON.stringify({
    level: "error",
    msg: "openapi document has only health/readiness paths -- a dependency group is missing, refusing to write a partial contract",
    paths,
  }));
  await app.close();
  process.exit(1);
}

writeFileSync(outfile, JSON.stringify(document, null, 2) + "\n");

console.log(JSON.stringify({
  level: "info",
  msg: "openapi document written",
  outfile,
  paths: paths.length,
}));

await app.close();
