// SPDX-License-Identifier: AGPL-3.0-only
import { normalizeDomain } from './domain.js';
import { DuplicateSourceError, UnknownSourceError } from './errors.js';
import type { SourceAdapterRegistry } from './registry.js';
import type { InstanceContext, SourceAdapter } from './source-adapter.js';

/**
 * The outcome of resolving a domain: the owning adapter, plus the {@link InstanceContext} when the
 * domain names a specific instance of a multi-instance source (#190). `instance` is absent for a
 * single-instance source and for a multi-instance source's alias (which routes to the adapter without
 * pinning an instance).
 */
export interface ResolvedSource {
    readonly adapter: SourceAdapter;
    readonly instance?: InstanceContext;
}

/**
 * Resolves a requested domain — canonical, alias, OR instance (#190) — to its owning adapter.
 *
 * Built once from a {@link SourceAdapterRegistry}: it indexes every adapter's canonical, alias, and
 * instance domains up front, so resolution is O(1) and any collision (two adapters claiming the same
 * domain) surfaces eagerly at construction rather than silently at lookup time. An instance domain
 * resolves to the same adapter PLUS its {@link InstanceContext} — the host/locale/cookie-scope the
 * `list`/`fetch` stages run against; a plain canonical/alias resolves to the adapter alone.
 */
export class SourceResolver {
    readonly #byDomain = new Map<string, ResolvedSource>();

    constructor(registry: SourceAdapterRegistry) {
        for (const adapter of registry.all()) {
            this.#index(adapter.descriptor.canonicalDomain, { adapter });
            for (const alias of adapter.descriptor.aliasDomains) {
                this.#index(alias, { adapter });
            }
            // Index instances last so a canonical/alias that is ALSO an instance domain is upgraded to
            // carry its context (the richer entry wins — see #index).
            for (const instance of adapter.descriptor.instances ?? []) {
                this.#index(instance.domain, { adapter, instance });
            }
        }
    }

    /**
     * Index `domain` → `resolved`, rejecting only a true collision: a domain already claimed by a
     * DIFFERENT adapter. The same-adapter guard tolerates a domain repeated by the SAME adapter — a
     * self-alias, a duplicated alias, or a canonical that is also an instance — because re-indexing the
     * same adapter is idempotent. When the same adapter re-indexes a domain, the entry carrying an
     * {@link InstanceContext} wins over a bare one, so indexing the instances after the canonical/alias
     * never downgrades an instance domain to a context-less entry.
     */
    #index(domain: string, resolved: ResolvedSource): void {
        const normalized = normalizeDomain(domain);
        const existing = this.#byDomain.get(normalized);
        if (existing !== undefined && existing.adapter !== resolved.adapter) {
            throw new DuplicateSourceError(normalized);
        }
        if (existing?.instance !== undefined && resolved.instance === undefined) {
            return; // keep the richer (instance-bearing) entry
        }
        this.#byDomain.set(normalized, resolved);
    }

    /**
     * Resolve a canonical, alias, or instance domain to its adapter.
     * @throws {@link UnknownSourceError} if no adapter claims the domain.
     */
    resolve(domain: string): SourceAdapter {
        return this.resolveInstance(domain).adapter;
    }

    /** Like {@link resolve}, but returns `undefined` instead of throwing on an unknown domain. */
    tryResolve(domain: string): SourceAdapter | undefined {
        return this.tryResolveInstance(domain)?.adapter;
    }

    /**
     * Resolve a domain to its adapter AND any {@link InstanceContext} (#190) — the instance-aware form
     * the collection path uses to thread per-instance parameters into `list`/`fetch`.
     * @throws {@link UnknownSourceError} if no adapter claims the domain.
     */
    resolveInstance(domain: string): ResolvedSource {
        const resolved = this.tryResolveInstance(domain);
        if (resolved === undefined) {
            throw new UnknownSourceError(normalizeDomain(domain));
        }
        return resolved;
    }

    /** Like {@link resolveInstance}, but returns `undefined` instead of throwing on an unknown domain. */
    tryResolveInstance(domain: string): ResolvedSource | undefined {
        return this.#byDomain.get(normalizeDomain(domain));
    }
}
