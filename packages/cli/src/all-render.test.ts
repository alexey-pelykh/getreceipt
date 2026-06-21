// SPDX-License-Identifier: AGPL-3.0-only
import type { OperationOutcome, OperationResult } from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import {
    batchExitCode,
    deriveBatchOutcome,
    renderAllJson,
    renderAllText,
    type BatchReport,
    type BatchSourceResult,
} from './all-render.js';

const WINDOW = { from: '2024-01-01T00:00:00.000Z', to: '2024-01-31T00:00:00.000Z' };

function result(source: string, outcome: OperationOutcome, extra: Partial<OperationResult> = {}): OperationResult {
    return { source, outcome, window: WINDOW, written: [], skipped: [], ...extra };
}

function ran(source: string, outcome: OperationOutcome, extra: Partial<OperationResult> = {}): BatchSourceResult {
    return { source, ok: true, result: result(source, outcome, extra) };
}

function failed(source: string, kind = 'unknown-source'): BatchSourceResult {
    return { source, ok: false, error: { kind, message: `no adapter for ${source}` } };
}

describe('deriveBatchOutcome', () => {
    it('is `succeeded` for an empty run (nothing failed)', () => {
        expect(deriveBatchOutcome([])).toBe('succeeded');
    });

    it('is `succeeded` only when every source is a clean success', () => {
        expect(deriveBatchOutcome([ran('a', 'succeeded'), ran('b', 'succeeded')])).toBe('succeeded');
    });

    it('is `failed` when no source is a clean success', () => {
        expect(deriveBatchOutcome([failed('a'), ran('b', 'failed')])).toBe('failed');
    });

    it('is `partial` when some succeed and some do not', () => {
        expect(deriveBatchOutcome([ran('a', 'succeeded'), failed('b')])).toBe('partial');
    });

    it('counts a reauth-required source as NOT a clean success', () => {
        // one clean + one reauth → partial; reauth alone → failed (reauth is not "succeeded").
        expect(deriveBatchOutcome([ran('a', 'succeeded'), ran('b', 'reauth-required')])).toBe('partial');
        expect(deriveBatchOutcome([ran('b', 'reauth-required')])).toBe('failed');
    });

    it('counts a partial single-source run as NOT a clean success', () => {
        expect(deriveBatchOutcome([ran('a', 'partial', { written: [{ id: 'x', issuedAt: WINDOW.from }] })])).toBe(
            'failed',
        );
    });
});

describe('batchExitCode — the partial-failure ladder', () => {
    it('maps succeeded → 0, partial → 3, failed → 4', () => {
        expect(batchExitCode('succeeded')).toBe(0);
        expect(batchExitCode('partial')).toBe(3);
        expect(batchExitCode('failed')).toBe(4);
    });
});

describe('renderAllText', () => {
    function report(sources: BatchSourceResult[], outcome: BatchReport['outcome']): BatchReport {
        return { profile: 'default', outcome, concurrency: 3, sources };
    }

    it('renders the header with profile, concurrency, and outcome', () => {
        const text = renderAllText(report([ran('a', 'succeeded')], 'succeeded'));
        expect(text).toContain('all (profile: default, concurrency: 3) — succeeded');
    });

    it('renders a ran source with written/skipped counts', () => {
        const text = renderAllText(
            report([ran('shop.example', 'succeeded', { written: [{ id: 'r1', issuedAt: WINDOW.from }] })], 'succeeded'),
        );
        expect(text).toContain('shop.example — succeeded');
        expect(text).toContain('written: 1');
        expect(text).toContain('skipped: 0');
    });

    it('renders a reauth-required source with its reason and NO written/skipped counts (Finding 1 coverage)', () => {
        const text = renderAllText(
            report([ran('shop.example', 'reauth-required', { reason: 'session expired' })], 'failed'),
        );
        expect(text).toContain('shop.example — reauth-required');
        expect(text).toContain('session expired');
        expect(text).not.toContain('written:'); // counts are omitted for a reauth-required source
    });

    it('names the `login` remedy verb for a reauth-required source (#17 [AC3])', () => {
        const text = renderAllText(
            report([ran('shop.example', 'reauth-required', { reason: 'session expired' })], 'failed'),
        );
        expect(text).toContain('getreceipt login shop.example');
    });

    it('renders a pre-flight error source with its kind and message', () => {
        const text = renderAllText(report([failed('ghost.example', 'unknown-source')], 'failed'));
        expect(text).toContain('ghost.example — error (unknown-source)');
        expect(text).toContain('no adapter for ghost.example');
    });

    it('renders a wins/total footer', () => {
        const text = renderAllText(report([ran('a', 'succeeded'), failed('b')], 'partial'));
        expect(text).toContain('1/2 succeeded');
    });

    it('renders "(no sources configured)" for an empty run', () => {
        const text = renderAllText(report([], 'succeeded'));
        expect(text).toContain('(no sources configured)');
        expect(text).not.toContain('succeeded\n0/0');
    });
});

describe('renderAllJson', () => {
    it('round-trips a structured batch report (incl. an explicit window)', () => {
        const report: BatchReport = {
            profile: 'default',
            outcome: 'partial',
            concurrency: 2,
            window: WINDOW,
            sources: [ran('a', 'succeeded'), failed('b')],
        };
        expect(JSON.parse(renderAllJson(report))).toEqual(report);
    });
});
