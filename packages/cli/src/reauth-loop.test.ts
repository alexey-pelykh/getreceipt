// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';

import type { CliIO } from './io.js';
import { attendedReauthPrompt, DEFAULT_REAUTH_ATTEMPTS, runWithAttendedReauth } from './reauth-loop.js';

/** A `runOnce` yielding the queued results in order (the last repeats), recording how many times it ran. */
function scriptedRun<T>(...results: readonly T[]): { runOnce: () => Promise<T>; calls: () => number } {
    let index = 0;
    let calls = 0;
    return {
        runOnce: () => {
            calls += 1;
            const result = results[Math.min(index, results.length - 1)]!;
            index += 1;
            return Promise.resolve(result);
        },
        calls: () => calls,
    };
}

const needsReauth = (r: string): boolean => r === 'reauth-required';

describe('runWithAttendedReauth — opt-in + TTY gate (#247)', () => {
    it('never enters the loop without --reauth: returns the first result, never prompts', async () => {
        const run = scriptedRun('reauth-required', 'succeeded');
        const onReauth = vi.fn(() => Promise.resolve());
        const result = await runWithAttendedReauth({
            runOnce: run.runOnce,
            needsReauth,
            reauth: false, // no flag → today's behavior, untouched
            isInteractive: () => true,
            onReauth,
        });
        expect(result).toBe('reauth-required');
        expect(run.calls()).toBe(1);
        expect(onReauth).not.toHaveBeenCalled();
    });

    it('never prompts when not interactive (piped/CI): returns the first result, never reads stdin', async () => {
        const run = scriptedRun('reauth-required', 'succeeded');
        const onReauth = vi.fn(() => Promise.resolve());
        const result = await runWithAttendedReauth({
            runOnce: run.runOnce,
            needsReauth,
            reauth: true, // opted in...
            isInteractive: () => false, // ...but no TTY, so the loop is never entered
            onReauth,
        });
        expect(result).toBe('reauth-required');
        expect(run.calls()).toBe(1);
        expect(onReauth).not.toHaveBeenCalled();
    });

    it('prompts once and resumes: reauth-required → (re-auth) → succeeded', async () => {
        const run = scriptedRun('reauth-required', 'succeeded');
        const onReauth = vi.fn(() => Promise.resolve());
        const result = await runWithAttendedReauth({
            runOnce: run.runOnce,
            needsReauth,
            reauth: true,
            isInteractive: () => true,
            onReauth,
        });
        expect(result).toBe('succeeded');
        expect(run.calls()).toBe(2); // initial + one resume
        expect(onReauth).toHaveBeenCalledTimes(1);
    });

    it('bound=1: a resume that STILL needs re-auth stops after one prompt (no coercive loop)', async () => {
        const run = scriptedRun('reauth-required', 'reauth-required'); // never clears
        const onReauth = vi.fn(() => Promise.resolve());
        const result = await runWithAttendedReauth({
            runOnce: run.runOnce,
            needsReauth,
            reauth: true,
            isInteractive: () => true,
            onReauth,
        });
        expect(result).toBe('reauth-required'); // falls through to the honest outcome
        expect(run.calls()).toBe(2); // initial + exactly one resume
        expect(onReauth).toHaveBeenCalledTimes(1); // exactly one prompt
    });

    it('never prompts when the first run already succeeds', async () => {
        const run = scriptedRun('succeeded');
        const onReauth = vi.fn(() => Promise.resolve());
        const result = await runWithAttendedReauth({
            runOnce: run.runOnce,
            needsReauth,
            reauth: true,
            isInteractive: () => true,
            onReauth,
        });
        expect(result).toBe('succeeded');
        expect(run.calls()).toBe(1);
        expect(onReauth).not.toHaveBeenCalled();
    });

    it('honors a higher maxAttempts: prompts up to the bound, then falls through', async () => {
        const run = scriptedRun('reauth-required', 'reauth-required', 'reauth-required');
        const onReauth = vi.fn(() => Promise.resolve());
        const result = await runWithAttendedReauth({
            runOnce: run.runOnce,
            needsReauth,
            reauth: true,
            isInteractive: () => true,
            onReauth,
            maxAttempts: 2,
        });
        expect(result).toBe('reauth-required');
        expect(run.calls()).toBe(3); // initial + 2 resumes
        expect(onReauth).toHaveBeenCalledTimes(2);
    });

    it('defaults to a single re-auth attempt', () => {
        expect(DEFAULT_REAUTH_ATTEMPTS).toBe(1);
    });
});

describe('attendedReauthPrompt — redaction-safe, domain-only, resume-not-restart (#247)', () => {
    function captureIO(): { io: CliIO; err: () => string } {
        const chunks: string[] = [];
        return {
            io: { writeOut: () => undefined, writeErr: (t) => void chunks.push(t) },
            err: () => chunks.join(''),
        };
    }

    it('names only the source domain, instructs an in-browser sign-in, then reads the resume line', async () => {
        const { io, err } = captureIO();
        const prompts: string[] = [];
        const readLine = (_io: CliIO, prompt: string): Promise<string> => {
            prompts.push(prompt);
            return Promise.resolve(''); // operator pressed Enter
        };
        await attendedReauthPrompt(io, 'amazon.fr', readLine)();

        expect(err()).toContain('collecting from amazon.fr');
        // Resume, not restart — reassure the operator saved receipts are skipped.
        expect(err()).toContain('skipped on resume');
        // The action happens in THEIR browser (the CLI never handles the password).
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain('Sign in to amazon.fr again in your browser');
        expect(prompts[0]).toContain('press Enter to resume');
    });

    it('surfaces no secret/step-up material — the prompt is a fixed literal over the domain', async () => {
        const { io, err } = captureIO();
        const prompts: string[] = [];
        const readLine = (_io: CliIO, prompt: string): Promise<string> => {
            prompts.push(prompt);
            return Promise.resolve('');
        };
        await attendedReauthPrompt(io, 'amazon.fr', readLine)();
        const all = err() + prompts.join('');
        expect(all).not.toMatch(/max_auth_age|session-token|password|otp/i);
    });
});
