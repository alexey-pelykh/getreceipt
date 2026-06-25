// SPDX-License-Identifier: AGPL-3.0-only
import { Secret } from '@getreceipt/auth';
import type { ConfigParseResult } from '@getreceipt/auth';
import { PERSONAL_USE_NOTICE, SourceAdapterRegistry, SourceResolver, UNOFFICIAL_DISCLAIMER } from '@getreceipt/core';
import type { ArtifactHandle, AuthHandle, CollectResult, ReceiptRef, SourceAdapter } from '@getreceipt/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FromCommandEnv } from './from-command.js';
import { reauthRemedy } from './from-render.js';
import { createProgram, runCli, type ProgramOptions } from './program.js';

interface RunResult {
    out: string;
    err: string;
    error: unknown;
}

/** Build the program, capture Commander's own output via configureOutput, and run it under exitOverride. */
async function runProgram(args: string[], options: ProgramOptions = {}): Promise<RunResult> {
    const out: string[] = [];
    const err: string[] = [];
    const io = { writeOut: (t: string) => out.push(t), writeErr: (t: string) => err.push(t) };
    const program = createProgram(options);
    // exitOverride + output capture must be set per command (Commander does not propagate either),
    // so a subcommand's `--help` is captured and throws a zero-exit signal rather than exiting the worker.
    program.exitOverride();
    program.configureOutput(io);
    for (const sub of program.commands) {
        sub.exitOverride();
        sub.configureOutput(io);
    }

    let error: unknown;
    try {
        await program.parseAsync([...args], { from: 'user' });
    } catch (caught) {
        error = caught;
    }
    return { out: out.join(''), err: err.join(''), error };
}

describe('createProgram — assembly', () => {
    it('wires the from, all, sources, status, login, logout, config, and mcp verbs', () => {
        const names = createProgram()
            .commands.map((c) => c.name())
            .sort();
        expect(names).toEqual(['all', 'config', 'from', 'login', 'logout', 'mcp', 'sources', 'status']);
    });

    it('the verb named in the reauth-required remedy is a registered command (#17 [AC3])', () => {
        // Close the loop: the remedy tells the user to run a verb, and that verb must actually exist.
        const verb = /getreceipt (\w+)/.exec(reauthRemedy('grandfrais.com'))?.[1];
        expect(verb).toBe('login');
        expect(createProgram().commands.map((c) => c.name())).toContain(verb);
    });
});

describe('createProgram — --help (AC #4)', () => {
    it('lists the verbs and carries the unofficial-disclaimer + personal-use footer', async () => {
        const { out, error } = await runProgram(['--help']);

        // Commander signals help via a zero-exit CommanderError under exitOverride.
        expect(error).toMatchObject({ code: 'commander.helpDisplayed', exitCode: 0 });
        expect(out).toContain('from');
        expect(out).toContain('config');
        expect(out).toContain('affiliated with, endorsed by, or supported by any of the services');
        expect(out).toContain('personal use only');
    });

    it('carries the disclaimer on a subcommand help screen too (afterAll)', async () => {
        const { out } = await runProgram(['from', '--help']);
        expect(out).toContain('Collect receipts from one configured source');
        expect(out).toContain('affiliated with, endorsed by, or supported by any of the services');
    });
});

describe('createProgram — --version (AC #4)', () => {
    it('prints the version followed by the unofficial disclaimer', async () => {
        const { out, error } = await runProgram(['--version'], { version: '9.9.9' });

        expect(error).toMatchObject({ code: 'commander.version', exitCode: 0 });
        expect(out).toContain('9.9.9');
        expect(out).toContain('affiliated with, endorsed by, or supported by any of the services');
    });

    it('defaults to the bootstrap version when none is injected', async () => {
        const { out } = await runProgram(['--version']);
        expect(out).toContain('0.0.0');
        // Sanity: the disclaimer constant is the one shipped by core.
        expect(UNOFFICIAL_DISCLAIMER).toContain('Unofficial');
        expect(PERSONAL_USE_NOTICE).toContain('personal use only');
    });
});

describe('createProgram — routes to the from verb with the injected env', () => {
    it('routes `from` to the injected env (its resolver + io are the ones used)', async () => {
        const err: string[] = [];
        const { error } = await runProgram(['from', 'no-such.example'], {
            fromEnv: {
                io: { writeOut: () => {}, writeErr: (t) => err.push(t) },
                consent: { ensure: () => Promise.resolve() },
                // Inject an empty resolver: the only way the message below appears is if the program
                // routed to `from` AND `from` used THIS env (resolver + io), proving env injection.
                resolver: new SourceResolver(new SourceAdapterRegistry()),
            },
        });

        expect(error).toMatchObject({ exitCode: 1, code: 'getreceipt.from.unknown-source' });
        expect(err.join('')).toContain('No source adapter is registered');
    });
});

const WINDOW = { from: new Date('2024-01-01T00:00:00.000Z'), to: new Date('2024-01-31T00:00:00.000Z') };

/** A `from` env that resolves `shop.example` and drives a stubbed `collect` — enough for runCli to reach a real outcome. */
function workingFromEnv(collected: CollectResult | (() => Promise<CollectResult>)): Partial<FromCommandEnv> {
    const adapter: SourceAdapter = {
        descriptor: {
            canonicalDomain: 'shop.example',
            aliasDomains: [],
            authKind: 'password',
            credentialShapes: ['password'],
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
            defaultWindow: { days: 30 },
            pagination: 'none',
        },
        authenticate: async () => ({}) as unknown as AuthHandle,
        list: async (): Promise<readonly ReceiptRef[]> => [],
        fetch: async () =>
            ({ bytes: new Uint8Array([1]), contentType: 'application/pdf' }) as unknown as ArtifactHandle,
    };
    const registry = new SourceAdapterRegistry();
    registry.register(adapter);
    const config: ConfigParseResult = {
        config: { sources: { 'shop.example': { kind: 'password', secret: 'inline' } } },
        warnings: [],
    };
    return {
        io: { writeOut: () => {}, writeErr: () => {} },
        consent: { ensure: () => Promise.resolve() },
        resolveConfigPath: () => '/test/.getreceipt.yaml',
        loadConfig: () => config,
        resolver: new SourceResolver(registry),
        resolveCredential: () => Promise.resolve(new Secret('resolved')),
        createWriter: () => ({ has: async () => false, write: async () => {} }),
        collect: typeof collected === 'function' ? collected : () => Promise.resolve(collected),
    };
}

describe('runCli — exit-code mapping (the bin core; AC #3 at the program level)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('returns 0 for --version and --help (Commander zero-exit signals)', async () => {
        // Commander writes version/help to process streams here (runCli sets no output config); silence it.
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        expect(await runCli(['--version'])).toBe(0);
        expect(await runCli(['--help'])).toBe(0);
    });

    it('returns 1 for a Commander parse error (unknown command, missing argument)', async () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        expect(await runCli(['definitely-not-a-command'])).toBe(1);
        expect(await runCli(['from'])).toBe(1); // missing required <domain>
    });

    it('returns 1 for a usage error from the from verb (unknown source)', async () => {
        expect(
            await runCli(['from', 'no-such.example'], {
                fromEnv: {
                    io: { writeOut: () => {}, writeErr: () => {} },
                    consent: { ensure: () => Promise.resolve() },
                    resolver: new SourceResolver(new SourceAdapterRegistry()),
                },
            }),
        ).toBe(1);
    });

    it('returns 0 when the from verb succeeds', async () => {
        const code = await runCli(['from', 'shop.example', '--json'], {
            fromEnv: workingFromEnv({
                outcome: 'succeeded',
                source: 'shop.example',
                window: WINDOW,
                written: [],
                skipped: [],
            }),
        });
        expect(code).toBe(0);
    });

    it('passes a verb outcome exit code through (reauth-required → 5)', async () => {
        const code = await runCli(['from', 'shop.example'], {
            fromEnv: workingFromEnv({
                outcome: 'reauth-required',
                source: 'shop.example',
                window: WINDOW,
                reason: 'expired',
            }),
        });
        expect(code).toBe(5);
    });

    it('maps an unexpected (non-Commander) error to the usage code and reports it', async () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const code = await runCli(['from', 'shop.example'], {
            fromEnv: workingFromEnv(() => Promise.reject(new Error('boom: unexpected'))),
        });
        expect(code).toBe(1);
        expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('boom: unexpected');
    });
});
