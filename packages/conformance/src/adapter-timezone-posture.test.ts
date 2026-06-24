// SPDX-License-Identifier: AGPL-3.0-only
import { BUNDLED_ADAPTERS } from '@getreceipt/cli';
import { describe, expect, it } from 'vitest';

/**
 * Every bundled adapter MUST declare an explicit IANA `timezone` (#127). The window resolver falls back
 * to the HOST zone when a source declares none — an acceptable default, but a SHIPPED adapter must be
 * explicit so a `--since`/`--until` calendar window resolves to the same instants on every host (CI
 * runs in UTC; a French user runs in Europe/Paris) and a receipt timestamped at the local month-start
 * is never silently missed. All sources are French, so the declared zone is `Europe/Paris`.
 *
 * Enumerated from `BUNDLED_ADAPTERS` (not a hardcoded list), so a newly-added adapter is covered the
 * moment it ships — a regression that forgets the field fails here.
 */
describe('every bundled adapter declares an explicit IANA timezone (#127)', () => {
    it.each(BUNDLED_ADAPTERS.map((a) => [a.descriptor.canonicalDomain, a.descriptor.timezone] as const))(
        '%s declares a timezone resolvable by Intl',
        (domain, timezone) => {
            expect(timezone, `${domain} must declare descriptor.timezone`).toBeDefined();
            expect(() => new Intl.DateTimeFormat('en-US', { timeZone: timezone })).not.toThrow();
        },
    );

    it('declares Europe/Paris for the current all-French source set', () => {
        for (const adapter of BUNDLED_ADAPTERS) {
            expect(adapter.descriptor.timezone, adapter.descriptor.canonicalDomain).toBe('Europe/Paris');
        }
    });
});
