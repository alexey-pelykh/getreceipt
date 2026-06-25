// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import {
    isAuthChallengeRequired,
    MAX_AUTH_CHALLENGE_ROUNDS,
    resolveAuthChallenges,
    UnresolvedChallengeError,
} from './index.js';
import type {
    AuthChallenge,
    AuthChallengeRequired,
    AuthHandle,
    AuthResult,
    ChallengeLifecycleEvent,
    ChallengeObserver,
    ChallengeResolution,
    ChallengeResolver,
    ChallengeType,
} from './index.js';

// Opaque handles are minted by casting a plain object — the resolver never inspects them.
function brand<T>(value: object): T {
    return value as unknown as T;
}
const handle = brand<AuthHandle>({ session: 'ok' });

function challenge(type: ChallengeType = 'otp-totp'): AuthChallenge {
    return { type, prompt: 'Enter the code' };
}

// A resolver that answers every challenge with `resolution`, recording the challenges it saw.
function recordingResolver(resolution: ChallengeResolution = { response: '123456' }): {
    readonly resolver: ChallengeResolver;
    readonly seen: AuthChallenge[];
} {
    const seen: AuthChallenge[] = [];
    return {
        resolver: {
            resolve: async (c) => {
                seen.push(c);
                return resolution;
            },
        },
        seen,
    };
}

/**
 * An {@link AuthResult} that demands `types.length` challenges in order, then resolves to the session.
 * Records every resolution handed to `resume`, so a test can assert what the orchestrator submitted.
 */
function challengeChain(types: readonly ChallengeType[]): {
    readonly initial: AuthResult;
    readonly resolutions: ChallengeResolution[];
} {
    const resolutions: ChallengeResolution[] = [];
    function step(index: number): AuthResult {
        if (index >= types.length) {
            return handle;
        }
        return {
            challenge: challenge(types[index]),
            resume: async (resolution) => {
                resolutions.push(resolution);
                return step(index + 1);
            },
        };
    }
    return { initial: step(0), resolutions };
}

describe('isAuthChallengeRequired', () => {
    it('is false for an established session handle', () => {
        expect(isAuthChallengeRequired(handle)).toBe(false);
    });

    it('is true for a challenge carrier', () => {
        const carrier: AuthChallengeRequired = { challenge: challenge(), resume: async () => handle };
        expect(isAuthChallengeRequired(carrier)).toBe(true);
    });
});

describe('resolveAuthChallenges', () => {
    it('returns a bare handle untouched, requiring no resolver (backward compatibility)', async () => {
        await expect(resolveAuthChallenges(handle)).resolves.toBe(handle);
    });

    it('resolves a single challenge and resumes to the session', async () => {
        const { resolver, seen } = recordingResolver();
        const { initial } = challengeChain(['otp-totp']);

        await expect(resolveAuthChallenges(initial, resolver)).resolves.toBe(handle);
        expect(seen.map((c) => c.type)).toEqual(['otp-totp']);
    });

    it('chains multiple challenges (challenge -> challenge -> session)', async () => {
        const { resolver, seen } = recordingResolver();
        const { initial } = challengeChain(['otp-sms', 'push']);

        await expect(resolveAuthChallenges(initial, resolver)).resolves.toBe(handle);
        expect(seen.map((c) => c.type)).toEqual(['otp-sms', 'push']);
    });

    it('forwards the resolver answer to the adapter resume continuation', async () => {
        const resolution: ChallengeResolution = { response: 'one-time-token', trustThisDevice: true };
        const { resolver } = recordingResolver(resolution);
        const { initial, resolutions } = challengeChain(['captcha']);

        await resolveAuthChallenges(initial, resolver);

        expect(resolutions).toEqual([resolution]);
    });

    it('rejects with UnresolvedChallengeError(no-resolver) when a challenge appears and no resolver is given', async () => {
        const { initial } = challengeChain(['otp-email']);

        await expect(resolveAuthChallenges(initial)).rejects.toMatchObject({
            name: 'UnresolvedChallengeError',
            reason: 'no-resolver',
            challengeType: 'otp-email',
        });
    });

    it('resolves a chain of exactly MAX_AUTH_CHALLENGE_ROUNDS challenges', async () => {
        const { resolver } = recordingResolver();
        const types = Array.from({ length: MAX_AUTH_CHALLENGE_ROUNDS }, (): ChallengeType => 'otp-totp');
        const { initial } = challengeChain(types);

        await expect(resolveAuthChallenges(initial, resolver)).resolves.toBe(handle);
    });

    it('rejects with UnresolvedChallengeError(exhausted) past MAX_AUTH_CHALLENGE_ROUNDS', async () => {
        const { resolver } = recordingResolver();
        const types = Array.from({ length: MAX_AUTH_CHALLENGE_ROUNDS + 1 }, (): ChallengeType => 'otp-totp');
        const { initial } = challengeChain(types);

        await expect(resolveAuthChallenges(initial, resolver)).rejects.toMatchObject({
            name: 'UnresolvedChallengeError',
            reason: 'exhausted',
        });
    });
});

describe('resolveAuthChallenges — lifecycle observability (#142 AC1/AC2)', () => {
    function recordEvents(): { readonly observer: ChallengeObserver; readonly events: ChallengeLifecycleEvent[] } {
        const events: ChallengeLifecycleEvent[] = [];
        return { observer: (event) => events.push(event), events };
    }

    it('emits emitted then resolved for a single challenge, with the source and type-derived mode', async () => {
        const { resolver } = recordingResolver();
        const { initial } = challengeChain(['otp-totp']);
        const { observer, events } = recordEvents();

        await resolveAuthChallenges(initial, resolver, { source: 'free.fr', observer });

        expect(events).toEqual([
            { phase: 'emitted', source: 'free.fr', type: 'otp-totp' },
            { phase: 'resolved', source: 'free.fr', type: 'otp-totp', mode: 'totp-computed' },
        ]);
    });

    it('reports an out-of-band challenge as human-entered', async () => {
        const { resolver } = recordingResolver();
        const { initial } = challengeChain(['otp-sms']);
        const { observer, events } = recordEvents();

        await resolveAuthChallenges(initial, resolver, { source: 'monoprix.fr', observer });

        expect(events).toContainEqual({
            phase: 'resolved',
            source: 'monoprix.fr',
            type: 'otp-sms',
            mode: 'human-entered',
        });
    });

    it('streams an event per round across a multi-challenge chain', async () => {
        const { resolver } = recordingResolver();
        const { initial } = challengeChain(['otp-sms', 'push']);
        const { observer, events } = recordEvents();

        await resolveAuthChallenges(initial, resolver, { source: 'free.fr', observer });

        expect(events.map((e) => `${e.phase}:${'type' in e ? e.type : ''}`)).toEqual([
            'emitted:otp-sms',
            'resolved:otp-sms',
            'emitted:push',
            'resolved:push',
        ]);
    });

    it('emits degraded(no-resolver) carrying the type before raising', async () => {
        const { initial } = challengeChain(['otp-email']);
        const { observer, events } = recordEvents();

        await expect(resolveAuthChallenges(initial, undefined, { source: 'free.fr', observer })).rejects.toMatchObject({
            reason: 'no-resolver',
        });
        expect(events).toEqual([
            { phase: 'emitted', source: 'free.fr', type: 'otp-email' },
            { phase: 'degraded', source: 'free.fr', reason: 'no-resolver', type: 'otp-email' },
        ]);
    });

    it('emits degraded(exhausted) with NO type before raising past the round ceiling', async () => {
        const { resolver } = recordingResolver();
        const types = Array.from({ length: MAX_AUTH_CHALLENGE_ROUNDS + 1 }, (): ChallengeType => 'otp-totp');
        const { initial } = challengeChain(types);
        const { observer, events } = recordEvents();

        await expect(resolveAuthChallenges(initial, resolver, { source: 'free.fr', observer })).rejects.toMatchObject({
            reason: 'exhausted',
        });
        const degraded = events.filter((e) => e.phase === 'degraded');
        expect(degraded).toEqual([{ phase: 'degraded', source: 'free.fr', reason: 'exhausted' }]);
    });

    it('derives exactly the modes it can produce: totp-computed for TOTP, human-entered for the rest', async () => {
        const { resolver } = recordingResolver();
        const { initial } = challengeChain(['otp-totp', 'otp-sms', 'push', 'captcha', 'webauthn']);
        const { observer, events } = recordEvents();

        await resolveAuthChallenges(initial, resolver, { source: 'free.fr', observer });

        // The resolved-event mode is a closed OUTPUT set — no third mode leaks in (a device-trust mode
        // would arrive with its own producer in #140, not be derivable here).
        const modes = events.flatMap((e) => (e.phase === 'resolved' ? [e.mode] : []));
        expect(new Set(modes)).toEqual(new Set(['totp-computed', 'human-entered']));
    });

    it('puts NO secret material on any event — the resolved code travels only on the resolution (AC2)', async () => {
        const { resolver } = recordingResolver({ response: '123456', trustThisDevice: true });
        const { initial } = challengeChain(['otp-totp']);
        const { observer, events } = recordEvents();

        await resolveAuthChallenges(initial, resolver, { source: 'free.fr', observer });

        const serialized = JSON.stringify(events);
        expect(serialized).not.toContain('123456');
        // The trust-this-device election is a resolution detail, not an event field.
        expect(serialized).not.toContain('trustThisDevice');
    });

    it('runs silently with no observer (backward-compatible 2-arg call is unaffected)', async () => {
        const { resolver } = recordingResolver();
        const { initial } = challengeChain(['otp-totp']);

        await expect(resolveAuthChallenges(initial, resolver)).resolves.toBe(handle);
    });
});

describe('UnresolvedChallengeError', () => {
    it('carries the reason and challenge type without leaking secret material', () => {
        const error = new UnresolvedChallengeError('no-resolver', 'otp-totp');
        expect(error).toBeInstanceOf(Error);
        expect(error.reason).toBe('no-resolver');
        expect(error.challengeType).toBe('otp-totp');
        expect(error.message).toContain('otp-totp');
        expect(error.message).not.toContain('123456');
    });
});
