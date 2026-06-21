// SPDX-License-Identifier: AGPL-3.0-only
import { verificationAdvisory } from '@getreceipt/core';
import type { SourceListing } from '@getreceipt/core';

/**
 * One registered source as the `sources` verb reports it: its declared capabilities and
 * verification state (from {@link SourceListing}) plus whether it is configured under the
 * active profile. Pure data — no secret material (a source's declared shape, never its
 * credentials).
 */
export interface SourceView extends SourceListing {
    /** Whether the active profile has credentials for this source (by canonical domain or any alias). */
    readonly configured: boolean;
}

/** The structured object `sources --json` emits — the shared shape the future MCP `sources` tool returns. */
export interface SourcesReport {
    readonly profile: string;
    readonly sources: readonly SourceView[];
}

/** Serialize a {@link SourcesReport} for `--json`. */
export function renderSourcesJson(report: SourcesReport): string {
    return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * Render a {@link SourcesReport} as human-readable text: a header naming the profile, one
 * grep-friendly row per source (domain, auth, transport, artifact, verification, configured)
 * with its aliases on a sub-line, and one advisory line per distinct not-`ok` verification
 * state present (driven by {@link verificationAdvisory}). Pure — no I/O.
 */
export function renderSourcesText(report: SourcesReport): string {
    const lines: string[] = [`sources (profile: ${report.profile})`];

    if (report.sources.length === 0) {
        lines.push('  (no sources registered)');
        return `${lines.join('\n')}\n`;
    }

    for (const source of report.sources) {
        lines.push(
            [
                `  ${source.canonicalDomain}`,
                source.authKind,
                source.transportTier,
                source.artifactMode,
                source.verificationState,
                source.configured ? 'configured' : 'not-configured',
            ].join('  '),
        );
        if (source.aliasDomains.length > 0) {
            lines.push(`    aliases: ${source.aliasDomains.join(', ')}`);
        }
    }

    for (const message of distinctAdvisories(report.sources)) {
        lines.push(`⚠ ${message}`);
    }

    return `${lines.join('\n')}\n`;
}

/** The distinct verification advisory messages across the listed sources (each warned state surfaced once). */
function distinctAdvisories(sources: readonly SourceView[]): readonly string[] {
    const messages = new Set<string>();
    for (const source of sources) {
        const advisory = verificationAdvisory(source.verificationState);
        if (advisory.message !== undefined) {
            messages.add(advisory.message);
        }
    }
    return [...messages];
}
