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
    // The identity surface. Missing from this list until the integration sweep
    // found the consequence: a contract of 38 paths, every one assuming a
    // session, and no route in it able to issue one.
    identity: () => stub("identity"),
    limiter: stub("limiter"),
    // Registration-time only: the route reads its limits and path from here.
    upload: () => ({
      path: "/workspaces/:workspaceId/documents/:documentId/upload",
      limits: { maxBytes: 25 * 1024 * 1024, maxPages: 500 },
      resolveContext: () => null,
      dependenciesFor: () => stub("upload.dependencies"),
      // Registers GET /upload-capacity. Absent means the deployment has no
      // capacity constraint to report, and the route is not mounted at all —
      // so leaving it out here dropped a real path from the contract.
      resolveActor: () => null,
    }),
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
      folders: () => stub("workspaces.folders"),
      preparation: () => stub("workspaces.preparation"),
      recipients: () => stub("workspaces.recipients"),
      signingRequests: () => stub("workspaces.signingRequests"),
      // Conditional groups. Each gates one route, and each of these was
      // missing here at one point, so the emitted contract omitted a surface
      // that a configured deployment genuinely serves.
      documentContent: () => stub("workspaces.documentContent"),
      completedArtifact: () => stub("workspaces.completedArtifact"),
      sendSigningRequest: () => stub("workspaces.sendSigningRequest"),
      audit: () => stub("workspaces.audit"),
      organization: () => stub("workspaces.organization"),
      cancelSigningRequest: () => stub("workspaces.cancelSigningRequest"),
      // Missing since migration 058 first added this group: the emitted
      // document has never described the five workflow-template routes, or
      // now the two document-attach routes 059 adds — `create-app.ts`'s
      // `if (workspaces.workflowTemplates !== undefined)` guard silently
      // skipped registering them here, the exact failure this file's own
      // comments already warn about for the groups above. Found while adding
      // 059's routes and confirming they would actually reach this document.
      workflowTemplates: () => stub("workspaces.workflowTemplates"),
    },
  },
});

await app.ready();

const document = app.swagger();
const paths = Object.keys((document as { paths?: Record<string, unknown> }).paths ?? {});

// ── The guard, raised ──────────────────────────────────────────────────────
//
// It used to refuse a document with only health and readiness. That is the right
// instinct and it fired at 2 paths, which is why it could not fire at 38 --
// exactly the partial contract that shipped with no way to sign in.
//
// So it now asserts a FLOOR and a required set. The floor catches a group going
// missing wholesale; the required paths catch the case the floor cannot see, by
// naming the surfaces whose absence is not a smaller contract but a broken one.
const MINIMUM_PATHS = 70;
const REQUIRED_PATHS = [
  "/auth/register",
  "/auth/sessions",
  "/auth/password-resets",
  "/workspaces",
  "/signing-access/bootstrap",
  "/workspaces/{workspaceId}/signing-requests/{signingRequestId}/audit",
  "/workspaces/{workspaceId}/units",
  // The conditional groups. Each mounts only when its dependency is supplied,
  // which is exactly how all three went missing from the emitted contract
  // without anything failing — named here so that cannot recur quietly.
  "/upload-capacity",
  "/workspaces/{workspaceId}/documents/{documentId}/content",
  "/workspaces/{workspaceId}/signing-requests/{signingRequestId}/completed-document",
  "/workspaces/{workspaceId}/signing-requests/stats",
];

const missingRequired = REQUIRED_PATHS.filter(path => !paths.includes(path));

if (paths.length < MINIMUM_PATHS || missingRequired.length > 0) {
  console.error(JSON.stringify({
    level: "error",
    msg: "openapi document is partial -- a dependency group is missing, refusing to write it",
    paths: paths.length,
    minimum: MINIMUM_PATHS,
    missingRequired,
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
