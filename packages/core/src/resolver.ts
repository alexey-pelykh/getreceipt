// SPDX-License-Identifier: AGPL-3.0-only
import { normalizeDomain } from './domain.js';
import { DuplicateSourceError, UnknownSourceError } from './errors.js';
import type { SourceAdapterRegistry } from './registry.js';
import type { SourceAdapter } from './source-adapter.js';

/**
 * Resolves a requested domain — canonical OR alias — to its owning adapter.
 *
 * Built once from a {@link SourceAdapterRegistry}: it indexes every adapter's
 * canonical and alias domains up front, so resolution is O(1) and any alias
 * collision (two adapters claiming the same domain) surfaces eagerly at
 * construction rather than silently at lookup time.
 */
export class SourceResolver {
    readonly #byDomain = new Map<string, SourceAdapter>();

    constructor(registry: SourceAdapterRegistry) {
        for (const adapter of registry.all()) {
            this.#index(adapter.descriptor.canonicalDomain, adapter);
            for (const alias of adapter.descriptor.aliasDomains) {
                this.#index(alias, adapter);
            }
        }
    }

    /**
     * Index `domain` → `adapter`, rejecting only a true collision: a domain already
     * claimed by a DIFFERENT adapter. The `existing !== adapter` guard deliberately
     * tolerates a domain repeated by the SAME adapter — a self-alias (canonical listed
     * in its own `aliasDomains`) or a duplicated alias entry — because re-indexing the
     * same adapter is idempotent. Linting such redundant descriptors belongs to the
     * concrete adapters once they land (#4+), not to this routing layer.
     */
    #index(domain: string, adapter: SourceAdapter): void {
        const normalized = normalizeDomain(domain);
        const existing = this.#byDomain.get(normalized);
        if (existing !== undefined && existing !== adapter) {
            throw new DuplicateSourceError(normalized);
        }
        this.#byDomain.set(normalized, adapter);
    }

    /**
     * Resolve a canonical or alias domain to its adapter.
     * @throws {@link UnknownSourceError} if no adapter claims the domain.
     */
    resolve(domain: string): SourceAdapter {
        const adapter = this.tryResolve(domain);
        if (adapter === undefined) {
            throw new UnknownSourceError(normalizeDomain(domain));
        }
        return adapter;
    }

    /** Like {@link resolve}, but returns `undefined` instead of throwing on an unknown domain. */
    tryResolve(domain: string): SourceAdapter | undefined {
        return this.#byDomain.get(normalizeDomain(domain));
    }
}
