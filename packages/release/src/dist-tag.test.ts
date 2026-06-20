// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { deriveDistTag } from './dist-tag.js';

describe('deriveDistTag (AC2: dist-tag routing)', () => {
    it('routes a plain release to latest', () => {
        expect(deriveDistTag('0.1.0')).toBe('latest');
        expect(deriveDistTag('1.0.0')).toBe('latest');
        expect(deriveDistTag('0.0.0')).toBe('latest');
    });

    it('routes a pre-release to next', () => {
        expect(deriveDistTag('0.1.0-rc.1')).toBe('next');
        expect(deriveDistTag('0.1.0-alpha.0')).toBe('next');
        expect(deriveDistTag('1.0.0-beta')).toBe('next');
    });

    it('treats build-metadata-only as a plain release (latest), not a pre-release', () => {
        expect(deriveDistTag('1.0.0+build.5')).toBe('latest');
    });

    it('throws on a non-SemVer version rather than guessing a tag', () => {
        expect(() => deriveDistTag('1.2')).toThrow(/not a valid SemVer/);
    });
});
