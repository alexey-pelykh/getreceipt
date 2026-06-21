// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { ADAPTER_VERIFICATION_STATES, verificationAdvisory } from './index.js';
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
