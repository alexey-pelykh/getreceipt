// SPDX-License-Identifier: AGPL-3.0-only
import type { SessionStore } from '@getreceipt/auth';
import type { SourceResolver } from '@getreceipt/core';
import { Command, CommanderError } from 'commander';

import { createDefaultResolver } from './default-sources.js';
import { EXIT_CODES } from './from-render.js';
import { processStreamsIO, type CliIO } from './io.js';
import { defaultWritableSessionStore } from './sessions.js';

/**
 * The `logout` command's collaborators. Every field has a production default, so
 * `createLogoutCommand()` works as-is; tests override individual seams — a fixture resolver,
 * an in-memory session store. Deliberately thinner than `login`: clearing a stored session
 * touches no service, so there is no consent gate, no credential resolution, and no config.
 */
export interface LogoutCommandEnv {
    readonly io: CliIO;
    /** Maps the requested domain to its canonical store key. Defaults to the bundled-adapter resolver. */
    readonly resolver: SourceResolver;
    readonly sessionStore: SessionStore;
}

function defaultEnv(): LogoutCommandEnv {
    return {
        io: processStreamsIO(),
        resolver: createDefaultResolver(),
        sessionStore: defaultWritableSessionStore(),
    };
}

/** A usage-exit signal whose user-facing text was ALREADY written via {@link CliIO}; carries no message of its own. */
function exitWith(code: string): CommanderError {
    return new CommanderError(EXIT_CODES.usage, code, '');
}

/**
 * Build the `logout <domain>` command: clear the stored session for a source — to rotate, switch
 * account, or recover from a stuck session (#17). It deletes under the canonical key `login`
 * stores beneath; deletion is unconditional and idempotent, so it recovers even a corrupt or
 * unreadable session and never fails when nothing is stored. No service is contacted and no
 * credential is read. Returns a fresh {@link Command} per call (test-friendly).
 */
export function createLogoutCommand(overrides: Partial<LogoutCommandEnv> = {}): Command {
    const env: LogoutCommandEnv = { ...defaultEnv(), ...overrides };

    return new Command('logout')
        .description('Clear the stored session for a source (rotate, switch account, or recover a stuck session).')
        .argument('<domain>', 'source domain to log out of (canonical or alias)')
        .action(async (domain: string) => {
            // Clear under the canonical key login stores beneath; fall back to the requested domain so a
            // session left by a since-removed adapter is still clearable.
            const key = env.resolver.tryResolve(domain)?.descriptor.canonicalDomain ?? domain;

            try {
                await env.sessionStore.delete(key);
            } catch (error) {
                env.io.writeErr(
                    `✗ ${domain}: ${error instanceof Error ? error.message : 'session could not be cleared'}\n`,
                );
                throw exitWith('getreceipt.logout.clear-failed');
            }

            env.io.writeOut(`✓ logged out of ${key}; any stored session was cleared\n`);
        });
}
