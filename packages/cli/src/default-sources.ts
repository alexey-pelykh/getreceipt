// SPDX-License-Identifier: AGPL-3.0-only
import { AmazonFrAdapter, ENDPOINTS as amazonEndpoints } from '@getreceipt/adapter-amazon-fr';
import { freeFrAdapter } from '@getreceipt/adapter-free-fr';
import { grandfraisAdapter } from '@getreceipt/adapter-grandfrais-com';
import { ENDPOINTS, MonoprixAdapter } from '@getreceipt/adapter-monoprix-fr';
import { particuliersAlpiqFrAdapter } from '@getreceipt/adapter-particuliers-alpiq-fr';
import { proFreeFrAdapter } from '@getreceipt/adapter-pro-free-fr';
import { SourceAdapterRegistry, SourceResolver } from '@getreceipt/core';
import type { SourceAdapter } from '@getreceipt/core';
import { createImpersonatingTransport } from '@getreceipt/transport-impersonate';

import { defaultReadableSessionStore } from './sessions.js';

/**
 * Construct the bundled adapters fresh, wiring each anti-bot-gated source with the transport its
 * descriptor demands. This is the production composition root — `createDefaultResolver()` (every
 * collection verb) and the live conformance harness both build on it, so injecting here fixes the
 * shipped CLI/MCP *and* the live oracle in one move (#101).
 *
 * monoprix's collection host (`client.monoprix.fr`) is Cloudflare-gated on the TLS/HTTP-2 fingerprint,
 * so it is driven by a Chrome-impersonating transport SCOPED to exactly that host (read from the wire
 * contract's `apiOrigin` — single source of truth); auth (`sso.monoprix.fr`) and every other host fall
 * through to plain `fetch`, keeping the live-validated OIDC flow off the native path. amazon.fr's order
 * host (`www.amazon.fr`) is likewise fingerprint-gated, so it too runs over a Chrome-impersonating
 * transport scoped to that host (read from its wire `origin`); its session is the user's imported browser
 * cookies, never a login (#181). grandfrais, free.fr, and pro.free.fr are not impersonation-wired and stay
 * on plain `fetch` — pro.free.fr's cookie session in particular is INCOMPATIBLE with the impersonating
 * transport (it drops Set-Cookie; see its adapter). The `requiresImpersonation` wiring gate
 * (impersonation-gate.test.ts) asserts every source DECLARING the need is actually constructed this way.
 */
export function buildBundledAdapters(): readonly SourceAdapter[] {
    const monoprix = new MonoprixAdapter({
        transport: createImpersonatingTransport({ impersonateHosts: [new URL(ENDPOINTS.apiOrigin).host] }),
    });
    // amazon is also wired with opt-in at-rest session reuse (#189): the readable session store skips the
    // browser cookie read when a still-fresh session was stored by `login amazon.fr`. The store is NULL until
    // that first login creates the sessions dir, so an un-logged-in run imports fresh (the basic per-run path).
    const amazon = new AmazonFrAdapter({
        transport: createImpersonatingTransport({ impersonateHosts: [new URL(amazonEndpoints.origin).host] }),
        sessionReuse: { store: defaultReadableSessionStore() },
    });
    return [grandfraisAdapter, monoprix, freeFrAdapter, proFreeFrAdapter, particuliersAlpiqFrAdapter, amazon];
}

/**
 * Every source adapter the CLI ships with, in a stable registration order (the order `sources`/`status`
 * list them in). Built once via {@link buildBundledAdapters}. Tests inject their own resolver instead.
 */
export const BUNDLED_ADAPTERS: readonly SourceAdapter[] = buildBundledAdapters();

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
