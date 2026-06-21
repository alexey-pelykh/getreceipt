// SPDX-License-Identifier: AGPL-3.0-only
import { grandfraisAdapter } from '@getreceipt/adapter-grandfrais';
import { monoprixAdapter } from '@getreceipt/adapter-monoprix';
import { SourceAdapterRegistry, SourceResolver } from '@getreceipt/core';
import type { SourceAdapter } from '@getreceipt/core';

/**
 * Every source adapter the CLI ships with, in a stable registration order (the order
 * `sources`/`status` list them in). This is the single place adapters are wired into the
 * front-end: adding a source means adding it here, and every verb — `from`, `all`,
 * `sources`, `status` — picks it up. Tests inject their own resolver instead.
 */
export const BUNDLED_ADAPTERS: readonly SourceAdapter[] = [grandfraisAdapter, monoprixAdapter];

/** Build a registry holding the given adapters (defaults to {@link BUNDLED_ADAPTERS}). */
export function createDefaultRegistry(adapters: readonly SourceAdapter[] = BUNDLED_ADAPTERS): SourceAdapterRegistry {
    const registry = new SourceAdapterRegistry();
    for (const adapter of adapters) {
        registry.register(adapter);
    }
    return registry;
}

/** Build a resolver over the bundled adapters — the production default for every collection verb. */
export function createDefaultResolver(): SourceResolver {
    return new SourceResolver(createDefaultRegistry());
}
