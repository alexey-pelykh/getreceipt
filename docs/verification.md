# Verification & trust state

Every source `getreceipt` ships carries a **verification state**, shown by `getreceipt sources` (and
the `list_sources` MCP tool). This page explains what that state means, where it comes from, and — the
question this page exists to answer — **why a successful `collect` does not, by itself, mark a source
verified.**

## The three states

| State              | Meaning                                                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`unverified`**   | The adapter's reverse-engineered flow has **never** been machine-confirmed against the live service. Results are best-effort.                                           |
| **`e2e-verified`** | The flow was **confirmed current** against the live service by the project's live conformance oracle.                                                                   |
| **`stale`**        | The flow **was** confirmed, but that confirmation has aged out (older than ~30 days) or a later check found the live shape had drifted. Re-verification is recommended. |

`getreceipt sources` surfaces a short advisory for any non-`ok` state, and the state **decays** on its
own: an `e2e-verified` source whose last confirmation ages past the freshness horizon is shown as
`stale` without anyone re-running anything.

> At the `0.1.0` stage **every bundled source is `unverified`** — the adapters are still landing across
> the release series and none has been put through the live oracle yet. That is stated plainly, not
> hidden: an honest `unverified` badge is the point.

## What the state is — and is not

The verification state is a **property of the shipped adapter**, the same for every user, that sits
alongside the adapter's other declared facts (`authKind`, `transportTier`, `artifactMode`). It answers
one question: **"is this adapter's reverse-engineered flow confirmed to still match the live service?"**

It is therefore **not**:

- **not** something an adapter declares about itself (an adapter cannot mark itself verified);
- **not** a per-document integrity check (that is the content hash on each receipt the writer stores);
- **not** a record of whether _you_ have collected from the source.

## Why a successful `collect` does not mark a source verified

It is reasonable to expect that collecting twelve invoices from a source proves the adapter works — and
in a narrow sense it does. So why does `getreceipt sources` still say `unverified` right after a
successful run?

Because **a successful collect and the verification badge answer two different questions**, at two
different scopes:

- A successful **collect** is **your** result, on **your** machine, against **your** account, in a
  window **you** chose. It is _local liveness_: it proves the flow worked **for you, just now**. It is
  not reproducible by anyone else and is not committed anywhere.
- The verification **badge** is a _shipped fidelity claim_: the maintainers confirmed the adapter still
  matches the live service. It must mean **the same thing for every user** of that adapter.

If a local collect promoted the badge, the badge would mean different things to different people —
`e2e-verified` on your machine, `unverified` on someone else's, for the **same** shipped adapter. That
would quietly destroy the one thing the badge is for: a claim you can trust **because** it is the same
for everyone and not a side effect of your own history.

There is also a **fence** the badge is built on that a local collect does not have. The live oracle runs
**operator-attended** — under the maintainer's authority, not yours — and writes its receipts to a
throwaway directory **outside** the repository; its verdict is meant to be **committed**, so that — once
the bridge described below is wired — the claim is auditable and the **same for everyone**, not a
per-machine artifact. A `collect` on your machine writes real receipts to **your** disk under **your**
credentials; treating it as a verification source would trust an unfenced, per-machine signal as if it
were that shared one.

### So where do I look to confirm _my_ collect worked?

You already have it, in two honest places:

- **The collection manifest** the run prints — the `written` / `skipped` receipts are the direct,
  authoritative record that your collect succeeded.
- **`getreceipt status`** (the `auth_status` MCP tool) — your stored session's disposition for each
  source.

The verification badge is deliberately a separate, narrower signal; it is not the place to read "did my
last run work?"

## How a source becomes `e2e-verified`

Promotion comes from the project's **live conformance oracle** (the `@getreceipt/conformance` live
harness). It runs one real collection against a live source and classifies the outcome — a non-empty
success promotes to `e2e-verified` and stamps the confirmation date; an empty success proves nothing
(zero receipts is not evidence); a shape mismatch against the adapter's `wire.ts` model is recorded as
drift (`stale`). The oracle is **off by default** and never runs unattended in CI — it only runs when an
operator opts in with real credentials.

> **Planned (the loop this page's decision unblocks):** the oracle's verdict is not yet persisted to a
> committed ledger or read back by a default production lookup, so today the surface honestly shows
> `unverified` for every source. Wiring that bridge — persist the oracle's verdict → a committed ledger
> → a default lookup that reads it — is the sequenced next step. Notably, a user's `collect` is **not**
> part of that bridge, for the reasons above.

## See also

- [README](../README.md#configuration) — the verification note in the project overview.
- [docs/configuration.md](configuration.md) — sources, credentials, and where receipts are written.
