// SPDX-License-Identifier: AGPL-3.0-only
import type { ConfigParseResult, CredentialValue, LoginSecrets, Secret } from '@getreceipt/auth';
import type {
    CollectInstancesRequest,
    CollectRequest,
    CollectResult,
    OperationResult,
    ReceiptWriter,
    SourceResolver,
} from '@getreceipt/core';
import { Command, CommanderError } from 'commander';

import { batchExitCode, renderAllJson, renderAllText, type BatchReport } from './all-render.js';
import { DEFAULT_PROFILE } from './config-render.js';
import { consentExitCodeFor, ConsentRequiredError, createConsentGate, type ConsentGate } from './consent-gate.js';
import { EXIT_CODES, exitCodeFor, renderResultsTable } from './from-render.js';
import { processStreamsIO, type CliIO } from './io.js';
import { promptLine } from './interactive-challenge-resolver.js';
import { OperationError } from './operation-runner.js';
import { attendedReauthPrompt, runWithAttendedReauth } from './reauth-loop.js';
import {
    defaultCollectionDeps,
    runCollect,
    runCollectAllInstances,
    type CollectionDeps,
    type CollectParams,
} from './operations.js';
import { resolveConfigSelection, resolveGlobalOptions } from './resolve-options.js';
import { traceAdapter, traceChallengeObserver } from './verbose-trace.js';
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
    /** Resolves a single-item login reference to both username and secret. */
    readonly resolveLogin: (ref: string) => Promise<LoginSecrets>;
    /** Builds the receipt writer for a target directory. */
    readonly createWriter: (outDir: string) => ReceiptWriter;
    readonly collect: (request: CollectRequest) => Promise<CollectResult>;
    /** Auth-once / data-per-instance collection for `--all-instances` (#190). */
    readonly collectInstances: (request: CollectInstancesRequest) => Promise<readonly CollectResult[]>;
    readonly now: () => Date;
    /**
     * Whether we can prompt for an attended re-auth (#247): stdin AND stderr a TTY. Defaults to the real
     * check; injectable so the loop is testable without a TTY. A non-TTY run never prompts, never reads stdin.
     */
    readonly isInteractive: () => boolean;
    /** Reads one operator line for the attended re-auth prompt; defaults to the shared {@link promptLine}. Injectable for tests. */
    readonly readLine: (io: CliIO, prompt: string) => Promise<string>;
}

interface FromOptions {
    readonly since?: string;
    readonly until?: string;
    readonly out?: string;
    readonly json?: boolean;
    readonly verbose?: boolean;
    readonly debug?: boolean;
    readonly acceptConsent?: boolean;
    /** Collect every configured instance of a multi-instance source under one shared auth (#190). */
    readonly allInstances?: boolean;
    /** Opt into the attended re-auth loop (#247): on a mid-collect step-up, prompt to re-authenticate in the browser and resume. */
    readonly reauth?: boolean;
}

function defaultEnv(): FromCommandEnv {
    return {
        io: processStreamsIO(),
        consent: createConsentGate(),
        // Attended re-auth (#247) gates on BOTH streams being a TTY (the prompt shows on stderr), mirroring
        // the consent gate; the readline helper is the one the interactive challenge resolver already uses.
        isInteractive: () => process.stdin.isTTY === true && process.stderr.isTTY === true,
        readLine: promptLine,
        ...defaultCollectionDeps(),
    };
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
        .option('-o, --out <dir>', 'directory to write receipts into', '.')
        .option('--json', 'emit the structured operation result as JSON')
        .option('--verbose', 'stream secret-fenced stage diagnostics to stderr')
        .option('--debug', 'alias for --verbose')
        .option('--accept-consent', 'record the one-time consent acknowledgment non-interactively (for CI / piped use)')
        .option(
            '--all-instances',
            'collect every configured instance of a multi-instance source (e.g. amazon.fr and amazon.com) under one shared sign-in',
        )
        .option(
            '--reauth',
            'on a mid-collect re-auth step-up, pause to let you sign in again in your browser, then resume (interactive terminals only)',
        )
        .action(async (domain: string, options: FromOptions, command: Command) => {
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
            const selection = resolveConfigSelection(command, { stderr: env.io.writeErr });
            // The label is the profile NAME (for the report); the FILE it selects is in `selection`.
            const profile = resolveGlobalOptions(command).profile ?? DEFAULT_PROFILE;
            const verbose = options.verbose === true || options.debug === true;
            const outDir = options.out ?? '.';

            const params: CollectParams = {
                source: domain,
                profile,
                selection,
                outDir,
                ...(window === undefined ? {} : { window }),
            };
            // Verbose wraps the adapter with a secret-fenced stage tracer AND a challenge-lifecycle
            // observer (#142); both trace sinks are the CLI's stderr.
            const deps: CollectionDeps = verbose
                ? {
                      ...env,
                      instrument: (adapter) => traceAdapter(adapter, env.io.writeErr),
                      challengeObserver: traceChallengeObserver(env.io.writeErr),
                  }
                : env;

            // --all-instances (#190): collect every configured instance of the source under ONE shared auth,
            // reporting a per-instance batch (same shape `all` emits) rather than a single result.
            if (options.allInstances === true) {
                let report: BatchReport;
                try {
                    // A step-up hits the ONE shared session (authenticate runs once, #190), so a single
                    // re-auth heals every instance — prompt once, re-run the whole batch (skips written).
                    report = await runWithAttendedReauth({
                        runOnce: () => runCollectAllInstances(params, deps),
                        needsReauth: (r) => r.sources.some((s) => s.ok && s.result.outcome === 'reauth-required'),
                        reauth: options.reauth === true,
                        isInteractive: env.isInteractive,
                        onReauth: attendedReauthPrompt(env.io, domain, env.readLine),
                    });
                } catch (error) {
                    if (error instanceof OperationError) {
                        env.io.writeErr(`✗ ${error.message}\n`);
                        throw exitWith(EXIT_CODES.usage, `getreceipt.from.${error.kind}`);
                    }
                    throw error;
                }
                env.io.writeOut(options.json === true ? renderAllJson(report) : renderAllText(report));
                const code = batchExitCode(report.outcome);
                if (code !== EXIT_CODES.success) {
                    throw exitWith(code, `getreceipt.from.${report.outcome}`);
                }
                return;
            }

            let result: OperationResult;
            try {
                result = await runWithAttendedReauth({
                    runOnce: () => runCollect(params, deps),
                    needsReauth: (r) => r.outcome === 'reauth-required',
                    reauth: options.reauth === true,
                    isInteractive: env.isInteractive,
                    onReauth: attendedReauthPrompt(env.io, domain, env.readLine),
                });
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
