// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { hasPrerelease, isValidSemver, parseSemver } from './semver.js';

describe('parseSemver', () => {
    it('parses a plain release', () => {
        expect(parseSemver('0.1.0')).toEqual({ major: 0, minor: 1, patch: 0, prerelease: undefined, build: undefined });
    });

    it('extracts the pre-release component', () => {
        expect(parseSemver('0.1.0-rc.1')).toEqual({
            major: 0,
            minor: 1,
            patch: 0,
            prerelease: 'rc.1',
            build: undefined,
        });
    });

    it('extracts build metadata without treating it as a pre-release', () => {
        expect(parseSemver('1.0.0+build.5')).toEqual({
            major: 1,
            minor: 0,
            patch: 0,
            prerelease: undefined,
            build: 'build.5',
        });
    });

    it('returns null for a non-SemVer string', () => {
        expect(parseSemver('1.2')).toBeNull();
        expect(parseSemver('v1.2.3')).toBeNull();
        expect(parseSemver('nonsense')).toBeNull();
    });
});

describe('isValidSemver', () => {
    it('accepts valid versions', () => {
        expect(isValidSemver('0.1.0')).toBe(true);
        expect(isValidSemver('10.20.30-alpha.0')).toBe(true);
    });

    it('rejects invalid versions, including leading zeros and short forms', () => {
        expect(isValidSemver('1.2')).toBe(false);
        expect(isValidSemver('01.2.3')).toBe(false);
        expect(isValidSemver('v1.2.3')).toBe(false);
    });
});

describe('hasPrerelease', () => {
    it('detects pre-release versions', () => {
        expect(hasPrerelease('0.1.0-rc.1')).toBe(true);
        expect(hasPrerelease('0.1.0-0')).toBe(true);
    });

    it('returns false for plain or build-metadata-only versions', () => {
        expect(hasPrerelease('0.1.0')).toBe(false);
        expect(hasPrerelease('1.0.0+build.5')).toBe(false);
    });

    it('returns false for invalid versions', () => {
        expect(hasPrerelease('not-a-version')).toBe(false);
    });
});
