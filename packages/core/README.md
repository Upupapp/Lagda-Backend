# @lagda/core

Pure LAGDA business rules. The layer that answers *"is this allowed?"* without
knowing how anything is stored or transported.

**Backend-only.** The frontend consumes `@lagda/contracts`, never this package.

## Allowed dependencies

`@lagda/contracts` and nothing else. No production dependency has been added.

## Prohibited

HTTP · database · storage · queues · logging · metrics · PDF · sealing ·
environment · feature flags · Node built-ins.

Enforced by ESLint (INV-005) and by `core-purity.test.ts`, which reads this
package's own source and fails on a clock read, a random source, an environment
read, an infrastructure import, `any`, a stray TODO, or a generic status setter.

## Two rules worth knowing before editing

**Time is a parameter.** `isExpired(state, expiresAt, now)` — never an internal
`Date.now()`. A test must give the same answer next decade.

**No generic status setter.** Lifecycle changes go through named actions
(`send`, `decline`, `complete`) so every transition is auditable. `setStatus`
would make the transition table decorative.

## Layout

| Module | Contains |
|---|---|
| `common` | `PolicyResult`, `DomainError`, `Instant`, `assertNever` |
| `signing` | Participant semantics, lifecycle, send/eligibility/completion policies |
| `workspaces` | Ownership invariants |

Subpaths: `@lagda/core/signing`, `/workspaces`, `/common`.

## Outcomes

`PolicyResult` for questions a user could reasonably fail — returns *all*
reasons, never throws. `DomainError` for operations against impossible states —
thrown. The test: could a well-behaved user cause this?

## Testing

Pure, deterministic, no mocks, fixed timestamps. If a core test needs a mock,
the logic is in the wrong layer.

## Documentation

`docs/backend/domain/` — [conventions](../../../Lagda/docs/backend/domain/DOMAIN_CONVENTIONS.md),
state machines, model inventory, and the foundation report.
