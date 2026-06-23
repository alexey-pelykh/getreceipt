// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { listSources, SourceAdapterRegistry } from './index.js';
import type { SourceAdapter, SourceDescriptor, SourceVerification } from './index.js';

/** A descriptor-only adapter; the three stages throw because listSources only reads the descriptor. */
function fakeAdapter(canonicalDomain: string, descriptor: Partial<SourceDescriptor> = {}): SourceAdapter {
    const unusedStage = (): never => {
        throw new Error('adapter stage must not be invoked in listSources tests');
    };
    return {
        descriptor: {
            canonicalDomain,
            aliasDomains: [],
            authKind: 'password',
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
            defaultWindow: { days: 90 },
            pagination: 'none',
            ...descriptor,
        },
        authenticate: unusedStage,
        list: unusedStage,
        fetch: unusedStage,
    };
}

describe('listSources', () => {
    it('returns an empty listing for an empty registry', () => {
        expect(listSources(new SourceAdapterRegistry())).toEqual([]);
    });

    it('surfaces each source with its key capabilities and defaults to unverified', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(
            fakeAdapter('free.fr', {
                aliasDomains: ['adsl.free.fr'],
                authKind: 'oauth2',
                transportTier: 'headless-browser',
                artifactMode: 'rendered',
            }),
        );

        expect(listSources(registry)).toEqual([
            {
                canonicalDomain: 'free.fr',
                aliasDomains: ['adsl.free.fr'],
                authKind: 'oauth2',
                transportTier: 'headless-browser',
                artifactMode: 'rendered',
                verificationState: 'unverified',
            },
        ]);
    });

    it('preserves registration order', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(fakeAdapter('a.test'));
        registry.register(fakeAdapter('b.test'));

        expect(listSources(registry).map((listing) => listing.canonicalDomain)).toEqual(['a.test', 'b.test']);
    });

    it('surfaces the verification state from the lookup, defaulting unknown domains to unverified', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(fakeAdapter('verified.test'));
        registry.register(fakeAdapter('stale.test'));
        registry.register(fakeAdapter('unknown.test'));

        const now = new Date('2026-06-23T00:00:00Z');
        const records: Record<string, SourceVerification> = {
            // Within the default horizon → stays e2e-verified.
            'verified.test': { state: 'e2e-verified', lastVerifiedAt: new Date('2026-06-20T00:00:00Z') },
            'stale.test': { state: 'stale' },
        };
        const lookup = (domain: string): SourceVerification | undefined => records[domain];

        expect(
            listSources(registry, lookup, { now }).map((listing) => [
                listing.canonicalDomain,
                listing.verificationState,
            ]),
        ).toEqual([
            ['verified.test', 'e2e-verified'],
            ['stale.test', 'stale'],
            ['unknown.test', 'unverified'],
        ]);
    });

    it('decays an e2e-verified source to stale once its last-verified date ages past the horizon (#90)', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(fakeAdapter('aging.test'));

        const verifiedAt = new Date('2026-01-01T00:00:00Z');
        const lookup = (): SourceVerification => ({ state: 'e2e-verified', lastVerifiedAt: verifiedAt });

        // One day after verification: fresh.
        expect(listSources(registry, lookup, { now: new Date('2026-01-02T00:00:00Z') })[0]?.verificationState).toBe(
            'e2e-verified',
        );
        // 60 days after verification (> 30-day default horizon): decayed to stale.
        expect(listSources(registry, lookup, { now: new Date('2026-03-02T00:00:00Z') })[0]?.verificationState).toBe(
            'stale',
        );
    });

    it('ships the last-verified date as ISO when recorded, and omits it when never verified (#90)', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(fakeAdapter('dated.test'));
        registry.register(fakeAdapter('never.test'));

        const verifiedAt = new Date('2026-06-20T08:30:00Z');
        const lookup = (domain: string): SourceVerification | undefined =>
            domain === 'dated.test' ? { state: 'e2e-verified', lastVerifiedAt: verifiedAt } : undefined;

        const [dated, never] = listSources(registry, lookup, { now: new Date('2026-06-23T00:00:00Z') });
        expect(dated?.lastVerifiedAt).toBe('2026-06-20T08:30:00.000Z');
        // Never-verified ships no date at all (exactOptionalPropertyTypes: the key is absent, not undefined).
        expect(never !== undefined && 'lastVerifiedAt' in never).toBe(false);
    });
});
