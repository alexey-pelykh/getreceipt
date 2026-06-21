// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { Secret } from './index.js';
import type { StoredSession } from './index.js';
// serialize/deserialize are internal to the store layer; import directly to test the projection in isolation.
import { deserializeSession, serializeSession } from './session.js';

const TOKEN = 'session-token-SENTINEL-do-not-leak';

describe('serializeSession / deserializeSession', () => {
    it('round-trips a session, re-fencing the token in a Secret', () => {
        const session: StoredSession = {
            token: new Secret(TOKEN),
            expiresAt: 1_900_000_000_000,
            issuedAt: 1_800_000_000_000,
        };
        const restored = deserializeSession(serializeSession(session));
        expect(restored?.token).toBeInstanceOf(Secret);
        expect(restored?.token.expose()).toBe(TOKEN);
        expect(restored?.expiresAt).toBe(1_900_000_000_000);
        expect(restored?.issuedAt).toBe(1_800_000_000_000);
    });

    it('round-trips a token-only session (no timestamps)', () => {
        const restored = deserializeSession(serializeSession({ token: new Secret(TOKEN) }));
        expect(restored?.token.expose()).toBe(TOKEN);
        expect(restored?.expiresAt).toBeUndefined();
        expect(restored?.issuedAt).toBeUndefined();
    });

    it('exposes the token in the serialized projection — at the boundary, by design [AC2]', () => {
        // The serialized form is what a store hands to an encryptor / keyring; the token IS present here on purpose.
        expect(serializeSession({ token: new Secret(TOKEN) })).toContain(TOKEN);
    });

    it('keeps the token out of every implicit serialization of the live StoredSession [AC2]', () => {
        const session: StoredSession = { token: new Secret(TOKEN) };
        expect(JSON.stringify(session)).not.toContain(TOKEN);
        expect(String(session.token)).not.toContain(TOKEN);
        expect(`${session.token}`).not.toContain(TOKEN);
    });

    it('returns undefined for unrecognizable input rather than throwing', () => {
        expect(deserializeSession('not json at all')).toBeUndefined();
        expect(deserializeSession(JSON.stringify({ noToken: true }))).toBeUndefined();
        expect(deserializeSession(JSON.stringify({ token: '' }))).toBeUndefined();
        expect(deserializeSession(JSON.stringify({ token: TOKEN, expiresAt: 'soon' }))).toBeUndefined();
        expect(deserializeSession(JSON.stringify([TOKEN]))).toBeUndefined();
    });
});
