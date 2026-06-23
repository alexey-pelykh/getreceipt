// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { DuplicateSourceError, SourceAdapterRegistry, SourceResolver, UnknownSourceError } from './index.js';
import type { SourceAdapter, SourceDescriptor } from './index.js';

/**
 * Build a {@link SourceAdapter} whose three stages throw if called — the registry
 * and resolver only ever read the DECLARED descriptor (canonical + alias domains),
 * never the implemented stages, so stubbing them keeps each test focused on routing.
 */
function fakeAdapter(
    canonicalDomain: string,
    aliasDomains: readonly string[] = [],
    descriptor: Partial<SourceDescriptor> = {},
): SourceAdapter {
    const unusedStage = (): never => {
        throw new Error('adapter stage must not be invoked in registry/resolver tests');
    };
    return {
        descriptor: {
            canonicalDomain,
            aliasDomains,
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

describe('SourceAdapterRegistry', () => {
    it('registers and looks up an adapter by its canonical domain', () => {
        const registry = new SourceAdapterRegistry();
        const adapter = fakeAdapter('free.fr');

        registry.register(adapter);

        expect(registry.get('free.fr')).toBe(adapter);
        expect(registry.has('free.fr')).toBe(true);
    });

    it('looks up case-insensitively and ignores surrounding whitespace', () => {
        const registry = new SourceAdapterRegistry();
        const adapter = fakeAdapter('Free.FR');

        registry.register(adapter);

        expect(registry.get('  free.fr  ')).toBe(adapter);
        expect(registry.has('FREE.fr')).toBe(true);
    });

    it('returns undefined / false for an unregistered canonical domain', () => {
        const registry = new SourceAdapterRegistry();

        expect(registry.get('unknown.test')).toBeUndefined();
        expect(registry.has('unknown.test')).toBe(false);
    });

    it('rejects a second adapter claiming the same canonical domain', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(fakeAdapter('free.fr'));

        expect(() => registry.register(fakeAdapter('FREE.FR'))).toThrow(DuplicateSourceError);
    });

    it('exposes every registered adapter in registration order', () => {
        const registry = new SourceAdapterRegistry();
        const first = fakeAdapter('a.test');
        const second = fakeAdapter('b.test');
        registry.register(first);
        registry.register(second);

        expect(registry.all()).toEqual([first, second]);
    });
});

describe('SourceResolver', () => {
    it('resolves a canonical domain to its adapter', () => {
        const registry = new SourceAdapterRegistry();
        const adapter = fakeAdapter('free.fr', ['adsl.free.fr']);
        registry.register(adapter);
        const resolver = new SourceResolver(registry);

        expect(resolver.resolve('free.fr')).toBe(adapter);
    });

    it('resolves an alias domain to its canonical adapter', () => {
        const registry = new SourceAdapterRegistry();
        const adapter = fakeAdapter('free.fr', ['adsl.free.fr', 'www.free.fr']);
        registry.register(adapter);
        const resolver = new SourceResolver(registry);

        expect(resolver.resolve('adsl.free.fr')).toBe(adapter);
        expect(resolver.resolve('www.free.fr')).toBe(adapter);
    });

    it('resolves canonical and alias domains case-insensitively', () => {
        const registry = new SourceAdapterRegistry();
        const adapter = fakeAdapter('free.fr', ['Adsl.Free.FR']);
        registry.register(adapter);
        const resolver = new SourceResolver(registry);

        expect(resolver.resolve('ADSL.free.fr')).toBe(adapter);
    });

    it('throws a typed UnknownSourceError carrying the normalized domain', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(fakeAdapter('free.fr'));
        const resolver = new SourceResolver(registry);

        expect(() => resolver.resolve('orange.fr')).toThrow(UnknownSourceError);

        let caught: unknown;
        try {
            resolver.resolve('Orange.FR');
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(UnknownSourceError);
        expect((caught as UnknownSourceError).domain).toBe('orange.fr');
    });

    it('returns undefined from tryResolve for an unknown domain', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(fakeAdapter('free.fr'));
        const resolver = new SourceResolver(registry);

        expect(resolver.tryResolve('orange.fr')).toBeUndefined();
        expect(resolver.tryResolve('free.fr')).toBeDefined();
    });

    it('returns undefined from tryResolve when built over an empty registry', () => {
        const resolver = new SourceResolver(new SourceAdapterRegistry());

        expect(resolver.tryResolve('free.fr')).toBeUndefined();
    });

    it('rejects construction when two adapters claim the same alias', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(fakeAdapter('free.fr', ['shared.test']));
        registry.register(fakeAdapter('orange.fr', ['shared.test']));

        expect(() => new SourceResolver(registry)).toThrow(DuplicateSourceError);
    });

    it('rejects construction when one adapter alias collides with another canonical domain', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(fakeAdapter('free.fr'));
        registry.register(fakeAdapter('orange.fr', ['free.fr']));

        expect(() => new SourceResolver(registry)).toThrow(DuplicateSourceError);
    });

    it('tolerates an adapter that lists its own canonical domain as an alias', () => {
        const registry = new SourceAdapterRegistry();
        const adapter = fakeAdapter('free.fr', ['free.fr']);
        registry.register(adapter);

        // Construction would throw DuplicateSourceError if the self-alias were not tolerated.
        const resolver = new SourceResolver(registry);

        expect(resolver.resolve('free.fr')).toBe(adapter);
    });

    it('tolerates a duplicate alias repeated within a single adapter', () => {
        const registry = new SourceAdapterRegistry();
        const adapter = fakeAdapter('free.fr', ['adsl.free.fr', 'adsl.free.fr']);
        registry.register(adapter);

        const resolver = new SourceResolver(registry);

        expect(resolver.resolve('adsl.free.fr')).toBe(adapter);
    });
});
