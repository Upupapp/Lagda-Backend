# `@lagda/email`

The transactional email transport. One adapter, behind `EmailDeliveryProvider`.

**May contain:** the selected provider's HTTP client, envelope configuration,
and the mapping from a provider response to a LAGDA-owned transport result.

**May not contain:** business logic, template selection, rendering, secret
resolution, or any knowledge of what a notification means. It is handed a
finished `EmailMessage` and returns an outcome.

**Why a package rather than a folder.** `api` and `worker` are both composition
roots and both need to wire this; putting it inside either would make the other
depend on a delivery mechanism. It sits beside `sealing` and `storage` for the
same reason and with the same shape.

**Provider:** Postmark (ADR-037). Replacing it means rewriting `postmark.ts` and
nothing else — no other package names a vendor, and an architecture test holds
that.
