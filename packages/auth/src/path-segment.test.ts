// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { sanitizePathSegment } from './path-segment.js';

describe('sanitizePathSegment — the shared safe-segment rule (owned profiles #253 + output labels #266)', () => {
    it('returns an already-safe segment unchanged', () => {
        for (const value of ['personal', 'business', 'amazon.com', 'a-b_c.1', 'Work2024']) {
            expect(sanitizePathSegment(value)).toBe(value);
        }
    });

    it('replaces any char outside [A-Za-z0-9._-] with a dash so the segment can never traverse or be OS-illegal', () => {
        expect(sanitizePathSegment('my label')).toBe('my-label');
        expect(sanitizePathSegment('a/b')).toBe('a-b');
        expect(sanitizePathSegment('../etc')).toBe('..-etc');
        expect(sanitizePathSegment('a:b')).toBe('a-b');
        expect(sanitizePathSegment('café')).toBe('caf-');
    });

    it('returns null for a segment that reduces to nothing meaningful (would collapse onto the parent dir)', () => {
        for (const degenerate of ['', '.', '..', '-', '---', '/', '//']) {
            expect(sanitizePathSegment(degenerate)).toBeNull();
        }
    });

    it("keeps a `.`/`..` that is only PART of a longer segment (the interior-dot policy is the caller's to add)", () => {
        // The shared rule only rejects a segment that is EXACTLY `.`/`..`; `parseLabel` (#266) layers the
        // stricter leading-`.`/interior-`..` rejection on top for user-authored labels.
        expect(sanitizePathSegment('.hidden')).toBe('.hidden');
        expect(sanitizePathSegment('a..b')).toBe('a..b');
    });
});
