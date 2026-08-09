# @lagda/worker

**Status:** foundation only. No implementation yet — see `../../README.md`.

## Responsibility

Background job consumer process and composition root. Workers call application use cases.

## Must not contain

Reimplementing business behaviour that belongs in a use case.

## Compile-time dependencies

`@lagda/contracts`, `@lagda/core`, `@lagda/application`, `@lagda/db`, `@lagda/sealing`, `@lagda/storage`
