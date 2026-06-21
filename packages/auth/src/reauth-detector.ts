// SPDX-License-Identifier: AGPL-3.0-only
import type { StoredSession } from './session.js';

/** A {@link ReauthDetector.assess} verdict: the session is still usable, or it is expired and needs fresh credentials. */
export type ReauthAssessment = { readonly status: 'valid' } | { readonly status: 'expired'; readonly reason: string };

/** Construction-time seams; each has a production default, so `new ReauthDetector()` works as-is. */
export interface ReauthDetectorOptions {
    /** Clock for "now". Defaults to wall time. Injected so expiry logic is deterministic in tests. */
    readonly now?: () => Date;
    /**
     * Safety margin in ms: a session expiring within this window of "now" is treated as already
     * expired, so a token is not reused moments before it dies mid-request. Defaults to 0.
     */
    readonly clockSkewMs?: number;
}

/**
 * Decides — before any network call — whether a stored session is still worth
 * reusing. This is the proactive half of the re-auth seam: a session whose
 * {@link StoredSession.expiresAt} is in the past (within {@link ReauthDetectorOptions.clockSkewMs})
 * needs fresh credentials. The reactive backstop stays {@link ReauthRequiredError},
 * which an adapter throws when a surprise rejection arrives for a session believed
 * valid — or one whose expiry was never known.
 *
 * A session with no known `expiresAt` assesses as `valid`: absence of an expiry is
 * not evidence of expiry, and the runtime seam still catches a token that is in fact
 * dead.
 */
export class ReauthDetector {
    readonly #now: () => Date;
    readonly #clockSkewMs: number;

    constructor(options: ReauthDetectorOptions = {}) {
        this.#now = options.now ?? (() => new Date());
        this.#clockSkewMs = options.clockSkewMs ?? 0;
    }

    /** Assess whether a session is still usable. Deterministic w.r.t. the injected clock; reveals no token material. */
    assess(session: StoredSession): ReauthAssessment {
        if (session.expiresAt === undefined) {
            return { status: 'valid' };
        }
        if (this.#now().getTime() + this.#clockSkewMs >= session.expiresAt) {
            return {
                status: 'expired',
                reason: `stored session expired at ${new Date(session.expiresAt).toISOString()}`,
            };
        }
        return { status: 'valid' };
    }
}
