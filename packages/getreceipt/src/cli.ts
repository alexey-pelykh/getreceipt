#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { runCli } from '@getreceipt/cli';
import { startMcpServer } from '@getreceipt/mcp';

// Thin shim: assemble + run the program (testable as `runCli`), then exit with its code.
// `--version` carries the unofficial-use disclaimer; `--help` carries it as a footer.
// The umbrella is the one place CLI and MCP meet: it injects the MCP server starter so the `mcp`
// verb serves tools without `@getreceipt/cli` depending on `@getreceipt/mcp` (which depends on it).
process.exit(await runCli(process.argv.slice(2), { mcpEnv: { startMcpServer } }));
