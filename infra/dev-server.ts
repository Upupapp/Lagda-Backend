// A local API for frontend integration work — FRONTEND-01 §F support.
//
// NOT a deployment target and not a substitute for the real stack. There is no
// PostgreSQL here: this boots `createApp` with in-process dependencies so the
// frontend can exercise REAL HTTP against REAL handlers -- real routing, real
// TypeBox validation, real cookies and CSRF, the real error envelope and the
// real X-Request-Id -- while the persistence layer is absent.
//
//   node --experimental-strip-types infra/dev-server.ts [port]
//
// WHAT IS WIRED
//   /health, /ready            fully real
//   /public/verifications/:id  real route and real handler, backed by a lookup
//                              that finds nothing, so it exercises the
//                              not-found path end to end
//
// WHAT IS NOT, and why it is not a matter of adding a line here:
//   Every other surface needs its dependency group, and the identity surface
//   alone needs seventeen use-case graphs that nothing in the repository has
//   ever constructed -- identity-routes.test.ts stubs all seventeen and says so
//   ("a stub that answered would let a mounted-but-broken route pass as a
//   mounted one"). Wiring them for real is the composition command OD-069 asked
//   for, not a dev-server detail.

import { createApp, loadApiConfig } from "@lagda/api";

const port = Number(process.argv[2] ?? 8787);

const config = loadApiConfig({
  NODE_ENV: "development",
  API_PORT: String(port),
  LOG_LEVEL: "info",
  // The Vite dev server and preview server.
  CORS_ORIGINS: "http://localhost:5173,http://localhost:4173",
});

const app = await createApp({
  config,
  dependencies: {
    databaseHealth: { isReachable: () => Promise.resolve(true) },
    publicVerification: () => ({
      lookup: {
        // Finds nothing. That is deliberate: with no database there is no
        // record to return, and answering with an invented one would be the
        // fake success this whole command exists to avoid. The not-found path
        // is real, and it is what the frontend needs to branch on.
        findByVerificationId: () => Promise.resolve(null),
      },
    }),
  },
});

await app.listen({ port, host: "127.0.0.1" });
console.log(JSON.stringify({ level: "info", msg: "dev api listening", port }));
