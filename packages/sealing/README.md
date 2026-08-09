# @lagda/sealing

**Status:** foundation only. No implementation yet — see `../../README.md`.

## Responsibility

Document integrity and finalization behind the DocumentSealer port. The only package permitted to import a PDF library (INV-001).

## Must not contain

Exposing library types outside the package. SealRequest and SealResult are LAGDA-owned structures (INV-008).

## Compile-time dependencies

`@lagda/contracts`, `@lagda/application`
