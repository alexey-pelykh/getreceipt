// SPDX-License-Identifier: AGPL-3.0-only
import { UnresolvedChallengeError } from '@getreceipt/core';
import type { AuthChallenge } from '@getreceipt/core';
import { describe, expect, it, vi } from 'vitest';

import type { MfaConfig } from './config.js';
import { TotpError } from './errors.js';
import { Secret } from './secret.js';
import { createMfaChallengeResolver, TotpChallengeResolver } from './totp-resolver.js';

// RFC 6238 reference seed (canonical Base32) and a clock pinned to T=59s → code 287082 (Appendix B).
const RFC_SEED_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const AT_T59 = () => new Date(59_000);
const TOTP_AT_T59 = '287082';

function totpChallenge(extra: Partial<AuthChallenge> = {}): AuthChallenge {
    return { type: 'otp-totp', prompt: 'Enter your 6-digit code', ...extra };
}

describe('TotpChallengeResolver — unattended code computation (AC1)', () => {
    it('computes the RFC code locally from the seed, with no prompt or human input', async () => {
        const resolver = new TotpChallengeResolver({
            resolveSeed: () => Promise.resolve(new Secret(RFC_SEED_BASE32)),
            now: AT_T59,
        });

        const resolution = await resolver.resolve(totpChallenge());

        expect(resolution.response).toBe(TOTP_AT_T59);
    });

    it('resolves the seed LAZILY — only when a challenge actually fires, and once per resolve', async () => {
        const resolveSeed = vi.fn(() => Promise.resolve(new Secret(RFC_SEED_BASE32)));
        const resolver = new TotpChallengeResolver({ resolveSeed, now: AT_T59 });

        expect(resolveSeed).not.toHaveBeenCalled(); // construction does no `op read`

        await resolver.resolve(totpChallenge());

        expect(resolveSeed).toHaveBeenCalledTimes(1);
    });

    it('defaults to real time when no clock is injected (produces a 6-digit numeric code)', async () => {
        const resolver = new TotpChallengeResolver({
            resolveSeed: () => Promise.resolve(new Secret(RFC_SEED_BASE32)),
        });

        const resolution = await resolver.resolve(totpChallenge());

        expect(resolution.response).toMatch(/^\d{6}$/);
    });
});

describe('TotpChallengeResolver — trust-this-device (mfa.trustDevice × source offer)', () => {
    it('opts in only when config asked AND the source offered the option', async () => {
        const resolver = new TotpChallengeResolver({
            resolveSeed: () => Promise.resolve(new Secret(RFC_SEED_BASE32)),
            now: AT_T59,
            trustDevice: true,
        });

        const resolution = await resolver.resolve(totpChallenge({ trustOption: true }));

        expect(resolution.trustThisDevice).toBe(true);
    });

    it('does NOT opt in when the source made no offer, even if config asked', async () => {
        const resolver = new TotpChallengeResolver({
            resolveSeed: () => Promise.resolve(new Secret(RFC_SEED_BASE32)),
            now: AT_T59,
            trustDevice: true,
        });

        const resolution = await resolver.resolve(totpChallenge()); // no trustOption

        expect(resolution.trustThisDevice).toBeUndefined();
    });

    it('does NOT opt in when config did not ask, even if the source offered', async () => {
        const resolver = new TotpChallengeResolver({
            resolveSeed: () => Promise.resolve(new Secret(RFC_SEED_BASE32)),
            now: AT_T59,
        });

        const resolution = await resolver.resolve(totpChallenge({ trustOption: true }));

        expect(resolution.trustThisDevice).toBeUndefined();
    });
});

describe('TotpChallengeResolver — typed failures, never leaking the seed', () => {
    it('rejects a non-otp-totp challenge (defensive surface guard)', async () => {
        const resolver = new TotpChallengeResolver({
            resolveSeed: () => Promise.resolve(new Secret(RFC_SEED_BASE32)),
            now: AT_T59,
        });

        await expect(resolver.resolve({ type: 'otp-sms', prompt: 'SMS code' })).rejects.toMatchObject({
            name: 'TotpError',
            reason: 'unsupported-challenge',
        });
    });

    it('rejects an invalid Base32 seed without echoing it', async () => {
        const badSeed = 'not-valid-base32!!!';
        const resolver = new TotpChallengeResolver({
            resolveSeed: () => Promise.resolve(new Secret(badSeed)),
            now: AT_T59,
        });

        const rejection = resolver.resolve(totpChallenge());

        await expect(rejection).rejects.toBeInstanceOf(TotpError);
        await expect(rejection).rejects.toMatchObject({ reason: 'invalid-seed' });
        await rejection.catch((error: unknown) => {
            expect((error as TotpError).message).not.toContain(badSeed);
        });
    });
});

describe('createMfaChallengeResolver — wiring the in-process surface from mfa config', () => {
    const resolveCredential = () => Promise.resolve(new Secret(RFC_SEED_BASE32));

    it('returns undefined when there is no mfa block', () => {
        expect(createMfaChallengeResolver(undefined, { resolveCredential })).toBeUndefined();
    });

    it('returns undefined for out-of-band types (sms/email/push are not in-process)', () => {
        for (const type of ['sms', 'email', 'push'] as const) {
            const mfa: MfaConfig = { type };
            expect(createMfaChallengeResolver(mfa, { resolveCredential })).toBeUndefined();
        }
    });

    it('builds a resolver that answers otp-totp with the locally computed code', async () => {
        const mfa: MfaConfig = { type: 'totp', seed: { ref: 'op://Personal/example/totp' } };
        const resolver = createMfaChallengeResolver(mfa, { resolveCredential, now: AT_T59 });

        expect(resolver).toBeDefined();
        const resolution = await resolver!.resolve(totpChallenge());
        expect(resolution.response).toBe(TOTP_AT_T59);
    });

    it('passes trustDevice through to the in-process resolver', async () => {
        const mfa: MfaConfig = { type: 'totp', seed: { ref: 'op://Personal/example/totp' }, trustDevice: true };
        const resolver = createMfaChallengeResolver(mfa, { resolveCredential, now: AT_T59 });

        const resolution = await resolver!.resolve(totpChallenge({ trustOption: true }));
        expect(resolution.trustThisDevice).toBe(true);
    });

    it('resolves the seed lazily through resolveCredential (the existing secret path)', async () => {
        const lazy = vi.fn(resolveCredential);
        const mfa: MfaConfig = { type: 'totp', seed: { ref: 'op://Personal/example/totp' } };
        const resolver = createMfaChallengeResolver(mfa, { resolveCredential: lazy, now: AT_T59 });

        expect(lazy).not.toHaveBeenCalled();
        await resolver!.resolve(totpChallenge());
        expect(lazy).toHaveBeenCalledTimes(1);
        expect(lazy).toHaveBeenCalledWith(mfa.seed);
    });

    it('routes ONLY the in-process surface — a browser/out-of-band challenge stays unresolved (#134)', async () => {
        // The factory wires only `in-process`, so a captcha (browser-ceremony) has no sub-resolver and
        // surfaces the structured UnresolvedChallengeError collect() maps to reauth-required.
        const mfa: MfaConfig = { type: 'totp', seed: { ref: 'op://Personal/example/totp' } };
        const resolver = createMfaChallengeResolver(mfa, { resolveCredential, now: AT_T59 });

        await expect(resolver!.resolve({ type: 'captcha', prompt: 'Solve the captcha' })).rejects.toBeInstanceOf(
            UnresolvedChallengeError,
        );
    });
});
