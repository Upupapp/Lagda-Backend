# Promotion handover — `agent/backend`

**Prepared 2026-09-03. HEAD `8b5b984`.**

Written for whoever promotes this branch, so the pre-flight does not have to be
done twice. Nothing here was pushed: this clone has `push=no_push` and
promotion is the supervisor's.

---

## The sweep, with evidence

`git fetch --all --tags --prune`, then compared at commit **and** tree level.

```
upstream-only commits   0
local-only commits      93
containment             origin/master IS contained in HEAD  (fast-forward)
files upstream has      1  — and it is our own deletion, see below
that we do not
```

**"Nothing to merge" is the real outcome.** No merge commit was manufactured.

### Two things that would trip a careless promotion

**The default branch is `master`, not `main`.** The frontend repo uses `main`.
A promotion script written around `main` targets a branch this repo does not
have.

**The one file that looked upstream-only was our own deletion.**
`packages/api/src/security/secret-box.ts` — moved to
`packages/security/src/secret-box.ts` by `489700a`. Proved before merging with:

```sh
git log --oneline --diff-filter=D origin/master..HEAD -- <file>
```

A hit means a deliberate local deletion. Empty would have meant real upstream
work about to be lost.

---

## What is on the branch

93 commits ahead of `origin/master`. **21 are from the 2026-09-03 session**
described below; the other 72 are BACKEND-44 and BACKEND-45 work that predates
it. This document vouches for the gates passing across the whole branch, and
for the intent of the 21 only.

---

## Gates, from a clean checkout

Run in a **detached worktree at the stamped SHA**, not the working directory,
after a fresh `npm ci`:

```
SHA          8b5b984
npm ci       clean
typecheck    0 errors
lint         clean            (lint is also the architecture gate)
unit         2,808 passing
integration  646 passing, 0 failing
build        clean
```

Integration needs a real PostgreSQL:

```sh
./scripts/testing/test-database.sh
DATABASE_TEST_URL="postgres://postgres@127.0.0.1:55433/lagda_test" \
  npm run test:integration
```

---

## One blocker found and fixed in pre-flight

**`npm ci` failed on any clean checkout.** `@lagda/security` was missing from
`package-lock.json`: `489700a` created the package and never updated the lock.

**CI's first step is `npm ci`**, so every run on this branch would have stopped
before a single gate. It was invisible in the working tree, whose incremental
`node_modules` already had the workspace linked — which is precisely why the
gates above were run from a clean install instead.

Fixed in `8b5b984`. The diff is exactly the missing workspace entry.

---

## Defects fixed that matter in production

Each was invisible to a passing unit suite and appeared only against a real
database.

**No upload could ever succeed.** `commitAcceptance` marked an upload accepted
without passing `acceptedArtifactId`, which migration 006's CHECK refuses, so
every upload returned 503. The in-memory upload repository accepted a row
PostgreSQL refuses — a fake looser than the database is a different system. The
fake enforces the constraint now, and a source guard checks the composition
root, which no test executes.

**No completion could ever be recorded.** `recordCompletion` targeted
`ON CONFLICT (signing_request_id)` against `PRIMARY KEY (workspace_id,
signing_request_id)`. PostgreSQL requires an inference target to match a unique
index exactly, so the pipeline's final write threw every time. A guard now reads
every `insertInto(...).onConflict(...)` in the repositories and matches it
against `pg_indexes`; the other eight were already correct.

**RESTRICT violations were reported as internal errors.** `isForeignKeyViolation`
checked SQLSTATE 23503 only. PostgreSQL raises **23001** for `ON DELETE
RESTRICT`, which this schema uses in 31 places — so a caller deleting something
still referenced got a 500 instead of an explainable conflict.

**A signing invitation led nowhere.** Sending minted a grant, sealed a
credential and wrote an invitation carrying a link — and the route that link
points at was not registered in a deployment.

**A bodyless POST was rejected.** A state transition carries no payload, and
most HTTP clients set `Content-Type: application/json` regardless; Fastify's
empty-body error was mapped to "not valid JSON". The client this repo ships
omits the header when there is no body, so only a third-party caller would have
met it.

---

## Deployment surface

A deployment now serves **10 of 11** top-level dependency groups and 11 of 11
workspace sub-groups.

**Still unwired: `publicVerification`** — the anonymous "is this document
genuine" lookup.

`packages/api/src/server/production-composition.test.ts` holds the register of
surfaces that exist in code and cannot be reached in a deployment, and keeps it
honest **in both directions**: it fails if a listed surface has since been
wired, and if a wired one is listed.

---

## What was proven end to end

Driven through the real HTTP API against real PostgreSQL, real object storage
and a real malware scanner — no doubles, no seeded SQL:

workspace → document → **upload** → recipient → field placement → signing
request → mark ready → return to draft → **send** → set and clear a deadline →
recipient opens the emailed link → enter → consent → **submit a signature**.

The workflow then advanced on its own to `completion-ready`, created a
completion run, and recorded seven evidence events from `transaction-created`
to `signature-completed`. An EICAR-carrying PDF was refused with 422 and left
the document with no bytes.

The recipient credential was unsealed from the notification intent exactly as
the delivery worker does it, so the token under test is the one a recipient
receives.

---

## Known gaps

- `publicVerification` is unwired.
- The **completion pipeline does not run**: a request reaches
  `completion-ready` with a run created, and nothing advances it.
- Email delivery is configured but no provider credential is set locally, so
  invitations are written as intents rather than sent.
