# @lagda/api

**Status:** foundation only. No implementation yet — see `../../README.md`.

## Responsibility

Fastify HTTP process and composition root. Routes authenticate, validate, authorize, build use-case input, invoke, and map the result.

## Must not contain

Primary domain logic in route handlers (INV-004). As a composition root it may construct adapters and inject them; that is wiring, not a business-layer dependency.

## Compile-time dependencies

`@lagda/contracts`, `@lagda/core`, `@lagda/application`, `@lagda/db`, `@lagda/sealing`, `@lagda/storage`
