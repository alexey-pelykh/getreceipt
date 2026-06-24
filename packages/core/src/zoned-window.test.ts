// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { zonedDayEnd, zonedDayStart } from './zoned-window.js';

describe('zonedDayStart — start-of-day in a named zone', () => {
    it('resolves a Europe/Paris summer date to local midnight, BEFORE UTC midnight (#127)', () => {
        // The exact reported case: 2026-06-01 00:00 Paris (CEST, +02:00) = 2026-05-31T22:00:00Z.
        // A monthly invoice issued at the local month-start lands here — a UTC window would miss it.
        expect(zonedDayStart('2026-06-01', 'Europe/Paris').toISOString()).toBe('2026-05-31T22:00:00.000Z');
    });

    it('resolves a Europe/Paris winter date with the CET (+01:00) offset', () => {
        expect(zonedDayStart('2026-01-01', 'Europe/Paris').toISOString()).toBe('2025-12-31T23:00:00.000Z');
    });

    it('is identity for UTC', () => {
        expect(zonedDayStart('2026-06-01', 'UTC').toISOString()).toBe('2026-06-01T00:00:00.000Z');
    });

    it('handles a negative-offset zone (America/New_York, EDT −04:00)', () => {
        expect(zonedDayStart('2026-06-01', 'America/New_York').toISOString()).toBe('2026-06-01T04:00:00.000Z');
    });
});

describe('zonedDayEnd — end-of-day in a named zone', () => {
    it('resolves to 23:59:59.999 local, so the named day is fully inside an inclusive window', () => {
        // Fixes the latent until=00:00 bug: 2026-06-24 must cover the whole day, not its first instant.
        expect(zonedDayEnd('2026-06-24', 'Europe/Paris').toISOString()).toBe('2026-06-24T21:59:59.999Z');
    });

    it('is the last millisecond of the UTC day for UTC', () => {
        expect(zonedDayEnd('2026-06-24', 'UTC').toISOString()).toBe('2026-06-24T23:59:59.999Z');
    });
});

describe('zoned day bounds span exactly one local calendar day', () => {
    it('end − start = 24h − 1ms on a non-DST day', () => {
        const start = zonedDayStart('2026-06-10', 'Europe/Paris').getTime();
        const end = zonedDayEnd('2026-06-10', 'Europe/Paris').getTime();
        expect(end - start).toBe(86_400_000 - 1);
    });
});

describe('DST transition days (the subtle cases the two-pass resolution exists for)', () => {
    it('spring-forward day is 23h − 1ms long (Europe/Paris 2026-03-29, clocks 02:00→03:00)', () => {
        const start = zonedDayStart('2026-03-29', 'Europe/Paris');
        const end = zonedDayEnd('2026-03-29', 'Europe/Paris');
        expect(start.toISOString()).toBe('2026-03-28T23:00:00.000Z'); // 00:00 CET (+01:00)
        expect(end.getTime() - start.getTime()).toBe(82_799_999); // 23h − 1ms
    });

    it('fall-back day is 25h − 1ms long and its end is the SECOND 23:59 (Europe/Paris 2026-10-25)', () => {
        const start = zonedDayStart('2026-10-25', 'Europe/Paris');
        const end = zonedDayEnd('2026-10-25', 'Europe/Paris');
        expect(start.toISOString()).toBe('2026-10-24T22:00:00.000Z'); // 00:00 CEST (+02:00)
        expect(end.toISOString()).toBe('2026-10-25T22:59:59.999Z'); // 23:59:59.999 CET (+01:00)
        expect(end.getTime() - start.getTime()).toBe(89_999_999); // 25h − 1ms
    });

    it('rolls a midnight spring-forward GAP forward to the gap edge, not back a day (America/Sao_Paulo 2017-10-15)', () => {
        // Brazil historically sprang forward AT 00:00 (00:00 → 01:00), so 2017-10-15 00:00 never occurred.
        // Day-start must resolve to the first valid instant (01:00 local = 03:00Z), not the prior day.
        expect(zonedDayStart('2017-10-15', 'America/Sao_Paulo').toISOString()).toBe('2017-10-15T03:00:00.000Z');
    });
});
