// SPDX-License-Identifier: AGPL-3.0-only
import type { AuthHandle } from '@getreceipt/core';

import type { StoredSession } from './session.js';

/**
 * An adapter that can project the session behind its opaque {@link AuthHandle} into a
 * persistable {@link StoredSession} — the sanctioned bridge the `login` ceremony (#17) uses
 * to persist a session WITHOUT reimplementing the adapter's (possibly multi-step)
 * `authenticate` flow, and WITHOUT `@getreceipt/core` naming {@link StoredSession} (it
 * cannot: auth depends on core, not the reverse). The adapter already holds the token in
 * the handle it minted; this re-homes it into the store's shape (adding expiry/issuance
 * when the source exposes them). The token stays fenced in its {@link Secret} — re-homed,
 * never exposed.
 */
export interface SessionPersistableAdapter {
    /**
     * Project an {@link AuthHandle} THIS adapter just minted into the persistable session.
     * Synchronous and pure: `authenticate` already did the network work (including any
     * token-mint step), so this only widens the in-memory handle.
     */
    toStoredSession(auth: AuthHandle): StoredSession;
}

/**
 * Whether `adapter` can hand its session to a {@link SessionStore} — the capability `login`
 * gates on. A source whose auth is not persistable (e.g. a future passkey source with no
 * reusable token) simply does not implement {@link SessionPersistableAdapter.toStoredSession},
 * and `login` reports that honestly rather than persisting nothing.
 */
export function isSessionPersistable(adapter: object): adapter is SessionPersistableAdapter {
    return typeof (adapter as Partial<SessionPersistableAdapter>).toStoredSession === 'function';
}
