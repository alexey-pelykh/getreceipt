// SPDX-License-Identifier: AGPL-3.0-only
import type { ConfigParseResult, CredentialValue, Secret } from '@getreceipt/auth';
import type { CollectRequest, CollectResult, OperationResult, ReceiptWriter, SourceResolver } from '@getreceipt/core';
import { Command, CommanderError } from 'commander';

import { DEFAULT_PROFILE } from './config-render.js';
import { consentExitCodeFor, ConsentRequiredError, createConsentGate, type ConsentGate } from './consent-gate.js';
import { EXIT_CODES, exitCodeFor, renderResultsTable } from './from-render.js';
import { processStreamsIO, type CliIO } from './io.js';
import { OperationError } from './operation-runner.js';
import { defaultCollectionDeps, runCollect, type CollectionDeps, type CollectParams } from './operations.js';
import { traceAdapter } from './verbose-trace.js';
import { parseWindow } from './window.js';

/**
 * The `from` command's collaborators. Every field has a production default, so
 * `createFromCommand()` works as-is; tests override individual seams — a fake
 * {@link SourceResolver}, a stub credential resolver, a temp-dir writer, a capturing
 * {@link CliIO} — without touching the network, the real home dir, or the `op` CLI.
 */
export interface FromCommandEnv {
    readonly io: CliIO;
    /** Runtime consent pre-flight (#32): gates the fetch BEFORE any service is touched with credentials. */
    readonly consent: ConsentGate;
    readonly resolveConfigPath: () => string;
    readonly loadConfig: (path: string) => ConfigParseResult;
    /** Resolves a requested domain to its adapter. Defaults to the bundled-adapter resolver ({@link createDefaultResolver}). */
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
    readonly acceptConsent?: boolean;
}

function defaultEnv(): FromCommandEnv {
    return { io: processStreamsIO(), consent: createConsentGate(), ...defaultCollectionDeps() };
}

/** A non-zero exit signal whose user-facing text was ALREADY written via {@link CliIO} — it carries no message of its own. */
function exitWith(exitCode: number, code: string): CommanderError {
    return new CommanderError(exitCode, code, '');
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
        .option('--accept-consent', 'record the one-time consent acknowledgment non-interactively (for CI / piped use)')
        .action(async (domain: string, options: FromOptions) => {
            // Consent gate FIRST — before any service is touched with the user's credentials (#32).
            try {
                await env.consent.ensure({ acceptFlag: options.acceptConsent === true });
            } catch (error) {
                if (error instanceof ConsentRequiredError) {
                    throw exitWith(consentExitCodeFor(error.reason), `getreceipt.from.consent-${error.reason}`);
                }
                throw error;
            }

            const window = parseWindow(env.io, options.since, options.until, 'getreceipt.from');
            const profile = options.profile ?? DEFAULT_PROFILE;
            const verbose = options.verbose === true || options.debug === true;
            const outDir = options.out ?? '.';

            const params: CollectParams = {
                source: domain,
                profile,
                outDir,
                ...(window === undefined ? {} : { window }),
            };
            // Verbose wraps the adapter with a secret-fenced tracer; the trace sink is the CLI's stderr.
            const deps: CollectionDeps = verbose
                ? { ...env, instrument: (adapter) => traceAdapter(adapter, env.io.writeErr) }
                : env;

            let result: OperationResult;
            try {
                result = await runCollect(params, deps);
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
