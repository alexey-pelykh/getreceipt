// SPDX-License-Identifier: AGPL-3.0-only
import { Readable } from 'node:stream';

import type { ConsentRecord, ConsentStore } from '@getreceipt/auth';
import { CONSENT_ACKNOWLEDGMENT, CONSENT_VERSION } from '@getreceipt/core';
import { describe, expect, it, vi } from 'vitest';

import {
    consentExitCodeFor,
    ConsentRequiredError,
    createConsentGate,
    decideConsent,
    ensureConsent,
    readlineConfirm,
    type ConsentGateDeps,
} from './consent-gate.js';
import { EXIT_CODES } from './from-render.js';
import type { CliIO } from './io.js';

const NOW = new Date('2026-06-21T12:00:00.000Z');

interface Harness {
    readonly deps: ConsentGateDeps;
    readonly saved: ConsentRecord[];
    readonly errText: () => string;
    readonly confirm: ReturnType<typeof vi.fn>;
}

/** Build gate deps with recording I/O + an in-memory store. `stored` seeds a prior record; `confirm` defaults to yes. */
function harness(
    opts: { stored?: ConsentRecord; interactive?: boolean; confirm?: () => Promise<boolean> } = {},
): Harness {
    const errs: string[] = [];
    // The gate writes solely to stderr; stdout stays clean for --json, so discard it here.
    const io: CliIO = { writeOut: () => {}, writeErr: (t) => errs.push(t) };
    const saved: ConsentRecord[] = [];
    let current = opts.stored;
    const store: ConsentStore = {
        load: () => Promise.resolve(current),
        save: (record) => {
            saved.push(record);
            current = record;
            return Promise.resolve();
        },
    };
    const confirm = vi.fn(opts.confirm ?? (() => Promise.resolve(true)));
    return {
        deps: { store, io, isInteractive: () => opts.interactive ?? false, confirm, now: () => NOW },
        saved,
        errText: () => errs.join(''),
        confirm,
    };
}

describe('decideConsent (pure matrix)', () => {
    it('returns accepted when a record exists — regardless of flag/interactivity', () => {
        expect(decideConsent({ accepted: true, acceptFlag: false, interactive: false })).toBe('accepted');
        expect(decideConsent({ accepted: true, acceptFlag: true, interactive: true })).toBe('accepted');
    });

    it('returns opt-in when not accepted but the flag is set', () => {
        expect(decideConsent({ accepted: false, acceptFlag: true, interactive: false })).toBe('opt-in');
    });

    it('returns prompt when not accepted, no flag, and interactive', () => {
        expect(decideConsent({ accepted: false, acceptFlag: false, interactive: true })).toBe('prompt');
    });

    it('returns blocked when not accepted, no flag, and NOT interactive', () => {
        expect(decideConsent({ accepted: false, acceptFlag: false, interactive: false })).toBe('blocked');
    });
});

describe('ensureConsent — consent given proceeds (AC: consent given → proceeds)', () => {
    it('proceeds silently when a current record is already stored (no prompt, no save, no notice)', async () => {
        const h = harness({
            stored: { acceptedAt: '2025-01-01T00:00:00.000Z', version: CONSENT_VERSION },
            interactive: true,
        });
        await expect(ensureConsent(h.deps, { acceptFlag: false })).resolves.toBeUndefined();
        expect(h.confirm).not.toHaveBeenCalled();
        expect(h.saved).toHaveLength(0);
        expect(h.errText()).toBe('');
    });

    it('re-prompts when the stored record predates the current terms version', async () => {
        // A stale (older-version) acknowledgment must NOT count as accepted.
        const h = harness({
            stored: { acceptedAt: '2020-01-01T00:00:00.000Z', version: CONSENT_VERSION - 1 },
            interactive: true,
        });
        await ensureConsent(h.deps, { acceptFlag: false });
        expect(h.confirm).toHaveBeenCalledOnce();
        expect(h.saved).toEqual([{ acceptedAt: NOW.toISOString(), version: CONSENT_VERSION }]);
    });

    it('records consent on a prompted yes and shows the acknowledgment terms', async () => {
        const h = harness({ interactive: true, confirm: () => Promise.resolve(true) });
        await ensureConsent(h.deps, { acceptFlag: false });
        expect(h.confirm).toHaveBeenCalledOnce();
        expect(h.errText()).toContain(CONSENT_ACKNOWLEDGMENT);
        expect(h.saved).toEqual([{ acceptedAt: NOW.toISOString(), version: CONSENT_VERSION }]);
    });
});

describe('ensureConsent — --accept-consent opt-in (non-interactive)', () => {
    it('shows the terms BEFORE persisting, records, and proceeds without prompting', async () => {
        const h = harness({ interactive: false });
        await ensureConsent(h.deps, { acceptFlag: true });
        expect(h.confirm).not.toHaveBeenCalled();
        expect(h.errText()).toContain(CONSENT_ACKNOWLEDGMENT); // disclosure shown even on scripted opt-in
        expect(h.saved).toEqual([{ acceptedAt: NOW.toISOString(), version: CONSENT_VERSION }]);
    });
});

describe('ensureConsent — consent required blocks (AC: consent required → blocked)', () => {
    it('blocks a NON-interactive run without consent, NEVER reading stdin (no hang)', async () => {
        const h = harness({ interactive: false });
        await expect(ensureConsent(h.deps, { acceptFlag: false })).rejects.toBeInstanceOf(ConsentRequiredError);
        // The decisive no-hang guarantee: the prompt seam is never invoked on the non-interactive path.
        expect(h.confirm).not.toHaveBeenCalled();
        expect(h.saved).toHaveLength(0); // a block must NOT fabricate a record
        expect(h.errText()).toContain('--accept-consent');
    });

    it('tags the non-interactive block with reason "non-interactive"', async () => {
        const h = harness({ interactive: false });
        await expect(ensureConsent(h.deps, { acceptFlag: false })).rejects.toMatchObject({ reason: 'non-interactive' });
    });

    it('blocks (and does NOT persist) when the user declines the prompt', async () => {
        const h = harness({ interactive: true, confirm: () => Promise.resolve(false) });
        await expect(ensureConsent(h.deps, { acceptFlag: false })).rejects.toMatchObject({ reason: 'declined' });
        expect(h.saved).toHaveLength(0); // a decline must NOT record consent
        expect(h.errText()).toContain('declined');
    });
});

describe('ensureConsent — persistence (AC: persistence)', () => {
    it('a fresh acceptance makes the NEXT run proceed silently (consent is not re-prompted)', async () => {
        const h = harness({ interactive: true, confirm: () => Promise.resolve(true) });

        // First run: prompted + recorded.
        await ensureConsent(h.deps, { acceptFlag: false });
        expect(h.confirm).toHaveBeenCalledOnce();
        expect(h.saved).toHaveLength(1);

        // Second run against the SAME store: the persisted record short-circuits the gate.
        await ensureConsent(h.deps, { acceptFlag: false });
        expect(h.confirm).toHaveBeenCalledOnce(); // not called again
        expect(h.saved).toHaveLength(1); // not saved again
    });
});

describe('consentExitCodeFor', () => {
    it('maps non-interactive block → 6 and decline → 7', () => {
        expect(consentExitCodeFor('non-interactive')).toBe(EXIT_CODES.consentRequired);
        expect(consentExitCodeFor('non-interactive')).toBe(6);
        expect(consentExitCodeFor('declined')).toBe(EXIT_CODES.consentDeclined);
        expect(consentExitCodeFor('declined')).toBe(7);
    });
});

describe('createConsentGate', () => {
    it('builds a gate that ensures through the injected seams', async () => {
        const saved: ConsentRecord[] = [];
        const gate = createConsentGate({
            store: {
                load: () => Promise.resolve(undefined),
                save: (r) => {
                    saved.push(r);
                    return Promise.resolve();
                },
            },
            io: { writeOut: () => {}, writeErr: () => {} },
            isInteractive: () => false,
            now: () => NOW,
        });
        await gate.ensure({ acceptFlag: true });
        expect(saved).toEqual([{ acceptedAt: NOW.toISOString(), version: CONSENT_VERSION }]);
    });
});

describe('readlineConfirm (default prompt — parses y/N, never hangs on a finite stream)', () => {
    const errs: string[] = [];
    const io: CliIO = { writeOut: () => {}, writeErr: (t) => errs.push(t) };

    it.each([
        ['y\n', true],
        ['yes\n', true],
        ['Y\n', true],
        ['  yes  \n', true],
        ['n\n', false],
        ['\n', false],
        ['nope\n', false],
    ])('reads %j as %s', async (line, expected) => {
        const answer = await readlineConfirm(io, Readable.from([line]));
        expect(answer).toBe(expected);
    });

    it('writes the prompt through CliIO (stays captured, not raw stderr)', async () => {
        errs.length = 0;
        await readlineConfirm(io, Readable.from(['y\n']));
        expect(errs.join('')).toContain('Accept and continue?');
    });
});
