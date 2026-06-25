// SPDX-License-Identifier: AGPL-3.0-only
import { listSources, UnknownSourceError } from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import { BUNDLED_ADAPTERS, createDefaultRegistry, createDefaultResolver } from './default-sources.js';
import { defaultListSourcesDeps } from './operations.js';

describe('default-sources — bundled adapter wiring', () => {
    it('bundles the shipped concrete adapters (grandfrais.com, monoprix.fr)', () => {
        const domains = BUNDLED_ADAPTERS.map((adapter) => adapter.descriptor.canonicalDomain);
        expect(domains).toContain('grandfrais.com');
        expect(domains).toContain('monoprix.fr');
    });

    it('builds a registry holding every bundled adapter (NOT the empty registry the scaffold shipped)', () => {
        const registry = createDefaultRegistry();
        expect(registry.all()).toHaveLength(BUNDLED_ADAPTERS.length);
        expect(registry.has('grandfrais.com')).toBe(true);
        expect(registry.has('monoprix.fr')).toBe(true);
    });

    it('builds a resolver that resolves every bundled adapter by canonical domain (case-insensitively)', () => {
        const resolver = createDefaultResolver();
        expect(resolver.resolve('grandfrais.com').descriptor.canonicalDomain).toBe('grandfrais.com');
        expect(resolver.resolve('monoprix.fr').descriptor.canonicalDomain).toBe('monoprix.fr');
        // Case-insensitive normalization is wired through the bundled resolver (neither bundled adapter
        // declares subdomain aliases; alias indexing is covered in the resolver + sources-command suites).
        expect(resolver.resolve('MONOPRIX.fr').descriptor.canonicalDomain).toBe('monoprix.fr');
    });

    it('rejects an unknown domain through the bundled resolver', () => {
        expect(() => createDefaultResolver().resolve('no-such.example')).toThrow(UnknownSourceError);
    });

    it('surfaces every bundled adapter as `unverified` by default — verification is the live oracle, not collect (#144)', () => {
        // No production VerificationLookup is wired (it is fed only by the fenced live conformance oracle,
        // never by a user's collect), so the honest 0.1.0 state is `unverified` for every shipped source.
        // This locks that no fabricated verified state leaks into the default surface.
        const listings = listSources(createDefaultRegistry());
        expect(listings).toHaveLength(BUNDLED_ADAPTERS.length);
        for (const listing of listings) {
            expect(listing.verificationState).toBe('unverified');
            expect('lastVerifiedAt' in listing).toBe(false);
        }
    });

    it('wires NO verification lookup in the production `sources` deps — a tripwire for the deferred ledger bridge (#144)', () => {
        // Today nothing is wired, so the surface is honestly all-`unverified`. When the live oracle's
        // verdict is later persisted to a committed ledger and read back, THIS is where a lookup appears —
        // and whoever wires it must confirm it reads that committed ledger, never a user's collect.
        expect(defaultListSourcesDeps().verification).toBeUndefined();
    });
});
