// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { isWithinDateFilter } from './index.js';
import type { DateFilter, DateRange } from './index.js';

const RANGE: DateRange = {
    from: new Date('2026-01-10T00:00:00.000Z'),
    to: new Date('2026-01-20T00:00:00.000Z'),
};
const FROM = RANGE.from;
const TO = RANGE.to;
const INTERIOR = new Date('2026-01-15T00:00:00.000Z');
const BEFORE = new Date('2026-01-09T23:59:59.999Z');
const AFTER = new Date('2026-01-20T00:00:00.001Z');

function filter(fromInclusive: boolean, toInclusive: boolean): DateFilter {
    return { basis: 'issued', fromInclusive, toInclusive };
}

const ALL_COMBOS = [filter(true, true), filter(false, false), filter(false, true), filter(true, false)];

describe('isWithinDateFilter', () => {
    it('includes an interior instant regardless of bound inclusivity', () => {
        for (const f of ALL_COMBOS) {
            expect(isWithinDateFilter(INTERIOR, RANGE, f)).toBe(true);
        }
    });

    it('excludes instants outside the range regardless of bound inclusivity', () => {
        for (const f of ALL_COMBOS) {
            expect(isWithinDateFilter(BEFORE, RANGE, f)).toBe(false);
            expect(isWithinDateFilter(AFTER, RANGE, f)).toBe(false);
        }
    });

    describe('inclusive bounds (fromInclusive: true, toInclusive: true)', () => {
        const f = filter(true, true);

        it('includes an instant exactly on the from bound', () => {
            expect(isWithinDateFilter(FROM, RANGE, f)).toBe(true);
        });

        it('includes an instant exactly on the to bound', () => {
            expect(isWithinDateFilter(TO, RANGE, f)).toBe(true);
        });
    });

    describe('exclusive bounds (fromInclusive: false, toInclusive: false)', () => {
        const f = filter(false, false);

        it('excludes an instant exactly on the from bound', () => {
            expect(isWithinDateFilter(FROM, RANGE, f)).toBe(false);
        });

        it('excludes an instant exactly on the to bound', () => {
            expect(isWithinDateFilter(TO, RANGE, f)).toBe(false);
        });

        it('includes the instant one millisecond inside each bound (exclusion is exactly at the bound)', () => {
            expect(isWithinDateFilter(new Date(FROM.getTime() + 1), RANGE, f)).toBe(true);
            expect(isWithinDateFilter(new Date(TO.getTime() - 1), RANGE, f)).toBe(true);
        });
    });

    describe('half-open bounds', () => {
        it('excludes the from bound but includes the to bound (fromInclusive: false, toInclusive: true)', () => {
            const f = filter(false, true);
            expect(isWithinDateFilter(FROM, RANGE, f)).toBe(false);
            expect(isWithinDateFilter(TO, RANGE, f)).toBe(true);
        });

        it('includes the from bound but excludes the to bound (fromInclusive: true, toInclusive: false)', () => {
            const f = filter(true, false);
            expect(isWithinDateFilter(FROM, RANGE, f)).toBe(true);
            expect(isWithinDateFilter(TO, RANGE, f)).toBe(false);
        });
    });
});
