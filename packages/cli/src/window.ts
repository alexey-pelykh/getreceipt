// SPDX-License-Identifier: AGPL-3.0-only
import type { OperationWindow } from '@getreceipt/core';
import { CommanderError } from 'commander';

import { EXIT_CODES } from './from-render.js';
import type { CliIO } from './io.js';

/** A strict ISO-8601 calendar date — `YYYY-MM-DD`, nothing looser. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A usage-exit signal whose user-facing text was ALREADY written via {@link CliIO}; carries no message of its own. */
function usageExit(code: string): CommanderError {
    return new CommanderError(EXIT_CODES.usage, code, '');
}

/**
 * Parse a strict `YYYY-MM-DD` date (UTC midnight), or `undefined` if the string isn't one.
 * Bare `new Date(...)` silently mis-handles two cases the "ISO date" contract must reject: an
 * impossible day in a valid month (`2024-02-30` rolls forward to Mar 1) and locale-dependent
 * legacy formats (`2024-1-1`, `01/15/2024` parse in local time, inconsistently across engines).
 */
function parseIsoDate(value: string): Date | undefined {
    if (!ISO_DATE.test(value)) {
        return undefined;
    }
    const date = new Date(value);
    // A rolled-over day parses fine but no longer round-trips to the requested calendar date.
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        return undefined;
    }
    return date;
}

/**
 * Validate the `--since`/`--until` pair into a canonical ISO window, or `undefined` when
 * neither is given (the adapter's default window then applies). Both-or-neither, both strict
 * `YYYY-MM-DD`, and `since <= until` — each violation is a usage error whose message is written
 * before the exit signal is thrown. Shared by the `from` (one source) and `all` (every source)
 * collection verbs, with `errorCode` namespacing the thrown {@link CommanderError} per verb.
 */
export function parseWindow(
    io: CliIO,
    since: string | undefined,
    until: string | undefined,
    errorCode: string,
): OperationWindow | undefined {
    if (since === undefined && until === undefined) {
        return undefined;
    }
    if (since === undefined || until === undefined) {
        io.writeErr('✗ --since and --until must be provided together\n');
        throw usageExit(`${errorCode}.window-incomplete`);
    }
    const from = parseIsoDate(since);
    if (from === undefined) {
        io.writeErr(`✗ --since is not a valid ISO date (expected YYYY-MM-DD): ${since}\n`);
        throw usageExit(`${errorCode}.bad-date`);
    }
    const to = parseIsoDate(until);
    if (to === undefined) {
        io.writeErr(`✗ --until is not a valid ISO date (expected YYYY-MM-DD): ${until}\n`);
        throw usageExit(`${errorCode}.bad-date`);
    }
    if (from.getTime() > to.getTime()) {
        io.writeErr('✗ --since must not be after --until\n');
        throw usageExit(`${errorCode}.window-inverted`);
    }
    return { since: from.toISOString(), until: to.toISOString() };
}
