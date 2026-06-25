// SPDX-License-Identifier: AGPL-3.0-only
import type { AuthHandle, AuthResult, CredentialContext, SourceAdapter, SourceDescriptor } from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import { traceAdapter, traceChallengeObserver } from './verbose-trace.js';

const DESCRIPTOR: SourceDescriptor = {
    canonicalDomain: 'shop.example',
    aliasDomains: [],
    authKind: 'password',
    transportTier: 'http-api',
    artifactMode: 'pdf-download',
    dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
    defaultWindow: { days: 30 },
    pagination: 'none',
};

/** Minimal adapter whose `authenticate` yields a caller-chosen {@link AuthResult}; list/fetch are unused here. */
function adapterReturning(result: AuthResult): SourceAdapter {
    return {
        descriptor: DESCRIPTOR,
        authenticate: async () => result,
        list: async () => [],
        fetch: async () => ({}) as never,
    };
}

/** Collect every line the trace emits into an array (each call is one already-newline-terminated line). */
function capture(): { sink: (line: string) => void; lines: string[] } {
    const lines: string[] = [];
    return { sink: (line) => lines.push(line), lines };
}

describe('traceChallengeObserver — the --verbose challenge-lifecycle sink (#142 AC1)', () => {
    it('streams an emitted event as a prefixed, newline-terminated line', () => {
        const { sink, lines } = capture();
        traceChallengeObserver(sink)({ phase: 'emitted', source: 'free.fr', type: 'otp-totp' });
        expect(lines).toEqual(['[getreceipt] challenge emitted source=free.fr type=otp-totp\n']);
    });

    it('streams a resolved event carrying the resolution mode', () => {
        const { sink, lines } = capture();
        traceChallengeObserver(sink)({ phase: 'resolved', source: 'free.fr', type: 'otp-totp', mode: 'totp-computed' });
        expect(lines).toEqual(['[getreceipt] challenge resolved source=free.fr type=otp-totp mode=totp-computed\n']);
    });

    it('streams a degraded event carrying the reason and in-play type', () => {
        const { sink, lines } = capture();
        traceChallengeObserver(sink)({ phase: 'degraded', source: 'free.fr', reason: 'no-resolver', type: 'otp-sms' });
        expect(lines).toEqual(['[getreceipt] challenge degraded source=free.fr reason=no-resolver type=otp-sms\n']);
    });

    it('drops a whole line through the secret fence if a field ever carries a secret-shaped value (AC2 backstop)', () => {
        // The event fields are closed enums + the source domain, so a secret cannot arrive by construction.
        // This proves the fence still guards the sink: a pathologically secret-shaped source is suppressed,
        // not streamed — the same backstop traceAdapter applies to a credential-shaped receipt id.
        const secretShapedSource = 'sk' + '_live_' + 'A'.repeat(28);
        const { sink, lines } = capture();
        traceChallengeObserver(sink)({ phase: 'emitted', source: secretShapedSource, type: 'otp-totp' });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('suppressed');
        expect(lines[0]).not.toContain(secretShapedSource);
    });
});

describe('traceAdapter — authenticate reports the stage honestly (#133 follow-up, via #142)', () => {
    it('logs "challenge issued (<type>)" — never a false "ok" — when authenticate returns a challenge', async () => {
        const { sink, lines } = capture();
        const challenge: AuthResult = {
            challenge: { type: 'otp-totp', prompt: 'Enter the code from your authenticator app' },
            resume: async () => ({}) as unknown as AuthHandle,
        };
        await traceAdapter(adapterReturning(challenge), sink).authenticate({} as CredentialContext);

        expect(lines.some((l) => l.includes('authenticate: challenge issued (otp-totp)'))).toBe(true);
        expect(lines.some((l) => l.includes('authenticate: ok'))).toBe(false);
        // The human-facing prompt is NOT a closed enum — it must never reach the trace.
        expect(lines.some((l) => l.includes('Enter the code'))).toBe(false);
    });

    it('logs "authenticate: ok" when authenticate establishes a session directly', async () => {
        const { sink, lines } = capture();
        await traceAdapter(adapterReturning({} as unknown as AuthHandle), sink).authenticate({} as CredentialContext);
        expect(lines.some((l) => l.includes('authenticate: ok'))).toBe(true);
    });
});
