# @lagda/storage

**Status:** foundation only. No implementation yet — see `../../README.md`.

## Responsibility

Object-storage port implementation over S3-compatible storage.

## Must not contain

Vendor-specific behaviour leaking into application code. Private documents must never become publicly readable objects.

## Compile-time dependencies

`@lagda/contracts`, `@lagda/application`
