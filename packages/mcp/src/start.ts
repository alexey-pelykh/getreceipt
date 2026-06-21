// SPDX-License-Identifier: AGPL-3.0-only
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { createMcpServer } from './server.js';

/**
 * Serve the getreceipt MCP server over stdio — the entry point the CLI `mcp` verb runs (injected via
 * `ProgramOptions.startMcpServer`, so `@getreceipt/cli` need not depend on this package). stdout is the
 * JSON-RPC channel; all human-facing output goes to stderr.
 *
 * Resolves only when the transport CLOSES (client disconnects / stdin ends). This wait is load-bearing:
 * `connect()` returns as soon as the stdin listener is attached — it does NOT block — and the umbrella
 * bin wraps the verb in `process.exit()`, which ignores the open stdin handle. Without awaiting close,
 * the server would exit before serving a single request. `transport` is injectable for tests.
 */
export async function startMcpServer(transport: Transport = new StdioServerTransport()): Promise<void> {
    const server = createMcpServer();
    // Protocol.onclose (distinct from transport.onclose, which connect() owns) fires on transport close.
    const closed = new Promise<void>((resolve) => {
        server.server.onclose = resolve;
    });
    await server.connect(transport);
    await closed;
}
