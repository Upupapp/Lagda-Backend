# `expired` — designed, decided, and built

**Status:** SHIPPED. Backend `a25c7c6`, frontend `a256a53`, on top of the design
recorded in `95c1313`.

This file is kept because the DECISION it records outlives the code.

## The decision

Implementing `expired` required a **third** unpoliced index table, and
`GlobalUnitOfWork` documented its exceptions as "one of TWO". The owner approved
the third on 2026-08-31.

It was raised rather than taken quietly because the sentence naming those
exceptions is an invariant, and rewriting an invariant in a diff is how one
stops being one.

## Why no smaller design existed

Measured against the running database:

```
signing_requests   rls: true   tenant_isolation = (workspace_id = lagda_current_workspace())
workspaces         rls: true   tenant_isolation, member_workspace_read
signing_workflow_advance_intents   rls: false   (none)
notification_dispatch_index        rls: false   (none)
```

A deadline passes with nobody watching, so something must sweep. `runGlobal`
sets no workspace context, so a cross-tenant scan of `signing_requests` returns
zero rows — by design, not by accident. `workspaces` is policed too, so the
sweep cannot even enumerate tenants and visit them one at a time. Every
cross-tenant read in this system is an unpoliced index of identifiers, and
expiry needed one for the same reason.

**Deriving expiry at read time was rejected.** The stored `state` would stay
`sent` while the API reported `expired`, so the database and the wire would
disagree about whether a document still accepts signatures. Transitioning
lazily on read was rejected for a second reason: it makes a read perform a
write, which an auditor's read-only guarantee must not do.

## What the repo decided, not us

| question | answered by |
|---|---|
| deadline measured from what? | `ExpirationSettings`: per-request, opt-in, an absolute instant |
| who may set one? | `avail("edit-expiration", isActive && canPrepare)` — byte for byte the product's rule for `cancel`, so `signing-request.cancel` is the capability |
| which states? | core's `TRANSITIONS`: `sent` and `partially-completed`, never `completion-ready` |
| stored or derived? | the product's fixtures: `status: "expired"` beside `isExpired: true` |

## The two things most likely to be broken by a later change

**The deadline constraint is deliberately NOT biconditional**, unlike `sent_at`
and `completed_at`:

```
expired => expires_at is not null       ENFORCED
expires_at is not null => expired       FALSE, and must be
```

A future deadline is the ordinary case for a live request. "Fixing" the
asymmetry would expire a request the moment a deadline was set.

**The index is maintained by a TRIGGER, never by application code.** `setExpiry`
writes only the request row. Adding an index write beside it would create a
second writer for one fact, and the second writer is the one that drifts.
