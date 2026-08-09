# Migrations

Source-controlled migrations are the **only** way LAGDA's schema changes.

## Commands

```bash
npm run db:migrate           # apply pending migrations
npm run db:migrate:status    # show applied / pending
```

Both need `DATABASE_URL`. They print the target as `host:port/database` — never
the URL, which carries the password.

## Adding one

1. Create `NNN_description.ts` beside this file, zero-padded so lexical order is
   execution order.
2. Export `up` and, only if the change is genuinely reversible, `down`.
3. **Register it in `runner.ts`.** Migrations are listed explicitly, not
   discovered from disk — discovery breaks once compiled to `dist` and makes
   ordering depend on directory listing.
4. Update the row types in `../schema/` in the same commit. They are
   hand-maintained; a migration and its types changing together is what stops
   them drifting.

## Rules

**Never edit an applied migration.** Once it has run anywhere shared, it is
history. Write a new forward migration instead.

**Migrations are a deployment step, not application startup.** If every API
process migrated on boot, a rolling deploy would have several instances racing
the same schema change at whatever moment a container restarted. Kysely's
migration lock prevents concurrent application, but the discipline matters more.

**`down` is for local development.** Most production migrations are not safely
reversible — one that drops a column cannot restore its data. Production rollback
is a restore-from-backup question.

**Once data exists, breaking changes go expand → deploy → backfill → switch →
contract.** Large backfills run in batches outside a blocking schema transaction.
`NOT VALID` constraints and `CREATE INDEX CONCURRENTLY` are the tools when tables
are big enough to need them.

## Local setup

```sql
CREATE DATABASE lagda_dev;
CREATE DATABASE lagda_test;
```

Copy `.env.example` to `.env`, set `DATABASE_URL` and `DATABASE_TEST_URL`, then
`npm run db:migrate`.

Integration tests refuse to run unless the database name contains `test` — the
harness truncates tables.
