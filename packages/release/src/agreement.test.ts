// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { assertAgreement } from './agreement.js';

describe('assertAgreement (AC3: dist-tag ↔ release pre-release flag must agree)', () => {
    it('passes when a pre-release version is flagged pre-release', () => {
        expect(() => assertAgreement('0.1.0-rc.1', true)).not.toThrow();
    });

    it('passes when a plain version is not flagged pre-release', () => {
        expect(() => assertAgreement('0.1.0', false)).not.toThrow();
    });

    it('throws when a pre-release version is NOT flagged pre-release (would land on @latest)', () => {
        expect(() => assertAgreement('0.1.0-rc.1', false)).toThrow(/mismatch/);
    });

    it('throws when a plain version IS flagged pre-release', () => {
        expect(() => assertAgreement('0.1.0', true)).toThrow(/mismatch/);
    });
});
