# @lagda/db

**Status:** foundation only. No implementation yet — see `../../README.md`.

## Responsibility

PostgreSQL persistence: repository implementations, migrations, persistence mapping, workspace-scoped data access, transaction support.

## Must not contain

Business logic. Persistence records are not the domain model and are not automatically the public API contract.

## Compile-time dependencies

`@lagda/contracts`, `@lagda/core`, `@lagda/application`
