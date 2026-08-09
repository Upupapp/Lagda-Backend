# @lagda/application

**Status:** foundation only. No implementation yet — see `../../README.md`.

## Responsibility

Use cases and orchestration, plus the abstract ports they depend on (repositories, ObjectStorage, DocumentSealer, NotificationPublisher, Clock, IdGenerator, TransactionManager).

## Must not contain

Concrete infrastructure libraries. Use cases depend on ports this package owns; the composition root supplies the implementations.

## Compile-time dependencies

`@lagda/contracts`, `@lagda/core`
