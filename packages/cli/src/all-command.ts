// SPDX-License-Identifier: AGPL-3.0-only
import { CredentialResolver, defaultConfigPath, loadConfig as authLoadConfig } from '@getreceipt/auth';
import type { ConfigParseResult, CredentialValue, Secret } from '@getreceipt/auth';
import { collect as coreCollect, FilesystemReceiptWriter, Semaphore } from '@getreceipt/core';
import type {
    CollectRequest,
    CollectResult,
    OperationSpec,
    OperationWindow,
    ReceiptWriter,
    SourceResolver,
} from '@getreceipt/core';
import { Command, CommanderError } from 'commander';

import {
    batchExitCode,
    deriveBatchOutcome,
    renderAllJson,
    renderAllText,
    type BatchReport,
    type BatchSourceResult,
} from './all-render.js';
import { DEFAULT_PROFILE, resolveActiveProfile } from './config-render.js';
import { consentExitCodeFor, ConsentRequiredError, createConsentGate, type ConsentGate } from './consent-gate.js';
import { createDefaultResolver } from './default-sources.js';
import { EXIT_CODES } from './from-render.js';
import { processStreamsIO, type CliIO } from './io.js';
import { OperationError, runOperation, type OperationRunnerDeps } from './operation-runner.js';
import { traceAdapter } from './verbose-trace.js';
import { parseWindow } from './window.js';

/** Default concurrency cap: heavier/browser sources are never fanned out unboundedly. */
const DEFAULT_CONCURRENCY = 3;

/**
 * The `all` command's collaborators — the same seams as `from` (it runs `from`'s execution
 * path once per configured source). Every field has a production default, so
 * `createAllCommand()` works as-is; tests override individual seams (fake resolver, stub
 * credential resolver, temp-dir writer, capturing {@link CliIO}).
 */
export interface AllCommandEnv {
    readonly io: CliIO;
    /** Runtime consent pre-flight (#32): gates the batch BEFORE any service is touched with credentials. */
    readonly consent: ConsentGate;
    readonly resolveConfigPath: () => string;
    readonly loadConfig: (path: string) => ConfigParseResult;
    readonly resolver: SourceResolver;
    readonly resolveCredential: (value: CredentialValue) => Promise<Secret>;
    readonly createWriter: (outDir: string) => ReceiptWriter;
    readonly collect: (request: CollectRequest) => Promise<CollectResult>;
    readonly now: () => Date;
}

interface AllOptions {
    readonly since?: string;
    readonly until?: string;
    readonly profile?: string;
    readonly out?: string;
    readonly json?: boolean;
    readonly concurrency?: string;
    readonly verbose?: boolean;
    readonly debug?: boolean;
    readonly acceptConsent?: boolean;
}

function defaultEnv(): AllCommandEnv {
    const credentialResolver = new CredentialResolver();
    return {
        io: processStreamsIO(),
        consent: createConsentGate(),
        resolveConfigPath: defaultConfigPath,
        loadConfig: authLoadConfig,
        resolver: createDefaultResolver(),
        resolveCredential: (value) => credentialResolver.resolve(value),
        createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
        collect: coreCollect,
        now: () => new Date(),
    };
}

/** A usage-exit signal whose user-facing text was ALREADY written via {@link CliIO}; carries no message of its own. */
function exitWith(code: string): CommanderError {
    return new CommanderError(EXIT_CODES.usage, code, '');
}

/** Parse `--concurrency`: a positive integer, defaulting to {@link DEFAULT_CONCURRENCY}; anything else is a usage error. */
function parseConcurrency(io: CliIO, value: string | undefined): number {
    if (value === undefined) {
        return DEFAULT_CONCURRENCY;
    }
    if (!/^\d+$/.test(value) || Number(value) < 1) {
        io.writeErr(`✗ --concurrency must be a positive integer: ${value}\n`);
        throw exitWith('getreceipt.all.bad-concurrency');
    }
    return Number(value);
}

/**
 * Build the `all` command: run `collect()` for EVERY source configured under the active profile,
 * continue past a failing source, and report a per-source result — as a human table (default) or
 * JSON (`--json`, the shared CLI↔MCP shape). Fan-out is capped by `--concurrency` (default
 * {@link DEFAULT_CONCURRENCY}) so heavier/browser sources never run unbounded. The batch outcome
 * maps to a partial-failure exit ladder (full 0 / partial 3 / failed 4). Returns a fresh
 * {@link Command} per call (test-friendly).
 */
export function createAllCommand(overrides: Partial<AllCommandEnv> = {}): Command {
    const env: AllCommandEnv = { ...defaultEnv(), ...overrides };

    return new Command('all')
        .description('Collect receipts from every configured source (continue-on-error, capped concurrency).')
        .option('--since <date>', 'start of the collection window (ISO date, YYYY-MM-DD)')
        .option('--until <date>', 'end of the collection window (ISO date, YYYY-MM-DD)')
        .option('-p, --profile <name>', 'config profile supplying credentials', DEFAULT_PROFILE)
        .option('-o, --out <dir>', 'directory to write receipts into', '.')
        .option('--concurrency <n>', `max sources collected at once (default ${DEFAULT_CONCURRENCY})`)
        .option('--json', 'emit the structured batch report as JSON')
        .option('--verbose', 'stream secret-fenced stage diagnostics to stderr')
        .option('--debug', 'alias for --verbose')
        .option('--accept-consent', 'record the one-time consent acknowledgment non-interactively (for CI / piped use)')
        .action(async (options: AllOptions) => {
            // Consent gate FIRST — ONCE, before the fan-out touches any service with credentials (#32).
            try {
                await env.consent.ensure({ acceptFlag: options.acceptConsent === true });
            } catch (error) {
                if (error instanceof ConsentRequiredError) {
                    throw new CommanderError(
                        consentExitCodeFor(error.reason),
                        `getreceipt.all.consent-${error.reason}`,
                        '',
                    );
                }
                throw error;
            }

            const window = parseWindow(env.io, options.since, options.until, 'getreceipt.all');
            const concurrency = parseConcurrency(env.io, options.concurrency);
            const profile = resolveActiveProfile(options.profile);

            // Pre-flight the config ONCE so a missing file / undefined profile is a single usage error,
            // not the same error repeated per source.
            const path = env.resolveConfigPath();
            let parsed: ConfigParseResult;
            try {
                parsed = env.loadConfig(path);
            } catch (error) {
                env.io.writeErr(`✗ ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
                throw exitWith('getreceipt.all.load-failed');
            }
            const configured = parsed.config.profiles[profile];
            if (configured === undefined) {
                env.io.writeErr(`✗ profile "${profile}" is not defined in ${path}\n`);
                throw exitWith('getreceipt.all.unknown-profile');
            }

            const verbose = options.verbose === true || options.debug === true;
            const outDir = options.out ?? '.';
            const deps: OperationRunnerDeps = {
                resolver: env.resolver,
                resolveConfigPath: env.resolveConfigPath,
                loadConfig: env.loadConfig,
                resolveCredential: env.resolveCredential,
                createWriter: () => env.createWriter(outDir),
                collect: env.collect,
                now: env.now,
                ...(verbose ? { instrument: (adapter) => traceAdapter(adapter, env.io.writeErr) } : {}),
            };

            const semaphore = new Semaphore(concurrency);
            const sources = await Promise.all(
                Object.keys(configured.sources).map((source) =>
                    semaphore.run(() => runOneSource(source, profile, window, deps)),
                ),
            );

            const outcome = deriveBatchOutcome(sources);
            const report: BatchReport = {
                profile,
                outcome,
                concurrency,
                ...(window === undefined ? {} : { window: { from: window.since, to: window.until } }),
                sources,
            };

            env.io.writeOut(options.json === true ? renderAllJson(report) : renderAllText(report));

            const code = batchExitCode(outcome);
            if (code !== EXIT_CODES.success) {
                throw new CommanderError(code, `getreceipt.all.${outcome}`, '');
            }
        });
}

/**
 * Run one source through the shared {@link runOperation} and capture its fate as a
 * {@link BatchSourceResult} — NEVER throwing, so one source's failure can't strand the rest
 * (continue-on-error). A pre-flight {@link OperationError} becomes a typed `error` slot; any
 * other throw is captured opaquely as `unexpected`.
 */
async function runOneSource(
    source: string,
    profile: string,
    window: OperationWindow | undefined,
    deps: OperationRunnerDeps,
): Promise<BatchSourceResult> {
    const spec: OperationSpec = window === undefined ? { source, profile } : { source, profile, window };
    try {
        const result = await runOperation(spec, deps);
        return { source, ok: true, result };
    } catch (error) {
        if (error instanceof OperationError) {
            return { source, ok: false, error: { kind: error.kind, message: error.message } };
        }
        return {
            source,
            ok: false,
            error: { kind: 'unexpected', message: error instanceof Error ? error.message : String(error) },
        };
    }
}
