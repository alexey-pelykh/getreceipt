// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { listSources, SourceAdapterRegistry } from './index.js';
import type { AdapterVerificationState, SourceAdapter, SourceDescriptor } from './index.js';

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
                aliasDomains: ['pro.free.fr'],
                authKind: 'oauth2',
                transportTier: 'headless-browser',
                artifactMode: 'rendered',
            }),
        );

        expect(listSources(registry)).toEqual([
            {
                canonicalDomain: 'free.fr',
                aliasDomains: ['pro.free.fr'],
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

        const states: Record<string, AdapterVerificationState> = {
            'verified.test': 'e2e-verified',
            'stale.test': 'stale',
        };
        const lookup = (domain: string): AdapterVerificationState | undefined => states[domain];

        expect(
            listSources(registry, lookup).map((listing) => [listing.canonicalDomain, listing.verificationState]),
        ).toEqual([
            ['verified.test', 'e2e-verified'],
            ['stale.test', 'stale'],
            ['unknown.test', 'unverified'],
        ]);
    });
});
