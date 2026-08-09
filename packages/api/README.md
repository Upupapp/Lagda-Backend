# @lagda/api

The HTTP adapter and the composition root. Fastify lives here and nowhere else.

## Rules

1. **No domain logic in routes.** A handler does: validated input → trusted
   context → application use case → map result → response.
2. **No SQL in routes.** Route modules cannot import `@lagda/db`, `kysely` or
   `pg` — ESLint blocks it by directory. The composition root may.
3. **No sealing or storage in routes.** Same rule, same reason.
4. **Every route declares a response schema.** Fastify serializes through it, so
   an undeclared field cannot escape. This is a security boundary, not
   documentation — TypeScript cannot provide it.
5. **Contracts come from `@lagda/contracts`.** No route-local duplicates.
6. **One error envelope.** `reply.send(error)` is a bug; everything goes through
   `mapError`.
7. **Routes take capabilities as parameters.** No production singleton is
   imported into a route module, so every route is testable with fakes.
8. **No `process.env` outside `config/`.**
9. **Startup never runs migrations.**

## Layout

```
src/
  app/
    create-app.ts       Fastify factory. Does NOT listen, does NOT ready.
    dependencies.ts     The typed dependency object. May import @lagda/db.
  config/               The only place process.env is read.
  context/              Server-observed request metadata, with provenance.
  errors/               The one envelope builder and the Ajv translator.
  logging/              Pino options, redaction, explicit serializer allowlists.
  routes/               health, readiness. No DB, no sealing, no storage.
  server/
    start-server.ts     Reads env, builds infra, listens, installs shutdown.
    shutdown.ts         Idempotent, bounded, HTTP before database.
    main.ts             The executable.
  index.ts              Re-exports only. Importing this starts nothing.
```

## Development

```bash
npm run dev:api
```

Requires `DATABASE_URL` — startup performs a bounded connectivity check and
refuses to listen if PostgreSQL is unreachable.

## Production

```bash
npm run build
npm run start:api
```

Runs compiled JavaScript. Responds to SIGTERM, does not daemonize, logs JSON to
stdout — compatible with PM2 and container supervision.

## Endpoints

| Path | Purpose | Database |
|---|---|---|
| `GET /health` | Liveness. Is the process alive? | **No** |
| `GET /ready` | Readiness. Should it receive traffic? 503 when not. | Yes |

No product endpoints exist yet. That is deliberate.

Documentation: `docs/backend/api/` — API_BOOTSTRAP, REQUEST_CONTEXT,
ERROR_MAPPING, TRUST_PROXY.
