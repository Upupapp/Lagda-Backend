# @lagda/contracts

The canonical contract boundary shared by the LAGDA frontend and backend.

```
        @lagda/contracts
          ↑           ↑
      frontend     backend
```

Not frontend→backend, and not two copies kept in step by hand. When both sides
must agree on a serialized shape, the agreement lives here.

**Status:** partial. Only `verification` and the primitives it needs are
extracted. 19 of the 27 frontend model files are MIXED — domain and UI grown
together — and each needs splitting before extraction. See
`docs/backend/contracts/CONTRACT_EXTRACTION_REPORT.md`.

---

## What belongs here

A type belongs here when the frontend and backend must agree on its **serialized
or semantic shape**:

- identifiers · status values · request DTOs · response DTOs
- error codes · pagination primitives · public domain references
- verification payloads · recipient-facing state · shared permission identifiers

The test is whether it crosses, or defines something that crosses, a process
boundary. Sharing a name with something in the other application is not enough.

## DO NOT ADD

- **UI state** — `isExpanded`, `selectedTab`, `sortDir`, wizard step, sidebar
  state, hover, drag, display colours, avatar fallbacks
- **Database models** — rows, ORM entities, column mappings, persistence keys
- **Infrastructure types** — Fastify, `pg`, `pg-boss`, `pdf-lib`, AWS SDK, Pino
- **Node-only APIs** — `node:crypto`, `node:fs`, `node:path`, `Buffer`
- **Browser/framework types** — React, `ReactNode`, `CSSProperties`, DOM events
- **Backend application ports** — `DocumentSealer`, repositories. Those belong to
  `@lagda/application`; this package is for *cross-client* contracts, not every
  reusable backend type
- **Secrets in responses** — password hashes, session secrets, reset or OTP
  tokens, signing access tokens, storage keys
- **Non-JSON values** — `Date`, `BigInt`, `Map`, `Set`, class instances
- **Compatibility fields "just in case"** — no `legacyX?`, `newX?` without a real
  requirement

ESLint enforces the infrastructure and framework bans. The rest is review.

---

## Usage

```ts
import { PublicVerificationResponseSchema } from "@lagda/contracts/verification";
import type { WorkspaceId, VerificationId } from "@lagda/contracts";
import { Value } from "@sinclair/typebox/value";

if (Value.Check(PublicVerificationResponseSchema, input)) { /* typed */ }
```

Subpaths — `.`, `./ids`, `./common`, `./verification` — let a consumer import one
domain without pulling the rest. Deep paths into `src/` are not exported.

## Schema strategy

TypeBox, schema-first: the schema is written and the type is **derived** from it
with `Static`, so a type can never disagree with its validator. Rationale in
`docs/backend/adr/ADR-002-contract-runtime-schema-strategy.md`.

Two conventions worth knowing:

- **Requests reject unknown properties** (`additionalProperties: false`).
  Responses stay permissive to additive fields.
- **Never use `format`.** TypeBox rejects unregistered formats while Ajv ignores
  them, so one schema would behave differently in the two validators this
  package must satisfy. Use `pattern`.

## Browser compatibility

The frontend is a first-class consumer. No Node built-ins, no environment reads,
no side effects on import — importing this package must not connect to anything,
mutate a global, or log. TypeBox has zero runtime dependencies.

---

## Before changing a shared contract

1. Is the value serialized? Changing a status string is an **API change**, not a
   refactor.
2. Is the change backward compatible? Additive is usually safe; removing or
   renaming is not.
3. Who reads it, and who writes it? A field nobody consumes should not be here.
4. Does a runtime schema need updating alongside the type?
5. Do fixtures or tests depend on the shape?
6. Does stored data need to remain interpretable — evidence records especially?
7. Does the frontend compile against it?

Mark removals with `@deprecated` and a replacement before deleting.
