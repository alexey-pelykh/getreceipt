// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url';

import { InMemoryKeyring, KeyringSessionStore, scanForSecrets, Secret, SessionStoreError } from '@getreceipt/auth';
import type { ConfigParseResult, SessionStore, StoredSession } from '@getreceipt/auth';
import { SourceAdapterRegistry, SourceResolver } from '@getreceipt/core';
import type { AuthHandle, ArtifactHandle, SourceAdapter } from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import { createStatusCommand } from './status-command.js';
import type { StatusCommandEnv } from './status-command.js';
import type { StatusReport } from './status-render.js';
import { addGlobalConfigOptions } from './resolve-options.js';

const configFixture = fileURLToPath(new URL('./__fixtures__/multi.getreceipt.yaml', import.meta.url));
const workFixture = fileURLToPath(new URL('./__fixtures__/multi.work.getreceipt.yaml', import.meta.url));

/** Selection-aware resolver: `--config` path wins; `--profile work` → the work fixture; unknown profile → a missing path; else the default. */
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

/** Fixed clock so the {@link ReauthDetector} verdict is deterministic. */
const NOW = new Date('2024-06-01T00:00:00.000Z');
const FUTURE = Date.parse('2024-12-01T00:00:00.000Z'); // after NOW → valid
const PAST = Date.parse('2024-01-01T00:00:00.000Z'); // before NOW → expired

function fakeAdapter(canonicalDomain: string): SourceAdapter {
    return {
        descriptor: {
            canonicalDomain,
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
        list: async () => [],
        fetch: async () => ({}) as unknown as ArtifactHandle,
    };
}

/** Resolver with `shop.example` registered; `ghost.example` (in the fixture) is deliberately unregistered. */
function resolverWithShop(): SourceResolver {
    const registry = new SourceAdapterRegistry();
    registry.register(fakeAdapter('shop.example'));
    return new SourceResolver(registry);
}

interface RunResult {
    out: string;
    err: string;
    error: unknown;
}

async function runStatus(args: string[], overrides: Partial<StatusCommandEnv> = {}): Promise<RunResult> {
    const out: string[] = [];
    const err: string[] = [];
    const env: Partial<StatusCommandEnv> = {
        io: { writeOut: (t) => out.push(t), writeErr: (t) => err.push(t) },
        resolveConfigPath: fixtureResolver,
        resolver: resolverWithShop(),
        sessionStore: new KeyringSessionStore(new InMemoryKeyring()),
        now: () => NOW,
        ...overrides,
    };
    const cmd = createStatusCommand(env);
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

/** A store pre-seeded with one session for `shop.example`. */
async function storeWith(session: StoredSession): Promise<SessionStore> {
    const store = new KeyringSessionStore(new InMemoryKeyring());
    await store.save('shop.example', session);
    return store;
}

describe('status — per-source session/auth state (AC #2)', () => {
    it('reports `none` for a configured source with no stored session', async () => {
        const { out, error } = await runStatus([]);
        expect(error).toBeUndefined();
        expect(out).toContain('status (profile: default)');
        expect(out).toMatch(/shop\.example.*session: none/);
    });

    it('reports `valid` (with expiry) for a live stored session', async () => {
        const { out } = await runStatus([], {
            sessionStore: await storeWith({ token: new Secret('tok'), expiresAt: FUTURE }),
        });
        expect(out).toMatch(/shop\.example.*session: valid/);
        expect(out).toContain('expires: 2024-12-01');
    });

    it('reports `expired` for a stored session past its expiry', async () => {
        const { out } = await runStatus([], {
            sessionStore: await storeWith({ token: new Secret('tok'), expiresAt: PAST }),
        });
        expect(out).toMatch(/shop\.example.*session: expired/);
        expect(out).toContain('expired at 2024-01-01');
    });

    it('marks a configured-but-unregistered source [unregistered]', async () => {
        // `ghost.example` is in the fixture but has no adapter in the resolver.
        const { out } = await runStatus([]);
        expect(out).toMatch(/ghost\.example.*\[unregistered\]/);
    });

    it('emits a structured report under --json', async () => {
        const { out, error } = await runStatus(['--json'], {
            sessionStore: await storeWith({ token: new Secret('tok'), expiresAt: FUTURE }),
        });
        expect(error).toBeUndefined();

        const report = JSON.parse(out) as StatusReport;
        expect(report.profile).toBe('default');
        const byReq = Object.fromEntries(report.sources.map((s) => [s.requested, s]));
        expect(byReq['shop.example']).toMatchObject({
            source: 'shop.example',
            authKind: 'password',
            registered: true,
            session: 'valid',
            expiresAt: '2024-12-01T00:00:00.000Z',
        });
        expect(byReq['ghost.example']).toMatchObject({ registered: false, session: 'none' });
    });

    it('maps a no-passphrase session-store failure to `unknown`', async () => {
        const lockedStore: SessionStore = {
            load: () => Promise.reject(new SessionStoreError('no passphrase configured', 'no-passphrase')),
            save: () => Promise.resolve(),
            delete: () => Promise.resolve(),
        };
        const { out } = await runStatus(['--json'], { sessionStore: lockedStore });
        const report = JSON.parse(out) as StatusReport;
        expect(report.sources.find((s) => s.requested === 'shop.example')?.session).toBe('unknown');
    });

    it('maps a decryption failure to `locked`', async () => {
        const lockedStore: SessionStore = {
            load: () => Promise.reject(new SessionStoreError('wrong passphrase or corrupt file', 'decryption-failed')),
            save: () => Promise.resolve(),
            delete: () => Promise.resolve(),
        };
        const { out } = await runStatus(['--json'], { sessionStore: lockedStore });
        const report = JSON.parse(out) as StatusReport;
        expect(report.sources.find((s) => s.requested === 'shop.example')?.session).toBe('locked');
    });

    it('NEVER reveals the stored token (text or JSON)', async () => {
        const secretToken = 'sk' + '_live_' + 'A'.repeat(28);
        const store = await storeWith({ token: new Secret(secretToken), expiresAt: FUTURE });

        const text = await runStatus([], { sessionStore: store });
        const json = await runStatus(['--json'], { sessionStore: store });

        expect(text.out).not.toContain(secretToken);
        expect(json.out).not.toContain(secretToken);
        expect(scanForSecrets([{ path: 'status-text', content: text.out }])).toEqual([]);
        expect(scanForSecrets([{ path: 'status-json', content: json.out }])).toEqual([]);
    });

    it('reports status against the selected --profile', async () => {
        // `work` configures only shop.example.
        const { out } = await runStatus(['--json', '--profile', 'work']);
        const report = JSON.parse(out) as StatusReport;
        expect(report.profile).toBe('work');
        expect(report.sources.map((s) => s.requested)).toEqual(['shop.example']);
    });
});

describe('status — usage errors', () => {
    it('exits 1 when the config cannot be read', async () => {
        const { err, error } = await runStatus([], {
            loadConfig: () => {
                throw new Error('boom: unreadable');
            },
        });
        expect(error).toMatchObject({ exitCode: 1 });
        expect(err).toContain('boom: unreadable');
    });

    it('exits 1 when the requested profile file does not exist (per-file model)', async () => {
        // --profile absent → ~/.getreceipt/absent.yaml; here a deliberately-missing path → a config read error.
        const { err, error } = await runStatus(['--profile', 'absent']);
        expect(error).toMatchObject({ exitCode: 1 });
        expect(err).toContain('config file could not be read');
    });

    it('reports an empty source list (exit 0) for a file that configures no sources', async () => {
        // A readable file with no sources is not an error — there is simply nothing to report.
        const empty: ConfigParseResult = { config: { sources: {} }, warnings: [] };
        const { out, error } = await runStatus(['--json'], { loadConfig: () => empty });
        expect(error).toBeUndefined();
        expect((JSON.parse(out) as StatusReport).sources).toEqual([]);
    });
});
