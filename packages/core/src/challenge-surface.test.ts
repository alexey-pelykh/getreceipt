// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { challengeSurface, RoutingChallengeResolver, UnresolvedChallengeError } from './index.js';
import type {
    AuthChallenge,
    ChallengeResolution,
    ChallengeResolver,
    ChallengeSurface,
    ChallengeType,
} from './index.js';

// The full ChallengeType union (mirrors challenge.test.ts) — drives the exhaustiveness checks.
const ALL_TYPES: readonly ChallengeType[] = ['otp-totp', 'otp-sms', 'otp-email', 'push', 'captcha', 'webauthn'];

function challenge(type: ChallengeType, extra: Partial<AuthChallenge> = {}): AuthChallenge {
    return { type, prompt: `prompt for ${type}`, ...extra };
}

/**
 * A sub-resolver tagged with the surface it stands in for: it answers with `surface` and records
 * every challenge it saw, so a test can assert WHICH surface the router dispatched a type to.
 */
function labeledResolver(surface: ChallengeSurface): {
    readonly resolver: ChallengeResolver;
    readonly seen: AuthChallenge[];
} {
    const seen: AuthChallenge[] = [];
    return {
        resolver: {
            resolve: (c) => {
                seen.push(c);
                return Promise.resolve({ response: surface });
            },
        },
        seen,
    };
}

describe('challengeSurface (R-UNI: the headless vs browser-needing split)', () => {
    it('classifies otp-totp as in-process — headless, the storable-factor win (R-UNI-02)', () => {
        expect(challengeSurface('otp-totp')).toBe('in-process');
    });

    it('classifies the out-of-band factors (sms / email / push) as out-of-band — human, no browser', () => {
        expect(challengeSurface('otp-sms')).toBe('out-of-band');
        expect(challengeSurface('otp-email')).toBe('out-of-band');
        expect(challengeSurface('push')).toBe('out-of-band');
    });

    it('classifies the browser-needing factors (captcha / webauthn) as browser-ceremony (R-UNI-01)', () => {
        expect(challengeSurface('captcha')).toBe('browser-ceremony');
        expect(challengeSurface('webauthn')).toBe('browser-ceremony');
    });

    it('never routes a headless challenge onto the browser path (R-UNI-02 BUT NOT)', () => {
        // The unattended win is negated the moment a locally-computable factor needs a browser.
        expect(challengeSurface('otp-totp')).not.toBe('browser-ceremony');
    });

    it('maps every declared challenge type to a defined surface — total over the union', () => {
        const surfaces = new Set<ChallengeSurface>(['in-process', 'out-of-band', 'browser-ceremony']);
        for (const type of ALL_TYPES) {
            expect(surfaces.has(challengeSurface(type))).toBe(true);
        }
    });
});

describe('RoutingChallengeResolver (AC1: one port, no second browser seam)', () => {
    it('is itself a ChallengeResolver — one resolve() port for every challenge type', async () => {
        // The whole union flows through ONE resolve() — there is no parallel browser resolver
        // injected alongside it (R-UNI-01 BUT NOT: "no parallel resolver seams").
        const router: ChallengeResolver = new RoutingChallengeResolver({
            'in-process': labeledResolver('in-process').resolver,
            'out-of-band': labeledResolver('out-of-band').resolver,
            'browser-ceremony': labeledResolver('browser-ceremony').resolver,
        });

        for (const type of ALL_TYPES) {
            await expect(router.resolve(challenge(type))).resolves.toHaveProperty('response');
        }
    });

    it('dispatches each type to the sub-resolver for its surface', async () => {
        const inProcess = labeledResolver('in-process');
        const outOfBand = labeledResolver('out-of-band');
        const browser = labeledResolver('browser-ceremony');
        const router = new RoutingChallengeResolver({
            'in-process': inProcess.resolver,
            'out-of-band': outOfBand.resolver,
            'browser-ceremony': browser.resolver,
        });

        expect((await router.resolve(challenge('otp-totp'))).response).toBe('in-process');
        expect((await router.resolve(challenge('otp-sms'))).response).toBe('out-of-band');
        expect((await router.resolve(challenge('captcha'))).response).toBe('browser-ceremony');

        expect(inProcess.seen.map((c) => c.type)).toEqual(['otp-totp']);
        expect(outOfBand.seen.map((c) => c.type)).toEqual(['otp-sms']);
        expect(browser.seen.map((c) => c.type)).toEqual(['captcha']);
    });

    it('routes BOTH browser-needing types (captcha + webauthn) through the same one ceremony resolver', async () => {
        // AC1: browser-needing types resolve via the existing ceremony port — the single
        // browser-ceremony sub-resolver, not one bespoke seam per challenge.
        const browser = labeledResolver('browser-ceremony');
        const router = new RoutingChallengeResolver({ 'browser-ceremony': browser.resolver });

        await router.resolve(challenge('captcha'));
        await router.resolve(challenge('webauthn'));

        expect(browser.seen.map((c) => c.type)).toEqual(['captcha', 'webauthn']);
    });
});

describe('RoutingChallengeResolver — webauthn accommodation (AC2)', () => {
    it('resolves a webauthn challenge through a generic browser-ceremony resolver — no self-passkey path needed', async () => {
        // AC2: the abstraction accommodates `webauthn` with nothing passkey-specific — a plain
        // ChallengeResolver standing in for the headed-browser ceremony is all it takes. The
        // self-signed `passkey-self` assertion is a separate (unbuilt) auth path, not a dependency.
        const browser = labeledResolver('browser-ceremony');
        const router = new RoutingChallengeResolver({ 'browser-ceremony': browser.resolver });

        const resolution = await router.resolve(challenge('webauthn', { prompt: 'Touch your security key' }));

        expect(resolution.response).toBe('browser-ceremony');
        expect(browser.seen).toHaveLength(1);
    });
});

describe('RoutingChallengeResolver — never hang, never silent (browser deferred → reauth)', () => {
    it('rejects with UnresolvedChallengeError(no-resolver) when the browser surface is unwired', async () => {
        // @getreceipt/browser is deferred, so a real composition root wires no browser-ceremony
        // resolver. A captcha must surface the structured error collect() maps to reauth-required
        // (#134) — never block on input, never silently succeed.
        const router = new RoutingChallengeResolver({ 'in-process': labeledResolver('in-process').resolver });

        await expect(router.resolve(challenge('captcha'))).rejects.toMatchObject({
            name: 'UnresolvedChallengeError',
            reason: 'no-resolver',
            challengeType: 'captcha',
        });
    });

    it('also rejects for an unwired webauthn challenge, naming only the redaction-safe type', async () => {
        const router = new RoutingChallengeResolver({});

        const rejection = router.resolve(challenge('webauthn'));

        await expect(rejection).rejects.toBeInstanceOf(UnresolvedChallengeError);
        await expect(rejection).rejects.toMatchObject({ reason: 'no-resolver', challengeType: 'webauthn' });
    });

    it('rejects an unwired out-of-band challenge the same way (uniform fallback across surfaces)', async () => {
        const router = new RoutingChallengeResolver({
            'browser-ceremony': labeledResolver('browser-ceremony').resolver,
        });

        await expect(router.resolve(challenge('otp-sms'))).rejects.toMatchObject({
            reason: 'no-resolver',
            challengeType: 'otp-sms',
        });
    });
});

describe('RoutingChallengeResolver — pure pass-through (no observation / mutation of the response)', () => {
    it('returns the sub-resolver resolution unchanged, by identity', async () => {
        // The router must not copy, normalize, or rewrite the credential-bearing resolution.
        const resolution: ChallengeResolution = { response: 'super-secret-token', trustThisDevice: true };
        const passthrough: ChallengeResolver = { resolve: () => Promise.resolve(resolution) };
        const router = new RoutingChallengeResolver({ 'browser-ceremony': passthrough });

        const out = await router.resolve(challenge('captcha'));

        expect(out).toBe(resolution); // same reference — no mutation, no defensive copy
        expect(out.response).toBe('super-secret-token');
        expect(out.trustThisDevice).toBe(true);
    });

    it('does not invoke any other surface when dispatching (only the matched sub-resolver runs)', async () => {
        const inProcess = labeledResolver('in-process');
        const browser = labeledResolver('browser-ceremony');
        const router = new RoutingChallengeResolver({
            'in-process': inProcess.resolver,
            'browser-ceremony': browser.resolver,
        });

        await router.resolve(challenge('otp-totp'));

        expect(inProcess.seen).toHaveLength(1);
        expect(browser.seen).toHaveLength(0);
    });
});
