// SPDX-License-Identifier: AGPL-3.0-only
import { InMemoryKeyring, KeyringSessionStore, ReauthDetector, reuseStoredSession, Secret } from '@getreceipt/auth';
import type { SessionStore } from '@getreceipt/auth';
import { SourceAdapterRegistry, SourceResolver } from '@getreceipt/core';
import type { ArtifactHandle, AuthHandle, ReceiptRef, SourceAdapter } from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import { createLogoutCommand } from './logout-command.js';
import type { LogoutCommandEnv } from './logout-command.js';

function fakeAdapter(canonicalDomain = 'shop.example', aliasDomains: string[] = []): SourceAdapter {
    return {
        descriptor: {
            canonicalDomain,
            aliasDomains,
            authKind: 'password',
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
            defaultWindow: { days: 30 },
            pagination: 'none',
        },
        authenticate: async (): Promise<AuthHandle> => ({}) as unknown as AuthHandle,
        list: async (): Promise<readonly ReceiptRef[]> => [],
        fetch: async (): Promise<ArtifactHandle> => ({}) as unknown as ArtifactHandle,
    };
}

function resolverWith(adapter: SourceAdapter): SourceResolver {
    const registry = new SourceAdapterRegistry();
    registry.register(adapter);
    return new SourceResolver(registry);
}

interface RunResult {
    out: string;
    err: string;
    error: unknown;
}

async function runLogout(args: string[], overrides: Partial<LogoutCommandEnv> = {}): Promise<RunResult> {
    const out: string[] = [];
    const err: string[] = [];
    const env: Partial<LogoutCommandEnv> = {
        io: { writeOut: (t) => out.push(t), writeErr: (t) => err.push(t) },
        resolver: resolverWith(fakeAdapter()),
        sessionStore: new KeyringSessionStore(new InMemoryKeyring()),
        ...overrides,
    };
    const cmd = createLogoutCommand(env);
    cmd.exitOverride();

    let error: unknown;
    try {
        await cmd.parseAsync([...args], { from: 'user' });
    } catch (caught) {
        error = caught;
    }
    return { out: out.join(''), err: err.join(''), error };
}

describe('logout — clears the stored session', () => {
    it('clears a stored session so a later reuse must re-login [AC2]', async () => {
        const store = new KeyringSessionStore(new InMemoryKeyring());
        await store.save('shop.example', {
            token: new Secret('tok'),
            expiresAt: Date.parse('2099-01-01T00:00:00.000Z'),
        });
        expect((await reuseStoredSession({ store, detector: new ReauthDetector(), key: 'shop.example' })).outcome).toBe(
            'reuse',
        );

        const { out, error } = await runLogout(['shop.example'], { sessionStore: store });

        expect(error).toBeUndefined();
        expect(out).toContain('logged out of shop.example');
        expect((await reuseStoredSession({ store, detector: new ReauthDetector(), key: 'shop.example' })).outcome).toBe(
            'absent',
        );
    });

    it('clears under the canonical key when an alias is requested [AC2]', async () => {
        const store = new KeyringSessionStore(new InMemoryKeyring());
        await store.save('shop.example', { token: new Secret('tok') });

        await runLogout(['www.shop.example'], {
            sessionStore: store,
            resolver: resolverWith(fakeAdapter('shop.example', ['www.shop.example'])),
        });

        expect((await reuseStoredSession({ store, detector: new ReauthDetector(), key: 'shop.example' })).outcome).toBe(
            'absent',
        );
    });

    it('recovers a corrupt / unreadable session — delete is unconditional [AC2]', async () => {
        const keyring = new InMemoryKeyring();
        await keyring.set('shop.example', 'not-json-garbage'); // a stuck session that would fail to load
        const store = new KeyringSessionStore(keyring);

        const { error } = await runLogout(['shop.example'], { sessionStore: store });

        expect(error).toBeUndefined();
        expect(await keyring.get('shop.example')).toBeUndefined();
    });

    it('succeeds when nothing is stored (idempotent)', async () => {
        const { out, error } = await runLogout(['shop.example']);
        expect(error).toBeUndefined();
        expect(out).toContain('logged out of shop.example');
    });

    it('clears under the requested domain when the source is unregistered', async () => {
        const store = new KeyringSessionStore(new InMemoryKeyring());
        await store.save('legacy.example', { token: new Secret('tok') });

        const { out, error } = await runLogout(['legacy.example'], {
            sessionStore: store,
            resolver: new SourceResolver(new SourceAdapterRegistry()),
        });

        expect(error).toBeUndefined();
        expect(out).toContain('logged out of legacy.example');
        expect(
            (await reuseStoredSession({ store, detector: new ReauthDetector(), key: 'legacy.example' })).outcome,
        ).toBe('absent');
    });

    it('exits 1 when the store cannot clear the session', async () => {
        const failing: SessionStore = {
            load: () => Promise.resolve(undefined),
            save: () => Promise.resolve(),
            delete: () => Promise.reject(new Error('disk on fire')),
        };

        const { error, err } = await runLogout(['shop.example'], { sessionStore: failing });

        expect(error).toMatchObject({ exitCode: 1 });
        expect(err).toContain('disk on fire');
    });
});
