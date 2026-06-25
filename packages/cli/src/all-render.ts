// SPDX-License-Identifier: AGPL-3.0-only
import type { OperationResult } from '@getreceipt/core';

import { EXIT_CODES, reauthRemedy } from './from-render.js';

/**
 * One source's slot in a batch run. Either it ran — carrying the same {@link OperationResult}
 * a single `from` would emit (CLI↔MCP parity) — or it never started, carrying a pre-flight
 * `error` (unknown source, unreadable config, not configured, unresolvable credentials). The
 * `error.message` is pre-sanitized by its origin (#6 config, #22 credentials): no secret material.
 */
export type BatchSourceResult =
    | { readonly source: string; readonly ok: true; readonly result: OperationResult }
    | {
          readonly source: string;
          readonly ok: false;
          readonly error: { readonly kind: string; readonly message: string };
      };

/** The roll-up of a batch run: every source succeeded, some did, or none did. Drives the exit-code ladder. */
export type BatchOutcome = 'succeeded' | 'partial' | 'failed';

/** The structured object `all --json` emits — the shared shape the future MCP `all` tool returns. */
export interface BatchReport {
    readonly profile: string;
    readonly outcome: BatchOutcome;
    /** The concurrency cap applied to the run (heavier sources are never fanned out beyond this). */
    readonly concurrency: number;
    /**
     * The requested window echoed as `YYYY-MM-DD` calendar dates (NOT instants — each source resolves the
     * day in its own zone, so no single instant pair fits the batch, #145), when `--since`/`--until` were
     * given; omitted when each source used its own default. Contrast {@link OperationResult.window}, which a
     * single-source run reports as resolved ISO-8601 instants.
     */
    readonly window?: { readonly from: string; readonly to: string };
    readonly sources: readonly BatchSourceResult[];
}

/** Whether a slot counts as a clean success — it ran AND every receipt was written/skipped. */
function succeeded(entry: BatchSourceResult): boolean {
    return entry.ok && entry.result.outcome === 'succeeded';
}

/**
 * Roll per-source results up into a batch outcome: all clean → `succeeded`; none clean →
 * `failed`; a mix → `partial`. An empty run (no configured sources) is `succeeded` — nothing
 * failed. Anything not a clean success (a `failed`/`partial`/`reauth-required` run, or a
 * pre-flight error) counts against full success.
 */
export function deriveBatchOutcome(results: readonly BatchSourceResult[]): BatchOutcome {
    if (results.length === 0) {
        return 'succeeded';
    }
    const wins = results.filter(succeeded).length;
    if (wins === results.length) {
        return 'succeeded';
    }
    return wins === 0 ? 'failed' : 'partial';
}

/**
 * Map a batch outcome to its exit code — the partial-failure ladder AC4 requires:
 * `succeeded` → 0, `partial` → 3 (some sources failed), `failed` → 4 (all failed). Reuses the
 * `from` ladder values so a script branches on the same codes for one or many sources.
 */
export function batchExitCode(outcome: BatchOutcome): number {
    switch (outcome) {
        case 'succeeded':
            return EXIT_CODES.success;
        case 'partial':
            return EXIT_CODES.partial;
        case 'failed':
            return EXIT_CODES.failed;
    }
}

/** Serialize a {@link BatchReport} for `--json`. */
export function renderAllJson(report: BatchReport): string {
    return `${JSON.stringify(report, null, 2)}\n`;
}

/** One compact per-source line: outcome plus written/skipped counts (a ran source) or the error (a pre-flight failure). */
function sourceLine(entry: BatchSourceResult): string {
    if (!entry.ok) {
        return `  ${entry.source} — error (${entry.error.kind}): ${entry.error.message}`;
    }
    const { result } = entry;
    const parts = [`  ${entry.source} — ${result.outcome}`];
    // written/skipped counts are meaningful only for a run that listed receipts; reauth-required never lists.
    if (result.outcome !== 'reauth-required') {
        parts.push(`written: ${result.written.length}`, `skipped: ${result.skipped.length}`);
    }
    if (result.reason !== undefined) {
        parts.push(result.reason);
    }
    // Name the remedy verb (#17) so a batch user knows exactly which source to re-`login`.
    if (result.outcome === 'reauth-required') {
        parts.push(reauthRemedy(result.source));
    }
    return parts.join('   ');
}

/**
 * Render a {@link BatchReport} as human-readable text: a header naming the profile, concurrency,
 * and batch outcome; one grep-friendly line per source; and a `wins/total succeeded` footer.
 * Pure — no I/O. Per-source lines come from secret-safe sources ({@link OperationResult} via the
 * shared mapper; pre-sanitized pre-flight messages).
 */
export function renderAllText(report: BatchReport): string {
    const lines: string[] = [
        `all (profile: ${report.profile}, concurrency: ${report.concurrency}) — ${report.outcome}`,
    ];

    if (report.sources.length === 0) {
        lines.push('  (no sources configured)');
        return `${lines.join('\n')}\n`;
    }

    for (const entry of report.sources) {
        lines.push(sourceLine(entry));
    }

    const wins = report.sources.filter(succeeded).length;
    lines.push(`${wins}/${report.sources.length} succeeded`);
    return `${lines.join('\n')}\n`;
}
