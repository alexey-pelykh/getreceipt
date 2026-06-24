// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import type { AuthChallenge, ChallengeResolution, ChallengeResolver, ChallengeType } from './index.js';

const ALL_TYPES: readonly ChallengeType[] = ['otp-totp', 'otp-sms', 'otp-email', 'push', 'captcha', 'webauthn'];

/**
 * A resolver defined OUTSIDE core (here, in the test) — the stand-in for a real
 * composition-root implementation. Its existence is the dependency-inversion proof:
 * the port is satisfiable without core importing any implementation.
 */
function fixedResolver(resolution: ChallengeResolution): ChallengeResolver {
    return { resolve: () => Promise.resolve(resolution) };
}

/** A consumer that receives the resolver by injection, never by import — models how the auth flow will use the seam. */
async function resolveWith(resolver: ChallengeResolver, challenge: AuthChallenge): Promise<ChallengeResolution> {
    return resolver.resolve(challenge);
}

describe('ChallengeResolver port (AC1: single resolve seam)', () => {
    it('resolves a challenge to a { response } with trustThisDevice omitted', async () => {
        const resolver = fixedResolver({ response: '123456' });

        const result = await resolveWith(resolver, { type: 'otp-totp', prompt: 'Enter the 6-digit code' });

        expect(result.response).toBe('123456');
        expect(result.trustThisDevice).toBeUndefined();
    });

    it('carries trustThisDevice back when the resolver opts in', async () => {
        const resolver = fixedResolver({ response: 'approved', trustThisDevice: true });

        const result = await resolveWith(resolver, { type: 'push', prompt: 'Approve the push', trustOption: true });

        expect(result).toEqual({ response: 'approved', trustThisDevice: true });
    });

    it('is async — resolve returns a Promise', () => {
        const resolver = fixedResolver({ response: 'x' });

        const pending = resolver.resolve({ type: 'captcha', prompt: 'Solve the CAPTCHA' });

        expect(pending).toBeInstanceOf(Promise);
        return expect(pending).resolves.toEqual({ response: 'x' });
    });

    it('accepts every declared challenge type through the one abstraction', async () => {
        const resolver = fixedResolver({ response: 'ok' });

        for (const type of ALL_TYPES) {
            const result = await resolveWith(resolver, { type, prompt: `prompt for ${type}` });
            expect(result.response).toBe('ok');
        }
    });

    it('lets the resolver branch on the challenge it receives', async () => {
        const resolver: ChallengeResolver = {
            resolve: (challenge) => Promise.resolve({ response: `answer:${challenge.type}` }),
        };

        const totp = await resolveWith(resolver, { type: 'otp-totp', prompt: 'code' });
        const sms = await resolveWith(resolver, { type: 'otp-sms', prompt: 'code' });

        expect(totp.response).toBe('answer:otp-totp');
        expect(sms.response).toBe('answer:otp-sms');
    });
});

describe('AuthChallenge (AC2: human prompt + redaction-safe metadata)', () => {
    it('carries a human-facing prompt', () => {
        const challenge: AuthChallenge = { type: 'otp-sms', prompt: 'Enter the code we texted you' };

        expect(challenge.prompt).toBe('Enter the code we texted you');
    });

    it('carries a redaction-safe metadata bag — string→string, fully serializable', () => {
        const challenge: AuthChallenge = {
            type: 'otp-sms',
            prompt: 'Enter the code we texted you',
            metadata: { target: 'phone ending 89', issuer: 'Acme' },
        };

        // String→string is loggable as-is and survives a serialize round-trip with no loss —
        // the structural guarantee behind "redaction-safe, no secret leakage".
        expect(Object.values(challenge.metadata ?? {}).every((v) => typeof v === 'string')).toBe(true);
        expect(JSON.parse(JSON.stringify(challenge.metadata))).toEqual(challenge.metadata);
    });

    it('keeps the secret answer off the challenge — it travels only as the resolution response', async () => {
        const challenge: AuthChallenge = {
            type: 'otp-totp',
            prompt: 'Enter the 6-digit code',
            metadata: { issuer: 'Acme' },
        };

        // The challenge a source emits (and may log) never holds the answer.
        expect(Object.keys(challenge)).not.toContain('response');

        const result = await fixedResolver({ response: '654321' }).resolve(challenge);
        expect(result.response).toBe('654321');
    });

    it('treats metadata and trustOption as optional', () => {
        const minimal: AuthChallenge = { type: 'webauthn', prompt: 'Touch your security key' };

        expect(minimal.metadata).toBeUndefined();
        expect(minimal.trustOption).toBeUndefined();
    });
});

describe('dependency inversion (AC3: port injected, not imported by core)', () => {
    it('challenge.ts is purely declarative — zero runtime footprint, so no implementation is defined or imported', async () => {
        const moduleNamespace = await import('./challenge.js');

        // Interfaces and type aliases erase at compile time; an empty runtime module
        // proves core neither ships nor imports a concrete resolver here.
        expect(Object.keys(moduleNamespace)).toHaveLength(0);
    });

    it('a resolver implemented outside core satisfies the port and is consumed by injection', async () => {
        let received: AuthChallenge | undefined;
        const externalResolver: ChallengeResolver = {
            resolve: (challenge) => {
                received = challenge;
                return Promise.resolve({ response: 'from-external-impl' });
            },
        };

        const result = await resolveWith(externalResolver, { type: 'otp-email', prompt: 'check email' });

        expect(received?.type).toBe('otp-email');
        expect(result.response).toBe('from-external-impl');
    });
});
