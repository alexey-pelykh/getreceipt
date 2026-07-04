// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configuredCredentialShapes, fromCredentialContext, parseConfig, Secret } from '@getreceipt/auth';
import type { DomainAuthConfig } from '@getreceipt/auth';
import { BUNDLED_ADAPTERS } from '@getreceipt/cli';
import {
    resolveCredentialShape,
    SourceAdapterRegistry,
    SourceResolver,
    UnsupportedCredentialShapeError,
} from '@getreceipt/core';
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
                kind: 'password',
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

/**
 * #169 — every shipped adapter declares its supported credential shape(s), and the core fail-closed
 * gate accepts a representative good config while rejecting a bad one. Sources are named EXPLICITLY (not
 * filtered from BUNDLED_ADAPTERS) so a dropped or misdeclared adapter FAILS here rather than silently
 * leaving a filtered set (degenerate subject); a coverage guard asserts the bundle is exactly the union
 * below. The password sources each drive a good/bad pair through the REAL descriptor projection
 * (`configuredCredentialShapes`) and the REAL gate (`resolveCredentialShape`) — the cross-package
 * linkage no single package owns.
 *
 * #181 splits out the FIRST session-kind source (Amazon — canonical `amazon.com` since #226): it imports a
 * browser session and supplies NO credential, so it declares `credentialShapes: ['none']` and the
 * operation-runner bypasses the #169 password gate for it. The password-shape assertions below therefore run
 * over {@link PASSWORD_SOURCES} only; {@link SESSION_SOURCES} get their own posture assertion. Both are named
 * explicitly so a revert (a session source regaining a password shape, or vice versa) FAILS here rather than
 * slipping through.
 */
const PASSWORD_SOURCES = ['free.fr', 'grandfrais.com', 'monoprix.fr', 'particuliers.alpiq.fr', 'pro.free.fr'] as const;
// The session sources: amazon (canonical amazon.com per ADR-008 / #226, not the amazon.fr marketplace instance)
// and mobile.free.fr (Free Mobile, session-import, #125). Each imports a browser session and supplies no credential.
const SESSION_SOURCES = ['amazon.com', 'mobile.free.fr'] as const;
/** Every shipped source — the bundle must be EXACTLY this union (the coverage guard below). */
const SHIPPED_SOURCES = [...PASSWORD_SOURCES, ...SESSION_SOURCES] as const;

/** Parse one source's `auth` block into its typed config (the domain was just inserted, so it resolves). */
function shippedSourceConfig(domain: string, auth: unknown): DomainAuthConfig {
    const config = parseConfig({ sources: { [domain]: { auth } } }).config.sources[domain];
    if (config === undefined) {
        throw new Error(`expected a parsed config for "${domain}"`);
    }
    return config;
}

describe('#169 — shipped adapters declare a credential shape the fail-closed gate enforces', () => {
    it('the bundled set is exactly the shipped sources (no adapter silently dropped)', () => {
        const bundled = BUNDLED_ADAPTERS.map((adapter) => adapter.descriptor.canonicalDomain).sort();
        expect(bundled).toEqual([...SHIPPED_SOURCES].sort());
    });

    it.each(PASSWORD_SOURCES)('%s declares a non-empty credentialShapes set that includes password', (domain) => {
        const { credentialShapes } = bundledAdapterFor(domain).descriptor;
        expect(credentialShapes.length).toBeGreaterThan(0);
        expect(credentialShapes).toContain('password');
    });

    // Good: a single-item password login resolves to `password` through the real descriptor + gate.
    it.each(PASSWORD_SOURCES)('%s: a representative password config passes the shape gate', (domain) => {
        const adapter = bundledAdapterFor(domain);
        const config = shippedSourceConfig(domain, { ref: 'op://Vault/Item' });
        expect(resolveCredentialShape(adapter.descriptor, configuredCredentialShapes(config))).toBe('password');
    });

    // Bad: an explicit api-token config against a password-only adapter is rejected fail-closed.
    it.each(PASSWORD_SOURCES)('%s: an api-token config is rejected fail-closed', (domain) => {
        const adapter = bundledAdapterFor(domain);
        const config = shippedSourceConfig(domain, { kind: 'api-token', secret: { ref: 'op://Vault/Item' } });
        expect(() => resolveCredentialShape(adapter.descriptor, configuredCredentialShapes(config))).toThrow(
            UnsupportedCredentialShapeError,
        );
    });
});

describe('#181 — the session sources declare no credential shape (bypass the #169 password gate)', () => {
    // Each session source (amazon canonical amazon.com since #226; mobile.free.fr since #125) imports a browser
    // session and supplies no credential; the field is required + non-empty, so it declares exactly ['none']. A
    // revert to a password shape (or an added api-token shape) FAILS here.
    it.each(SESSION_SOURCES)('%s declares authKind: session with credentialShapes ["none"]', (domain) => {
        const { authKind, credentialShapes } = bundledAdapterFor(domain).descriptor;
        expect(authKind).toBe('session');
        expect(credentialShapes).toEqual(['none']);
    });
});
