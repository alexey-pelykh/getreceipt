// SPDX-License-Identifier: AGPL-3.0-only
import { createInterface } from 'node:readline/promises';

import { challengeSurface } from '@getreceipt/core';
import type { AuthChallenge, ChallengeResolution, ChallengeResolver } from '@getreceipt/core';

import type { CliIO } from './io.js';

/**
 * The `out-of-band` {@link ChallengeResolver} (#138): a human-in-the-loop CLI prompt that answers an
 * `otp-sms` / `otp-email` / `push` challenge a source raises mid-login. It is wired ONLY inside the
 * `login` ceremony — never the unattended collect path, where an out-of-band challenge instead
 * surfaces as `reauth-required` (#134). For an OTP it prompts the operator for the delivered code;
 * for a `push` it asks them to approve on their device, then resumes (the source polls the approval).
 *
 * The entered code is credential material: it is never logged or persisted — it leaves solely as the
 * {@link ChallengeResolution.response} the auth flow submits. The prompt and the challenge metadata
 * are redaction-safe by the {@link AuthChallenge} contract, so they are safe to show.
 */
export interface InteractivePromptChallengeResolverOptions {
    readonly io: CliIO;
    /**
     * Opt into the source's "remember this device" offer — but ONLY when the source configured it.
     * Mirrors the TOTP resolver: {@link ChallengeResolution.trustThisDevice} is sent only when this is
     * true AND the challenge actually offered {@link AuthChallenge.trustOption}.
     */
    readonly trustDevice?: boolean;
    /**
     * Whether we can prompt: stdin is readable AND stderr (where the prompt is shown) is a TTY. Mirrors
     * the consent gate so a piped / CI `login` hitting a challenge fails cleanly instead of hanging on
     * a read that never returns. Injectable for tests.
     */
    readonly isInteractive?: () => boolean;
    /**
     * Writes the input prompt to stderr and reads one operator line. Injectable so the prompt flow is
     * testable without a real TTY (and so a test can supply the code deterministically).
     */
    readonly readLine?: (io: CliIO, prompt: string) => Promise<string>;
}

export class InteractivePromptChallengeResolver implements ChallengeResolver {
    readonly #io: CliIO;
    readonly #trustDevice: boolean;
    readonly #isInteractive: () => boolean;
    readonly #readLine: (io: CliIO, prompt: string) => Promise<string>;

    constructor(options: InteractivePromptChallengeResolverOptions) {
        this.#io = options.io;
        this.#trustDevice = options.trustDevice ?? false;
        this.#isInteractive = options.isInteractive ?? defaultIsInteractive;
        this.#readLine = options.readLine ?? promptLine;
    }

    async resolve(challenge: AuthChallenge): Promise<ChallengeResolution> {
        // Defensive: this resolver IS the `out-of-band` surface. The router never sends another surface
        // here, but guard so a future surface can't be silently answered with a typed-in code.
        if (challengeSurface(challenge.type) !== 'out-of-band') {
            throw new Error(`the interactive prompt cannot answer a "${challenge.type}" challenge`);
        }
        // Never block on a read that can't return: a piped / non-TTY `login` must fail cleanly, not hang.
        if (!this.#isInteractive()) {
            throw new Error(
                `${challenge.type} verification needs an interactive terminal — re-run \`getreceipt login\` in a terminal`,
            );
        }

        this.#io.writeErr(`\n${describeChallenge(challenge)}\n`);
        // A `push` carries no code to type: the operator approves on their device and the source polls
        // that approval on resume, so the response is empty — the Enter keypress is just the go-ahead.
        if (challenge.type === 'push') {
            await this.#readLine(this.#io, 'Approve the request on your device, then press Enter to continue: ');
            return this.#withTrust({ response: '' }, challenge);
        }
        const response = (await this.#readLine(this.#io, 'Code: ')).trim();
        return this.#withTrust({ response }, challenge);
    }

    /** Attach `trustThisDevice` only when the source both configured it AND offered it on this challenge. */
    #withTrust(resolution: ChallengeResolution, challenge: AuthChallenge): ChallengeResolution {
        return this.#trustDevice && challenge.trustOption === true
            ? { ...resolution, trustThisDevice: true }
            : resolution;
    }
}

/** Render the redaction-safe parts of a challenge for display: its prompt plus any non-secret descriptor. */
function describeChallenge(challenge: AuthChallenge): string {
    const metadata = challenge.metadata;
    if (metadata === undefined || Object.keys(metadata).length === 0) {
        return challenge.prompt;
    }
    const detail = Object.entries(metadata)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
    return `${challenge.prompt} (${detail})`;
}

/** Can we prompt? The prompt shows on stderr (stdout stays clean), so gate on both stdin and stderr being a TTY. */
function defaultIsInteractive(): boolean {
    return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

/**
 * Write the prompt through {@link CliIO} (NOT raw stderr, so it stays captured/testable), then read one
 * line from stdin. `terminal: false` keeps it a plain line read — the surrounding TTY echoes the
 * operator's keystrokes. `input` is injectable so the line-parsing is testable without a real TTY.
 * The same shape as the consent gate's `readlineConfirm`.
 */
export async function promptLine(
    io: CliIO,
    prompt: string,
    input: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
    io.writeErr(prompt);
    const rl = createInterface({ input, terminal: false });
    try {
        return await rl.question('');
    } finally {
        rl.close();
    }
}
