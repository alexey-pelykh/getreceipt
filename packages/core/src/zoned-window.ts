// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resolve a `YYYY-MM-DD` calendar date to a UTC instant at a chosen wall-clock time IN a named IANA
 * zone — the conversion that fixes #127. A `--since`/`--until` calendar date is the user's intent in
 * the SOURCE's local calendar (a Free invoice issued "1 June" is timestamped at 2026-06-01 00:00
 * Europe/Paris = 2026-05-31T22:00:00Z), so collapsing it to UTC midnight silently excludes it.
 *
 * No dependency: the zone offset is read back from `Intl.DateTimeFormat`, which every supported Node
 * ships with full IANA data. The one DST subtlety (an offset that differs between the naive guess and
 * the resolved instant) is handled by a single correction pass — the standard zoned-time-to-UTC method.
 */

/** The offset (ms) a zone is ahead of UTC at a given instant: wall-clock-in-zone minus the UTC instant. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const f: Record<string, string> = {};
    for (const part of parts) {
        if (part.type !== 'literal') {
            f[part.type] = part.value;
        }
    }
    const wall = Date.UTC(
        Number(f.year),
        Number(f.month) - 1,
        Number(f.day),
        Number(f.hour),
        Number(f.minute),
        Number(f.second),
    );
    // Compare at second precision (zone offsets are whole minutes) so the caller's sub-second part survives.
    return wall - Math.floor(utcMs / 1000) * 1000;
}

/** Materialize `YYYY-MM-DD` at a wall-clock time in `timeZone` to its UTC instant. */
function zonedWallTimeToUtc(
    calendarDate: string,
    hour: number,
    minute: number,
    second: number,
    ms: number,
    timeZone: string,
): Date {
    const year = Number(calendarDate.slice(0, 4));
    const month = Number(calendarDate.slice(5, 7));
    const day = Number(calendarDate.slice(8, 10));
    const guess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
    // Two-pass zoned-time-to-UTC (the standard method): the first offset positions us near the right
    // instant; a second offset at that instant catches a DST transition. When BOTH passes still
    // disagree the requested wall-time is in a spring-forward GAP (it never occurs) — roll forward to
    // the gap edge via the smaller offset. Day boundaries (00:00 / 23:59:59.999) of every shipped zone
    // sit far from any transition, so this resolves on the first pass; the rest guards the host-zone
    // fallback against the rare zone whose transition straddles midnight.
    const offset = zoneOffsetMs(guess, timeZone);
    let utc = guess - offset;
    const corrected = zoneOffsetMs(utc, timeZone);
    if (corrected !== offset) {
        utc = guess - corrected;
        if (zoneOffsetMs(utc, timeZone) !== corrected) {
            utc = guess - Math.min(offset, corrected);
        }
    }
    return new Date(utc);
}

/** The UTC instant at which the `YYYY-MM-DD` day BEGINS (00:00:00.000) in `timeZone`. */
export function zonedDayStart(calendarDate: string, timeZone: string): Date {
    return zonedWallTimeToUtc(calendarDate, 0, 0, 0, 0, timeZone);
}

/** The UTC instant at the LAST millisecond (23:59:59.999) of the `YYYY-MM-DD` day in `timeZone` — an inclusive upper bound. */
export function zonedDayEnd(calendarDate: string, timeZone: string): Date {
    return zonedWallTimeToUtc(calendarDate, 23, 59, 59, 999, timeZone);
}

/** The host's IANA zone — the default when a source declares none, so a local calendar window matches local receipts. */
export function hostTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
