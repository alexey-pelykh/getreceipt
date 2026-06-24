// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { validateWindow } from './window.js';

describe('validateWindow', () => {
    it('returns no window when neither bound is given (the adapter default applies)', () => {
        expect(validateWindow(undefined, undefined)).toEqual({ ok: true, window: undefined });
    });

    it('carries both bounds through as YYYY-MM-DD calendar dates, NOT collapsed to a UTC instant (#127)', () => {
        // Collapsing to a UTC instant here is the bug: the runner must resolve these in the source's zone.
        expect(validateWindow('2026-06-01', '2026-06-24')).toEqual({
            ok: true,
            window: { since: '2026-06-01', until: '2026-06-24' },
        });
    });

    it('accepts --since alone for an open-ended window to now, omitting until', () => {
        expect(validateWindow('2026-06-01', undefined)).toEqual({ ok: true, window: { since: '2026-06-01' } });
    });

    it('rejects --until without --since as incomplete', () => {
        const result = validateWindow(undefined, '2026-06-24');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.kind).toBe('incomplete');
            expect(result.message).toContain('requires --since');
        }
    });

    // Bare `new Date(...)` would silently mis-parse these to the WRONG day; strict validation rejects them.
    it.each(['2024-02-30', '2024-04-31', '2024-1-1', '01/15/2024', 'last-tuesday'])(
        'rejects a malformed --since date: %s',
        (bad) => {
            const result = validateWindow(bad, '2026-06-24');
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.kind).toBe('bad-date');
            }
        },
    );

    it('rejects a malformed --until date', () => {
        const result = validateWindow('2026-06-01', '2026-13-40');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.kind).toBe('bad-date');
        }
    });

    it('rejects an inverted window (since after until)', () => {
        const result = validateWindow('2026-06-24', '2026-06-01');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.kind).toBe('inverted');
        }
    });

    it('accepts an equal since/until (a single-day window)', () => {
        expect(validateWindow('2026-06-01', '2026-06-01')).toEqual({
            ok: true,
            window: { since: '2026-06-01', until: '2026-06-01' },
        });
    });
});
