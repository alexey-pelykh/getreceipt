// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fromCredentialContext, parseConfig, Secret } from '@getreceipt/auth';
import { BUNDLED_ADAPTERS } from '@getreceipt/cli';
import { SourceAdapterRegistry, SourceResolver } from '@getreceipt/core';
import type { CollectRequest, CollectResult, SourceAdapter } from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import type { LivePlan } from './live/gate.js';
import { runLiveCollection } from './live/harness.js';

/**
 * #152 regression — particuliers.alpiq.fr + monoprix.fr relabeled `oauth2` → `password`.
 *
 * Both are OIDC sources where the USER supplies a username + password; the authorization-code flow and
 * any internal token exchange are adapter implementation details, NOT the user's credential. #149 dropped
 * `oauth2` from the AuthKind vocabulary and #152 relabeled these two descriptors to `password`. This suite
 * locks the cross-package consequences of that relabel — the linkage no single package owns:
 *
 *   - AC3 — a single-item login `ref` config now RESOLVES for each source. The descriptor's `authKind` is
 *     the `kind` an operator writes for the source, and the config gate (`@getreceipt/auth` config.ts)
 *     rejects a single-item `ref` for any non-`password` kind; while these read `oauth2` the `ref` threw.
 *   - AC4 — the fenced `live/` oracle (`runLiveCollection`) labels the user-supplied username+password with
 *     `descriptor.authKind`. Driving it against the REAL bundled adapter proves the descriptor names the
 *     user's credential shape, not the internal OIDC exchange — the fake-adapter harness self-test
 *     (`live/harness.test.ts`) hardcodes `authKind`, so it cannot prove this for the real sources.
 *
 * The two domains are named EXPLICITLY rather than filtered by `authKind`: a revert of either descriptor
 * to a non-`password` kind must FAIL here, not silently drop out of a filtered set (degenerate subject).
 */
const RELABELED_SOURCES = ['monoprix.fr', 'particuliers.alpiq.fr'] as const;

function bundledAdapterFor(domain: string): SourceAdapter {
    const adapter = BUNDLED_ADAPTERS.find((candidate) => candidate.descriptor.canonicalDomain === domain);
    if (adapter === undefined) {
        throw new Error(`expected "${domain}" to be a bundled adapter`);
    }
    return adapter;
}

/** A resolver over exactly the one real bundled adapter under test — the live oracle resolves the source through it. */
function resolverFor(adapter: SourceAdapter): SourceResolver {
    const registry = new SourceAdapterRegistry();
    registry.register(adapter);
    return new SourceResolver(registry);
}

function succeededResult(source: string): CollectResult {
    return {
        outcome: 'succeeded',
        source,
        window: { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-04-01T00:00:00Z') },
        written: [{ id: 'r1', issuedAt: new Date('2026-02-01T00:00:00Z'), title: 'Receipt' }],
        skipped: [],
    };
}

describe('#152 — alpiq + monoprix are password sources (oauth2 → password relabel)', () => {
    it.each(RELABELED_SOURCES)('%s declares authKind: password (the relabel target)', (domain) => {
        expect(bundledAdapterFor(domain).descriptor.authKind).toBe('password');
    });

    // AC3: a single-item login `ref` config resolves — the `kind !== 'password'` throw no longer fires.
    it.each(RELABELED_SOURCES)('%s: a single-item login `ref` config resolves', (domain) => {
        const { authKind } = bundledAdapterFor(domain).descriptor;
        const { config, warnings } = parseConfig({
            sources: { [domain]: { auth: { kind: authKind, ref: 'op://Vault/Item' } } },
        });

        expect(warnings).toEqual([]);
        expect(config.sources[domain]?.kind).toBe('password');
        expect(config.sources[domain]?.ref).toBe('op://Vault/Item');
    });

    // AC4: the fenced live/ oracle packs the user-supplied username+password under descriptor.authKind.
    it.each(RELABELED_SOURCES)(
        '%s: the live oracle labels the user-supplied username+password as `password`',
        async (domain) => {
            const plan: LivePlan = {
                source: domain,
                username: 'user@example.test',
                secret: { ref: 'op://Vault/Item/password' },
            };
            let captured: CollectRequest | undefined;

            const run = await runLiveCollection(plan, {
                resolver: resolverFor(bundledAdapterFor(domain)),
                // No `op`, no network: resolve each reference to a distinct sentinel so a passed-through
                // reference (vs a resolved value) would be detectable.
                resolveCredential: async (value) =>
                    new Secret(typeof value === 'string' ? value : `resolved:${value.ref}`),
                collect: async (request) => {
                    captured = request;
                    return succeededResult(domain);
                },
                createOutDir: () => mkdtemp(join(tmpdir(), 'gr-152-')),
            });

            // The oracle resolved the REAL bundled adapter and packed the credential context with its
            // descriptor authKind — `password` — carrying the user-supplied username + secret through.
            const packed = fromCredentialContext(captured!.credentials);
            expect(packed.kind).toBe('password');
            expect(packed.username).toBe('user@example.test');
            expect(packed.secret?.expose()).toBe('resolved:op://Vault/Item/password');
            expect(run.source).toBe(domain);
        },
    );
});
