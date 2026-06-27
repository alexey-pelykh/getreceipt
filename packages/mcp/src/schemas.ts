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

/** One voluntary metadata entry (#97) — mirrors `ReceiptMetadatum`. */
const receiptMetadatumSchema = z.object({
    key: z.string(),
    label: z.string(),
    value: z.string(),
});

/** One receipt as the structured manifest lists it — mirrors `ReceiptSummary` (no handles, no paths). */
const receiptSummarySchema = z.object({
    id: z.string(),
    issuedAt: z.string(),
    title: z.string().optional(),
    metadata: z.array(receiptMetadatumSchema).optional(),
});

// The two collection tools echo `window` in DIFFERENT shapes — by design, not drift (#145). `collect`
// (single source) reports the RESOLVED instants; `collect_all` (batch) reports the REQUESTED calendar
// dates, because N differently-zoned sources have no single instant pair (see cli `runCollectAll`). Both
// stay structurally `{ from, to }: string` (so the drift guard holds); only the descriptions distinguish
// them — which is exactly the advertised output contract a client reads to know which to expect.

/** Single-source (`collect`) window: the effective, zone-resolved instants (`to` end-of-day for an explicit `until`, else `now`; #127). */
const collectWindowSchema = z.object({
    from: z.string().describe('start of the resolved window, an ISO-8601 instant (e.g. "2026-05-31T22:00:00.000Z")'),
    to: z
        .string()
        .describe(
            'end of the resolved window, an ISO-8601 instant: end-of-day for an explicit `until` (e.g. "2026-06-24T21:59:59.999Z", #127), else `now` for an open-ended or default window',
        ),
});

/** Batch (`collect_all`) window: the requested calendar dates; an open-ended `until` echoes today. */
const batchWindowSchema = z.object({
    from: z.string().describe('start of the requested window, a YYYY-MM-DD calendar date (e.g. "2024-01-01")'),
    to: z.string().describe('end of the requested window, a YYYY-MM-DD calendar date; today when `until` is omitted'),
});

/** Mirrors `ChallengeType`. */
const challengeTypeSchema = z.enum(['otp-totp', 'otp-sms', 'otp-email', 'push', 'captcha', 'webauthn']);

/**
 * One interactive-challenge outcome (#142) — mirrors `ChallengeOutcome`. EVERY field is a closed enum:
 * there is no place to carry the code, seed, session, or device-trust artifact. The compile-time drift
 * guard (schemas.test.ts) breaks the build if a future field widens to a free-form string, so the
 * redaction fence is enforced statically on the structured (MCP / `--json`) sink, not by discipline.
 */
const challengeOutcomeSchema = z.union([
    z.object({
        outcome: z.literal('resolved'),
        type: challengeTypeSchema,
        mode: z.enum(['totp-computed', 'human-entered']),
    }),
    z.object({
        outcome: z.literal('degraded'),
        reason: z.enum(['no-resolver', 'exhausted']),
        type: challengeTypeSchema.optional(),
    }),
]);

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
    window: collectWindowSchema,
    written: z.array(receiptSummarySchema),
    skipped: z.array(receiptSummarySchema),
    reason: z.string().optional(),
    challenges: z.array(challengeOutcomeSchema).optional(),
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
    window: batchWindowSchema.optional(),
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
    instanceDomains: z.array(z.string()),
    authKind: z.enum(['none', 'password', 'session', 'api-token', 'passkey']),
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
    authKind: z.enum(['none', 'password', 'session', 'api-token', 'passkey']),
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
