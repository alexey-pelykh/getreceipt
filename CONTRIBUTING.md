# Contributing to getreceipt

> **Unofficial.** `getreceipt` is not affiliated with, endorsed by, or supported by any of the
> services it integrates with. Contributing means building **within** that posture — the scope policy
> below is part of the contract, not a formality.

Thank you for your interest in contributing to `getreceipt`!

`getreceipt` is a personal-use tool: it fetches **your own** receipts, invoices, and statements from
services you already have accounts with, using **your own** credentials. That scope is not incidental —
it is the project's reason for being, and it shapes which contributions are accepted (see
[Scope & contribution-acceptance policy](#scope--contribution-acceptance-policy)).

## Code of Conduct

This project adopts the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md) (version 3.0). By
participating you are expected to uphold it. To report a concern about behavior in project spaces
(issues, pull requests, MCP interactions, or any other channel), email <alexey.pelykh@gmail.com> —
best-effort response within 7 days. See the [Code of Conduct](CODE_OF_CONDUCT.md) for the full
reporting procedure, privacy commitments, and enforcement ladder.

## Getting started

`getreceipt` is a [pnpm](https://pnpm.io/) workspace orchestrated by [Turborepo](https://turbo.build/).

**Requirements**: Node.js `>=24` (see [`.nvmrc`](.nvmrc) — `nvm use`) and pnpm `11` (managed via
Corepack / the `packageManager` field).

```sh
pnpm install        # install + link the workspace
pnpm build          # build every package (tsc project references; tsup for the umbrella)
pnpm typecheck      # strict type-check, including tests
pnpm test           # run the vitest suites
pnpm lint           # eslint (flat config) across the workspace
pnpm format         # prettier --write .   (format:check to verify)
```

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` before opening a PR: CI runs
all four across a Node `24`/`26` × Linux/macOS/Windows matrix, so a green local run is the cheapest way
to keep the PR green. The package layout and toolchain are described in the
[README](README.md#packages).

## Scope & contribution-acceptance policy

`getreceipt` keeps a deliberately narrow envelope: a **local**, **personal-use** tool that retrieves
**your own** documents at **human tempo**. A contribution that moves the project outside that envelope
is **declined regardless of implementation quality** — the constraint is the point, not a detail to be
optimized away.

Out of envelope, and not accepted: bulk or background automation, machine-tempo affordances
(`--watch`, `--repeat`), third-party or other-people's data, scraping, and financial-data aggregation.
Concretely:

- **Mass, bulk, or background automation** — anything that turns one-shot, human-initiated retrieval
  into machine-tempo collection.
- **Machine-tempo affordances** — `--watch`, `--repeat`, daemon / poll / cron-style loops, or any flag
  whose purpose is to run `getreceipt` unattended on a schedule. It runs once, when you ask it to.
- **Third-party or other-people's data** — anything that collects data belonging to anyone but the
  operator, or that operates on credentials that are not the operator's own.
- **Scraping** — harvesting content beyond the documents a service issues to the logged-in user.
- **Financial-data aggregation** — account-aggregation or open-banking features. Banks and other
  financial institutions are out of scope, and `getreceipt` fetches **documents, not balances or
  transaction history**.

This mirrors the posture in [README § Personal use & non-goals](README.md#personal-use--non-goals) and
the rationale in [docs/legitimacy.md](docs/legitimacy.md). If you are unsure whether an idea fits, open
an issue to discuss it **before** writing code.

## Adding a source: the per-adapter mini-gate

New source adapters are the main way `getreceipt` grows, and they are welcome. Because each adapter
names and speaks to a third-party service, every adapter PR is held to a short checklist that keeps the
project on the right side of its
[nominative-use posture](docs/legitimacy.md#service-names-are-nominative-references):

- [ ] **Domain-only identifiers.** The adapter targets the service by its own **domain**; the service
      name appears only to say _which_ service the adapter is for, never dressed up as the service.
- [ ] **No service marks.** No service **logo, brand color, icon, or screenshot** ships in the repo —
      the plain-text name is all an adapter needs.
- [ ] **No brand-named published artifact.** Do not name a package, binary, or release after a service.
      `getreceipt` is the project's own name; service names are nominative references only — an adapter
      package is named after the service's **domain** (see [Adapter package naming](#adapter-package-naming)).
- [ ] **Nominative framing in docs.** Docs name a service to identify it, imply no endorsement, and
      inherit the **Unofficial** disclaimer — no "official", no claimed affiliation.
- [ ] **Documents, not data.** The adapter fetches the **documents a service issues to you** (receipts,
      invoices, statements) — not balances, transaction history, or aggregated account data.
- [ ] **Human tempo, your own session.** The adapter authenticates **as the operator**, against the
      operator's own data, replicating a download a logged-in user could do by hand — no escalation and
      no machine-tempo loop.
- [ ] **Captures stay local.** Any traffic captures made while building the adapter **stay on your
      machine and are never committed** — `getreceipt` ships adapter _code_, not anyone's data, traffic
      dumps, or fixtures built from real personal documents.
- [ ] **Tested and licensed.** New behavior ships with executing tests, and every new source file
      carries the `SPDX-License-Identifier: AGPL-3.0-only` header (ESLint enforces it).

The reasoning behind each line lives in [docs/legitimacy.md](docs/legitimacy.md); the checklist is the
operational form of that posture.

## Adapter package naming

A source adapter is named after the **canonical domain it targets, TLD included** — the package name
is the source's registry key written as a package:

```
@getreceipt/adapter-{canonicalDomain, with every "." replaced by "-"}
```

| Canonical domain | Package                              |
| ---------------- | ------------------------------------ |
| `grandfrais.com` | `@getreceipt/adapter-grandfrais-com` |
| `monoprix.fr`    | `@getreceipt/adapter-monoprix-fr`    |
| `free.fr`        | `@getreceipt/adapter-free-fr`        |
| `pro.free.fr`    | `@getreceipt/adapter-pro-free-fr`    |

Keeping the **full** domain — TLD and all — makes the package-to-source mapping lossless and 1:1,
**collision-safe** across TLD-variant aliases and same-brand international sources (`brand.fr` vs
`brand.com` → `adapter-brand-fr` vs `adapter-brand-com`), and faithful to the domain-addressing model
(sources are addressed by their full domain). A subdomain source keeps its full label path
(`pro.free.fr` → `adapter-pro-free-fr`, distinct from `free.fr` → `adapter-free-fr`), and the package
follows the **canonical** domain only — never an alias domain.

The **`adapter-` prefix** is a deliberate role marker. The workspace splits into infrastructure
packages — the engine and tooling (`core`, `cli`, `mcp`, and the rest — no prefix; see the
[package table](README.md#packages)) — and source adapters (`adapter-*`). The prefix keeps the two
roles visually distinct under the shared `@getreceipt/` scope, follows the idiomatic `@scope/role-*`
pattern (`@rollup/plugin-*`, `@aws-sdk/client-*`), and lets `packages/adapter-*` be globbed for
adapter-only CI / lint / test rules.

Naming the package after the domain is itself a **nominative reference** — it says _which_ service the
adapter is for, not branding — consistent with the per-adapter mini-gate above and the
[nominative-use posture](docs/legitimacy.md#service-names-are-nominative-references).

## Licensing of contributions

`getreceipt` is licensed under [AGPL-3.0-only](LICENSE). Contributions are **inbound = outbound**: by
opening a pull request you agree that your contribution is licensed under **AGPL-3.0-only**, the same
license as the project (this is GitHub's default for contributions made through a pull request). Every
source file must carry the `SPDX-License-Identifier: AGPL-3.0-only` header — the ESLint config enforces
it.

There is **no Contributor License Agreement (CLA)** and no sign-off requirement today: for a
solo-maintained project a CLA bot is heavyweight infrastructure with little return. A CLA would be
introduced **only if and when commercial (dual) licensing is ever offered** — and not before. Until
then, contributing is as simple as opening a PR.

## Submitting changes

1. **Fork** and create a feature branch. Branches follow `{type}/{issue}-{slug}` — e.g.
   `docs/31-contributing-code-of-conduct`.
2. Make your change following the conventions above; keep the diff focused on one issue.
3. Run `pnpm lint && pnpm typecheck && pnpm test && pnpm format:check` locally.
4. **Commit** with a descriptive message in the project convention `(type) lowercase summary (#NN)` —
   e.g. `(feat) add acme source adapter (#42)`. Common types: `feat`, `fix`, `docs`, `test`, `ci`,
   `chore`, `refactor`.
5. **Open a pull request** that references the issue it addresses. CI must be green before a merge.

## Questions?

Open an issue for discussion before starting significant work — especially anything that touches the
scope envelope above. Aligning early beats having a well-built PR declined for being out of envelope.
