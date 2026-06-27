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
            credentialShapes: ['password'],
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

describe('SourceResolver — multi-instance fan-out (#190)', () => {
    const amazon = (): SourceAdapter =>
        fakeAdapter('amazon.fr', [], {
            instances: [
                { domain: 'amazon.fr', host: 'https://www.amazon.fr', cookieDomain: 'amazon.fr', locale: 'fr-FR' },
                { domain: 'amazon.com', host: 'https://www.amazon.com', cookieDomain: 'amazon.com', locale: 'en-US' },
            ],
        });

    it('resolves each instance domain to the same adapter paired with its own context', () => {
        const registry = new SourceAdapterRegistry();
        const adapter = amazon();
        registry.register(adapter);
        const resolver = new SourceResolver(registry);

        const fr = resolver.resolveInstance('amazon.fr');
        const com = resolver.resolveInstance('amazon.com');

        expect(fr.adapter).toBe(adapter);
        expect(com.adapter).toBe(adapter);
        expect(fr.instance?.host).toBe('https://www.amazon.fr');
        expect(fr.instance?.locale).toBe('fr-FR');
        expect(com.instance?.host).toBe('https://www.amazon.com');
        expect(com.instance?.locale).toBe('en-US');
    });

    it('resolves a canonical domain that is itself an instance to its own context (not a bare entry)', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(amazon());
        const resolver = new SourceResolver(registry);

        // amazon.fr is BOTH the canonical and an instance; the instance context must win over the bare entry.
        expect(resolver.resolveInstance('amazon.fr').instance?.cookieDomain).toBe('amazon.fr');
    });

    it('resolves an instance domain case-insensitively', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(amazon());
        const resolver = new SourceResolver(registry);

        expect(resolver.resolveInstance('AMAZON.COM').instance?.domain).toBe('amazon.com');
    });

    it('returns no instance for a single-instance source (canonical resolves bare)', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(fakeAdapter('free.fr', ['adsl.free.fr']));
        const resolver = new SourceResolver(registry);

        expect(resolver.resolveInstance('free.fr').instance).toBeUndefined();
        expect(resolver.resolveInstance('adsl.free.fr').instance).toBeUndefined();
    });

    it('keeps resolve()/tryResolve() returning just the adapter (backward-compatible)', () => {
        const registry = new SourceAdapterRegistry();
        const adapter = amazon();
        registry.register(adapter);
        const resolver = new SourceResolver(registry);

        expect(resolver.resolve('amazon.com')).toBe(adapter);
        expect(resolver.tryResolve('amazon.com')).toBe(adapter);
    });

    it('tryResolveInstance returns undefined for an unknown domain', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(amazon());
        const resolver = new SourceResolver(registry);

        expect(resolver.tryResolveInstance('amazon.de')).toBeUndefined();
    });

    it('rejects construction when an instance domain collides with another adapter', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(amazon());
        registry.register(fakeAdapter('shop.test', ['amazon.com']));

        expect(() => new SourceResolver(registry)).toThrow(DuplicateSourceError);
    });
});
