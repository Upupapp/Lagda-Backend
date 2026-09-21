# LAGDA eSignature — Backend

> **Implementation status: architecture and tooling foundation only.**
> No application endpoints exist. No authentication, documents, signing,
> persistence, queue, storage, email, or PDF processing is implemented.
> The backend is **not** usable and **not** production-ready.

Established by BACKEND-01. The architectural rules it follows come from
BACKEND-00.

---

## Requirements

- **Node.js 24** (`.nvmrc` pins `24`; `engines` requires `>=24 <25`)
- **npm** — the package manager, using npm workspaces

Nothing else for the default gate: `npm run check` needs no database, no cloud
account, no secrets and no running frontend.

**The integration suite is the exception.** `npm run test:integration` needs a
real, multi-connection PostgreSQL — see [Integration tests](#integration-tests).
It is not part of `check` or `ci` for that reason.

## Install

```bash
npm ci        # lockfile-respecting; use this in CI and for a clean checkout
npm install   # when adding or changing dependencies
```

## Commands

| Command | What it does |
|---|---|
| `npm run typecheck` | Typechecks every package plus tests and config. Fails on any type error. |
| `npm run lint` | ESLint 9 across all packages. **Also the architecture gate** — see below. |
| `npm run lint:fix` | Same, with autofix. Never run in CI. |
| `npm test` | Vitest, single run. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run build` | Compiles all packages to `dist/`. Fails on type errors. |
| `npm run clean` | Removes build output. Touches nothing else. |
| `npm run check` | `typecheck` → `lint` → `test`. The local gate. |
| `npm run ci` | `check` plus `build`. What CI runs. |
| `npm run test:integration` | The suites that need real PostgreSQL. Not in `check` — see below. |
| `npm run test:tenancy` | Just the cross-workspace isolation suite. |
| `npm run check:full` | `check` plus `test:integration`. |
| `npm run test:coverage` | Vitest with coverage. |
| `npm run db:migrate` | Applies migrations to `DATABASE_URL`. Up only. |
| `npm run db:migrate:status` | Reports which migrations have run. |
| `npm run signing:reconcile` | Applies outstanding signing-workflow advances once (e.g. declines recorded before declines advanced immediately). Idempotent. |
| `npm run openapi:emit` | Regenerates `openapi.json` from the contracts. |
| `npm run dev:api` / `npm run dev:worker` | The two processes, watched. |
| `npm run start:api` / `npm run start:worker` | The same, from `dist/`. |
| `npm run preflight` | Checks a deployment's configuration before it boots. |

`typecheck` and `build` share the same mechanism (TypeScript project
references); `typecheck` forces a full re-check while `build` is incremental.

`db:migrate` applies migrations and has **no `down`**. Reverting means calling a
migration's own `down` and deleting its `kysely_migration` row by hand — which is
deliberate friction: several migrations refuse to revert at all, because
narrowing a state vocabulary would mean choosing a state for rows that have one.

### No formatter

The LAGDA frontend has no formatter and explicitly rejected Prettier. The
backend follows that convention rather than introducing a second, conflicting
one. `.editorconfig` carries the shared whitespace rules. If a formatter is
adopted, it should be adopted in both repositories at once.

---

## Architecture

The authoritative documents live in the frontend repository, which is where
BACKEND-00 established them:

- `docs/backend/architecture.md` — package boundaries, tenancy, the sealing seam
- `docs/backend/ARCHITECTURE_INVARIANTS.md` — the rules, and what enforces each
- `docs/backend/ENFORCEMENT_MATRIX.md` — which invariant is executable today
- `docs/backend/OPEN_DECISIONS.md` — what is deliberately unresolved
- `docs/backend/adr/ADR-001-node-typescript-modular-monolith.md`

Their split across two repositories is tracked as **OD-008**.

### Package map

| Package | Responsibility |
|---|---|
| `@lagda/contracts` | Shared API and domain boundary contracts. No infrastructure. |
| `@lagda/core` | Pure domain logic. Runs in tests without a server or database. |
| `@lagda/application` | Use cases, and the ports they depend on. |
| `@lagda/db` | PostgreSQL persistence and workspace-scoped data access. |
| `@lagda/sealing` | Document finalization behind `DocumentSealer`. The only package allowed a PDF library. |
| `@lagda/storage` | Object-storage adapter. |
| `@lagda/api` | Fastify HTTP process. Composition root. |
| `@lagda/worker` | Background job process. Composition root. |

Each package has its own `README.md` stating what it may and may not contain.

### Dependency direction

```
                    contracts
                        ↑
                      core
                        ↑
                   application
                  ↗     ↑     ↖
                db   sealing  storage
                  ↖     ↑     ↗
                   api / worker
```

Arrows are **compile-time** dependencies. Read the bottom row carefully: `api`
and `worker` are composition roots, so they import both application ports *and*
the concrete adapters in order to wire them together. That is dependency
injection, not a business-layer dependency — application code never imports
`db`, `sealing`, or `storage` directly.

The graph is enforced twice: `package.json` workspace dependencies and
TypeScript project references must agree, and there must be no cycles. Both are
asserted in `tests/architecture/workspace.test.ts`.

### Lint is the architecture gate

`npm run lint` fails when a package imports something its layer may not depend
on — PDF libraries outside `sealing`, infrastructure inside `core`, frameworks
inside `contracts`. CI runs it as a hard gate.

---

## Tests

Vitest, Node environment, files named `*.test.ts`.

Workspace packages resolve to `src`, not `dist`, so tests never require a build
first and a stale `dist/` cannot make them pass against code that no longer
exists.

Layers separate by directory as they arrive:

```
tests/architecture/   structural rules
tests/contracts/      the published contract's own shape
tests/integration/    cross-adapter composition against real PostgreSQL
tests/security/       cross-workspace access, privilege escalation, CSRF, uploads
tests/e2e/            complete backend flows
```

`architecture`, `contracts` and `integration` exist; the rest are created by the
commands that need them rather than pre-made as empty folders. Most integration
suites live beside the code they exercise as `*.integration.test.ts`, and
`tests/integration/` holds the ones that wire two adapters together and so
belong to neither package.

### Integration tests

They need a **real, multi-connection PostgreSQL**, and no in-process substitute
will do. This is not fussiness: a single-connection stand-in cannot run a
request path that fans out, and a fake enforces no constraint at all. Both
limits have hidden real defects here — an upload that could never succeed, and a
completion that could never be recorded — each invisible to a green unit suite.

```bash
./scripts/testing/test-database.sh    # provisions a cluster; idempotent
DATABASE_TEST_URL="postgres://postgres@127.0.0.1:55433/lagda_test" \
  npm run test:integration
```

The script finds PostgreSQL even when it is not on `PATH` — Postgres.app ships
under `/Applications` and adds nothing to the shell, which is how one concludes
a machine has no PostgreSQL when it has one.

Two rules the harness enforces, both worth knowing before they surprise you:

- **The database name must contain `test`.** It truncates between cases, and an
  unlucky environment variable must not be able to point that at a development
  database.
- **Migrations run automatically.** There is no separate step, and the suite
  works from an empty database.

No coverage threshold is set. Thresholds become meaningful once real domain code
exists, and setting one now would only invite tests written to satisfy a number.

---

## Relationship to the frontend

The backend does **not** import frontend source (INV-006), and a test asserts it.
Shared contracts will flow through `@lagda/contracts`, consumed by both sides —
extraction is BACKEND-02's job, not something to anticipate here.
