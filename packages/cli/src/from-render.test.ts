// SPDX-License-Identifier: AGPL-3.0-only
import type { OperationResult } from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import { EXIT_CODES, exitCodeFor, renderResultsTable } from './from-render.js';

const isoWindow = { from: '2024-01-01T00:00:00.000Z', to: '2024-01-31T00:00:00.000Z' };

describe('exit-code ladder', () => {
    it('maps every outcome to a distinct, documented code', () => {
        expect(exitCodeFor('succeeded')).toBe(0);
        expect(exitCodeFor('partial')).toBe(3);
        expect(exitCodeFor('failed')).toBe(4);
        expect(exitCodeFor('reauth-required')).toBe(5);
    });

    it('keeps re-auth-required and the two failure codes mutually distinct (AC #3)', () => {
        const codes = [
            exitCodeFor('partial'),
            exitCodeFor('failed'),
            exitCodeFor('reauth-required'),
            EXIT_CODES.success,
        ];
        expect(new Set(codes).size).toBe(codes.length);
    });
});

describe('renderResultsTable', () => {
    it('renders a succeeded run: header, window, counts, and one row per receipt', () => {
        const result: OperationResult = {
            source: 'shop.example',
            outcome: 'succeeded',
            window: isoWindow,
            written: [
                { id: 'inv-1', issuedAt: '2024-01-05T09:00:00.000Z', title: 'January invoice' },
                { id: 'inv-2', issuedAt: '2024-01-06T09:00:00.000Z' },
            ],
            skipped: [{ id: 'inv-0', issuedAt: '2024-01-04T09:00:00.000Z' }],
        };

        const text = renderResultsTable(result);
        expect(text).toContain('shop.example — succeeded');
        expect(text).toContain('window: 2024-01-01 → 2024-01-31');
        expect(text).toContain('written: 2   skipped: 1');
        expect(text).toContain('written  inv-1  2024-01-05  January invoice');
        expect(text).toContain('written  inv-2  2024-01-06');
        expect(text).toContain('skipped  inv-0  2024-01-04');
        expect(text.endsWith('\n')).toBe(true);
    });

    it('renders a partial run with its failure reason', () => {
        const result: OperationResult = {
            source: 'shop.example',
            outcome: 'partial',
            window: isoWindow,
            written: [{ id: 'inv-1', issuedAt: '2024-01-05T09:00:00.000Z' }],
            skipped: [],
            reason: 'fetch timed out on inv-2',
        };

        const text = renderResultsTable(result);
        expect(text).toContain('shop.example — partial');
        expect(text).toContain('written: 1   skipped: 0');
        expect(text).toContain('partial: fetch timed out on inv-2');
    });

    it('renders reauth-required without receipt rows', () => {
        const result: OperationResult = {
            source: 'shop.example',
            outcome: 'reauth-required',
            window: isoWindow,
            written: [],
            skipped: [],
            reason: 'session expired',
        };

        const text = renderResultsTable(result);
        expect(text).toContain('shop.example — reauth-required');
        expect(text).toContain('re-authentication required: session expired');
        expect(text).not.toContain('written:');
    });
});
