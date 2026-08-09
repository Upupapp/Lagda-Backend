# @lagda/core

**Status:** foundation only. No implementation yet — see `../../README.md`.

## Responsibility

Pure domain logic: entities, value objects, invariants, state-transition rules, permission concepts, domain calculations.

## Must not contain

Fastify, PostgreSQL, object storage, email vendors, PDF libraries, queue implementations, HTTP, or filesystem behaviour. Core must run in tests without a server or a database.

## Compile-time dependencies

`@lagda/contracts`
