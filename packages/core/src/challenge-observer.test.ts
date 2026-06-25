// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { formatChallengeEvent } from './index.js';
import type {
    ChallengeLifecycleEvent,
    ChallengeResolutionMode,
    ChallengeType,
    UnresolvedChallengeReason,
} from './index.js';

// The full unions (mirror challenge.test.ts / auth-challenge) — drive the golden + exhaustiveness checks.
const ALL_TYPES: readonly ChallengeType[] = ['otp-totp', 'otp-sms', 'otp-email', 'push', 'captcha', 'webauthn'];
const ALL_MODES: readonly ChallengeResolutionMode[] = ['totp-computed', 'human-entered'];
const ALL_REASONS: readonly UnresolvedChallengeReason[] = ['no-resolver', 'exhausted'];

// Secret material that must NEVER appear in a formatted line (AC2). A 6-digit OTP and a base32 TOTP
// seed are NOT credential-shaped (the regex fence can't catch them), so this asserts the stronger
// by-construction property: the formatter only ever reads the event's closed-enum + domain fields.
const PLANTED_SECRETS = ['123456', 'JBSWY3DPEHPK3PXP', 'sk-LEAK-SENTINEL-0000', 'TRUST-LEAK-SENTINEL'];

describe('formatChallengeEvent — golden, redaction-safe serialization (#142 AC1/AC2)', () => {
    it('renders an emitted event as source + type', () => {
        expect(formatChallengeEvent({ phase: 'emitted', source: 'free.fr', type: 'otp-totp' })).toBe(
            'challenge emitted source=free.fr type=otp-totp',
        );
    });

    it('renders a resolved event as source + type + mode', () => {
        expect(
            formatChallengeEvent({ phase: 'resolved', source: 'free.fr', type: 'otp-totp', mode: 'totp-computed' }),
        ).toBe('challenge resolved source=free.fr type=otp-totp mode=totp-computed');
    });

    it('renders the human-entered resolution of an out-of-band challenge', () => {
        expect(
            formatChallengeEvent({ phase: 'resolved', source: 'monoprix.fr', type: 'otp-sms', mode: 'human-entered' }),
        ).toBe('challenge resolved source=monoprix.fr type=otp-sms mode=human-entered');
    });

    it('renders a degraded event with its reason and the in-play type', () => {
        expect(
            formatChallengeEvent({ phase: 'degraded', source: 'monoprix.fr', reason: 'no-resolver', type: 'otp-sms' }),
        ).toBe('challenge degraded source=monoprix.fr reason=no-resolver type=otp-sms');
    });

    it('renders a degraded event with no type (exhausted carries none) — no dangling "type="', () => {
        expect(formatChallengeEvent({ phase: 'degraded', source: 'free.fr', reason: 'exhausted' })).toBe(
            'challenge degraded source=free.fr reason=exhausted',
        );
    });

    it('never emits credential material for ANY phase × type × mode/reason combination', () => {
        const events: ChallengeLifecycleEvent[] = [
            ...ALL_TYPES.map((type): ChallengeLifecycleEvent => ({ phase: 'emitted', source: 'free.fr', type })),
            ...ALL_TYPES.flatMap((type) =>
                ALL_MODES.map(
                    (mode): ChallengeLifecycleEvent => ({ phase: 'resolved', source: 'free.fr', type, mode }),
                ),
            ),
            ...ALL_REASONS.flatMap((reason) => [
                { phase: 'degraded', source: 'free.fr', reason } as ChallengeLifecycleEvent,
                ...ALL_TYPES.map(
                    (type): ChallengeLifecycleEvent => ({ phase: 'degraded', source: 'free.fr', reason, type }),
                ),
            ]),
        ];

        for (const event of events) {
            const line = formatChallengeEvent(event);
            // Every line is built ONLY from the prefix tokens + the event's own enum/domain fields.
            expect(line).toMatch(
                /^challenge (emitted|resolved|degraded) source=free\.fr( (type|mode|reason)=[a-z-]+)+$/,
            );
            for (const secret of PLANTED_SECRETS) {
                expect(line).not.toContain(secret);
            }
        }
    });
});
