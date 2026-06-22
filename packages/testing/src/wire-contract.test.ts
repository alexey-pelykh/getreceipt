// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { findHandAuthoredEndpointLiterals, wireFixture, WireFixtureError } from './wire-contract.js';

// A stand-in wire schema with a defaulted field, mirroring the real adapter contracts (e.g. monoprix's
// `type` default). The point is the helpers' behaviour, not any specific adapter's shape.
const receiptSchema = z.object({
    id: z.string().min(1),
    type: z.string().default('store'),
    amount: z.number(),
});

describe('wireFixture — fixtures derive from the wire schema (#88)', () => {
    it('returns a schema-conforming fixture unchanged', () => {
        const fixture = wireFixture(receiptSchema, { id: 'r1', type: 'store', amount: 9.99 });

        expect(fixture).toEqual({ id: 'r1', type: 'store', amount: 9.99 });
    });

    it('serves the body AS AUTHORED — an omitted defaulted field is not injected by validation', () => {
        // This is what lets a test exercise the adapter's own default path: the wire body must reach the
        // adapter without `type`, even though the schema would default it on parse.
        const fixture = wireFixture(receiptSchema, { id: 'r1', amount: 1 });

        expect(fixture).toEqual({ id: 'r1', amount: 1 });
        expect('type' in fixture).toBe(false);
    });

    it('throws WireFixtureError for a planted divergent fixture (wrong field type)', () => {
        const divergent = { id: 'r1', amount: 'nope' } as unknown as z.input<typeof receiptSchema>;

        expect(() => wireFixture(receiptSchema, divergent)).toThrow(WireFixtureError);
    });

    it('throws for a divergence the schema rejects (empty required string) and carries the ZodError on cause', () => {
        let caught: unknown;
        try {
            wireFixture(receiptSchema, { id: '', amount: 1 });
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(WireFixtureError);
        expect((caught as WireFixtureError).cause).toBeInstanceOf(z.ZodError);
        expect((caught as WireFixtureError).message).toContain('id');
    });
});

describe('findHandAuthoredEndpointLiterals — flags hand-authored endpoints in a test (#88)', () => {
    it('flags an absolute-URL string literal hand-typed beside the adapter (the circular-green vector)', () => {
        const planted = ["const BASE = 'https://bff.example.com';", 'http.get(`${BASE}/v1/receipts`, handler);'].join(
            '\n',
        );

        expect(findHandAuthoredEndpointLiterals(planted)).toContain('https://bff.example.com');
    });

    it('passes a source that sources every endpoint from the wire contract (no URL literals)', () => {
        const clean = [
            "import { ENDPOINTS } from './wire.js';",
            'http.get(`${ENDPOINTS.origin}${ENDPOINTS.receipts}`, handler);',
        ].join('\n');

        expect(findHandAuthoredEndpointLiterals(clean)).toEqual([]);
    });

    it('does not flag a URL mentioned only in a comment', () => {
        const commented = ['// there is no live https://bff.example.com in CI', 'const x = 1;'].join('\n');

        expect(findHandAuthoredEndpointLiterals(commented)).toEqual([]);
    });

    it('does not mistake the `//` inside a URL string for a line comment', () => {
        const tricky = ["const u = 'https://x.example.com/a';", 'const y = 2;'].join('\n');

        expect(findHandAuthoredEndpointLiterals(tricky)).toEqual(['https://x.example.com/a']);
    });
});
