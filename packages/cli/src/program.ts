// SPDX-License-Identifier: AGPL-3.0-only
import { PERSONAL_USE_NOTICE, UNOFFICIAL_DISCLAIMER } from '@getreceipt/core';
import { Command, CommanderError } from 'commander';

import { createAllCommand, type AllCommandEnv } from './all-command.js';
import { createConfigCommand, type ConfigCommandEnv } from './config-command.js';
import { createFromCommand, type FromCommandEnv } from './from-command.js';
import { EXIT_CODES } from './from-render.js';
import { createLoginCommand, type LoginCommandEnv } from './login-command.js';
import { createLogoutCommand, type LogoutCommandEnv } from './logout-command.js';
import { createMcpCommand, type McpCommandEnv } from './mcp-command.js';
import { createSourcesCommand, type SourcesCommandEnv } from './sources-command.js';
import { createStatusCommand, type StatusCommandEnv } from './status-command.js';

/** Version reported when the caller injects none. The packages bootstrap at 0.0.0; real version stamping lands with publishing (#11). */
const DEFAULT_VERSION = '0.0.0';

/** Construction-time options for {@link createProgram}; all optional, so `createProgram()` yields the full production CLI. */
export interface ProgramOptions {
    /** Version string reported by `--version`. */
    readonly version?: string;
    /** Seam overrides for the `from` subcommand (tests inject a fake resolver / writer / IO). */
    readonly fromEnv?: Partial<FromCommandEnv>;
    /** Seam overrides for the `all` subcommand. */
    readonly allEnv?: Partial<AllCommandEnv>;
    /** Seam overrides for the `sources` subcommand. */
    readonly sourcesEnv?: Partial<SourcesCommandEnv>;
    /** Seam overrides for the `status` subcommand. */
    readonly statusEnv?: Partial<StatusCommandEnv>;
    /** Seam overrides for the `login` subcommand. */
    readonly loginEnv?: Partial<LoginCommandEnv>;
    /** Seam overrides for the `logout` subcommand. */
    readonly logoutEnv?: Partial<LogoutCommandEnv>;
    /** Seam overrides for the `config` subcommand. */
    readonly configEnv?: Partial<ConfigCommandEnv>;
    /** Seam overrides for the `mcp` subcommand — chiefly the injected `startMcpServer` thunk from `@getreceipt/mcp`. */
    readonly mcpEnv?: Partial<McpCommandEnv>;
}

/**
 * Assemble the root `getreceipt` program: the `from`, `all`, `sources`, `status`, `login`,
 * `logout`, `config`, and `mcp` verbs, `--version` (which prints the version AND the unofficial-use
 * disclaimer), and a help
 * footer carrying the disclaimer + personal-use posture on every command (`afterAll`), so the
 * legitimacy posture ships on the CLI channel wherever a user looks. Returns a fresh
 * {@link Command} per call (test-friendly); the bin adds exit-code handling around it.
 */
export function createProgram(options: ProgramOptions = {}): Command {
    const program = new Command('getreceipt')
        .description('Unofficial receipt fetcher (CLI + MCP) — fetch your own receipts with your own credentials.')
        .version(
            `${options.version ?? DEFAULT_VERSION}\n${UNOFFICIAL_DISCLAIMER}`,
            '-V, --version',
            'output the version and unofficial-use disclaimer',
        )
        .addHelpText('afterAll', `\n${UNOFFICIAL_DISCLAIMER}\n${PERSONAL_USE_NOTICE}\n`)
        .showHelpAfterError('(run with --help for usage)');

    program.addCommand(createFromCommand(options.fromEnv ?? {}));
    program.addCommand(createAllCommand(options.allEnv ?? {}));
    program.addCommand(createSourcesCommand(options.sourcesEnv ?? {}));
    program.addCommand(createStatusCommand(options.statusEnv ?? {}));
    program.addCommand(createLoginCommand(options.loginEnv ?? {}));
    program.addCommand(createLogoutCommand(options.logoutEnv ?? {}));
    program.addCommand(createConfigCommand(options.configEnv ?? {}));
    program.addCommand(createMcpCommand(options.mcpEnv ?? {}));

    return program;
}

/**
 * Assemble and run the program, returning the process exit code instead of exiting — the
 * testable core the bin wraps with `process.exit`. Under `exitOverride`, every termination
 * (a verb's outcome exit, a parse error, `--help`/`--version`) surfaces as a
 * {@link CommanderError} whose `exitCode` is authoritative; an unexpected throw maps to the
 * `usage` code. Commands write their own user-facing text, so this adds none except for the
 * unexpected-error backstop.
 *
 * @param argv user arguments (no `node`/script prefix), e.g. `process.argv.slice(2)`.
 */
export async function runCli(argv: readonly string[], options: ProgramOptions = {}): Promise<number> {
    const program = createProgram(options);
    // exitOverride must be set per command (Commander does not propagate it): the root and every verb.
    program.exitOverride();
    for (const sub of program.commands) {
        sub.exitOverride();
    }

    try {
        await program.parseAsync([...argv], { from: 'user' });
        return EXIT_CODES.success;
    } catch (error) {
        if (error instanceof CommanderError) {
            return error.exitCode;
        }
        process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
        return EXIT_CODES.usage;
    }
}
