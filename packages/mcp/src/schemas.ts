// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Zod schemas for the four MCP tools.
 *
 * INPUT shapes mirror each CLI verb's options, so a tool argument set maps 1:1 to a verb
 * invocation. OUTPUT schemas describe the SAME structured object the CLI emits under `--json`
 * ({@link @getreceipt/core!OperationResult}, {@link @getreceipt/cli!BatchReport},
 * {@link @getreceipt/cli!SourcesReport}, {@link @getreceipt/cli!StatusReport}) — declared so the
 * MCP SDK validates each tool's structured content at runtime AND advertises an output contract to
 * clients. They are hand-authored here (not derived) but kept honest two ways: a compile-time
 * drift guard in `schemas.test.ts` asserts each `z.infer` equals the canonical type, and the
 * CLI↔MCP parity gate asserts the emitted objects are byte-for-byte identical.
 */

/** One receipt as the structured manifest lists it — mirrors `ReceiptSummary` (no handles, no paths). */
const receiptSummarySchema = z.object({
    id: z.string(),
    issuedAt: z.string(),
    title: z.string().optional(),
});

const operationWindowSchema = z.object({ from: z.string(), to: z.string() });

// ── collect (↔ CLI `from`) ────────────────────────────────────────────────────────────────────

export const collectInputShape = {
    source: z.string().describe('source domain to collect from (canonical or alias)'),
    since: z.string().optional().describe('start of the collection window (ISO date, YYYY-MM-DD)'),
    until: z.string().optional().describe('end of the collection window (ISO date, YYYY-MM-DD)'),
    profile: z.string().optional().describe('config profile supplying credentials (default "default")'),
    out: z.string().optional().describe('directory to write receipts into (default ".")'),
    acceptConsent: z
        .boolean()
        .optional()
        .describe('record the one-time consent acknowledgment non-interactively (for unattended use)'),
};

/** Structured manifest for one source — mirrors `OperationResult`; `reauth-required` is a first-class outcome. */
export const collectOutputSchema = z.object({
    source: z.string(),
    outcome: z.enum(['succeeded', 'partial', 'failed', 'reauth-required']),
    window: operationWindowSchema,
    written: z.array(receiptSummarySchema),
    skipped: z.array(receiptSummarySchema),
    reason: z.string().optional(),
});

// ── collect_all (↔ CLI `all`) ─────────────────────────────────────────────────────────────────

export const collectAllInputShape = {
    since: z.string().optional().describe('start of the collection window (ISO date, YYYY-MM-DD)'),
    until: z.string().optional().describe('end of the collection window (ISO date, YYYY-MM-DD)'),
    profile: z.string().optional().describe('config profile supplying credentials (default "default")'),
    out: z.string().optional().describe('directory to write receipts into (default ".")'),
    concurrency: z.number().int().positive().optional().describe('max sources collected at once (default 3)'),
    acceptConsent: z
        .boolean()
        .optional()
        .describe('record the one-time consent acknowledgment non-interactively (for unattended use)'),
};

/** A source's slot in a batch run — mirrors `BatchSourceResult` (ran-with-result, or pre-flight error). */
const batchSourceResultSchema = z.union([
    z.object({ source: z.string(), ok: z.literal(true), result: collectOutputSchema }),
    z.object({
        source: z.string(),
        ok: z.literal(false),
        error: z.object({ kind: z.string(), message: z.string() }),
    }),
]);

/** Structured batch manifest — mirrors `BatchReport`; per-source failures are data, not errors. */
export const collectAllOutputSchema = z.object({
    profile: z.string(),
    outcome: z.enum(['succeeded', 'partial', 'failed']),
    concurrency: z.number(),
    window: operationWindowSchema.optional(),
    sources: z.array(batchSourceResultSchema),
});

// ── list_sources (↔ CLI `sources`) ────────────────────────────────────────────────────────────

export const listSourcesInputShape = {
    profile: z.string().optional().describe('config profile to report configured-state against (default "default")'),
};

/** One registered source — mirrors `SourceView` (`SourceListing` + `configured`). */
const sourceViewSchema = z.object({
    canonicalDomain: z.string(),
    aliasDomains: z.array(z.string()),
    authKind: z.enum(['none', 'password', 'oauth2', 'api-token', 'passkey']),
    transportTier: z.enum(['http-api', 'html-scrape', 'headless-browser']),
    artifactMode: z.enum(['pdf-download', 'html-capture', 'rendered']),
    verificationState: z.enum(['unverified', 'e2e-verified', 'stale']),
    lastVerifiedAt: z.string().optional(),
    configured: z.boolean(),
});

/** Structured sources manifest — mirrors `SourcesReport`. */
export const listSourcesOutputSchema = z.object({
    profile: z.string(),
    sources: z.array(sourceViewSchema),
});

// ── auth_status (↔ CLI `status`) ──────────────────────────────────────────────────────────────

export const authStatusInputShape = {
    profile: z.string().optional().describe('config profile to report status for (default "default")'),
};

/** One source's session disposition — mirrors `SourceSessionView` (never carries a token). */
const sourceSessionViewSchema = z.object({
    source: z.string(),
    requested: z.string(),
    authKind: z.enum(['none', 'password', 'oauth2', 'api-token', 'passkey']),
    registered: z.boolean(),
    session: z.enum(['none', 'valid', 'expired', 'locked', 'unknown']),
    expiresAt: z.string().optional(),
    reason: z.string().optional(),
});

/** Structured status manifest — mirrors `StatusReport`. */
export const authStatusOutputSchema = z.object({
    profile: z.string(),
    sources: z.array(sourceSessionViewSchema),
});
