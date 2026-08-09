# @lagda/sealing

The PDF sealing adapter. **The only package permitted to import a PDF library.**

## What it does

Implements `DocumentSealer` from `@lagda/application`:

```ts
seal(request: SealRequest): Promise<SealResult>
```

Given a prepared PDF and the values participants submitted, it returns the sealed
document, a separate completion certificate, and a SHA-256 digest of each.

## What it does not do

It does **not** apply a cryptographic signature. No PAdES, no PKCS#7, no X.509,
no HSM, no timestamp authority. The seal scheme is `hash-evidence`: integrity
rests on LAGDA holding the digest of the exact distributed bytes plus the
evidence log.

It also has no storage, no database, no transaction, no clock and no randomness.
Bytes come in as an argument and go out as a return value.

## Layout

```
src/
  index.ts                  the public surface: one class, six error types
  node-document-sealer.ts   the implementation
  errors/                   LAGDA-owned failures, each with a code and retryable
  internal/                 private collaborators — NOT exported
    digest.ts               the only node:crypto in the backend
    fields.ts               the only place the PDF Y-axis flip happens
    certificate.ts          the completion certificate renderer
```

`internal/` is not exported, and `package.json` declares a single `.` entry
point so a deep import cannot reach it. Exporting `hashDocument` separately would
let a caller hash a document without sealing it — two operations that must never
disagree.

## Rules

1. **pdf-lib stays here.** Enforced by lint and by
   `tests/architecture/sealing.test.ts`.
2. **No pdf-lib type crosses the seam.** `SealRequest`/`SealResult` are
   LAGDA-owned; document bytes are `Uint8Array`, never Node's `Buffer`.
3. **One method on `DocumentSealer`.** Every additional one is a call site a
   future remote signer must reproduce.
4. **Hash after every byte-changing step.** `signedDocumentHash` must equal the
   digest of the bytes actually returned.
5. **Stay deterministic.** No clock, no randomness, no environment reads.
6. **Never call this inside a database transaction.** It is slow, external, and
   cannot be rolled back.

## Tests

```bash
npx vitest run packages/sealing tests/architecture/sealing.test.ts
```

42 tests, no database required. Documentation lives in
`docs/backend/sealing/` in the frontend repository.
