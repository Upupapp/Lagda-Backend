# Backend sweep scripts

Mechanical checks that answer questions a reviewer cannot hold in their head.

## `unwired.mjs`

Finds exported functions, classes and consts with **no production reference
outside their own file**.

```
node scripts/sweep/unwired.mjs packages
```

Output is `UNREFERENCED` (nothing at all) or `TESTS-ONLY` (tests, but no
production caller).

**Why it exists.** The integration sweep found six route registrars written,
exported, and referenced by nothing — which shipped a contract with 38 paths and
no way to sign in. Nothing failed, because every piece was individually correct
and none was connected. Running this would have found it in one line.

**It is deliberately crude.** It counts textual references, so it is noisy: 283
findings, most of them pure domain helpers whose only caller is a test. That is
the right trade. A precise checker that missed `registerAuthRoutes` would be
worse than a noisy one that catches it, and the noise is greppable —
`register[A-Z]`, `handle[A-Z]`, `create[A-Z].*(Repository|Provider|Resolver)`
isolate the findings that mean a capability is unreachable.

**What it cannot see.** Anything reached through a loop, a registry, a string
key, or dynamic dispatch. It is a smoke alarm, not a proof.
