# Implementing `expired` needs a THIRD unpoliced index table

**Status:** designed, not built. The one open decision is architectural and is
named at the bottom.

**Date:** 2026-08-31. Draft migration kept beside this file as
`signing-request-expiry-migration.draft.ts` — written, applied against real
PostgreSQL, and reverted.

---

## What the repo already decides

Three questions looked open. None is.

| question | answered by |
|---|---|
| deadline measured from what? | `ExpirationSettings` in `transaction-detail.ts`: per-request, **opt-in** (`enabled`), an **absolute** `expiresAt`. No workspace default, no duration-from-send. |
| which states can expire? | `@lagda/core`'s `TRANSITIONS`: `expire` out of `sent` and `partially-completed`, deliberately **not** out of `completion-ready` — "a deadline that passes after the last signature does not un-sign anything". |
| stored state, or derived? | The product's own fixtures: `status: "expired"` sits beside `isExpired: true`, and a later row carries `status: "archived"` with `isExpired: true`. `expired` is a stored state that can be superseded. |

So the vocabulary, the edges and the storage model are settled. The missing
piece is the transition, and that is where the architecture bites.

## Why this is not a small feature

A deadline passes with nobody watching. Something must sweep. **The sweep
cannot read `signing_requests`.**

Measured against the running database:

```
signing_requests   rls: true   policies: tenant_isolation, signing_access_request_read, recipient_ceremony_scope
                               tenant_isolation = (workspace_id = lagda_current_workspace())
workspaces         rls: true   policies: tenant_isolation, member_workspace_read
```

`runGlobal` establishes no workspace context, so `tenant_isolation` matches
nothing. A global sweep over `signing_requests` returns zero rows — not by
accident, by design. And `workspaces` is policed too, so the sweep cannot even
enumerate tenants and visit them one at a time.

The two existing cross-tenant reads both work the same way:

```
signing_workflow_advance_intents   rls: false   policies: (none)
notification_dispatch_index        rls: false   policies: (none)
```

`GlobalUnitOfWork` states the rule and its own exceptions:

> One of **TWO** exceptions to "global mode is not a route to workspace data",
> and both are narrow enough to state exactly: the table each reads carries no
> policy because a cross-tenant scan cannot have one without `BYPASSRLS`, and
> each returns IDENTIFIERS ONLY.

So expiry needs a **third** unpoliced index table —
`signing_request_expiry_index`, holding `(workspace_id, signing_request_id,
expires_at)` and nothing else — written when a deadline is set, changed or
cleared, and when a request leaves a live state.

**That is a decision about a stated invariant, not a detail.** "Exactly two"
becomes "three", and the sentence naming them has to be rewritten. It should be
taken deliberately rather than discovered in a diff.

## The alternative, and why it was rejected

Derive expiry at read time and never store it: no sweep, no table. Rejected
because the stored `state` would stay `sent` while the API reported `expired`,
so the database and the wire would disagree about whether a document still
accepts signatures. For a signing product that is a claim about legal validity,
and it is the exact defect class this codebase keeps closing.

Transitioning lazily on read was rejected for a second reason: it makes a read
perform a write, which an auditor's read-only guarantee must not do.

## The build, if the third exception is accepted

1. **Migration** — the draft beside this file: `expires_at`, `expired` in the
   state CHECK, two constraints, a partial index. Plus the index table.
2. **Ports** — `SigningRequestExpiryIndexRepository` on `GlobalUnitOfWork`
   (`listDue({ now, limit })`, identifiers only); `setExpiry` and `expireIfDue`
   on the scoped repository.
3. **Use cases** — `setSigningRequestExpiry` (writes the row and the index
   entry in one transaction) and `expireDueSigningRequests` (mirrors
   `reconcileSigningWorkflow`: read refs globally, then `runForWorkspace` each).
4. **Contract** — `expiresAt` on the wire; remove `expired` from
   `SIGNING_REQUEST_STATES_NOT_YET_REACHABLE`. The architecture guard added in
   `34343d9` **fails until that entry is removed**, which is deliberate.
5. **Route** — setting and clearing a deadline.
6. **Worker** — a cron beside `CLEANUP_CRON` and `DISPATCH_CRON`.

## Two constraints from the draft worth keeping

**The deadline constraint is NOT biconditional**, unlike `sent_at` and
`completed_at`:

```
expired => expires_at is not null          ENFORCED
expires_at is not null => expired          FALSE, and must be
```

A future deadline is the ordinary case for a live request. Writing it
biconditionally would expire a request the moment a deadline was set.

**`down` refuses rather than reverting.** An expired request cannot be narrowed
into the old vocabulary without choosing a state for it, and every choice claims
something the request did not do.
