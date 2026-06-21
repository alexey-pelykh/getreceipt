// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url';

import { scanForSecrets } from '@getreceipt/auth';
import type { ConfigParseResult } from '@getreceipt/auth';
import { SourceAdapterRegistry } from '@getreceipt/core';
import type {
    AdapterVerificationState,
    ArtifactHandle,
    ArtifactMode,
    AuthHandle,
    AuthKind,
    SourceAdapter,
    TransportTier,
} from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import { createSourcesCommand } from './sources-command.js';
import type { SourcesCommandEnv } from './sources-command.js';
import type { SourcesReport } from './sources-render.js';

const configFixture = fileURLToPath(new URL('./__fixtures__/multi.getreceipt.yaml', import.meta.url));

/** A descriptor-only adapter — `sources` reads only the descriptor (never invokes a stage). */
function fakeAdapter(
    canonicalDomain: string,
    options: {
        aliases?: readonly string[];
        authKind?: AuthKind;
        transport?: TransportTier;
        artifact?: ArtifactMode;
    } = {},
): SourceAdapter {
    return {
        descriptor: {
            canonicalDomain,
            aliasDomains: options.aliases ?? [],
            authKind: options.authKind ?? 'password',
            transportTier: options.transport ?? 'http-api',
            artifactMode: options.artifact ?? 'pdf-download',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
            defaultWindow: { days: 30 },
            pagination: 'none',
        },
        authenticate: async () => ({}) as unknown as AuthHandle,
        list: async () => [],
        fetch: async () => ({}) as unknown as ArtifactHandle,
    };
}

/** Registry with `shop.example` (configured in the fixture) + `store.example` (registered but NOT configured). */
function registryWithTwo(): SourceAdapterRegistry {
    const registry = new SourceAdapterRegistry();
    registry.register(fakeAdapter('shop.example', { aliases: ['www.shop.example'] }));
    registry.register(fakeAdapter('store.example'));
    return registry;
}

interface RunResult {
    out: string;
    err: string;
    error: unknown;
}

async function runSources(args: string[], overrides: Partial<SourcesCommandEnv> = {}): Promise<RunResult> {
    const out: string[] = [];
    const err: string[] = [];
    const env: Partial<SourcesCommandEnv> = {
        io: { writeOut: (t) => out.push(t), writeErr: (t) => err.push(t) },
        resolveConfigPath: () => configFixture,
        registry: registryWithTwo(),
        ...overrides,
    };
    const cmd = createSourcesCommand(env);
    cmd.exitOverride();

    let error: unknown;
    try {
        await cmd.parseAsync([...args], { from: 'user' });
    } catch (caught) {
        error = caught;
    }
    return { out: out.join(''), err: err.join(''), error };
}

describe('sources — lists available sources with verification + configured state (AC #2)', () => {
    it('lists every registered adapter with capabilities and marks configured-state per profile', async () => {
        const { out, error } = await runSources([]);

        expect(error).toBeUndefined();
        expect(out).toContain('sources (profile: default)');
        // shop.example is configured under `default`; store.example is registered but not configured.
        expect(out).toMatch(/shop\.example.*configured/);
        expect(out).toMatch(/store\.example.*not-configured/);
        // capabilities + verification state are surfaced.
        expect(out).toContain('http-api');
        expect(out).toContain('unverified');
        // declared aliases appear.
        expect(out).toContain('aliases: www.shop.example');
    });

    it('emits a structured report under --json', async () => {
        const { out, error } = await runSources(['--json']);
        expect(error).toBeUndefined();

        const report = JSON.parse(out) as SourcesReport;
        expect(report.profile).toBe('default');
        const byDomain = Object.fromEntries(report.sources.map((s) => [s.canonicalDomain, s]));
        expect(byDomain['shop.example']?.configured).toBe(true);
        expect(byDomain['store.example']?.configured).toBe(false);
        expect(byDomain['shop.example']?.verificationState).toBe('unverified');
        expect(byDomain['shop.example']?.aliasDomains).toEqual(['www.shop.example']);
    });

    it('reports configured-state against the selected --profile', async () => {
        // The `work` profile configures only shop.example.
        const { out } = await runSources(['--json', '--profile', 'work']);
        const report = JSON.parse(out) as SourcesReport;
        expect(report.profile).toBe('work');
        const byDomain = Object.fromEntries(report.sources.map((s) => [s.canonicalDomain, s]));
        expect(byDomain['shop.example']?.configured).toBe(true);
        expect(byDomain['store.example']?.configured).toBe(false);
    });

    it('drives the verification-state surface from an injected lookup (AC #2)', async () => {
        const { out } = await runSources(['--json'], {
            verification: (domain) => (domain === 'shop.example' ? 'e2e-verified' : 'stale'),
        });
        const report = JSON.parse(out) as SourcesReport;
        const byDomain = Object.fromEntries(report.sources.map((s) => [s.canonicalDomain, s]));
        expect(byDomain['shop.example']?.verificationState).toBe('e2e-verified');
        expect(byDomain['store.example']?.verificationState).toBe('stale' satisfies AdapterVerificationState);
    });

    it('surfaces a verification advisory in human output for an unverified source', async () => {
        const { out } = await runSources([]);
        expect(out).toContain('⚠');
        expect(out.toLowerCase()).toContain('best-effort');
    });

    it('is non-fatal when config cannot be read: lists all as not-configured with a note (exit 0)', async () => {
        const { out, err, error } = await runSources([], {
            loadConfig: () => {
                throw new Error('boom: unreadable config');
            },
        });
        expect(error).toBeUndefined();
        expect(out).toMatch(/shop\.example.*not-configured/);
        expect(err).toContain('not-configured');
    });

    it('never emits secret-shaped output even though the config holds inline credentials', async () => {
        const inlineSecret = 'sk' + '_live_' + 'Z'.repeat(28);
        const config: ConfigParseResult = {
            config: {
                profiles: { default: { sources: { 'shop.example': { kind: 'password', secret: inlineSecret } } } },
            },
            warnings: [],
        };
        const { out } = await runSources(['--json'], { loadConfig: () => config });
        expect(out).not.toContain(inlineSecret);
        expect(scanForSecrets([{ path: 'sources-json', content: out }])).toEqual([]);
    });
});
