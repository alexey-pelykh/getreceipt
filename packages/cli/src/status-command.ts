// SPDX-License-Identifier: AGPL-3.0-only
import { Command, CommanderError } from 'commander';

import { resolveActiveProfile } from './config-render.js';
import { EXIT_CODES } from './from-render.js';
import { processStreamsIO, type CliIO } from './io.js';
import { OperationError } from './operation-runner.js';
import { defaultAuthStatusDeps, runAuthStatus, type AuthStatusDeps } from './operations.js';
import { resolveConfigSelection, resolveGlobalOptions } from './resolve-options.js';
import { renderStatusJson, renderStatusText, type StatusReport } from './status-render.js';

/**
 * The `status` command's collaborators — the shared {@link AuthStatusDeps} plus the `io` front-end
 * seam. Every field has a production default, so `createStatusCommand()` works as-is; tests override
 * individual seams — a fixture resolver, a fixture config, an in-memory session store, a fixed clock.
 */
export interface StatusCommandEnv extends AuthStatusDeps {
    readonly io: CliIO;
}

function defaultEnv(): StatusCommandEnv {
    return { io: processStreamsIO(), ...defaultAuthStatusDeps() };
}

/** A usage-exit signal whose user-facing text was ALREADY written via {@link CliIO}; carries no message of its own. */
function exitWith(code: string): CommanderError {
    return new CommanderError(EXIT_CODES.usage, code, '');
}

/**
 * Build the read-only `status` command: for every source configured under the active profile,
 * report its auth kind and stored-session disposition (none / valid / expired / locked / unknown)
 * via the shared {@link runAuthStatus} — as a human table (default) or JSON (`--json`, the shared
 * CLI↔MCP shape). It reveals NO token: only the session's disposition and, when known, a non-secret
 * expiry. A config that cannot be read, or a profile that is not defined, is a usage error (like
 * `from`). Returns a fresh {@link Command} per call (test-friendly).
 */
export function createStatusCommand(overrides: Partial<StatusCommandEnv> = {}): Command {
    const env: StatusCommandEnv = { ...defaultEnv(), ...overrides };

    return new Command('status')
        .description('Show stored-session / auth status per configured source.')
        .option('--json', 'emit the structured status report as JSON')
        .action(async (options: { json?: boolean }, command: Command) => {
            const selection = resolveConfigSelection(command, { stderr: env.io.writeErr });
            let report: StatusReport;
            try {
                report = await runAuthStatus(
                    { profile: resolveActiveProfile(resolveGlobalOptions(command).profile), selection },
                    env,
                );
            } catch (error) {
                if (error instanceof OperationError) {
                    env.io.writeErr(`✗ ${error.message}\n`);
                    throw exitWith(
                        error.kind === 'config' ? 'getreceipt.status.load-failed' : 'getreceipt.status.unknown-profile',
                    );
                }
                throw error;
            }

            env.io.writeOut(options.json === true ? renderStatusJson(report) : renderStatusText(report));
        });
}
