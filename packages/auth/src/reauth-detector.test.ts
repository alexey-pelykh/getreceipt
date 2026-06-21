// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { ReauthDetector, Secret } from './index.js';
import type { StoredSession } from './index.js';

const TOKEN = 'detector-token-SENTINEL-do-not-leak';
const clockAt =
    (iso: string): (() => Date) =>
    () =>
        new Date(iso);
const session = (overrides: Partial<StoredSession> = {}): StoredSession => ({ token: new Secret(TOKEN), ...overrides });

describe('ReauthDetector', () => {
    it('assesses a session whose expiry is in the future as valid [AC1]', () => {
        const detector = new ReauthDetector({ now: clockAt('2026-06-21T00:00:00.000Z') });
        expect(detector.assess(session({ expiresAt: Date.parse('2026-06-21T01:00:00.000Z') }))).toEqual({
            status: 'valid',
        });
    });

    it('assesses a session whose expiry has passed as expired [AC1]', () => {
        const detector = new ReauthDetector({ now: clockAt('2026-06-21T00:00:00.000Z') });
        expect(detector.assess(session({ expiresAt: Date.parse('2026-06-20T23:00:00.000Z') })).status).toBe('expired');
    });

    it('treats a session expiring exactly at "now" as expired (>= boundary) [AC1]', () => {
        const now = '2026-06-21T00:00:00.000Z';
        expect(new ReauthDetector({ now: clockAt(now) }).assess(session({ expiresAt: Date.parse(now) })).status).toBe(
            'expired',
        );
    });

    it('treats a session expiring within the clock-skew margin as already expired', () => {
        const detector = new ReauthDetector({ now: clockAt('2026-06-21T00:00:00.000Z'), clockSkewMs: 60_000 });
        // expires 30s from now — inside the 60s margin -> expired
        expect(detector.assess(session({ expiresAt: Date.parse('2026-06-21T00:00:30.000Z') })).status).toBe('expired');
    });

    it('assesses a session with no known expiry as valid — the runtime seam is the backstop [AC1]', () => {
        expect(new ReauthDetector().assess(session())).toEqual({ status: 'valid' });
    });

    it('defaults the clock to wall time: a long-past expiry is expired without an injected now', () => {
        expect(new ReauthDetector().assess(session({ expiresAt: 0 })).status).toBe('expired');
    });

    it('puts only a timestamp — never the token — in the expired reason [AC2]', () => {
        const detector = new ReauthDetector({ now: clockAt('2026-06-21T00:00:00.000Z') });
        const result = detector.assess(session({ expiresAt: Date.parse('2026-06-20T00:00:00.000Z') }));
        expect(result.status).toBe('expired');
        if (result.status === 'expired') {
            expect(result.reason).toContain('2026-06-20');
            expect(result.reason).not.toContain(TOKEN);
        }
    });
});
