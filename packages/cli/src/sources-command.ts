// SPDX-License-Identifier: AGPL-3.0-only
import { defaultConfigPath, loadConfig as authLoadConfig } from '@getreceipt/auth';
import type { ConfigParseResult } from '@getreceipt/auth';
import { listSources } from '@getreceipt/core';
import type { SourceAdapterRegistry, VerificationLookup } from '@getreceipt/core';
import { Command } from 'commander';

import { DEFAULT_PROFILE, resolveActiveProfile } from './config-render.js';
import { createDefaultRegistry } from './default-sources.js';
import { processStreamsIO, type CliIO } from './io.js';
import { renderSourcesJson, renderSourcesText, type SourceView, type SourcesReport } from './sources-render.js';

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
    return {
        io: processStreamsIO(),
        resolveConfigPath: defaultConfigPath,
        loadConfig: authLoadConfig,
        registry: createDefaultRegistry(),
    };
}

/**
 * Build the read-only `sources` command: list every registered adapter with its declared
 * capabilities, verification state, and whether it is configured under the active profile —
 * as a human table (default) or JSON (`--json`, the shared CLI↔MCP shape). A config that
 * cannot be read is non-fatal: every source is shown `not-configured` with a note on stderr,
 * so the available-sources listing still works before any config exists. Returns a fresh
 * {@link Command} per call (test-friendly).
 */
export function createSourcesCommand(overrides: Partial<SourcesCommandEnv> = {}): Command {
    const env: SourcesCommandEnv = { ...defaultEnv(), ...overrides };

    return new Command('sources')
        .description('List configured / available sources and their verification state.')
        .option('-p, --profile <name>', 'config profile to report configured-state against', DEFAULT_PROFILE)
        .option('--json', 'emit the structured sources report as JSON')
        .action((options: { profile?: string; json?: boolean }) => {
            const profile = resolveActiveProfile(options.profile);
            const configuredKeys = loadConfiguredKeys(env, profile);

            const sources: SourceView[] = listSources(env.registry, env.verification).map((listing) => ({
                ...listing,
                configured: isConfigured(listing.canonicalDomain, listing.aliasDomains, configuredKeys),
            }));
            const report: SourcesReport = { profile, sources };

            env.io.writeOut(options.json === true ? renderSourcesJson(report) : renderSourcesText(report));
        });
}

/**
 * The normalized (lowercased) source keys configured under `profile` — the set membership the
 * `configured` flag is computed against. A config that cannot be read, or a profile that is not
 * defined, yields an empty set plus a non-fatal note on stderr (listing still proceeds).
 */
function loadConfiguredKeys(env: SourcesCommandEnv, profile: string): ReadonlySet<string> {
    const path = env.resolveConfigPath();
    let parsed: ConfigParseResult;
    try {
        parsed = env.loadConfig(path);
    } catch (error) {
        env.io.writeErr(
            `⚠ could not read config (${path}): ${error instanceof Error ? error.message : String(error)}; sources shown as not-configured\n`,
        );
        return new Set();
    }
    const configured = parsed.config.profiles[profile];
    if (configured === undefined) {
        env.io.writeErr(`⚠ profile "${profile}" is not defined in ${path}; sources shown as not-configured\n`);
        return new Set();
    }
    return new Set(Object.keys(configured.sources).map((key) => key.toLowerCase()));
}

/** Whether a source is configured: its canonical domain or any alias appears among the configured keys (case-insensitive). */
function isConfigured(
    canonicalDomain: string,
    aliasDomains: readonly string[],
    configuredKeys: ReadonlySet<string>,
): boolean {
    if (configuredKeys.has(canonicalDomain.toLowerCase())) {
        return true;
    }
    return aliasDomains.some((alias) => configuredKeys.has(alias.toLowerCase()));
}
