// SPDX-License-Identifier: AGPL-3.0-only
import type { ConfigSelection } from '@getreceipt/auth';
import { Command, CommanderError } from 'commander';

import { resolveActiveProfile } from './config-render.js';
import { EXIT_CODES } from './from-render.js';
import { processStreamsIO, type CliIO } from './io.js';
import { resolveConfigSelection, resolveGlobalOptions } from './resolve-options.js';

/**
 * The launch-time config selection the `mcp` verb hands the server: which config FILE the tools
 * default to (`selection`, from `mcp --config`/`--profile`) and the profile NAME to report as the
 * default label (`profile`). A tool's per-call `profile` arg overrides BOTH.
 */
export interface McpLaunchSelection {
    /** The launch default file selection; omitted → the home-default file. */
    readonly selection?: ConfigSelection;
    /** The launch profile NAME (report label) when no per-call `profile` is given. */
    readonly profile?: string;
}

/**
 * The `mcp` command's collaborators: the injected server starter plus `io` for diagnostics. The
 * starter is a thunk (not a direct import) so `@getreceipt/cli` need not depend on `@getreceipt/mcp`
 * — which depends on the CLI — breaking the cycle; the umbrella bin injects the real starter.
 */
export interface McpCommandEnv {
    readonly io: CliIO;
    /**
     * Serve the MCP server over stdio (resolves when the client disconnects), loading the
     * launch-selected config file. Injected from `@getreceipt/mcp`; absent in a standalone CLI
     * build, where the verb reports it is unavailable.
     */
    readonly startMcpServer?: (launch: McpLaunchSelection) => Promise<void>;
}

function defaultEnv(): McpCommandEnv {
    return { io: processStreamsIO() };
}

/**
 * Build the `mcp` command: serve the four collection tools to an MCP client over stdio. stdout is the
 * JSON-RPC channel, so the verb writes NOTHING there — the transport owns it. Inherits the global
 * `--config`/`--profile` as the launch-default config file (each tool's per-call `profile` arg
 * overrides it). Registered even when no starter is injected (so the verb is discoverable and
 * `--help` works); without one it exits with a clear `unavailable` code. Returns a fresh
 * {@link Command} per call (test-friendly).
 */
export function createMcpCommand(overrides: Partial<McpCommandEnv> = {}): Command {
    const env: McpCommandEnv = { ...defaultEnv(), ...overrides };

    return new Command('mcp')
        .description('Serve the receipt-collection tools to an MCP client over stdio.')
        .action(async (_options: Record<string, never>, command: Command) => {
            if (env.startMcpServer === undefined) {
                env.io.writeErr('✗ the MCP server is not available in this build\n');
                throw new CommanderError(EXIT_CODES.usage, 'getreceipt.mcp.unavailable', '');
            }
            const selection = resolveConfigSelection(command, { stderr: env.io.writeErr });
            const profile = resolveGlobalOptions(command).profile;
            await env.startMcpServer({
                selection,
                ...(profile === undefined ? {} : { profile }),
            });
        });
}
