// SPDX-License-Identifier: AGPL-3.0-only
import { UnresolvedChallengeError } from '@getreceipt/core';
import type { AuthChallenge } from '@getreceipt/core';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import {
    DEFAULT_ELICITATION_TIMEOUT_MS,
    McpElicitationChallengeResolver,
    type ElicitFn,
} from './elicitation-challenge-resolver.js';

interface ElicitCall {
    readonly params: ElicitRequestFormParams;
    readonly options: RequestOptions | undefined;
}

interface Recorder {
    readonly elicit: ElicitFn;
    readonly calls: ElicitCall[];
}

/** An {@link ElicitFn} that records what it was asked and replies with a fixed {@link ElicitResult}. */
function replyingElicit(result: ElicitResult): Recorder {
    const calls: ElicitCall[] = [];
    return {
        calls,
        elicit: (params, options) => {
            calls.push({ params, options });
            return Promise.resolve(result);
        },
    };
}

/** The single recorded call, or a thrown assertion — keeps `noUncheckedIndexedAccess` honest without a `!`. */
function only(calls: readonly ElicitCall[]): ElicitCall {
    const [first, ...rest] = calls;
    if (first === undefined || rest.length > 0) {
        throw new Error(`expected exactly one elicitation, got ${calls.length}`);
    }
    return first;
}

/** An {@link ElicitFn} that rejects — the client cannot render a form, the request timed out, etc. */
const throwingElicit: ElicitFn = () => Promise.reject(new Error('Client does not support form elicitation.'));

const SMS: AuthChallenge = { type: 'otp-sms', prompt: 'Enter the code', metadata: { target: 'phone ending 89' } };

describe('McpElicitationChallengeResolver — accept path', () => {
    it('elicits a string `code` for an otp-sms challenge and returns the trimmed code as the response', async () => {
        const rec = replyingElicit({ action: 'accept', content: { code: '  424242  ' } });
        const resolver = new McpElicitationChallengeResolver({ elicit: rec.elicit });

        const resolution = await resolver.resolve(SMS);

        expect(resolution).toEqual({ response: '424242' });
        const { params, options } = only(rec.calls);
        // The message is the redaction-safe prompt + non-secret descriptor.
        expect(params.message).toBe('Enter the code (target: phone ending 89)');
        expect(params.mode).toBe('form');
        expect(Object.keys(params.requestedSchema.properties)).toEqual(['code']);
        expect(params.requestedSchema.required).toEqual(['code']);
        // A bounded timeout is always carried, so the wait can never hang.
        expect(options?.timeout).toBe(DEFAULT_ELICITATION_TIMEOUT_MS);
    });

    it('elicits a boolean confirmation for a push (no code crosses the channel) and returns an empty response', async () => {
        const rec = replyingElicit({ action: 'accept', content: { approved: true } });
        const resolver = new McpElicitationChallengeResolver({ elicit: rec.elicit });

        const resolution = await resolver.resolve({ type: 'push', prompt: 'Approve on your device' });

        expect(resolution).toEqual({ response: '' });
        expect(Object.keys(only(rec.calls).params.requestedSchema.properties)).toEqual(['approved']);
    });

    it('carries a caller-supplied timeout to the elicitation request', async () => {
        const rec = replyingElicit({ action: 'accept', content: { code: '1' } });
        const resolver = new McpElicitationChallengeResolver({ elicit: rec.elicit, timeoutMs: 1234 });

        await resolver.resolve(SMS);

        expect(only(rec.calls).options?.timeout).toBe(1234);
    });
});

describe('McpElicitationChallengeResolver — graceful degrade to reauth-required (#134)', () => {
    it('maps an elicitation that cannot be served (no form support / timeout / transport) to UnresolvedChallengeError', async () => {
        const resolver = new McpElicitationChallengeResolver({ elicit: throwingElicit });

        await expect(resolver.resolve(SMS)).rejects.toBeInstanceOf(UnresolvedChallengeError);
    });

    it.each(['decline', 'cancel'] as const)('maps a user %s to UnresolvedChallengeError', async (action) => {
        const rec = replyingElicit({ action });
        const resolver = new McpElicitationChallengeResolver({ elicit: rec.elicit });

        await expect(resolver.resolve({ type: 'otp-email', prompt: 'Enter the code' })).rejects.toBeInstanceOf(
            UnresolvedChallengeError,
        );
    });

    it('the degrade error names only the redaction-safe challenge type — never a code or descriptor', async () => {
        const rec = replyingElicit({ action: 'decline' });
        const resolver = new McpElicitationChallengeResolver({ elicit: rec.elicit });

        await expect(resolver.resolve(SMS)).rejects.toThrow(/otp-sms/);
        // The thrown error carries only the type, so a leaked code is impossible by construction.
        await expect(resolver.resolve(SMS)).rejects.not.toThrow(/phone ending 89/);
    });
});

describe('McpElicitationChallengeResolver — defensive surface guard', () => {
    it('rejects a non-out-of-band challenge with a plain Error (a misroute is a bug → `failed`, not reauth-required)', async () => {
        const rec = replyingElicit({ action: 'accept', content: { code: '1' } });
        const resolver = new McpElicitationChallengeResolver({ elicit: rec.elicit });

        // otp-totp is the in-process surface; the router never sends it here.
        await expect(resolver.resolve({ type: 'otp-totp', prompt: 'x' })).rejects.toThrow(/cannot answer/);
        await expect(resolver.resolve({ type: 'otp-totp', prompt: 'x' })).rejects.not.toBeInstanceOf(
            UnresolvedChallengeError,
        );
        expect(rec.calls).toHaveLength(0); // never elicited
    });
});

describe('McpElicitationChallengeResolver — trust-this-device double-gate', () => {
    const accepting = (): ElicitFn => replyingElicit({ action: 'accept', content: { code: '1' } }).elicit;

    it('sends trustThisDevice only when config opted in AND the challenge offered it', async () => {
        const resolver = new McpElicitationChallengeResolver({ elicit: accepting(), trustDevice: true });

        expect(await resolver.resolve({ ...SMS, trustOption: true })).toEqual({ response: '1', trustThisDevice: true });
    });

    it('omits trustThisDevice when the challenge did not offer it', async () => {
        const resolver = new McpElicitationChallengeResolver({ elicit: accepting(), trustDevice: true });

        expect(await resolver.resolve(SMS)).toEqual({ response: '1' });
    });

    it('omits trustThisDevice when config did not opt in', async () => {
        const resolver = new McpElicitationChallengeResolver({ elicit: accepting(), trustDevice: false });

        expect(await resolver.resolve({ ...SMS, trustOption: true })).toEqual({ response: '1' });
    });
});
