// SPDX-License-Identifier: AGPL-3.0-only
import { CredentialResolver, defaultConfigPath, loadConfig as authLoadConfig } from '@getreceipt/auth';
import type { ConfigParseResult, CredentialValue, Secret } from '@getreceipt/auth';
import {
    collect as coreCollect,
    FilesystemReceiptWriter,
    SourceAdapterRegistry,
    SourceResolver,
} from '@getreceipt/core';
import type {
    CollectRequest,
    CollectResult,
    OperationResult,
    OperationSpec,
    OperationWindow,
    ReceiptWriter,
} from '@getreceipt/core';
import { Command, CommanderError } from 'commander';

import { DEFAULT_PROFILE } from './config-render.js';
import { EXIT_CODES, exitCodeFor, renderResultsTable } from './from-render.js';
import { processStreamsIO, type CliIO } from './io.js';
import { OperationError, runOperation, type OperationRunnerDeps } from './operation-runner.js';
import { traceAdapter } from './verbose-trace.js';

/**
 * The `from` command's collaborators. Every field has a production default, so
 * `createFromCommand()` works as-is; tests override individual seams — a fake
 * {@link SourceResolver} (no real adapter ships in 0.1.0), a stub credential resolver,
 * a temp-dir writer, a capturing {@link CliIO} — without touching the network, the real
 * home dir, or the `op` CLI.
 */
export interface FromCommandEnv {
    readonly io: CliIO;
    readonly resolveConfigPath: () => string;
    readonly loadConfig: (path: string) => ConfigParseResult;
    /** Resolves a requested domain to its adapter. Default is an EMPTY registry — no source adapter ships in 0.1.0. */
    readonly resolver: SourceResolver;
    readonly resolveCredential: (value: CredentialValue) => Promise<Secret>;
    /** Builds the receipt writer for a target directory. */
    readonly createWriter: (outDir: string) => ReceiptWriter;
    readonly collect: (request: CollectRequest) => Promise<CollectResult>;
    readonly now: () => Date;
}

interface FromOptions {
    readonly since?: string;
    readonly until?: string;
    readonly profile?: string;
    readonly out?: string;
    readonly json?: boolean;
    readonly verbose?: boolean;
    readonly debug?: boolean;
}

function defaultEnv(): FromCommandEnv {
    const credentialResolver = new CredentialResolver();
    return {
        io: processStreamsIO(),
        resolveConfigPath: defaultConfigPath,
        loadConfig: authLoadConfig,
        // No source adapter ships in 0.1.0; production resolves an empty registry (→ unknown-source).
        resolver: new SourceResolver(new SourceAdapterRegistry()),
        resolveCredential: (value) => credentialResolver.resolve(value),
        createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
        collect: coreCollect,
        now: () => new Date(),
    };
}

/** A non-zero exit signal whose user-facing text was ALREADY written via {@link CliIO} — it carries no message of its own. */
function exitWith(exitCode: number, code: string): CommanderError {
    return new CommanderError(exitCode, code, '');
}

/** A strict ISO-8601 calendar date — `YYYY-MM-DD`, nothing looser. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a strict `YYYY-MM-DD` date (UTC midnight), or `undefined` if the string isn't one.
 * Bare `new Date(...)` silently mis-handles two cases the "ISO date" contract must reject: an
 * impossible day in a valid month (`2024-02-30` rolls forward to Mar 1) and locale-dependent
 * legacy formats (`2024-1-1`, `01/15/2024` parse in local time, inconsistently across engines).
 */
function parseIsoDate(value: string): Date | undefined {
    if (!ISO_DATE.test(value)) {
        return undefined;
    }
    const date = new Date(value);
    // A rolled-over day parses fine but no longer round-trips to the requested calendar date.
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        return undefined;
    }
    return date;
}

/**
 * Validate the `--since`/`--until` pair into a canonical ISO window, or `undefined` when
 * neither is given (the adapter's default window then applies). Both-or-neither, both strict
 * `YYYY-MM-DD`, and `since <= until` — each violation is a usage error whose message is
 * written before the exit signal is thrown.
 */
function parseWindow(io: CliIO, since: string | undefined, until: string | undefined): OperationWindow | undefined {
    if (since === undefined && until === undefined) {
        return undefined;
    }
    if (since === undefined || until === undefined) {
        io.writeErr('✗ --since and --until must be provided together\n');
        throw exitWith(EXIT_CODES.usage, 'getreceipt.from.window-incomplete');
    }
    const from = parseIsoDate(since);
    if (from === undefined) {
        io.writeErr(`✗ --since is not a valid ISO date (expected YYYY-MM-DD): ${since}\n`);
        throw exitWith(EXIT_CODES.usage, 'getreceipt.from.bad-date');
    }
    const to = parseIsoDate(until);
    if (to === undefined) {
        io.writeErr(`✗ --until is not a valid ISO date (expected YYYY-MM-DD): ${until}\n`);
        throw exitWith(EXIT_CODES.usage, 'getreceipt.from.bad-date');
    }
    if (from.getTime() > to.getTime()) {
        io.writeErr('✗ --since must not be after --until\n');
        throw exitWith(EXIT_CODES.usage, 'getreceipt.from.window-inverted');
    }
    return { since: from.toISOString(), until: to.toISOString() };
}

/**
 * Build the `from <domain>` command: resolve the adapter, run a single-source collection
 * via the shared {@link runOperation}, and report the structured {@link OperationResult}
 * as a human table (default) or JSON (`--json`, the CLI half of CLI↔MCP parity). The run's
 * outcome maps to a distinct exit code (see {@link EXIT_CODES}); `--verbose`/`--debug`
 * streams secret-fenced stage diagnostics to stderr (silent by default). Returns a fresh
 * {@link Command} per call (test-friendly).
 */
export function createFromCommand(overrides: Partial<FromCommandEnv> = {}): Command {
    const env: FromCommandEnv = { ...defaultEnv(), ...overrides };

    return new Command('from')
        .description('Collect receipts from one configured source and write them to disk.')
        .argument('<domain>', 'source domain to collect from (canonical or alias)')
        .option('--since <date>', 'start of the collection window (ISO date, YYYY-MM-DD)')
        .option('--until <date>', 'end of the collection window (ISO date, YYYY-MM-DD)')
        .option('-p, --profile <name>', 'config profile supplying credentials', DEFAULT_PROFILE)
        .option('-o, --out <dir>', 'directory to write receipts into', '.')
        .option('--json', 'emit the structured operation result as JSON')
        .option('--verbose', 'stream secret-fenced stage diagnostics to stderr')
        .option('--debug', 'alias for --verbose')
        .action(async (domain: string, options: FromOptions) => {
            const window = parseWindow(env.io, options.since, options.until);
            const profile = options.profile ?? DEFAULT_PROFILE;
            const spec: OperationSpec =
                window === undefined ? { source: domain, profile } : { source: domain, profile, window };

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

            let result: OperationResult;
            try {
                result = await runOperation(spec, deps);
            } catch (error) {
                if (error instanceof OperationError) {
                    env.io.writeErr(`✗ ${error.message}\n`);
                    throw exitWith(EXIT_CODES.usage, `getreceipt.from.${error.kind}`);
                }
                throw error;
            }

            if (options.json === true) {
                env.io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
            } else {
                env.io.writeOut(renderResultsTable(result));
            }

            // Output is written for every outcome; a non-success outcome additionally sets the exit code.
            if (result.outcome !== 'succeeded') {
                throw exitWith(exitCodeFor(result.outcome), `getreceipt.from.${result.outcome}`);
            }
        });
}
