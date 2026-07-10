// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';

import type { CliIO } from './io.js';
import {
    attendedReauthPrompt,
    browserReauthPrompt,
    DEFAULT_REAUTH_ATTEMPTS,
    defaultSignInWindowOpener,
    firstRunSignInNotice,
    runWithAttendedReauth,
} from './reauth-loop.js';
import type { SignInWindowOpener } from './reauth-loop.js';

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

describe('browserReauthPrompt — headful owned-profile sign-in, attended-only (#255)', () => {
    const SIGN_IN_URL = 'https://www.amazon.fr/ap/signin';
    const PROFILE_DIR = '/profiles/personal';

    function captureIO(): { io: CliIO; err: () => string } {
        const chunks: string[] = [];
        return {
            io: { writeOut: () => undefined, writeErr: (t) => void chunks.push(t) },
            err: () => chunks.join(''),
        };
    }

    /** A fake headful opener recording each (profileDir, signInUrl) and how many times its window was closed. */
    function fakeOpener(): {
        readonly open: SignInWindowOpener;
        readonly calls: () => ReadonlyArray<{ profileDir: string; signInUrl: string }>;
        readonly closed: () => number;
    } {
        const calls: Array<{ profileDir: string; signInUrl: string }> = [];
        let closed = 0;
        const open: SignInWindowOpener = (profileDir, signInUrl) => {
            calls.push({ profileDir, signInUrl });
            return Promise.resolve({
                close: () => {
                    closed += 1;
                    return Promise.resolve();
                },
            });
        };
        return { open, calls: () => calls, closed: () => closed };
    }

    it('opens the owned-profile window at the sign-in URL, prompts once over the domain, then closes it', async () => {
        const { io, err } = captureIO();
        const opener = fakeOpener();
        const prompts: string[] = [];
        const readLine = (_io: CliIO, prompt: string): Promise<string> => {
            prompts.push(prompt);
            return Promise.resolve(''); // operator pressed Enter
        };

        await browserReauthPrompt(io, 'amazon.fr', PROFILE_DIR, SIGN_IN_URL, opener.open, readLine)();

        // The headful window opened at the OWNED profile + the sign-in URL, and closed after the resume signal.
        expect(opener.calls()).toEqual([{ profileDir: PROFILE_DIR, signInUrl: SIGN_IN_URL }]);
        expect(opener.closed()).toBe(1);
        // Sign-in happens in getreceipt's OWN profile (not the operator's everyday browser — the HTTP-path phrasing).
        expect(err()).toContain('collecting from amazon.fr');
        expect(err()).toContain('getreceipt-owned browser profile');
        expect(err()).toContain('skipped on resume'); // resume, not restart
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain('Sign in to amazon.fr');
        expect(prompts[0]).toContain('press Enter to resume');
    });

    it('surfaces no secret/step-up material — fixed literals over the domain only', async () => {
        const { io, err } = captureIO();
        const opener = fakeOpener();
        const prompts: string[] = [];
        const readLine = (_io: CliIO, prompt: string): Promise<string> => {
            prompts.push(prompt);
            return Promise.resolve('');
        };
        await browserReauthPrompt(io, 'amazon.fr', PROFILE_DIR, SIGN_IN_URL, opener.open, readLine)();
        const all = err() + prompts.join('');
        expect(all).not.toMatch(/max_auth_age|session-token|password|otp/i);
    });

    it('AC2 attended: reauth-required → (headful sign-in) → resumes, opening exactly one window', async () => {
        const { io } = captureIO();
        const opener = fakeOpener();
        const run = scriptedRun('reauth-required', 'succeeded');
        const readLine = (): Promise<string> => Promise.resolve('');

        const result = await runWithAttendedReauth({
            runOnce: run.runOnce,
            needsReauth,
            reauth: true,
            isInteractive: () => true,
            onReauth: browserReauthPrompt(io, 'amazon.fr', PROFILE_DIR, SIGN_IN_URL, opener.open, readLine),
        });

        expect(result).toBe('succeeded');
        expect(run.calls()).toBe(2); // initial + one resume
        expect(opener.calls()).toHaveLength(1); // exactly one headful window
        expect(opener.closed()).toBe(1); // and it was closed
    });

    it('AC3 unattended (no TTY): step-up fails fast — NO headful window opened, stdin never read', async () => {
        const { io } = captureIO();
        const opener = fakeOpener();
        const run = scriptedRun('reauth-required', 'succeeded');
        let readLineCalls = 0;
        const readLine = (): Promise<string> => {
            readLineCalls += 1;
            return Promise.resolve('');
        };

        const result = await runWithAttendedReauth({
            runOnce: run.runOnce,
            needsReauth,
            reauth: true, // opted in...
            isInteractive: () => false, // ...but no TTY, so the loop never reaches onReauth
            onReauth: browserReauthPrompt(io, 'amazon.fr', PROFILE_DIR, SIGN_IN_URL, opener.open, readLine),
        });

        expect(result).toBe('reauth-required'); // honest fail-fast (→ exit 5 + reauthRemedy at the render layer)
        expect(run.calls()).toBe(1);
        expect(opener.calls()).toEqual([]); // NEVER blind-launch a headful window no one will see (#255 AC3)
        expect(readLineCalls).toBe(0); // stdin never read → no hang
    });

    it('AC4 bounded: a resume that STILL needs re-auth opens exactly one window, then falls through', async () => {
        const { io } = captureIO();
        const opener = fakeOpener();
        const run = scriptedRun('reauth-required', 'reauth-required'); // never clears
        const readLine = (): Promise<string> => Promise.resolve('');

        const result = await runWithAttendedReauth({
            runOnce: run.runOnce,
            needsReauth,
            reauth: true,
            isInteractive: () => true,
            onReauth: browserReauthPrompt(io, 'amazon.fr', PROFILE_DIR, SIGN_IN_URL, opener.open, readLine),
        });

        expect(result).toBe('reauth-required'); // bounded — no coercive loop
        expect(opener.calls()).toHaveLength(1); // exactly one window (DEFAULT_REAUTH_ATTEMPTS = 1)
        expect(opener.closed()).toBe(1);
    });
});

describe('firstRunSignInNotice — first-run owned-profile heads-up (#264/#256)', () => {
    it('names the addressed source and instructs a ONE-TIME sign-in in the getreceipt-owned profile', () => {
        const notice = firstRunSignInNotice('amazon.com');

        expect(notice).toContain('amazon.com');
        expect(notice.toLowerCase()).toContain('first run');
        expect(notice.toLowerCase()).toContain('sign in');
        // Points at the getreceipt-OWNED profile explicitly, NOT the operator's everyday browser.
        expect(notice).toContain('getreceipt-owned profile');
        expect(notice).toContain('not your everyday browser');
    });

    it('is redaction-safe: fixed literals over the (already-public) source domain only — no profile path or session material leaks', () => {
        const notice = firstRunSignInNotice('amazon.com');

        // A leaked filesystem path (the resolved profile dir) would carry a separator; the notice carries none.
        expect(notice).not.toContain('/');
        expect(notice).not.toContain('\\');
        // No home-dir or dotfile markers, no cookie/session token vocabulary.
        expect(notice).not.toMatch(/Users|home|\.getreceipt|cookie|session/i);
    });
});

describe('defaultSignInWindowOpener — Playwright-free construction (#270 AC5)', () => {
    it('constructs the opener WITHOUT eager-loading @getreceipt/browser: the factory is synchronous, the import is deferred into the returned closure', () => {
        // The factory returns a SignInWindowOpener synchronously — the `await import('@getreceipt/browser')` lives
        // INSIDE that closure, reached only when a window actually opens. So building the CLI env (which calls this)
        // never pulls Playwright into the always-loaded path; this test never invokes the closure, so none loads here.
        const opener = defaultSignInWindowOpener();
        expect(typeof opener).toBe('function');
        expect(opener.length).toBe(2); // (profileDir, signInUrl)
    });
});
