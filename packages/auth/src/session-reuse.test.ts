// SPDX-License-Identifier: AGPL-3.0-only
import { ReauthRequiredError } from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import {
    InMemoryKeyring,
    KeyringSessionStore,
    ReauthDetector,
    reuseStoredSession,
    Secret,
    toReauthRequiredError,
} from './index.js';
import type { SessionStore, StoredSession } from './index.js';

const TOKEN = 'reuse-token-SENTINEL-do-not-leak';
const DOMAIN = 'grandfrais.com';
const FUTURE = Date.parse('2099-01-01T00:00:00.000Z');
const PAST = Date.parse('2000-01-01T00:00:00.000Z');

/** A store stub that yields a fixed load result — lets the reuse verdict be tested without a backend. */
function stubStore(loaded: StoredSession | undefined): SessionStore {
    return {
        load: async () => loaded,
        save: async () => undefined,
        delete: async () => undefined,
    };
}

describe('reuseStoredSession', () => {
    it('reuses a valid stored session — no re-login [AC1]', async () => {
        const stored: StoredSession = { token: new Secret(TOKEN), expiresAt: FUTURE };
        const result = await reuseStoredSession({
            store: stubStore(stored),
            detector: new ReauthDetector(),
            key: DOMAIN,
        });
        expect(result.outcome).toBe('reuse');
        if (result.outcome === 'reuse') {
            expect(result.session.token.expose()).toBe(TOKEN);
        }
    });

    it('reports absent when nothing is stored — caller authenticates fresh [AC1]', async () => {
        const result = await reuseStoredSession({
            store: stubStore(undefined),
            detector: new ReauthDetector(),
            key: DOMAIN,
        });
        expect(result).toEqual({ outcome: 'absent' });
    });

    it('reports reauth-required for an expired stored session [AC1]', async () => {
        const result = await reuseStoredSession({
            store: stubStore({ token: new Secret(TOKEN), expiresAt: PAST }),
            detector: new ReauthDetector(),
            key: DOMAIN,
        });
        expect(result.outcome).toBe('reauth-required');
        if (result.outcome === 'reauth-required') {
            expect(result.reason).toContain('expired');
            expect(result.reason).not.toContain(TOKEN);
        }
    });

    it('reuses a session round-tripped through a real keyring-backed store [AC1][AC3]', async () => {
        const store = new KeyringSessionStore(new InMemoryKeyring());
        await store.save(DOMAIN, { token: new Secret(TOKEN), expiresAt: FUTURE });

        const result = await reuseStoredSession({ store, detector: new ReauthDetector(), key: DOMAIN });
        expect(result.outcome).toBe('reuse');
        if (result.outcome === 'reuse') {
            expect(result.session.token.expose()).toBe(TOKEN);
        }
    });
});

describe('toReauthRequiredError', () => {
    it('bridges a reauth-required verdict to the core ReauthRequiredError seam, carrying no token [AC1]', () => {
        const error = toReauthRequiredError(DOMAIN, { outcome: 'reauth-required', reason: 'stored session expired' });
        expect(error).toBeInstanceOf(ReauthRequiredError);
        expect(error.domain).toBe(DOMAIN);
        expect(error.message).toContain(DOMAIN);
        expect(error.message).toContain('stored session expired');
        expect(error.message).not.toContain(TOKEN);
    });
});
