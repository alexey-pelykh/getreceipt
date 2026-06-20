# getreceipt

> **Unofficial.** This project is not affiliated with, endorsed by, or supported by any of the
> services it integrates with. Use at your own risk.

`getreceipt` is a CLI + [MCP](https://modelcontextprotocol.io) tool for fetching your own receipts
from supported sources.

> **Status: `0.1.0` scaffold.** This is the foundational monorepo skeleton — workspace, packages,
> toolchain, and a green build/test/typecheck/lint baseline. There is **no product logic yet**;
> adapters, auth, CLI commands, and MCP tools land in later issues.

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

## Requirements

- **Node.js** `>=24` (see [`.nvmrc`](.nvmrc) — `nvm use`)
- **pnpm** `11` (managed via the `packageManager` field / Corepack)

## Getting started

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
