// SPDX-License-Identifier: AGPL-3.0-only
import type { DateFilter, DateRange } from './source-adapter.js';

/**
 * Whether `instant` falls inside `range` under the bound inclusivity a source DECLARES on its
 * {@link DateFilter}. The single home for the date-bound comparison: an adapter calls this from `list()`
 * instead of hardcoding `instant < from || instant > to`, so {@link DateFilter.fromInclusive} and
 * {@link DateFilter.toInclusive} are load-bearing — a source that declares an exclusive bound is honored,
 * not silently treated as inclusive.
 *
 * `instant` is the receipt's timestamp ALREADY resolved to the filter's declared {@link DateFilter.basis}
 * (e.g. {@link ReceiptRef.issuedAt} for `basis: 'issued'`); this predicate applies only the bound
 * semantics, never basis selection. Bounds compare at millisecond precision (`Date.getTime()`).
 *
 * Assumes a finite `instant`: an Invalid `Date` fails every comparison and is dropped, so callers must
 * resolve the timestamp from an upstream-validated source (adapters parse dates at their Zod wire boundary).
 */
export function isWithinDateFilter(instant: Date, range: DateRange, filter: DateFilter): boolean {
    const at = instant.getTime();
    const afterFrom = filter.fromInclusive ? at >= range.from.getTime() : at > range.from.getTime();
    const beforeTo = filter.toInclusive ? at <= range.to.getTime() : at < range.to.getTime();
    return afterFrom && beforeTo;
}
