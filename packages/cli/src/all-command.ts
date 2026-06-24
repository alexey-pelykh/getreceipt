// SPDX-License-Identifier: AGPL-3.0-only
import { Command, CommanderError } from 'commander';

import { batchExitCode, renderAllJson, renderAllText, type BatchReport } from './all-render.js';
import { resolveActiveProfile } from './config-render.js';
import { consentExitCodeFor, ConsentRequiredError, createConsentGate, type ConsentGate } from './consent-gate.js';
import { EXIT_CODES } from './from-render.js';
import { processStreamsIO, type CliIO } from './io.js';
import { OperationError } from './operation-runner.js';
import { DEFAULT_CONCURRENCY, defaultCollectionDeps, runCollectAll, type CollectionDeps } from './operations.js';
import { resolveConfigSelection, resolveGlobalOptions } from './resolve-options.js';
import { traceAdapter } from './verbose-trace.js';
import { parseWindow } from './window.js';

/**
 * The `all` command's collaborators — the shared {@link CollectionDeps} (it runs `from`'s execution
 * path once per configured source) plus the `io` + `consent` front-end seams. Every field has a
 * production default, so `createAllCommand()` works as-is; tests override individual seams (fake
 * resolver, stub credential resolver, temp-dir writer, capturing {@link CliIO}).
 */
export interface AllCommandEnv extends CollectionDeps {
    readonly io: CliIO;
    /** Runtime consent pre-flight (#32): gates the batch BEFORE any service is touched with credentials. */
    readonly consent: ConsentGate;
}

interface AllOptions {
    readonly since?: string;
    readonly until?: string;
    readonly out?: string;
    readonly json?: boolean;
    readonly concurrency?: string;
    readonly verbose?: boolean;
    readonly debug?: boolean;
    readonly acceptConsent?: boolean;
}

function defaultEnv(): AllCommandEnv {
    return { io: processStreamsIO(), consent: createConsentGate(), ...defaultCollectionDeps() };
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
 * Build the `all` command: run `collect()` for EVERY source configured under the active profile
 * (via the shared {@link runCollectAll}), continue past a failing source, and report a per-source
 * result — as a human table (default) or JSON (`--json`, the shared CLI↔MCP shape). Fan-out is
 * capped by `--concurrency` (default {@link DEFAULT_CONCURRENCY}). The batch outcome maps to a
 * partial-failure exit ladder (full 0 / partial 3 / failed 4). Returns a fresh {@link Command} per call.
 */
export function createAllCommand(overrides: Partial<AllCommandEnv> = {}): Command {
    const env: AllCommandEnv = { ...defaultEnv(), ...overrides };

    return new Command('all')
        .description('Collect receipts from every configured source (continue-on-error, capped concurrency).')
        .option('--since <date>', 'start of the collection window (ISO date, YYYY-MM-DD)')
        .option('--until <date>', 'end of the collection window (ISO date, YYYY-MM-DD)')
        .option('-o, --out <dir>', 'directory to write receipts into', '.')
        .option('--concurrency <n>', `max sources collected at once (default ${DEFAULT_CONCURRENCY})`)
        .option('--json', 'emit the structured batch report as JSON')
        .option('--verbose', 'stream secret-fenced stage diagnostics to stderr')
        .option('--debug', 'alias for --verbose')
        .option('--accept-consent', 'record the one-time consent acknowledgment non-interactively (for CI / piped use)')
        .action(async (options: AllOptions, command: Command) => {
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
            const selection = resolveConfigSelection(command, { stderr: env.io.writeErr });
            // The label is the profile NAME (for the report); the FILE it selects is in `selection`.
            const profile = resolveActiveProfile(resolveGlobalOptions(command).profile);
            const verbose = options.verbose === true || options.debug === true;
            const outDir = options.out ?? '.';

            const params = {
                profile,
                selection,
                concurrency,
                outDir,
                ...(window === undefined ? {} : { window }),
            };
            // Verbose wraps each adapter with a secret-fenced tracer; the trace sink is the CLI's stderr.
            const deps: CollectionDeps = verbose
                ? { ...env, instrument: (adapter) => traceAdapter(adapter, env.io.writeErr) }
                : env;

            let report: BatchReport;
            try {
                report = await runCollectAll(params, deps);
            } catch (error) {
                if (error instanceof OperationError) {
                    env.io.writeErr(`✗ ${error.message}\n`);
                    throw exitWith(
                        error.kind === 'config' ? 'getreceipt.all.load-failed' : 'getreceipt.all.unknown-profile',
                    );
                }
                throw error;
            }

            env.io.writeOut(options.json === true ? renderAllJson(report) : renderAllText(report));

            const code = batchExitCode(report.outcome);
            if (code !== EXIT_CODES.success) {
                throw new CommanderError(code, `getreceipt.all.${report.outcome}`, '');
            }
        });
}
