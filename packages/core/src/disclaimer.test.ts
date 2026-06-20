// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { PERSONAL_USE_NOTICE, UNOFFICIAL_DISCLAIMER } from './index.js';

/**
 * The canonical clause every channel must surface (issue #10). Kept byte-identical to the wording
 * in the package READMEs so the cross-channel invariant (e2e) can assert one shared substring.
 * Lowercase `affiliated` (no leading `Not`/`not`) so it is a literal substring of both the root
 * README ("This project is not affiliated…") and the package READMEs ("Not affiliated…").
 */
const CANONICAL_CLAUSE = 'affiliated with, endorsed by, or supported by any of the services it integrates with';

describe('UNOFFICIAL_DISCLAIMER', () => {
    it('carries the canonical "unofficial" marker and not-affiliated clause', () => {
        expect(UNOFFICIAL_DISCLAIMER.toLowerCase()).toContain('unofficial');
        expect(UNOFFICIAL_DISCLAIMER).toContain(CANONICAL_CLAUSE);
    });

    it('asserts use-at-your-own-risk', () => {
        expect(UNOFFICIAL_DISCLAIMER).toContain('Use at your own risk.');
    });
});

describe('PERSONAL_USE_NOTICE', () => {
    it('asserts personal use with your-own-credentials posture', () => {
        expect(PERSONAL_USE_NOTICE).toContain('personal use only');
        expect(PERSONAL_USE_NOTICE).toContain('your own credentials');
    });

    it('rejects the abusive-automation non-goals as shipped text', () => {
        for (const nonGoal of ['third-party data', 'scraping', 'bulk automation']) {
            expect(PERSONAL_USE_NOTICE).toContain(nonGoal);
        }
    });
});
