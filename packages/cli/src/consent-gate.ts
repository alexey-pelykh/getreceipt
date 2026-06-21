// SPDX-License-Identifier: AGPL-3.0-only
import { createInterface } from 'node:readline/promises';

import { createConsentStore } from '@getreceipt/auth';
import type { ConsentStore } from '@getreceipt/auth';
import { CONSENT_ACKNOWLEDGMENT, CONSENT_VERSION, PERSONAL_USE_NOTICE, UNOFFICIAL_DISCLAIMER } from '@getreceipt/core';

import { EXIT_CODES } from './from-render.js';
import { processStreamsIO, type CliIO } from './io.js';

/** Why a fetch run was refused at the consent gate. */
export type ConsentBlockReason = 'declined' | 'non-interactive';

/**
 * The gate's decision, a pure function of (stored consent, opt-in flag, interactivity):
 *  - `accepted` — consent already on record for the current terms; proceed silently.
 *  - `opt-in` — `--accept-consent` was passed; show the terms, record, proceed.
 *  - `prompt` — interactive and not yet accepted; ask before proceeding.
 *  - `blocked` — not accepted, no flag, and not interactive; refuse WITHOUT ever reading stdin.
 */
export type ConsentDecision = 'accepted' | 'opt-in' | 'prompt' | 'blocked';

/**
 * Decide what the consent gate must do — pure, no I/O — so the full matrix is unit-testable without a
 * real home dir or TTY. Order is load-bearing: a record short-circuits; an explicit opt-in flag beats
 * a prompt; a prompt needs interactivity; otherwise refuse (the `blocked` branch never reads stdin, so
 * a piped / CI invocation cannot hang).
 */
export function decideConsent(input: {
    readonly accepted: boolean;
    readonly acceptFlag: boolean;
    readonly interactive: boolean;
}): ConsentDecision {
    if (input.accepted) {
        return 'accepted';
    }
    if (input.acceptFlag) {
        return 'opt-in';
    }
    return input.interactive ? 'prompt' : 'blocked';
}

/**
 * A refusal at the consent gate — the fetch run must not start. Carries a machine-readable
 * {@link reason} (the user declined the prompt, or consent could not be obtained non-interactively)
 * and no message of its own: the gate has ALREADY written the user-facing explanation via {@link CliIO}.
 */
export class ConsentRequiredError extends Error {
    override readonly name = 'ConsentRequiredError';

    constructor(readonly reason: ConsentBlockReason) {
        super(`consent ${reason}`);
    }
}

/** Map a consent refusal to its CLI exit code (6 = needs acknowledgment, 7 = explicitly declined). */
export function consentExitCodeFor(reason: ConsentBlockReason): number {
    return reason === 'declined' ? EXIT_CODES.consentDeclined : EXIT_CODES.consentRequired;
}

/** The consent pre-flight a fetch verb runs before touching a service with the user's credentials. */
export interface ConsentGate {
    /** Ensure consent is on record; persist on a fresh acceptance. Throws {@link ConsentRequiredError} if refused. */
    ensure(opts: { readonly acceptFlag: boolean }): Promise<void>;
}

/** Construction-time collaborators for the real gate; each has a production default. */
export interface ConsentGateDeps {
    readonly store: ConsentStore;
    readonly io: CliIO;
    /** Whether we can prompt: stdin is readable AND stderr (where the prompt is shown) is a TTY. */
    readonly isInteractive: () => boolean;
    /** Ask the user to accept; resolves true on a yes. Only ever invoked on the interactive path. */
    readonly confirm: (io: CliIO) => Promise<boolean>;
    readonly now: () => Date;
}

function defaultDeps(): ConsentGateDeps {
    return {
        store: createConsentStore(),
        io: processStreamsIO(),
        // The prompt is shown on stderr (stdout stays clean for --json), so gate on stderr's TTY-ness.
        isInteractive: () => process.stdin.isTTY === true && process.stderr.isTTY === true,
        confirm: readlineConfirm,
        now: () => new Date(),
    };
}

/** The one-time first-run notice: the unofficial / personal-use posture plus the acknowledgment terms. Written to stderr. */
function printNotice(io: CliIO): void {
    io.writeErr(`\n${UNOFFICIAL_DISCLAIMER}\n${PERSONAL_USE_NOTICE}\n\n${CONSENT_ACKNOWLEDGMENT}\n`);
}

/**
 * Run the consent pre-flight: load the stored acknowledgment, decide, and act. Persists on a fresh
 * acceptance (opt-in flag or a prompted yes) and throws {@link ConsentRequiredError} — AFTER writing a
 * user-facing reason — on a decline or a non-interactive block. The notice is shown BEFORE persisting
 * even on the `--accept-consent` path, so a scripted opt-in never records consent to terms unseen.
 * Consent is recorded per machine (see {@link ConsentRecord}); the acknowledgment text binds the user.
 */
export async function ensureConsent(deps: ConsentGateDeps, opts: { readonly acceptFlag: boolean }): Promise<void> {
    const stored = await deps.store.load();
    const accepted = stored !== undefined && stored.version >= CONSENT_VERSION;
    const decision = decideConsent({ accepted, acceptFlag: opts.acceptFlag, interactive: deps.isInteractive() });

    switch (decision) {
        case 'accepted':
            return;
        case 'opt-in':
            printNotice(deps.io);
            await persist(deps);
            deps.io.writeErr('Consent recorded (--accept-consent).\n');
            return;
        case 'prompt': {
            printNotice(deps.io);
            const yes = await deps.confirm(deps.io);
            if (!yes) {
                deps.io.writeErr('✗ Consent declined; aborting. No receipts were fetched.\n');
                throw new ConsentRequiredError('declined');
            }
            await persist(deps);
            deps.io.writeErr('Consent recorded.\n');
            return;
        }
        case 'blocked':
            printNotice(deps.io);
            deps.io.writeErr(
                '✗ Consent is required before fetching, and this is not an interactive terminal.\n' +
                    '  Re-run in a terminal to accept, or pass --accept-consent to record acceptance non-interactively.\n',
            );
            throw new ConsentRequiredError('non-interactive');
    }
}

async function persist(deps: ConsentGateDeps): Promise<void> {
    await deps.store.save({ acceptedAt: deps.now().toISOString(), version: CONSENT_VERSION });
}

/**
 * The production {@link ConsentGateDeps.confirm}: write the prompt through {@link CliIO} (NOT raw
 * stderr, so it stays captured/testable), then read one line from stdin. `terminal: false` keeps it
 * a plain line read — the surrounding TTY echoes the user's keystrokes. `input` is injectable so the
 * line-parsing is testable without a real TTY (and proves the read never blocks on a closed stream).
 */
export async function readlineConfirm(io: CliIO, input: NodeJS.ReadableStream = process.stdin): Promise<boolean> {
    io.writeErr('Accept and continue? [y/N] ');
    const rl = createInterface({ input, terminal: false });
    try {
        const answer = await rl.question('');
        return /^\s*y(es)?\s*$/i.test(answer);
    } finally {
        rl.close();
    }
}

/** Build the production consent gate, overriding individual seams in tests. */
export function createConsentGate(overrides: Partial<ConsentGateDeps> = {}): ConsentGate {
    const deps: ConsentGateDeps = { ...defaultDeps(), ...overrides };
    return { ensure: (opts) => ensureConsent(deps, opts) };
}
