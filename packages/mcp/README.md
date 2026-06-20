# @getreceipt/mcp

[![npm](https://img.shields.io/npm/v/%40getreceipt%2Fmcp?logo=npm)](https://www.npmjs.com/package/@getreceipt/mcp)
[![License: AGPL-3.0-only](https://img.shields.io/npm/l/%40getreceipt%2Fmcp)](https://github.com/alexey-pelykh/getreceipt/blob/main/LICENSE)

The [MCP](https://modelcontextprotocol.io) server and tools for [getreceipt](https://github.com/alexey-pelykh/getreceipt) — exposes receipt fetching to MCP-compatible clients. Built on [`@getreceipt/core`](https://www.npmjs.com/package/@getreceipt/core).

> **Unofficial.** Not affiliated with, endorsed by, or supported by any of the services it integrates with. See the [project README](https://github.com/alexey-pelykh/getreceipt#readme) for the full disclaimer.

> **Status: `0.1.0` scaffold.** No MCP tools yet — they land in later issues.

## Install

End users should install the [`getreceipt`](https://www.npmjs.com/package/getreceipt) umbrella instead — it bundles the MCP server with the CLI:

```sh
npm install -g getreceipt
```

This package exists for composition. Requires **Node.js ≥ 22.19.0**, ESM only.

## License

[AGPL-3.0-only](https://github.com/alexey-pelykh/getreceipt/blob/main/LICENSE).
