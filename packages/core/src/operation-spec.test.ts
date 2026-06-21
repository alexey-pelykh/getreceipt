// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import type { CollectResult } from './collect.js';
import { toOperationResult } from './operation-spec.js';
import type { ReceiptRef } from './source-adapter.js';

const window = { from: new Date('2024-01-01T00:00:00.000Z'), to: new Date('2024-01-31T00:00:00.000Z') };
const isoWindow = { from: '2024-01-01T00:00:00.000Z', to: '2024-01-31T00:00:00.000Z' };

function ref(id: string, title?: string): ReceiptRef {
    return title === undefined
        ? { id, issuedAt: new Date('2024-01-05T09:00:00.000Z') }
        : { id, issuedAt: new Date('2024-01-05T09:00:00.000Z'), title };
}

describe('toOperationResult', () => {
    it('maps a succeeded result, rendering dates to ISO-8601 and receipts to summaries', () => {
        const collected: CollectResult = {
            outcome: 'succeeded',
            source: 'shop.example',
            window,
            written: [ref('inv-1', 'January invoice')],
            skipped: [ref('inv-0')],
        };

        expect(toOperationResult(collected)).toEqual({
            source: 'shop.example',
            outcome: 'succeeded',
            window: isoWindow,
            written: [{ id: 'inv-1', issuedAt: '2024-01-05T09:00:00.000Z', title: 'January invoice' }],
            // A titleless ref omits `title` entirely (exactOptionalPropertyTypes), not `title: undefined`.
            skipped: [{ id: 'inv-0', issuedAt: '2024-01-05T09:00:00.000Z' }],
        });
    });

    it('splits a failure WITH progress into `partial`', () => {
        const collected: CollectResult = {
            outcome: 'failed',
            source: 'shop.example',
            window,
            reason: 'fetch timed out on inv-2',
            cause: new Error('timeout'),
            written: [ref('inv-1')],
            skipped: [],
        };

        const result = toOperationResult(collected);
        expect(result.outcome).toBe('partial');
        expect(result.reason).toBe('fetch timed out on inv-2');
        expect(result.written).toEqual([{ id: 'inv-1', issuedAt: '2024-01-05T09:00:00.000Z' }]);
    });

    it('maps a failure with NO progress to `failed`', () => {
        const collected: CollectResult = {
            outcome: 'failed',
            source: 'shop.example',
            window,
            reason: 'authentication endpoint unreachable',
            cause: new Error('ENOTFOUND'),
            written: [],
            skipped: [],
        };

        const result = toOperationResult(collected);
        expect(result.outcome).toBe('failed');
        expect(result.reason).toBe('authentication endpoint unreachable');
        expect(result.written).toEqual([]);
    });

    it('maps reauth-required, carrying the optional reason', () => {
        const collected: CollectResult = {
            outcome: 'reauth-required',
            source: 'shop.example',
            window,
            reason: 'session expired',
        };

        expect(toOperationResult(collected)).toEqual({
            source: 'shop.example',
            outcome: 'reauth-required',
            window: isoWindow,
            written: [],
            skipped: [],
            reason: 'session expired',
        });
    });

    it('omits `reason` for a reauth-required result without one', () => {
        const collected: CollectResult = { outcome: 'reauth-required', source: 'shop.example', window };

        const result = toOperationResult(collected);
        expect(result).not.toHaveProperty('reason');
        expect(result.outcome).toBe('reauth-required');
    });

    it('produces a JSON-round-trippable value (no Date, no handles)', () => {
        const collected: CollectResult = {
            outcome: 'succeeded',
            source: 'shop.example',
            window,
            written: [ref('inv-1', 'January invoice')],
            skipped: [],
        };

        const result = toOperationResult(collected);
        expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    });
});
