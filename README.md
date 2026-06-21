# getreceipt

> **Unofficial.** This project is not affiliated with, endorsed by, or supported by any of the
> services it integrates with. Use at your own risk.

`getreceipt` is a CLI + [MCP](https://modelcontextprotocol.io) tool for fetching your own receipts
from supported sources.

## Install

Install the umbrella globally, or run it on demand with `npx` — both ship the `getreceipt` binary
(CLI + MCP server), self-contained:

```sh
npm install -g getreceipt      # then: getreceipt --help
npx getreceipt --help          # no install
```

Requires **Node.js ≥ 24**.

## Quickstart

1. **Create `~/.getreceipt.yaml`** with one source under the `default` profile. Substitute a real
   source from `getreceipt sources` for the `example.com` placeholder:

   ```yaml
   profiles:
     default:
       sources:
         example.com:
           auth:
             kind: password
             username: you@example.com
             secret:
               ref: op://Personal/example.com/password # a 1Password reference, not the secret itself
   ```

2. **Check it parses**, see what is configured, then **collect** receipts into a local folder:

   ```sh
   getreceipt config validate                 # non-zero exit if the file is invalid
   getreceipt sources                          # bundled sources + verification state
   getreceipt from example.com --since 2024-01-01 --until 2024-01-31 --out ./receipts
   ```

Receipts are written to `./receipts/<domain>/<receipt-id>.<ext>` with owner-only (`0600`)
permissions; an identical re-run re-writes nothing. The full schema, profiles, and the other
credential forms are in the **[configuration guide](docs/configuration.md)**.

## Commands

`getreceipt <verb>` — run `getreceipt --help` (or `getreceipt <verb> --help`) for the full surface.
`--version` prints the version together with the unofficial-use disclaimer.

| Verb                                | Purpose                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `from <domain>`                     | Collect receipts from one configured source into `<out>/<domain>/`.           |
| `all`                               | Collect from **every** configured source (continue-on-error, capped fan-out). |
| `sources`                           | List bundled sources, their declared capabilities, and verification state.    |
| `status`                            | Show the stored-session / auth status of each configured source.              |
| `login <domain>`                    | Authenticate to a source and store a reusable session for later runs.         |
| `logout <domain>`                   | Clear a source's stored session (rotate, switch account, or recover).         |
| `config show` / `validate` / `path` | Inspect the resolved configuration (read-only; secrets redacted).             |

The collection verbs (`from`, `all`) share `--since` / `--until` (ISO `YYYY-MM-DD`, supplied
together), `--profile <name>` (default `default`), `--out <dir>` (default `.`), `--json`, and
`--verbose`; `all` adds `--concurrency <n>` (default `3`). The introspection verbs (`sources`,
`status`, `config`) are read-only and never reveal a secret.

The session verbs persist auth between runs: `getreceipt login <domain>` authenticates once and
stores a reusable session; `getreceipt logout <domain>` clears it (to rotate, switch account, or
recover a stuck session). When a stored session expires, a collection reports `re-auth required`
and names `getreceipt login <domain>` as the remedy. Neither verb ever prints the token.

`from` exits `0` success · `1` usage/config · `3` partial · `4` failed · `5` re-auth required; `all`
reflects the batch outcome (`0` all ok · `3` partial · `4` none · `1` usage). The
[`@getreceipt/cli`](packages/cli) README carries the per-verb detail.

## Configuration

`getreceipt` reads `~/.getreceipt.yaml`. It holds named **profiles** (default: `default`), each
mapping a **source domain** to its **auth** — a `kind`, an optional `username`, and a `secret`
supplied as a **reference**, so the value itself never lives in the config file:

- **`op://…`** — resolved through the [1Password CLI](https://developer.1password.com/docs/cli/) (`op read`).
- **`encrypted-file:<path>`** — an AES-256-GCM file unlocked by `GETRECEIPT_SECRET_PASSPHRASE`.
- **inline string** — a raw literal; supported, but discouraged (it triggers a security warning).

The **[configuration guide](docs/configuration.md)** covers the full schema, every credential form,
where receipts land, and how sources are resolved.

> The two bundled sources (`grandfrais.com`, `monoprix.fr`) are currently **`unverified`** — their
> reverse-engineered flows have not been machine-confirmed against the live services, so results are
> best-effort. `getreceipt sources` shows each source's state.

## Personal use & non-goals

`getreceipt` fetches **your own** receipts, invoices, and statements from services you already have
accounts with, using **your own** credentials. It is for personal use only — **not** for third-party
data, scraping, bulk or abusive automation, or any use that violates a service's terms.

Explicit non-goals:

- **Banks and financial institutions are out of scope.** This is not an account-aggregation or
  open-banking tool.
- **Documents, not data.** `getreceipt` retrieves only the documents a service issues to you
  (receipts, invoices, statements) — never your account balances or transaction history.
- **No machine-tempo affordances.** There is no `--watch` and no `--repeat`; it runs once, at human
  tempo, when you ask it to.

The fuller posture and rationale — nominative service-name use, fair-use interoperability, and the
in/out-of-scope line — live in [docs/legitimacy.md](docs/legitimacy.md).

## Privacy

`getreceipt` runs entirely on your machine and **collects nothing**: no telemetry, no analytics, no
tracking, and no `getreceipt` server in the loop. Your credentials and the documents you fetch stay
local, and the only runtime traffic `getreceipt` is designed to make is to the service whose receipts
you requested. You are the data controller of what you download; the maintainer receives, sees, and
stores none of it.

See [PRIVACY.md](PRIVACY.md) for the full posture, the exhaustive network-scope list, and how to
verify the no-telemetry claim yourself.

## Packages

| Package                                   | Published | Purpose                                                                                              |
| ----------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| [`@getreceipt/core`](packages/core)       | ✅        | Pipeline, registry, resolvers (the engine).                                                          |
| [`@getreceipt/cli`](packages/cli)         | ✅        | CLI command surface.                                                                                 |
| [`@getreceipt/mcp`](packages/mcp)         | ✅        | MCP server + tools.                                                                                  |
| [`getreceipt`](packages/getreceipt)       | ✅        | Umbrella: carries the `bin` and bundles cli + mcp + core into a self-contained `npx`/global install. |
| [`@getreceipt/e2e`](packages/e2e)         | —         | End-to-end / integration smoke tests.                                                                |
| [`@getreceipt/testing`](packages/testing) | —         | Internal test support (shared MSW server + lifecycle).                                               |

Internal dependencies are linked with pnpm `workspace:^`.

## Development

Building from source (contributors). End users only need the [Install](#install) step above.

**Toolchain:** **Node.js** `>=24` (see [`.nvmrc`](.nvmrc) — `nvm use`) · **pnpm** `11` (managed via
the `packageManager` field / Corepack).

```sh
pnpm install        # install + link the workspace
pnpm build          # build every package (tsc project references; tsup for the umbrella)
pnpm typecheck      # strict type-check, including tests
pnpm test           # run the vitest suites
pnpm lint           # eslint (flat config) across the workspace
pnpm format         # prettier --write .   (format:check to verify)
```

All tasks are orchestrated by [Turborepo](https://turbo.build/) (`turbo.json`) and cached.

## Architecture

- **Workspace & versions** — pnpm workspace; every shared dependency version is pinned once in the
  [`pnpm-workspace.yaml`](pnpm-workspace.yaml) `catalog:` (single source of truth, referenced as
  `catalog:`).
- **TypeScript** — a strict shared base ([`tsconfig.base.json`](tsconfig.base.json): NodeNext ESM,
  `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, …). Each
  buildable package has a `tsconfig.json` (type-check, includes tests) and a composite
  `tsconfig.build.json` (emits `dist/`, excludes tests) wired with TypeScript project references.
- **Bundling** — `core`/`cli`/`mcp` emit declarations via `tsc -b`; the unscoped `getreceipt`
  umbrella is bundled by `tsup` with workspace deps inlined, so a global / `npx` install is
  self-contained.
- **Testing** — [Vitest](https://vitest.dev/) + [MSW](https://mswjs.io/). A shared MSW server and
  its lifecycle (listen / reset-between-tests / close) live in `@getreceipt/testing` and are wired
  into every package's tests via a shared setup file.
- **Lint & format** — ESLint flat config (`@eslint/js` + `typescript-eslint`) with an SPDX
  license-header rule, plus Prettier (kept consistent with [`.editorconfig`](.editorconfig)).

## License

[AGPL-3.0-only](LICENSE). Every source file carries an `SPDX-License-Identifier: AGPL-3.0-only`
header (enforced by ESLint).
