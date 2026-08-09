# @lagda/db

PostgreSQL persistence. Infrastructure only.

## DO NOT import this package from `@lagda/core` or `@lagda/application`

It **implements** the ports they declare. Importing it from either inverts the
dependency the architecture is built on and creates a cycle. ESLint enforces it;
the composition roots (`api`, `worker`) wire it up.

## Stack

PostgreSQL 16 · Kysely · `pg` · Kysely's migrator. Rationale in
[ADR-003](../../../Lagda/docs/backend/adr/ADR-003-postgresql-query-layer.md).

## Local setup

```sql
CREATE DATABASE lagda_dev;
CREATE DATABASE lagda_test;
```

```bash
cp .env.example .env      # set DATABASE_URL and DATABASE_TEST_URL
npm run db:migrate
npm run test:integration
```

## Commands

| Command | Purpose |
|---|---|
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:migrate:status` | Applied / pending |
| `npm test` | Unit tests — **no database needed** |
| `npm run test:integration` | Real PostgreSQL required |
| `npm run check:full` | Everything, including the database |

`npm test` stays offline on purpose. Requiring a database for every quick local
run is how people stop running tests.

## Layout

| Module | Contains |
|---|---|
| `config` | Validated configuration. **The only place that reads `process.env`** |
| `client` | Pool and lifecycle. Importing it connects to nothing |
| `schema` | Hand-maintained row types. Not contracts, not domain entities |
| `migrations` | Migration files, runner, and their README |
| `transactions` | The application's `TransactionManager`, PostgreSQL-backed |
| `mapping` | Explicit row ↔ domain conversion |
| `repositories` | Representative adapters (BACKEND-08 owns these properly) |
| `testing` | Integration harness |

## Transactions

`createTransactionManager(db)` implements the application port. The Kysely
transaction is carried inside an opaque context behind a symbol, so application
code cannot reach it — and `unwrapTransaction` throws if handed a context this
manager did not create, because silently starting an independent transaction
would break the atomicity the caller believes it has.

## Tenancy — read this before writing a query

**Two layers, both required.**

1. Every workspace-owned query is scoped **in SQL**. Fetching by ID and comparing
   the workspace afterwards still reads another tenant's row into memory.
2. **Row Level Security** (ADR-004) catches the query that *forgot* — the bug
   repository scoping cannot catch, because the forgetting happens there.

**Every query, including reads, runs inside a tenant transaction.** RLS context
is transaction-local (`SET LOCAL`), so a read issued on a pooled connection has
no context and returns nothing:

```ts
await transactions.runForWorkspace(workspaceId, tx =>
  memberships.findInWorkspace(workspaceId, memberId, tx));
```

If a query mysteriously returns empty, check that it is inside
`runForWorkspace` before checking anything else.

`runGlobal` exists for genuinely global data — user accounts, sessions. It sets
no tenant context, so tenant tables are invisible from it. That is deliberate:
missing context means **nothing**, never everything.

There is no unscoped lookup for a tenant-owned resource, no optional workspace
parameter, and no bypass flag. Privileged cross-tenant access, when it is ever
needed, will be a separate named capability.

## Prohibited

`process.env` outside `config/` · SQL built by string concatenation · dynamic
identifiers from a request · `err.message` inspection for error classification —
use SQLSTATE · document bytes in the database · schema mutation inside a test.
