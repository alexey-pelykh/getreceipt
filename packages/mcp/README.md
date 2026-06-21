# @getreceipt/mcp

[![npm](https://img.shields.io/npm/v/%40getreceipt%2Fmcp?logo=npm)](https://www.npmjs.com/package/@getreceipt/mcp)
[![License: AGPL-3.0-only](https://img.shields.io/npm/l/%40getreceipt%2Fmcp)](https://github.com/alexey-pelykh/getreceipt/blob/main/LICENSE)

The [MCP](https://modelcontextprotocol.io) server and tools for [getreceipt](https://github.com/alexey-pelykh/getreceipt) — exposes receipt fetching to MCP-compatible clients. Built on [`@getreceipt/core`](https://www.npmjs.com/package/@getreceipt/core).

> **Unofficial.** Not affiliated with, endorsed by, or supported by any of the services it integrates with. See the [project README](https://github.com/alexey-pelykh/getreceipt#readme) for the full disclaimer.

## Tools

Four tools, served over stdio, each mapping 1:1 to a CLI verb and returning the **same** structured result the verb emits under `--json` (one shared operation layer — kept in lock-step by a parity test):

| Tool           | CLI verb  | Does                                                          |
| -------------- | --------- | ------------------------------------------------------------- |
| `collect`      | `from`    | Collect receipts from one source (`reauth-required` is data). |
| `collect_all`  | `all`     | Collect from every configured source (per-source results).    |
| `list_sources` | `sources` | List registered sources, capabilities, and configured state.  |
| `auth_status`  | `status`  | Per-source session disposition (never reveals a token).       |

Every tool description carries the unofficial / own-accounts-only disclaimer, and the consent acknowledgment gates `collect` / `collect_all` (pass `acceptConsent: true` for unattended use).

## Install

End users should install the [`getreceipt`](https://www.npmjs.com/package/getreceipt) umbrella instead — it bundles the MCP server with the CLI:

```sh
npm install -g getreceipt
```

This package exists for composition. Requires **Node.js ≥ 24**, ESM only.

## License

[AGPL-3.0-only](https://github.com/alexey-pelykh/getreceipt/blob/main/LICENSE).
