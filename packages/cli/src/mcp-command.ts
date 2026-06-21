// SPDX-License-Identifier: AGPL-3.0-only
import { Command, CommanderError } from 'commander';

import { EXIT_CODES } from './from-render.js';
import { processStreamsIO, type CliIO } from './io.js';

/**
 * The `mcp` command's collaborators: the injected server starter plus `io` for diagnostics. The
 * starter is a thunk (not a direct import) so `@getreceipt/cli` need not depend on `@getreceipt/mcp`
 * — which depends on the CLI — breaking the cycle; the umbrella bin injects the real starter.
 */
export interface McpCommandEnv {
    readonly io: CliIO;
    /**
     * Serve the MCP server over stdio (resolves when the client disconnects). Injected from
     * `@getreceipt/mcp`; absent in a standalone CLI build, where the verb reports it is unavailable.
     */
    readonly startMcpServer?: () => Promise<void>;
}

function defaultEnv(): McpCommandEnv {
    return { io: processStreamsIO() };
}

/**
 * Build the `mcp` command: serve the four collection tools to an MCP client over stdio. stdout is the
 * JSON-RPC channel, so the verb writes NOTHING there — the transport owns it. Registered even when no
 * starter is injected (so the verb is discoverable and `--help` works); without one it exits with a
 * clear `unavailable` code. Returns a fresh {@link Command} per call (test-friendly).
 */
export function createMcpCommand(overrides: Partial<McpCommandEnv> = {}): Command {
    const env: McpCommandEnv = { ...defaultEnv(), ...overrides };

    return new Command('mcp')
        .description('Serve the receipt-collection tools to an MCP client over stdio.')
        .action(async () => {
            if (env.startMcpServer === undefined) {
                env.io.writeErr('✗ the MCP server is not available in this build\n');
                throw new CommanderError(EXIT_CODES.usage, 'getreceipt.mcp.unavailable', '');
            }
            await env.startMcpServer();
        });
}
