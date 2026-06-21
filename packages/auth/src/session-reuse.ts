// SPDX-License-Identifier: AGPL-3.0-only
import { ReauthRequiredError } from '@getreceipt/core';

import type { ReauthDetector } from './reauth-detector.js';
import type { SessionStore, StoredSession } from './session.js';

/**
 * The outcome of trying to reuse a stored session:
 *  - `reuse` — a valid session was found; skip the full re-login and use {@link SessionReuse.session};
 *  - `absent` — nothing is stored for the key; authenticate fresh (first run);
 *  - `reauth-required` — a session was stored but is expired; surface the typed
 *    re-auth signal rather than silently failing.
 */
export type SessionReuse =
    | { readonly outcome: 'reuse'; readonly session: StoredSession }
    | { readonly outcome: 'absent' }
    | { readonly outcome: 'reauth-required'; readonly reason: string };

/** Inputs to {@link reuseStoredSession}. */
export interface ReuseStoredSessionRequest {
    readonly store: SessionStore;
    readonly detector: ReauthDetector;
    /** Store key for the session (typically the canonical domain). */
    readonly key: string;
}

/**
 * The session-reuse flow: load a stored session and decide whether it can be reused.
 * Binds a {@link SessionStore} (where sessions live) to a {@link ReauthDetector}
 * (whether one is still valid) and returns a structured {@link SessionReuse} verdict —
 * it never throws for an expected condition, mirroring `collect()`'s never-throw
 * contract. The caller maps a `reauth-required` verdict onto the existing re-auth seam
 * via {@link toReauthRequiredError}.
 */
export async function reuseStoredSession(request: ReuseStoredSessionRequest): Promise<SessionReuse> {
    const { store, detector, key } = request;
    const session = await store.load(key);
    if (session === undefined) {
        return { outcome: 'absent' };
    }
    const assessment = detector.assess(session);
    if (assessment.status === 'expired') {
        return { outcome: 'reauth-required', reason: assessment.reason };
    }
    return { outcome: 'reuse', session };
}

/**
 * Bridge a `reauth-required` verdict to the typed {@link ReauthRequiredError} the core
 * re-auth seam already understands — so an adapter can turn a detected-expired session
 * into the same `reauth-required` `CollectResult` a runtime rejection produces. The
 * reason carries no secret material.
 */
export function toReauthRequiredError(
    domain: string,
    reuse: Extract<SessionReuse, { outcome: 'reauth-required' }>,
): ReauthRequiredError {
    return new ReauthRequiredError(domain, reuse.reason);
}
