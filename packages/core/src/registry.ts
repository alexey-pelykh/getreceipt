// SPDX-License-Identifier: AGPL-3.0-only
import { normalizeDomain } from './domain.js';
import { DuplicateSourceError } from './errors.js';
import type { SourceAdapter } from './source-adapter.js';

/**
 * Holds source adapters keyed by their canonical domain — the single source of
 * truth for "which adapters exist". Alias resolution is layered on top by
 * {@link SourceResolver}; the registry itself only knows canonical domains.
 */
export class SourceAdapterRegistry {
    readonly #byCanonicalDomain = new Map<string, SourceAdapter>();

    /**
     * Register an adapter under its canonical domain (case-insensitive).
     * @throws {@link DuplicateSourceError} if that canonical domain is already taken.
     */
    register(adapter: SourceAdapter): void {
        const domain = normalizeDomain(adapter.descriptor.canonicalDomain);
        if (this.#byCanonicalDomain.has(domain)) {
            throw new DuplicateSourceError(domain);
        }
        this.#byCanonicalDomain.set(domain, adapter);
    }

    /** Look up an adapter by its canonical domain (case-insensitive), or `undefined` if none is registered. */
    get(canonicalDomain: string): SourceAdapter | undefined {
        return this.#byCanonicalDomain.get(normalizeDomain(canonicalDomain));
    }

    /** Whether an adapter is registered under the given canonical domain. */
    has(canonicalDomain: string): boolean {
        return this.#byCanonicalDomain.has(normalizeDomain(canonicalDomain));
    }

    /** Every registered adapter, in registration order. */
    all(): readonly SourceAdapter[] {
        return [...this.#byCanonicalDomain.values()];
    }
}
