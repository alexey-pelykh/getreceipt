// SPDX-License-Identifier: AGPL-3.0-only
import type { CollectResult } from './collect.js';
import type { ReceiptMetadatum, ReceiptRef } from './source-adapter.js';

/**
 * The shared, serializable description of ONE collection operation — the structural
 * unit both front-ends build and run, so the CLI (`from`, later `all`) and the MCP
 * surface drive identical work from identical inputs (CLI↔MCP parity).
 *
 * It carries only the user-facing parameters of a run: no resolved adapter, no
 * credential material, no writer. Those are resolved at execution time from the
 * spec — keeping the spec a plain value that round-trips through JSON, a config
 * file, or an MCP tool argument unchanged.
 */
export interface OperationSpec {
    /** Canonical or alias domain of the source to collect from. */
    readonly source: string;
    /** Config profile that supplies this source's credentials. */
    readonly profile: string;
    /** Explicit collection window; omit to let the adapter's default window apply. */
    readonly window?: OperationWindow;
}

/**
 * An explicit collection window as ISO-8601 date strings. Strings (not `Date`) keep
 * {@link OperationSpec} serializable; `collect()` works in `Date`, so the runner
 * materializes these at execution time.
 */
export interface OperationWindow {
    readonly since: string;
    readonly until: string;
}

/** The four outcomes a front-end reports — {@link CollectResult}'s three, plus `partial` split out of a failure with progress. */
export type OperationOutcome = 'succeeded' | 'partial' | 'failed' | 'reauth-required';

/** A serializable view of one receipt, for the structured result. Mirrors {@link ReceiptRef} with the `Date` rendered as ISO-8601. */
export interface ReceiptSummary {
    readonly id: string;
    readonly issuedAt: string;
    readonly title?: string;
    /** Voluntary per-receipt metadata, carried through verbatim (already display strings, no conversion). */
    readonly metadata?: readonly ReceiptMetadatum[];
}

/**
 * The serializable outcome of running one {@link OperationSpec} — the object the CLI
 * emits under `--json` and the MCP tool returns, byte-for-byte identical. Both sides
 * produce it through {@link toOperationResult}, so parity is structural, not a
 * convention two code paths must remember to keep in step.
 *
 * Value-only: dates are ISO strings, receipts are {@link ReceiptSummary} (no handles,
 * no absolute paths), and no credential material can reach it.
 */
export interface OperationResult {
    readonly source: string;
    readonly outcome: OperationOutcome;
    /** The effective window applied (echoed back, default-resolved), as ISO-8601 bounds. */
    readonly window: { readonly from: string; readonly to: string };
    /** Receipts fetched and written this run, in listing order. */
    readonly written: readonly ReceiptSummary[];
    /** Receipts the writer already had, skipped without fetching, in listing order. */
    readonly skipped: readonly ReceiptSummary[];
    /** Human-readable detail for a `partial` / `failed` / `reauth-required` outcome; carries no secret material. */
    readonly reason?: string;
}

function summarize(ref: ReceiptRef): ReceiptSummary {
    // exactOptionalPropertyTypes: omit each optional entirely when absent, never set it to undefined.
    return {
        id: ref.id,
        issuedAt: ref.issuedAt.toISOString(),
        ...(ref.title === undefined ? {} : { title: ref.title }),
        ...(ref.metadata === undefined ? {} : { metadata: ref.metadata }),
    };
}

/**
 * Map a {@link CollectResult} into the front-end-facing {@link OperationResult}: render
 * dates to ISO-8601, receipts to {@link ReceiptSummary}, and split the single
 * `failed` collect outcome into `failed` (no progress) vs `partial` (some receipts
 * written before the failure) — the distinction the CLI's exit-code ladder and the
 * MCP response both surface. The lone shared mapper, so CLI and MCP cannot drift.
 */
export function toOperationResult(result: CollectResult): OperationResult {
    const window = { from: result.window.from.toISOString(), to: result.window.to.toISOString() };

    if (result.outcome === 'succeeded') {
        return {
            source: result.source,
            outcome: 'succeeded',
            window,
            written: result.written.map(summarize),
            skipped: result.skipped.map(summarize),
        };
    }

    if (result.outcome === 'reauth-required') {
        const base = {
            source: result.source,
            outcome: 'reauth-required' as const,
            window,
            written: [],
            skipped: [],
        };
        return result.reason === undefined ? base : { ...base, reason: result.reason };
    }

    // A failure with progress is reported as `partial` so a caller can tell "nothing happened"
    // from "some receipts landed before it broke" — the two map to distinct CLI exit codes.
    return {
        source: result.source,
        outcome: result.written.length > 0 ? 'partial' : 'failed',
        window,
        written: result.written.map(summarize),
        skipped: result.skipped.map(summarize),
        reason: result.reason,
    };
}
