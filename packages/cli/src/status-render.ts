// SPDX-License-Identifier: AGPL-3.0-only
import type { AuthKind } from '@getreceipt/core';

/**
 * Per-source session state — what `status` reports without revealing any token:
 *  - `none`    — nothing stored for the source (authenticate fresh on next run);
 *  - `valid`   — a stored session that {@link @getreceipt/auth!ReauthDetector} accepts;
 *  - `expired` — a stored session past its expiry (re-authentication required);
 *  - `locked`  — a session is stored but unreadable (wrong passphrase / corrupt);
 *  - `unknown` — the session backend cannot be consulted (no passphrase / no backend configured).
 */
export type SessionState = 'none' | 'valid' | 'expired' | 'locked' | 'unknown';

/**
 * One configured source's auth/session status. Value-only and secret-free: it carries the
 * declared auth kind and the session's DISPOSITION (plus an optional non-secret expiry and
 * reason) — never the token itself.
 */
export interface SourceSessionView {
    /** Canonical domain when the source is registered, else the configured key as written. */
    readonly source: string;
    /** The source key exactly as it appears in the config. */
    readonly requested: string;
    readonly authKind: AuthKind;
    /** Whether an adapter is registered for this source. */
    readonly registered: boolean;
    readonly session: SessionState;
    /** Session expiry as an ISO-8601 instant, when the stored session declares one. Non-secret. */
    readonly expiresAt?: string;
    /** Non-secret detail for an `expired` / `locked` / `unknown` state. */
    readonly reason?: string;
}

/** The structured object `status --json` emits — the shared shape the future MCP `status` tool returns. */
export interface StatusReport {
    readonly profile: string;
    readonly sources: readonly SourceSessionView[];
}

/** Serialize a {@link StatusReport} for `--json`. */
export function renderStatusJson(report: StatusReport): string {
    return `${JSON.stringify(report, null, 2)}\n`;
}

/** ISO-8601 timestamp → date-only `YYYY-MM-DD` for compact human display. */
function dateOnly(iso: string): string {
    return iso.slice(0, 10);
}

/**
 * Render a {@link StatusReport} as human-readable text: a header naming the profile and one
 * grep-friendly row per configured source (domain, auth kind, session state, optional expiry,
 * an `[unregistered]` marker), with any non-secret reason on a sub-line. Pure — no I/O, and
 * no token ever reaches it (the {@link SourceSessionView} carries none).
 */
export function renderStatusText(report: StatusReport): string {
    const lines: string[] = [`status (profile: ${report.profile})`];

    if (report.sources.length === 0) {
        lines.push('  (no sources configured)');
        return `${lines.join('\n')}\n`;
    }

    for (const view of report.sources) {
        const parts = [`  ${view.source}`, view.authKind, `session: ${view.session}`];
        if (view.expiresAt !== undefined) {
            parts.push(`expires: ${dateOnly(view.expiresAt)}`);
        }
        if (!view.registered) {
            parts.push('[unregistered]');
        }
        lines.push(parts.join('  '));
        if (view.reason !== undefined) {
            lines.push(`    ${view.reason}`);
        }
    }

    return `${lines.join('\n')}\n`;
}
