// SPDX-License-Identifier: AGPL-3.0-only
import { promptLine } from './interactive-challenge-resolver.js';
import type { CliIO } from './io.js';

/**
 * How many interactive re-auth attempts the loop makes before falling through to the honest
 * `reauth-required` outcome. One (#247): the resume is idempotent and a fresh browser cookie lands on disk
 * within seconds of a re-auth, so one round-trip suffices — and bounding at one forecloses a coercive prompt
 * loop when a step-up the operator cannot clear in-band keeps recurring (a resume that STILL needs re-auth is
 * a signal to stop, not to re-prompt).
 */
export const DEFAULT_REAUTH_ATTEMPTS = 1;

/** The opt-in, TTY-gated attended re-auth loop's collaborators (#247), generic over the run's result shape. */
export interface AttendedReauthOptions<T> {
    /** Run one collection attempt. Re-invoked after each re-auth — it re-imports the fresh session and skips already-written receipts. */
    readonly runOnce: () => Promise<T>;
    /** True when a result still needs re-auth (the `reauth-required` outcome). */
    readonly needsReauth: (result: T) => boolean;
    /** The `--reauth` opt-in. Without it the loop is never entered — today's behavior, unchanged. */
    readonly reauth: boolean;
    /** Can we prompt? stdin AND stderr a TTY. A non-TTY run never prompts and never reads stdin (no hang). */
    readonly isInteractive: () => boolean;
    /** Print the redaction-safe notice and wait for the operator's resume signal. Reached ONLY when opted-in AND interactive. */
    readonly onReauth: () => Promise<void>;
    /** Max re-auth attempts; defaults to {@link DEFAULT_REAUTH_ATTEMPTS}. */
    readonly maxAttempts?: number;
}

/**
 * Wrap a collection run in the attended re-auth loop (#247): run once, then — ONLY when `--reauth` is set
 * AND the terminal is interactive — on a `reauth-required` result prompt the operator to re-authenticate in
 * their browser and re-run (re-importing the fresh session, skipping already-written receipts: resume, not
 * restart). Bounded (default 1): a resume that STILL needs re-auth falls through to the honest
 * `reauth-required` outcome rather than re-prompting, so a step-up the operator cannot clear in-band never
 * becomes a coercive loop. Without the flag or without a TTY the first result is returned unchanged and stdin
 * is never read — mirroring the consent gate's `blocked` branch, so a piped / CI run cannot hang.
 */
export async function runWithAttendedReauth<T>(options: AttendedReauthOptions<T>): Promise<T> {
    let result = await options.runOnce();
    const maxAttempts = options.maxAttempts ?? DEFAULT_REAUTH_ATTEMPTS;
    let attempts = 0;
    // Opt-in AND interactive are re-checked each turn but never change mid-run; the guard is what keeps a
    // non-opted-in or piped run on today's exact path (no prompt, no stdin read).
    while (options.reauth && options.isInteractive() && options.needsReauth(result) && attempts < maxAttempts) {
        attempts += 1;
        await options.onReauth();
        result = await options.runOnce();
    }
    return result;
}

/**
 * Build the {@link AttendedReauthOptions.onReauth} action: print the re-auth notice and wait for the
 * operator's resume signal. The strings are FIXED literals naming only the `source` domain (already public
 * in the invocation) — never the adapter's `reason` (a prompt-injection fence) and never any account or
 * session material. They instruct the operator to sign in IN THEIR OWN BROWSER (the CLI never handles their
 * password/OTP) and reassure that already-saved receipts are skipped on resume. All output is on stderr, so a
 * `--json` run's stdout stays clean; pressing Enter is the go-ahead (Ctrl-C aborts to `reauth-required`).
 */
export function attendedReauthPrompt(
    io: CliIO,
    source: string,
    readLine: (io: CliIO, prompt: string) => Promise<string> = promptLine,
): () => Promise<void> {
    return async () => {
        io.writeErr(`\nRe-authentication is required to continue collecting from ${source}.\n`);
        io.writeErr('Already-saved receipts are skipped on resume — this resumes the run, it does not restart it.\n');
        await readLine(io, `Sign in to ${source} again in your browser, then press Enter to resume (Ctrl-C to stop): `);
    };
}

/**
 * Open the getreceipt-OWNED persistent profile in a headful window for an attended sign-in and hand back a handle
 * to close it — the shape `@getreceipt/browser`'s `openProfileForSignIn` provides (#255). Injected into
 * {@link browserReauthPrompt} so the CLI stays Playwright-free; the wiring that supplies the real opener (and the
 * resolved profile dir) is the config-selectability follow-up (#264).
 */
export type SignInWindowOpener = (
    profileDir: string,
    signInUrl: string,
) => Promise<{ readonly close: () => Promise<void> }>;

/**
 * Build the {@link AttendedReauthOptions.onReauth} action for the browser-DRIVEN tier (#255). Where
 * {@link attendedReauthPrompt} tells the operator to sign in again in their OWN browser (the HTTP path re-imports
 * from that cookie store), the browser tier's session lives in getreceipt's OWNED persistent profile — so this
 * OPENS a headful window at that profile ({@link SignInWindowOpener}), waits for the operator's resume signal,
 * then closes it. The signed-in cookies persist in the profile on disk, so {@link runWithAttendedReauth}'s next
 * `runOnce` re-navigates headless and resumes.
 *
 * The window opens INSIDE this action, which the loop reaches ONLY when opted-in AND interactive — so an
 * unattended (piped / scheduled) run NEVER launches a window (#255 AC3): the gate is structural, not a flag check
 * here. Redaction-safe: FIXED literals over the `source` domain only (already public in the invocation) — never
 * the adapter's `reason` (a prompt-injection fence) nor any account/session material; all output on stderr so a
 * `--json` stdout stays clean. Pressing Enter is the go-ahead (Ctrl-C aborts); the window is closed in a
 * `finally` so it never leaks on the resume path. getreceipt never handles the operator's password/OTP.
 */
export function browserReauthPrompt(
    io: CliIO,
    source: string,
    profileDir: string,
    signInUrl: string,
    openSignInWindow: SignInWindowOpener,
    readLine: (io: CliIO, prompt: string) => Promise<string> = promptLine,
): () => Promise<void> {
    return async () => {
        io.writeErr(`\nRe-authentication is required to continue collecting from ${source}.\n`);
        io.writeErr(
            'Opening a sign-in window in the getreceipt-owned browser profile — sign in there, not in your everyday browser.\n',
        );
        io.writeErr('Already-saved receipts are skipped on resume — this resumes the run, it does not restart it.\n');
        const signInWindow = await openSignInWindow(profileDir, signInUrl);
        try {
            await readLine(io, `Sign in to ${source} in the window, then press Enter to resume (Ctrl-C to stop): `);
        } finally {
            await signInWindow.close();
        }
    };
}
