// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url';

import { scanForSecrets, Secret } from '@getreceipt/auth';
import type { ConfigParseResult, DomainAuthConfig } from '@getreceipt/auth';
import { collect as coreCollect, SourceAdapterRegistry, SourceResolver } from '@getreceipt/core';
import type {
    ArtifactHandle,
    AuthHandle,
    CollectRequest,
    CollectResult,
    DateRange,
    SourceAdapter,
} from '@getreceipt/core';
import { describe, expect, it, vi } from 'vitest';

import { createAllCommand } from './all-command.js';
import type { AllCommandEnv } from './all-command.js';
import type { BatchReport } from './all-render.js';
import { ConsentRequiredError } from './consent-gate.js';
import { addGlobalConfigOptions } from './resolve-options.js';

const configFixture = fileURLToPath(new URL('./__fixtures__/multi.getreceipt.yaml', import.meta.url));
const workFixture = fileURLToPath(new URL('./__fixtures__/multi.work.getreceipt.yaml', import.meta.url));
const NOW = new Date('2024-06-01T00:00:00.000Z');
const WINDOW: DateRange = { from: NOW, to: NOW };

/**
 * A selection-aware `resolveConfigPath` that maps the per-file model onto the test fixtures: an
 * explicit `--config` path wins; `--profile work` → the work fixture; anything else → the default
 * multi fixture; an unknown profile → a deliberately-missing path (so loadConfig fails like a real
 * absent profile file would).
 */
function fixtureResolver(selection?: { path?: string; profile?: string }): string {
    if (selection?.path !== undefined && selection.path !== '') {
        return selection.path;
    }
    if (selection?.profile === 'work') {
        return workFixture;
    }
    if (selection?.profile !== undefined) {
        return `/nonexistent/${selection.profile}.getreceipt.yaml`;
    }
    return configFixture;
}

function fakeAdapter(canonicalDomain: string): SourceAdapter {
    return {
        descriptor: {
            canonicalDomain,
            aliasDomains: [],
            authKind: 'password',
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
            timezone: 'UTC', // pin the window-resolution zone so date assertions are host-TZ-independent
            defaultWindow: { days: 30 },
            pagination: 'none',
        },
        authenticate: async () => ({}) as unknown as AuthHandle,
        list: async () => [],
        fetch: async () => ({}) as unknown as ArtifactHandle,
    };
}

function resolverWith(...domains: string[]): SourceResolver {
    const registry = new SourceAdapterRegistry();
    for (const domain of domains) {
        registry.register(fakeAdapter(domain));
    }
    return new SourceResolver(registry);
}

/** A succeeded {@link CollectResult} for whichever source the request targets. */
function succeededFor(request: CollectRequest): CollectResult {
    return {
        outcome: 'succeeded',
        source: request.adapter.descriptor.canonicalDomain,
        window: request.window ?? WINDOW,
        written: [],
        skipped: [],
    };
}

interface RunResult {
    out: string;
    err: string;
    error: unknown;
}

async function runAll(args: string[], overrides: Partial<AllCommandEnv> = {}): Promise<RunResult> {
    const out: string[] = [];
    const err: string[] = [];
    const env: Partial<AllCommandEnv> = {
        io: { writeOut: (t) => out.push(t), writeErr: (t) => err.push(t) },
        // Consent is its own concern (consent-gate.test.ts); pass it through here so these tests
        // exercise the batch path. Tests that target the gate override this seam.
        consent: { ensure: () => Promise.resolve() },
        resolveConfigPath: fixtureResolver,
        resolver: resolverWith('shop.example'),
        resolveCredential: (value) =>
            Promise.resolve(value instanceof Object ? new Secret('resolved') : new Secret(value)),
        createWriter: () => ({ has: async () => false, write: async () => {} }),
        collect: (request) => Promise.resolve(succeededFor(request)),
        now: () => NOW,
        ...overrides,
    };
    const cmd = createAllCommand(env);
    // Standalone command (not via createProgram), so add the global --config/--profile it inherits there.
    addGlobalConfigOptions(cmd);
    cmd.exitOverride();

    let error: unknown;
    try {
        await cmd.parseAsync([...args], { from: 'user' });
    } catch (caught) {
        error = caught;
    }
    return { out: out.join(''), err: err.join(''), error };
}

/** A flat config (one profile per file) configuring exactly `domains`. */
function configWith(...domains: string[]): ConfigParseResult {
    const sources: Record<string, DomainAuthConfig> = {};
    for (const domain of domains) {
        sources[domain] = { kind: 'password', secret: 'x-not-real' };
    }
    return { config: { sources }, warnings: [] };
}

describe('all — runs every configured source, continue-on-error (AC #1)', () => {
    it('runs each configured source and continues past a failing one, with a per-source report', async () => {
        // Fixture `default`: shop.example (resolves + succeeds) + ghost.example (no adapter → pre-flight error).
        const { out, error } = await runAll([]);

        // A failing source does not abort the batch: shop still ran AND ghost is reported.
        expect(out).toMatch(/shop\.example — succeeded/);
        expect(out).toMatch(/ghost\.example — error \(unknown-source\)/);
        // partial outcome → exit 3 (some succeeded, some failed).
        expect(error).toMatchObject({ exitCode: 3 });
    });

    it('continues past a source whose collect rejects unexpectedly (captured, not thrown)', async () => {
        const { out, error } = await runAll([], {
            loadConfig: () => configWith('shop.example', 'store.example'),
            resolver: resolverWith('shop.example', 'store.example'),
            collect: (request) =>
                request.adapter.descriptor.canonicalDomain === 'store.example'
                    ? Promise.reject(new Error('kaboom'))
                    : Promise.resolve(succeededFor(request)),
        });
        expect(out).toMatch(/shop\.example — succeeded/);
        expect(out).toMatch(/store\.example — error \(unexpected\)/);
        expect(error).toMatchObject({ exitCode: 3 });
    });

    it('drives the real pipeline: an unresolvable challenge is one reauth-required entry per source, batch continues [#134]', async () => {
        // store.example demands a 2FA step; no resolver is wired into the collection path, so it cannot
        // be resolved here. shop.example is an ordinary source. The real collect() runs both.
        const challenger: SourceAdapter = {
            ...fakeAdapter('store.example'),
            authenticate: async () => ({
                challenge: { type: 'otp-sms', prompt: 'Enter the SMS code' },
                resume: async () => ({}) as unknown as AuthHandle,
            }),
        };
        const registry = new SourceAdapterRegistry();
        registry.register(fakeAdapter('shop.example'));
        registry.register(challenger);

        const { out, error } = await runAll([], {
            loadConfig: () => configWith('shop.example', 'store.example'),
            resolver: new SourceResolver(registry),
            collect: coreCollect,
        });

        // One continue-on-error entry per source: the challenge source surfaces reauth-required + remedy...
        expect(out).toMatch(/store\.example — reauth-required/);
        expect(out).toContain('run `getreceipt login store.example`');
        // ...and the unaffected source still ran to success.
        expect(out).toMatch(/shop\.example — succeeded/);
        // Mixed batch (one clean, one re-auth) → partial → exit 3.
        expect(error).toMatchObject({ exitCode: 3 });
    });
});

describe('all — consent gate (#32)', () => {
    it('blocks with exit 6 and never fetches when consent is required non-interactively', async () => {
        const collect = vi.fn((request: CollectRequest) => Promise.resolve(succeededFor(request)));
        const { error } = await runAll([], {
            consent: { ensure: () => Promise.reject(new ConsentRequiredError('non-interactive')) },
            collect,
        });
        expect(error).toMatchObject({ exitCode: 6, code: 'getreceipt.all.consent-non-interactive' });
        expect(collect).not.toHaveBeenCalled();
    });

    it('runs the gate exactly ONCE before the fan-out (not once per source)', async () => {
        const ensure = vi.fn(() => Promise.resolve());
        await runAll([], { consent: { ensure } }); // default fixture profile has two sources
        expect(ensure).toHaveBeenCalledOnce();
        expect(ensure).toHaveBeenCalledWith({ acceptFlag: false });
    });

    it('passes --accept-consent through to the gate', async () => {
        const ensure = vi.fn(() => Promise.resolve());
        await runAll(['--accept-consent'], { consent: { ensure } });
        expect(ensure).toHaveBeenCalledWith({ acceptFlag: true });
    });
});

describe('all — exit-code ladder (AC #4)', () => {
    it('exits 0 when every source succeeds', async () => {
        // `work` profile configures only shop.example (which succeeds).
        const { error } = await runAll(['--profile', 'work']);
        expect(error).toBeUndefined();
    });

    it('exits 3 (partial) when some succeed and some fail', async () => {
        const { error } = await runAll([]); // shop succeeds, ghost errors
        expect(error).toMatchObject({ exitCode: 3 });
    });

    it('exits 4 (failed) when no source succeeds', async () => {
        const { error } = await runAll([], {
            loadConfig: () => configWith('shop.example'),
            collect: (request) =>
                Promise.resolve({
                    outcome: 'failed',
                    source: request.adapter.descriptor.canonicalDomain,
                    window: WINDOW,
                    reason: 'auth endpoint unreachable',
                    cause: new Error('ENOTFOUND'),
                    written: [],
                    skipped: [],
                }),
        });
        expect(error).toMatchObject({ exitCode: 4 });
    });
});

describe('all — capped concurrency (AC #3 — no uncapped fan-out)', () => {
    async function measureMaxConcurrency(sourceCount: number, cap: number): Promise<{ max: number; ran: number }> {
        const domains = Array.from({ length: sourceCount }, (_, i) => `src${i}.example`);
        let active = 0;
        let max = 0;
        let ran = 0;
        const collect = async (request: CollectRequest): Promise<CollectResult> => {
            active += 1;
            max = Math.max(max, active);
            await new Promise((resolve) => setTimeout(resolve, 10));
            active -= 1;
            ran += 1;
            return succeededFor(request);
        };
        await runAll(['--concurrency', String(cap)], {
            resolver: resolverWith(...domains),
            loadConfig: () => configWith(...domains),
            collect,
        });
        return { max, ran };
    }

    it('never runs more sources at once than --concurrency (cap 2 over 5 sources)', async () => {
        const { max, ran } = await measureMaxConcurrency(5, 2);
        expect(ran).toBe(5); // every source still ran
        expect(max).toBe(2); // …but never more than 2 at a time
    });

    it('runs strictly sequentially at --concurrency 1', async () => {
        const { max, ran } = await measureMaxConcurrency(4, 1);
        expect(ran).toBe(4);
        expect(max).toBe(1);
    });
});

describe('all — structured output + window (AC #2)', () => {
    it('emits a structured batch report under --json', async () => {
        const { out, error } = await runAll(['--json']);
        expect(error).toMatchObject({ exitCode: 3 }); // partial (ghost errors)

        const report = JSON.parse(out) as BatchReport;
        expect(report.profile).toBe('default');
        expect(report.outcome).toBe('partial');
        expect(report.concurrency).toBe(3); // default cap

        const byName = Object.fromEntries(report.sources.map((s) => [s.source, s]));
        const shop = byName['shop.example'];
        const ghost = byName['ghost.example'];
        expect(shop?.ok).toBe(true);
        if (shop?.ok === true) {
            expect(shop.result.outcome).toBe('succeeded');
            expect(shop.result.source).toBe('shop.example');
        }
        expect(ghost?.ok).toBe(false);
        if (ghost?.ok === false) {
            expect(ghost.error.kind).toBe('unknown-source');
        }
    });

    it('threads an explicit --since/--until window to every source and echoes it', async () => {
        let seen: DateRange | undefined;
        const { out } = await runAll(['--json', '--since', '2024-01-01', '--until', '2024-01-31'], {
            loadConfig: () => configWith('shop.example'),
            collect: (request) => {
                seen = request.window;
                return Promise.resolve(succeededFor(request));
            },
        });
        expect(seen?.from.toISOString()).toBe('2024-01-01T00:00:00.000Z');
        expect(seen?.to.toISOString()).toBe('2024-01-31T23:59:59.999Z'); // end-of-day (#127)

        // The batch echoes the REQUESTED calendar window (each source resolves it in its own zone).
        const report = JSON.parse(out) as BatchReport;
        expect(report.window).toEqual({ from: '2024-01-01', to: '2024-01-31' });
    });

    it('reports "(no sources configured)" and exits 0 for an empty profile', async () => {
        const { out, error } = await runAll([], { loadConfig: () => configWith() });
        expect(error).toBeUndefined();
        expect(out).toContain('(no sources configured)');
    });

    it('never emits secret-shaped output (the resolved credential never reaches the report)', async () => {
        const secretToken = 'sk' + '_live_' + 'C'.repeat(28);
        const { out, error } = await runAll(['--json'], {
            loadConfig: () => configWith('shop.example'),
            resolveCredential: () => Promise.resolve(new Secret(secretToken)),
        });
        expect(error).toBeUndefined(); // all succeeded → output is non-empty (the assertion below is meaningful)
        expect(out).not.toContain(secretToken);
        expect(scanForSecrets([{ path: 'all-json', content: out }])).toEqual([]);
    });
});

describe('all — usage errors', () => {
    it('exits 1 for a non-integer --concurrency', async () => {
        const { err, error } = await runAll(['--concurrency', 'abc']);
        expect(error).toMatchObject({ exitCode: 1 });
        expect(err).toContain('--concurrency must be a positive integer');
    });

    it('exits 1 for a zero --concurrency', async () => {
        const { error } = await runAll(['--concurrency', '0']);
        expect(error).toMatchObject({ exitCode: 1 });
    });

    it('exits 1 when the config cannot be read', async () => {
        const { err, error } = await runAll([], {
            loadConfig: () => {
                throw new Error('boom: unreadable');
            },
        });
        expect(error).toMatchObject({ exitCode: 1 });
        expect(err).toContain('boom: unreadable');
    });

    it('exits 1 when the requested profile file does not exist (per-file model)', async () => {
        // --profile absent → ~/.getreceipt/absent.yaml; here a deliberately-missing path → a config read error.
        const { err, error } = await runAll(['--profile', 'absent']);
        expect(error).toMatchObject({ exitCode: 1 });
        expect(err).toContain('config file could not be read');
    });
});
