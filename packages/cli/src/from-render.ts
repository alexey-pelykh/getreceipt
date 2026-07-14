// SPDX-License-Identifier: AGPL-3.0-only
import type { OperationOutcome, OperationResult, ReceiptSummary } from '@getreceipt/core';

/**
 * The CLI exit-code ladder — documented and exported so scripts can branch on a run's outcome
 * (AC: re-auth-required and failures map to distinct exit codes). Shared by `from` and `all`
 * (and the consent gate); it lives here for historical reasons, not because it is `from`-only.
 *
 *  - `0` success — every listed receipt was written or already present.
 *  - `1` usage — the run never started: bad invocation, unreadable/!configured source,
 *        or credentials that could not be resolved (Commander's own parse errors also exit 1).
 *  - `3` partial — some receipts were written, then the run failed before completing.
 *  - `4` failed — the run failed with no receipts written.
 *  - `5` reauth-required — the source needs fresh credentials; re-authenticate and retry.
 *  - `6` consent-required — the runtime consent gate (#32) could not obtain consent
 *        non-interactively; re-run in a terminal or pass `--accept-consent`.
 *  - `7` consent-declined — the user explicitly declined the consent prompt.
 *
 * `2` is intentionally unused (avoids implying POSIX EX_USAGE semantics Commander does
 * not follow); the outcome codes start at `3` so they never collide with a parse error.
 */
export const EXIT_CODES = {
    success: 0,
    usage: 1,
    partial: 3,
    failed: 4,
    reauthRequired: 5,
    consentRequired: 6,
    consentDeclined: 7,
} as const;

/** Map a collection outcome to its {@link EXIT_CODES} value. Pre-flight (usage) errors are handled at the call site, not here. */
export function exitCodeFor(outcome: OperationOutcome): number {
    switch (outcome) {
        case 'succeeded':
            return EXIT_CODES.success;
        case 'partial':
            return EXIT_CODES.partial;
        case 'failed':
            return EXIT_CODES.failed;
        case 'reauth-required':
            return EXIT_CODES.reauthRequired;
    }
}

/**
 * The remedy line a `reauth-required` outcome shows — the command to re-establish the source's
 * session. Shared by the `from` and `all` renderers. Pure; carries no secret material.
 *
 * A bare token is a single source → the `login` verb (#17). A multi-account source (`accounts:`)
 * surfaces its accounts as `<label>/<domain>` (#266), which `login` rejects (#288); those
 * re-authenticate by re-collecting via `--all-instances`, which re-drives the per-account prompt.
 */
export function reauthRemedy(source: string): string {
    if (source.includes('/')) {
        const domain = source.slice(source.lastIndexOf('/') + 1);
        return `→ run \`getreceipt from ${domain} --all-instances\` to re-authenticate its accounts`;
    }
    return `→ run \`getreceipt login ${source}\` to re-authenticate`;
}

/** ISO-8601 timestamp → date-only `YYYY-MM-DD` for compact human display. */
function dateOnly(iso: string): string {
    return iso.slice(0, 10);
}

function receiptLine(label: string, receipt: ReceiptSummary): string {
    const parts = [`  ${label}`, receipt.id, dateOnly(receipt.issuedAt)];
    if (receipt.title !== undefined) {
        parts.push(receipt.title);
    }
    const row = parts.join('  ');
    if (receipt.metadata === undefined || receipt.metadata.length === 0) {
        return row;
    }
    // Each voluntary metadatum (#97) on its own indented `label: value` line beneath the receipt row.
    const metaLines = receipt.metadata.map((entry) => `      ${entry.label}: ${entry.value}`);
    return [row, ...metaLines].join('\n');
}

/**
 * Render an {@link OperationResult} as human-readable text (the default, non-`--json`
 * output): a header naming the source + outcome, the effective window, written/skipped
 * counts, one grep-friendly row per receipt, and a reason line for a non-success
 * outcome. Pure — no I/O, no color codes — so it is unit-testable and CI-safe.
 */
export function renderResultsTable(result: OperationResult): string {
    const lines: string[] = [
        `${result.source} — ${result.outcome}`,
        `window: ${dateOnly(result.window.from)} → ${dateOnly(result.window.to)}`,
    ];

    if (result.outcome !== 'reauth-required') {
        lines.push(`written: ${result.written.length}   skipped: ${result.skipped.length}`);
        for (const receipt of result.written) {
            lines.push(receiptLine('written', receipt));
        }
        for (const receipt of result.skipped) {
            lines.push(receiptLine('skipped', receipt));
        }
    }

    if (result.outcome === 'reauth-required') {
        lines.push(`re-authentication required${result.reason === undefined ? '' : `: ${result.reason}`}`);
        lines.push(reauthRemedy(result.source));
    } else if (result.reason !== undefined) {
        lines.push(`${result.outcome}: ${result.reason}`);
    }

    return `${lines.join('\n')}\n`;
}
