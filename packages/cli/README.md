# @getreceipt/cli

[![npm](https://img.shields.io/npm/v/%40getreceipt%2Fcli?logo=npm)](https://www.npmjs.com/package/@getreceipt/cli)
[![License: AGPL-3.0-only](https://img.shields.io/npm/l/%40getreceipt%2Fcli)](https://github.com/alexey-pelykh/getreceipt/blob/main/LICENSE)

The command surface for [getreceipt](https://github.com/alexey-pelykh/getreceipt) — a CLI for fetching your own receipts from supported sources. Built on [`@getreceipt/core`](https://www.npmjs.com/package/@getreceipt/core).

> **Unofficial.** Not affiliated with, endorsed by, or supported by any of the services it integrates with. See the [project README](https://github.com/alexey-pelykh/getreceipt#readme) for the full disclaimer.

> **Status: `0.1.0`.** Ships the `from` collection verb (`createFromCommand()`) and the read-only `config` surface (`show` / `validate` / `path`, via `createConfigCommand()`), assembled into the full program by `createProgram()`. The remaining verbs land in later issues. Source adapters do not ship yet, so `from` resolves an empty registry until they do.

## `from <domain>`

```sh
getreceipt from <domain> [--since <date> --until <date>] [--profile <name>] [--out <dir>] [--json] [--verbose]
```

Resolves the source adapter for `<domain>`, loads the credentials configured under `--profile` (default `default`), runs one collection over the window, and writes the receipts under `<out>/<domain>/`. `--since`/`--until` are strict ISO dates (`YYYY-MM-DD`) and must be supplied together; omit both to use the adapter's default window. `--json` emits the structured result object the MCP surface also returns (CLI↔MCP parity). `--verbose` (alias `--debug`) streams stage-level diagnostics to stderr, each line passed through the secret fence; silent by default.

### Exit codes

| Code | Meaning                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | Success — every listed receipt was written or already present.                                                                                               |
| `1`  | Usage / configuration — bad invocation, unknown / unconfigured source, unreadable config, or credentials that could not be resolved (the run never started). |
| `3`  | Partial — some receipts were written, then the run failed before completing.                                                                                 |
| `4`  | Failed — the run failed with no receipts written.                                                                                                            |
| `5`  | Re-auth required — the source needs fresh credentials; re-authenticate and retry.                                                                            |

## Install

End users should install the [`getreceipt`](https://www.npmjs.com/package/getreceipt) umbrella instead — it ships the `getreceipt` binary (CLI + MCP server) self-contained:

```sh
npm install -g getreceipt
```

This package exists for composition. Requires **Node.js ≥ 24**, ESM only.

## License

[AGPL-3.0-only](https://github.com/alexey-pelykh/getreceipt/blob/main/LICENSE).
