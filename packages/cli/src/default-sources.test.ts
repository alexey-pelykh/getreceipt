// SPDX-License-Identifier: AGPL-3.0-only
import { UnknownSourceError } from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import { BUNDLED_ADAPTERS, createDefaultRegistry, createDefaultResolver } from './default-sources.js';

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
});
