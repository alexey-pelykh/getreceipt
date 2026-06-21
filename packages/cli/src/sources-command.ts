// SPDX-License-Identifier: AGPL-3.0-only
import type { ConfigParseResult } from '@getreceipt/auth';
import type { SourceAdapterRegistry, VerificationLookup } from '@getreceipt/core';
import { Command } from 'commander';

import { DEFAULT_PROFILE, resolveActiveProfile } from './config-render.js';
import { processStreamsIO, type CliIO } from './io.js';
import { defaultListSourcesDeps, runListSources } from './operations.js';
import { renderSourcesJson, renderSourcesText } from './sources-render.js';

/**
 * The `sources` command's collaborators. Every field has a production default, so
 * `createSourcesCommand()` works as-is; tests override individual seams — a fixture registry,
 * a fixture config, a verification lookup, a capturing {@link CliIO} — without touching the
 * real home dir.
 */
export interface SourcesCommandEnv {
    readonly io: CliIO;
    readonly resolveConfigPath: () => string;
    readonly loadConfig: (path: string) => ConfigParseResult;
    /** The registry whose adapters are listed. Defaults to the bundled-adapter registry. */
    readonly registry: SourceAdapterRegistry;
    /** Looks up an adapter's verification state; defaults to none (every source surfaces as `unverified`). */
    readonly verification?: VerificationLookup;
}

function defaultEnv(): SourcesCommandEnv {
    return { io: processStreamsIO(), ...defaultListSourcesDeps() };
}

/**
 * Build the read-only `sources` command: list every registered adapter with its declared
 * capabilities, verification state, and whether it is configured under the active profile (via the
 * shared {@link runListSources}) — as a human table (default) or JSON (`--json`, the shared CLI↔MCP
 * shape). A config that cannot be read is non-fatal: every source is shown `not-configured` with a
 * note on stderr. Returns a fresh {@link Command} per call (test-friendly).
 */
export function createSourcesCommand(overrides: Partial<SourcesCommandEnv> = {}): Command {
    const env: SourcesCommandEnv = { ...defaultEnv(), ...overrides };

    return new Command('sources')
        .description('List configured / available sources and their verification state.')
        .option('-p, --profile <name>', 'config profile to report configured-state against', DEFAULT_PROFILE)
        .option('--json', 'emit the structured sources report as JSON')
        .action((options: { profile?: string; json?: boolean }) => {
            const report = runListSources(
                { profile: resolveActiveProfile(options.profile) },
                {
                    resolveConfigPath: env.resolveConfigPath,
                    loadConfig: env.loadConfig,
                    registry: env.registry,
                    onWarn: (message) => env.io.writeErr(message),
                    ...(env.verification === undefined ? {} : { verification: env.verification }),
                },
            );

            env.io.writeOut(options.json === true ? renderSourcesJson(report) : renderSourcesText(report));
        });
}
