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

/** Why a `--since`/`--until` pair was rejected — namespaces the CLI exit code and is front-end-agnostic. */
export type WindowErrorKind = 'incomplete' | 'bad-date' | 'inverted';

/** The pure outcome of validating a window: a canonical ISO window (or none), or a typed usage message. */
export type WindowValidation =
    | { readonly ok: true; readonly window: OperationWindow | undefined }
    | { readonly ok: false; readonly kind: WindowErrorKind; readonly message: string };

/**
 * Validate a `since`/`until` pair into a canonical ISO window — the pure, I/O-free, throw-free core
 * shared by the CLI `parseWindow` wrapper and the MCP collection tools. Both-or-neither, both strict
 * `YYYY-MM-DD`, and `since <= until`; neither given → no window (the adapter's default applies).
 * Messages carry no `✗` prefix — the front-end adds its own presentation.
 */
export function validateWindow(since: string | undefined, until: string | undefined): WindowValidation {
    if (since === undefined && until === undefined) {
        return { ok: true, window: undefined };
    }
    if (since === undefined || until === undefined) {
        return { ok: false, kind: 'incomplete', message: '--since and --until must be provided together' };
    }
    const from = parseIsoDate(since);
    if (from === undefined) {
        return {
            ok: false,
            kind: 'bad-date',
            message: `--since is not a valid ISO date (expected YYYY-MM-DD): ${since}`,
        };
    }
    const to = parseIsoDate(until);
    if (to === undefined) {
        return {
            ok: false,
            kind: 'bad-date',
            message: `--until is not a valid ISO date (expected YYYY-MM-DD): ${until}`,
        };
    }
    if (from.getTime() > to.getTime()) {
        return { ok: false, kind: 'inverted', message: '--since must not be after --until' };
    }
    return { ok: true, window: { since: from.toISOString(), until: to.toISOString() } };
}

/** Map a {@link WindowErrorKind} to its CLI exit-code suffix (preserves the per-failure code names). */
const WINDOW_ERROR_SUFFIX: Record<WindowErrorKind, string> = {
    incomplete: 'window-incomplete',
    'bad-date': 'bad-date',
    inverted: 'window-inverted',
};

/**
 * The CLI wrapper over {@link validateWindow}: write the usage message before the exit signal, and
 * namespace the thrown {@link CommanderError} per verb via `errorCode`. Shared by the `from` (one
 * source) and `all` (every source) collection verbs.
 */
export function parseWindow(
    io: CliIO,
    since: string | undefined,
    until: string | undefined,
    errorCode: string,
): OperationWindow | undefined {
    const result = validateWindow(since, until);
    if (!result.ok) {
        io.writeErr(`✗ ${result.message}\n`);
        throw usageExit(`${errorCode}.${WINDOW_ERROR_SUFFIX[result.kind]}`);
    }
    return result.window;
}
