// SPDX-License-Identifier: AGPL-3.0-only
import { scanForSecrets } from '@getreceipt/auth';
import type { AuthChallenge } from '@getreceipt/core';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { InteractivePromptChallengeResolver, promptLine } from './interactive-challenge-resolver.js';
import type { CliIO } from './io.js';

/** A capturing {@link CliIO} so prompt text written to stderr can be asserted (and scanned for leaks). */
function captureIO(): { io: CliIO; out: () => string; err: () => string } {
    const out: string[] = [];
    const err: string[] = [];
    return {
        io: { writeOut: (t) => out.push(t), writeErr: (t) => err.push(t) },
        out: () => out.join(''),
        err: () => err.join(''),
    };
}

/** Builds a resolver wired to a scripted line reader + forced interactivity, so no real TTY is touched. */
function resolverWith(opts: {
    line: string;
    trustDevice?: boolean;
    isInteractive?: () => boolean;
    io?: CliIO;
    onPrompt?: (prompt: string) => void;
}): InteractivePromptChallengeResolver {
    return new InteractivePromptChallengeResolver({
        io: opts.io ?? captureIO().io,
        ...(opts.trustDevice === undefined ? {} : { trustDevice: opts.trustDevice }),
        isInteractive: opts.isInteractive ?? (() => true),
        readLine: (_io, prompt) => {
            opts.onPrompt?.(prompt);
            return Promise.resolve(opts.line);
        },
    });
}

const SMS_CHALLENGE: AuthChallenge = {
    type: 'otp-sms',
    prompt: 'Enter the code we texted you',
    metadata: { target: 'phone ending 89' },
};

describe('InteractivePromptChallengeResolver — out-of-band code entry [AC1]', () => {
    it('prompts for an SMS code and returns it as the response (trimmed)', async () => {
        const resolver = resolverWith({ line: '  123456 \n' });

        const resolution = await resolver.resolve(SMS_CHALLENGE);

        expect(resolution.response).toBe('123456');
        expect(resolution.trustThisDevice).toBeUndefined();
    });

    it('answers an email OTP the same way', async () => {
        const resolver = resolverWith({ line: '987654' });

        const resolution = await resolver.resolve({ type: 'otp-email', prompt: 'Enter the emailed code' });

        expect(resolution.response).toBe('987654');
    });

    it('shows the challenge prompt and its redaction-safe metadata on stderr', async () => {
        const cap = captureIO();
        const prompts: string[] = [];
        const resolver = resolverWith({ line: '111111', io: cap.io, onPrompt: (p) => prompts.push(p) });

        await resolver.resolve(SMS_CHALLENGE);

        expect(cap.err()).toContain('Enter the code we texted you');
        expect(cap.err()).toContain('phone ending 89');
        // The short input prompt is asked for an OTP type.
        expect(prompts).toContain('Code: ');
    });

    it('does NOT ask for a code on a push challenge — it asks the operator to approve, response is empty', async () => {
        const cap = captureIO();
        const prompts: string[] = [];
        const resolver = resolverWith({ line: '', io: cap.io, onPrompt: (p) => prompts.push(p) });

        const resolution = await resolver.resolve({
            type: 'push',
            prompt: 'Approve the sign-in on your phone',
            metadata: { device: 'Pixel 8' },
        });

        expect(resolution.response).toBe('');
        // The no-code branch still shows the challenge prompt + redaction-safe metadata on stderr before
        // the approve gate, so the operator sees which request they are approving.
        expect(cap.err()).toContain('Approve the sign-in on your phone');
        expect(cap.err()).toContain('Pixel 8');
        expect(prompts.join('')).toContain('Approve the request on your device');
        expect(prompts.join('')).not.toBe('Code: ');
    });
});

describe('InteractivePromptChallengeResolver — trust-this-device election [AC1]', () => {
    it('sends trustThisDevice ONLY when the source configured it AND the challenge offers it', async () => {
        const resolver = resolverWith({ line: '123456', trustDevice: true });

        const resolution = await resolver.resolve({ ...SMS_CHALLENGE, trustOption: true });

        expect(resolution.trustThisDevice).toBe(true);
    });

    it('omits trustThisDevice when the source did NOT configure it, even if the challenge offers it', async () => {
        const resolver = resolverWith({ line: '123456', trustDevice: false });

        const resolution = await resolver.resolve({ ...SMS_CHALLENGE, trustOption: true });

        expect(resolution.trustThisDevice).toBeUndefined();
    });

    it('omits trustThisDevice when the challenge does NOT offer it, even if the source configured it', async () => {
        const resolver = resolverWith({ line: '123456', trustDevice: true });

        const resolution = await resolver.resolve({ ...SMS_CHALLENGE, trustOption: false });

        expect(resolution.trustThisDevice).toBeUndefined();
    });
});

describe('InteractivePromptChallengeResolver — never hangs / never leaks', () => {
    it('rejects WITHOUT reading stdin when not interactive (piped / CI), so login fails cleanly not hangs', async () => {
        let readAttempted = false;
        const resolver = new InteractivePromptChallengeResolver({
            io: captureIO().io,
            isInteractive: () => false,
            readLine: () => {
                readAttempted = true;
                return Promise.resolve('123456');
            },
        });

        await expect(resolver.resolve(SMS_CHALLENGE)).rejects.toThrow(/interactive terminal/);
        expect(readAttempted).toBe(false);
    });

    it('rejects a challenge type that is not out-of-band (defensive — the router never sends one)', async () => {
        const resolver = resolverWith({ line: '123456' });

        // `otp-totp` is in-process; the interactive prompt must refuse it rather than mis-answer.
        await expect(resolver.resolve({ type: 'otp-totp', prompt: 'x' })).rejects.toThrow(/cannot answer/);
    });

    it('never writes the entered code to any stream', async () => {
        const cap = captureIO();
        const code = 'sk' + '_live_' + 'Q'.repeat(28); // a value scanForSecrets recognizes
        const resolver = resolverWith({ line: code, io: cap.io });

        const resolution = await resolver.resolve(SMS_CHALLENGE);

        expect(resolution.response).toBe(code);
        expect(cap.out()).not.toContain(code);
        expect(cap.err()).not.toContain(code);
        expect(
            scanForSecrets([
                { path: 'prompt-out', content: cap.out() },
                { path: 'prompt-err', content: cap.err() },
            ]),
        ).toEqual([]);
    });
});

describe('promptLine — the real line reader (no TTY)', () => {
    it('writes the prompt to stderr and reads one line from the injected stream', async () => {
        const cap = captureIO();
        const input = Readable.from(['424242\nignored-second-line\n']);

        const answer = await promptLine(cap.io, 'Code: ', input);

        expect(answer).toBe('424242');
        expect(cap.err()).toBe('Code: ');
    });
});
