// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { parseTagToVersion } from './version-tag.js';

describe('parseTagToVersion', () => {
    it('strips the leading v from a plain release tag', () => {
        expect(parseTagToVersion('v0.1.0')).toBe('0.1.0');
    });

    it('strips the leading v from a pre-release tag', () => {
        expect(parseTagToVersion('v0.1.0-rc.1')).toBe('0.1.0-rc.1');
    });

    it('throws when the tag has no leading v', () => {
        expect(() => parseTagToVersion('0.1.0')).toThrow(/start with 'v'/);
    });

    it('throws when the remainder is not valid SemVer', () => {
        expect(() => parseTagToVersion('v1.2')).toThrow(/valid SemVer/);
        expect(() => parseTagToVersion('vnonsense')).toThrow(/valid SemVer/);
    });
});
