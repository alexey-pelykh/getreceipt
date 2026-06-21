// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { assertE2eCoverage, findAdaptersMissingE2eCoverage, MissingE2eCoverageError } from './index.js';

describe('findAdaptersMissingE2eCoverage', () => {
    it('returns nothing when there are no registered adapters', () => {
        expect(findAdaptersMissingE2eCoverage([], ['free.fr'])).toEqual([]);
    });

    it('returns nothing when every registered adapter is covered', () => {
        expect(findAdaptersMissingE2eCoverage(['free.fr', 'orange.fr'], ['orange.fr', 'free.fr'])).toEqual([]);
    });

    it('flags a registered adapter that lacks e2e coverage', () => {
        expect(findAdaptersMissingE2eCoverage(['free.fr', 'orange.fr'], ['free.fr'])).toEqual(['orange.fr']);
    });

    it('matches coverage case-insensitively (normalized)', () => {
        expect(findAdaptersMissingE2eCoverage(['Free.FR', '  orange.fr '], ['free.fr', 'ORANGE.FR'])).toEqual([]);
    });

    it('de-duplicates and preserves registered order', () => {
        expect(findAdaptersMissingE2eCoverage(['b.test', 'a.test', 'b.test'], [])).toEqual(['b.test', 'a.test']);
    });
});

describe('assertE2eCoverage', () => {
    it('does not throw when every registered adapter is covered', () => {
        expect(() => assertE2eCoverage(['free.fr'], ['free.fr'])).not.toThrow();
    });

    it('does not throw when nothing is registered', () => {
        expect(() => assertE2eCoverage([], [])).not.toThrow();
    });

    it('throws MissingE2eCoverageError listing the uncovered adapters', () => {
        let caught: unknown;
        try {
            assertE2eCoverage(['free.fr', 'orange.fr'], ['free.fr']);
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(MissingE2eCoverageError);
        expect((caught as MissingE2eCoverageError).domains).toEqual(['orange.fr']);
        expect((caught as MissingE2eCoverageError).message).toContain('orange.fr');
    });
});
