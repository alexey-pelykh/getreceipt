// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { isAlreadyPublished, parseViewResult } from './idempotency.js';

describe('parseViewResult (AC5: idempotency decision, pure)', () => {
    it('treats exit 0 with a version in stdout as already published', () => {
        expect(parseViewResult(0, '0.1.0\n')).toEqual({ existed: true });
    });

    it('treats a non-zero exit (E404 for an unpublished version) as not published', () => {
        expect(parseViewResult(1, '')).toEqual({ existed: false });
    });

    it('treats exit 0 with empty/whitespace stdout as not published (defensive)', () => {
        expect(parseViewResult(0, '   \n')).toEqual({ existed: false });
    });

    it('treats a signal-killed probe (null status) as not published', () => {
        expect(parseViewResult(null, '')).toEqual({ existed: false });
    });
});

describe('isAlreadyPublished', () => {
    it('reflects the parsed outcome', () => {
        expect(isAlreadyPublished({ existed: true })).toBe(true);
        expect(isAlreadyPublished({ existed: false })).toBe(false);
    });
});
