// SPDX-License-Identifier: AGPL-3.0-only
import type { AuthHandle } from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import { isSessionPersistable } from './session-persistable.js';
import type { SessionPersistableAdapter } from './session-persistable.js';
import { Secret } from './secret.js';
import type { StoredSession } from './session.js';

const TOKEN = 'persist-token-SENTINEL-do-not-leak';

/** A stand-in adapter that mints its handle as `{ token }` and projects it straight back — the shape both real adapters use. */
function persistableAdapter(): SessionPersistableAdapter {
    return {
        toStoredSession(auth: AuthHandle): StoredSession {
            return auth as unknown as StoredSession;
        },
    };
}

describe('isSessionPersistable', () => {
    it('accepts an adapter exposing toStoredSession', () => {
        expect(isSessionPersistable(persistableAdapter())).toBe(true);
    });

    it('rejects an adapter without toStoredSession (e.g. a non-persistable auth kind)', () => {
        expect(isSessionPersistable({ authenticate: () => undefined })).toBe(false);
    });

    it('narrows the type so toStoredSession is callable after the guard', () => {
        const adapter: object = persistableAdapter();
        const handle = { token: new Secret(TOKEN) } as unknown as AuthHandle;

        expect(isSessionPersistable(adapter)).toBe(true);
        if (isSessionPersistable(adapter)) {
            const session = adapter.toStoredSession(handle);
            expect(session.token.expose()).toBe(TOKEN);
        }
    });
});
