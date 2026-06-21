// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseAtBoundary, safeParseAtBoundary, TrustBoundaryError } from './index.js';

// Reused across the secret-hygiene tests; mirrors the sentinel convention in
// @getreceipt/auth's config.test.ts so a leak shows up as this exact substring.
const SECRET = 'sk-LEAK-SENTINEL-9f3a2b';

const receiptSchema = z.object({
    id: z.string().min(1),
    issuedAt: z.date(),
    title: z.string().optional(),
});

describe('parseAtBoundary', () => {
    it('returns the typed value for valid data', () => {
        const issuedAt = new Date('2026-01-02T03:04:05Z');
        const out = parseAtBoundary(receiptSchema, { id: 'r1', issuedAt }, 'free.fr:list');

        expect(out).toEqual({ id: 'r1', issuedAt });
        // Type-level: `out.id` is string (no cast). Runtime confirms the value survived.
        expect(out.id).toBe('r1');
    });

    it('throws a typed TrustBoundaryError carrying the boundary label', () => {
        let caught: unknown;
        try {
            parseAtBoundary(receiptSchema, { id: '', issuedAt: new Date() }, 'free.fr:list');
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(TrustBoundaryError);
        expect((caught as TrustBoundaryError).boundary).toBe('free.fr:list');
        expect((caught as TrustBoundaryError).name).toBe('TrustBoundaryError');
    });

    it('surfaces each violation as a value-free {path, code} issue', () => {
        let caught: TrustBoundaryError | undefined;
        try {
            parseAtBoundary(receiptSchema, { id: 'r1', issuedAt: 'nope' }, 'free.fr:list');
        } catch (error) {
            caught = error as TrustBoundaryError;
        }

        expect(caught?.issues).toEqual([{ path: 'issuedAt', code: 'invalid_type' }]);
    });

    it('renders nested object/array paths and a root failure', () => {
        const listSchema = z.object({ receipts: z.array(receiptSchema) });
        const nested = safeParseAtBoundary(
            listSchema,
            {
                receipts: [
                    { id: 'r1', issuedAt: new Date() },
                    { id: 'r2', issuedAt: 'nope' },
                ],
            },
            'free.fr:list',
        );
        expect(nested.ok).toBe(false);
        if (!nested.ok) {
            expect(nested.error.issues).toEqual([{ path: 'receipts[1].issuedAt', code: 'invalid_type' }]);
        }

        const root = safeParseAtBoundary(z.string(), 123, 'free.fr:fetch');
        expect(root.ok).toBe(false);
        if (!root.ok) {
            expect(root.error.issues).toEqual([{ path: '<root>', code: 'invalid_type' }]);
        }
    });

    it('rejects an invalid Date at the boundary (issuedAt hardening)', () => {
        const bad = safeParseAtBoundary(receiptSchema, { id: 'r1', issuedAt: new Date('not-a-date') }, 'free.fr:list');
        expect(bad.ok).toBe(false);

        const good = safeParseAtBoundary(receiptSchema, { id: 'r1', issuedAt: new Date() }, 'free.fr:list');
        expect(good.ok).toBe(true);
    });
});

describe('safeParseAtBoundary', () => {
    it('returns a typed ok result for valid data', () => {
        const result = safeParseAtBoundary(z.object({ a: z.number() }), { a: 1 }, 'b');
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.a).toBe(1);
        }
    });

    it('returns the SAME sanitized TrustBoundaryError on failure (no side door)', () => {
        const result = safeParseAtBoundary(z.object({ a: z.number() }), { a: 'no' }, 'b');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            // The non-throwing path must produce a sanitized TrustBoundaryError, never a raw ZodError.
            expect(result.error).toBeInstanceOf(TrustBoundaryError);
            expect(result.error.issues).toEqual([{ path: 'a', code: 'invalid_type' }]);
        }
    });
});

describe('TrustBoundaryError secret hygiene', () => {
    it('never echoes the offending VALUE — not in message, not in issues', () => {
        const result = safeParseAtBoundary(receiptSchema, { id: SECRET, issuedAt: SECRET }, 'free.fr:list');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            const serialized = `${result.error.message}::${JSON.stringify(result.error.issues)}`;
            expect(serialized).not.toContain(SECRET);
            // It still reports WHERE/WHAT, value-free.
            expect(result.error.issues.some((issue) => issue.path === 'issuedAt')).toBe(true);
        }
    });

    it('does not leak the received value via enum/invalid_value messages', () => {
        const result = safeParseAtBoundary(z.enum(['x', 'y']), SECRET, 'free.fr:list');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(`${result.error.message}::${JSON.stringify(result.error.issues)}`).not.toContain(SECRET);
        }
    });

    it('keeps an untrusted MAP KEY out of the error when modeled as array-of-entries', () => {
        // Design rule: never validate an untrusted-keyed record at the boundary (a
        // z.record key lands in the issue path and would leak). Model untrusted maps
        // as entries so the key travels as a VALUE — which is never echoed.
        const entriesSchema = z.array(z.object({ key: z.string(), value: z.number() }));
        const result = safeParseAtBoundary(entriesSchema, [{ key: SECRET, value: 'not-a-number' }], 'free.fr:list');

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(`${result.error.message}::${JSON.stringify(result.error.issues)}`).not.toContain(SECRET);
            expect(result.error.issues).toEqual([{ path: '[0].value', code: 'invalid_type' }]);
        }
    });
});
