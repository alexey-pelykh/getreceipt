#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCli } from '@getreceipt/cli';
import { startMcpServer } from '@getreceipt/mcp';

// Report the umbrella's own version, read from package.json at runtime: the release builds dist on the
// committed 0.0.0 and then stamps package.json, so a build-time-inlined version would freeze at 0.0.0 (#11).
const { version } = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
    version: string;
};

// Thin shim: assemble + run the program (testable as `runCli`), then exit with its code.
// The umbrella is the one place CLI and MCP meet: it injects the MCP server starter (bound to the same
// version, so the MCP serverInfo matches `--version`) so the `mcp` verb serves tools without
// `@getreceipt/cli` depending on `@getreceipt/mcp` (which depends on it).
process.exit(
    await runCli(process.argv.slice(2), {
        version,
        mcpEnv: { startMcpServer: () => startMcpServer(undefined, version) },
    }),
);
