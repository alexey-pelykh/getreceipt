// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import {
    ADAPTER_VERIFICATION_STATES,
    DEFAULT_FRESHNESS_HORIZON_MS,
    effectiveVerificationState,
    verificationAdvisory,
} from './index.js';
import type { AdapterVerificationState } from './index.js';

describe('ADAPTER_VERIFICATION_STATES', () => {
    it('is exactly the three trust states', () => {
        expect([...ADAPTER_VERIFICATION_STATES]).toEqual(['unverified', 'e2e-verified', 'stale']);
    });
});

describe('verificationAdvisory', () => {
    it('treats e2e-verified as ok with no warning message', () => {
        const advisory = verificationAdvisory('e2e-verified');
        expect(advisory).toEqual({ state: 'e2e-verified', level: 'ok', proceed: true });
        // exactOptionalPropertyTypes: the ok advisory omits the key entirely.
        expect('message' in advisory).toBe(false);
    });

    it('warns (but proceeds) for unverified, with a message', () => {
        const advisory = verificationAdvisory('unverified');
        expect(advisory.level).toBe('warn');
        expect(advisory.proceed).toBe(true);
        expect(advisory.message).toBeTruthy();
    });

    it('warns (but proceeds) for stale, with copy distinct from unverified', () => {
        const stale = verificationAdvisory('stale');
        expect(stale.level).toBe('warn');
        expect(stale.proceed).toBe(true);
        expect(stale.message).toBeTruthy();
        expect(stale.message).not.toBe(verificationAdvisory('unverified').message);
    });

    it('0.2.0 policy is warn-only: every state proceeds', () => {
        for (const state of ADAPTER_VERIFICATION_STATES) {
            const advisory = verificationAdvisory(state);
            expect(advisory.state).toBe(state);
            expect(advisory.proceed).toBe(true);
        }
    });

    it('handles only the declared states (exhaustiveness guard)', () => {
        // The switch's `never` default throws on an unknown state — proves no silent fall-through
        // if the union ever grows without the advisory being updated.
        const rogue = 'tampered' as AdapterVerificationState;
        expect(() => verificationAdvisory(rogue)).toThrow(/unhandled verification state/);
    });
});

describe('DEFAULT_FRESHNESS_HORIZON_MS', () => {
    it('is 30 days in milliseconds', () => {
        expect(DEFAULT_FRESHNESS_HORIZON_MS).toBe(30 * 24 * 60 * 60 * 1000);
    });
});

describe('effectiveVerificationState — runtime staleness decay (#90)', () => {
    const VERIFIED_AT = new Date('2026-06-01T00:00:00Z');
    const day = (n: number): Date => new Date(VERIFIED_AT.getTime() + n * 24 * 60 * 60 * 1000);

    it('keeps a FRESH e2e-verified source (last-verified within the horizon)', () => {
        expect(effectiveVerificationState({ state: 'e2e-verified', lastVerifiedAt: VERIFIED_AT }, day(10))).toBe(
            'e2e-verified',
        );
    });

    it('decays a STALE e2e-verified source (last-verified older than the horizon) to stale', () => {
        expect(effectiveVerificationState({ state: 'e2e-verified', lastVerifiedAt: VERIFIED_AT }, day(31))).toBe(
            'stale',
        );
    });

    it('leaves a NEVER-VERIFIED source unverified regardless of the clock', () => {
        expect(effectiveVerificationState({ state: 'unverified' }, day(9999))).toBe('unverified');
    });

    it('treats an e2e-verified source that ships NO date as stale (freshness is unprovable)', () => {
        expect(effectiveVerificationState({ state: 'e2e-verified' }, day(0))).toBe('stale');
    });

    it('passes an already-stale source through unchanged', () => {
        expect(effectiveVerificationState({ state: 'stale', lastVerifiedAt: VERIFIED_AT }, day(0))).toBe('stale');
    });

    it('treats exactly-at-the-horizon as still fresh, one ms past as stale (boundary)', () => {
        const atHorizon = new Date(VERIFIED_AT.getTime() + DEFAULT_FRESHNESS_HORIZON_MS);
        expect(effectiveVerificationState({ state: 'e2e-verified', lastVerifiedAt: VERIFIED_AT }, atHorizon)).toBe(
            'e2e-verified',
        );
        const justPast = new Date(atHorizon.getTime() + 1);
        expect(effectiveVerificationState({ state: 'e2e-verified', lastVerifiedAt: VERIFIED_AT }, justPast)).toBe(
            'stale',
        );
    });

    it('honors a custom horizon override (a 7-day horizon makes a 10-day-old verification stale)', () => {
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        expect(
            effectiveVerificationState({ state: 'e2e-verified', lastVerifiedAt: VERIFIED_AT }, day(10), sevenDaysMs),
        ).toBe('stale');
    });

    it('tolerates a future last-verified date (clock skew) as fresh, never promoting beyond e2e-verified', () => {
        expect(effectiveVerificationState({ state: 'e2e-verified', lastVerifiedAt: day(5) }, VERIFIED_AT)).toBe(
            'e2e-verified',
        );
    });
});
