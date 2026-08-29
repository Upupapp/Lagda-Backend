# TRUST_PROXY

How much of the `X-Forwarded-For` chain the API believes when it decides what
`request.ip` is.

This document exists because two places send you here — the config error you
get for `TRUST_PROXY=true`, and `.env.example` — and neither could, until now,
be followed.

## What reads `request.ip`

Two things, and they fail differently when it is wrong.

**Rate limiting.** Every IP-scoped policy buckets by `request.ip`:
`auth.signin.ip` (5/minute), `auth.register.ip`, `auth.reset.request.ip`,
`mfa.verify.ip`, and the recipient-facing signing policies.

**Signing evidence.** The address recorded against a signature. This one is
durable and is the reason `TRUST_PROXY=true` is refused rather than
discouraged.

## Choosing a value

| In front of the API | Value |
|---|---|
| Nothing — clients reach it directly | leave unset (or `false`) |
| Exactly one reverse proxy or load balancer | `1` |
| A CDN in front of a load balancer | `2` |
| Proxies at known fixed addresses | `10.0.0.1,10.0.0.2` |

Count the hops that append to `X-Forwarded-For` **between the client and this
process**, not the number of network devices.

`TRUST_PROXY=true` is rejected at boot. It trusts the entire chain, and the
chain is attacker-controlled at its left-hand end: a client sends
`X-Forwarded-For: 1.2.3.4` and the API believes it. That means choosing the IP
written into signing evidence, and choosing which rate-limit bucket to spend.

## Getting it wrong, in both directions

**Too low** — unset, but deployed behind a proxy.

`request.ip` is the *proxy's* address for every request. All clients share one
rate-limit bucket, so `auth.signin.ip` at 5/minute becomes a cap of five
sign-ins per minute **for the entire deployment**. It presents as users being
unable to sign in during ordinary traffic, with no error anywhere except
`429`s. Signing evidence records the proxy for every signature.

The API logs a warning at boot in production when `TRUST_PROXY` is unset, for
exactly this reason. It is a warning and not a refusal because a directly
reached API is a legitimate deployment and the process cannot tell the two
apart.

**Too high** — more hops trusted than exist.

The client controls the entries beyond the real ones, so it picks its own
`request.ip`: a fresh rate-limit bucket per request, and a forged address in
signing evidence.

Too low is an availability failure. Too high is an integrity failure. Neither
announces itself.

## Verifying it

Send one request from a known client address and read the request log:

```
{"event":"...","req":{"requestId":"req_...","method":"POST","url":"/auth/sessions"}}
```

`request.ip` should be the **client's** address, not the proxy's. If it is the
proxy's, the value is too low. If a request carrying a handwritten
`X-Forwarded-For: 203.0.113.9` reports `203.0.113.9`, the value is too high.

Check it after any change to what sits in front of the API. A CDN added in
front of an existing load balancer silently adds a hop.
