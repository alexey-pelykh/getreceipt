# @getreceipt/adapter-amazon

[![License: AGPL-3.0-only](https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg)](../../LICENSE)

The Amazon source adapter for [getreceipt](https://github.com/alexey-pelykh/getreceipt) — a **generic,
multi-marketplace** Amazon source. Its canonical domain is **`amazon.com`**, and it serves each Amazon
storefront (`amazon.com`, `amazon.fr`, …) as a separate **instance**: different orders behind **one** Amazon
sign-in.

> **Unofficial.** Not affiliated with, endorsed by, or supported by Amazon. It collects **your own** orders,
> from **your own** account, using **your own** browser session. See the
> [project README](https://github.com/alexey-pelykh/getreceipt#readme) for the full disclaimer.

## Marketplace instances

One imported browser session serves every instance; each instance is collected as separate data (orders on
`.com` are not visible on `.fr`) and written under its own output directory. The canonical is listed first.

| instance         | status                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`amazon.fr`**  | **e2e-verified** against the live site — the working marketplace today.                                                                                                                                                                                                                                                                                                    |
| **`amazon.com`** | **declared, not yet validated** — page structure and cookie/auth model are still synthetic; live validation is pending [#229](https://github.com/alexey-pelykh/getreceipt/issues/229). Treat `.com` collection as experimental until then.                                                                                                                                 |
| **`amazon.de`**  | **declared, not yet validated** — added as an instance sharing amazon.fr's server-rendered order-card structure (per the [#228](https://github.com/alexey-pelykh/getreceipt/issues/228) recon); proven over synthetic fixtures, live validation pending [#230](https://github.com/alexey-pelykh/getreceipt/issues/230). Treat `.de` collection as experimental until then. |

A marketplace is **collectable only once it is a declared and validated instance.**

## Configuration & addressing

Configure the source under its canonical `amazon.com` key, list the instances to collect with an optional
source-level `instances:` key, and address them with `from <instance>` / `from amazon.com --all-instances`. The
full config shape, addressing asymmetry, per-instance output, and source-level re-auth are documented in
**[docs/configuration.md § Multi-marketplace instances](../../docs/configuration.md#multi-marketplace-instances-amazon)**.

## Bundled adapter

A **bundled** adapter (`private` — wired into the CLI/MCP by `createDefaultResolver()`), not a standalone
published package; install the [`getreceipt`](https://www.npmjs.com/package/getreceipt) umbrella instead.
Amazon's order host is fingerprint-gated, so collection runs over a Chrome-impersonating transport; auth is
your imported browser session, never a login getreceipt drives.

## License

[AGPL-3.0-only](../../LICENSE). Every source file carries an `SPDX-License-Identifier` header.
