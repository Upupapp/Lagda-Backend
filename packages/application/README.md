# @lagda/application

Business orchestration. Answers *what the system does*, without knowing how PostgreSQL, S3, email, Fastify, PDF libraries or queues do it.

## Depends on

`@lagda/core` · `@lagda/contracts`. No external production dependencies.

## Must not depend on

Fastify · PostgreSQL · object storage · queues · PDF libraries · email vendors · `process.env` · and LAGDA's own `@lagda/db`, `@lagda/storage`, `@lagda/sealing`.

That last group is the one that catches people: those packages *implement* the ports declared here, so importing them inverts the dependency the architecture is built on. ESLint enforces it; only the composition roots (`api`, `worker`) may import both sides.

## Rules

**Explicit dependencies.** Constructor injection, no container, no service locator, no globals. Each use case receives only the ports it needs.

**No hidden time or randomness.** `Clock` supplies "now"; generators supply IDs.

**Workspace scope comes from the actor**, never from a request body.

**Errors carry no HTTP semantics** — a `category`, which BACKEND-11 maps to a status.

**Nothing irreversible before validation.** No external side effect inside a transaction.

## Layout

| Module | Contains |
|---|---|
| `common/ports` | `Clock`, `TransactionManager`, repositories, ID generators, `DocumentSealer` |
| `common/errors` | Typed application errors with categories |
| `common/context` | `UserActor`, `RecipientActor`, `SystemActor`, `ObservedRequestEvidence` |
| `workspaces` | `CreateWorkspace`, `GetWorkspaceMember` — foundation implementations |
| `test-support` | Fakes. Not exported from the package entry point. |

Subpaths: `@lagda/application/ports`, `/errors`, `/workspaces`.

## Testing

Instantiate directly with fakes. No database, no server, no network. Fakes respect tenancy exactly as the real ports demand — a permissive fake would let a cross-tenant bug pass its own test.

## Documentation

`docs/backend/application/` — conventions, ports, use-case catalog, foundation report.
