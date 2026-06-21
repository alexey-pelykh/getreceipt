// SPDX-License-Identifier: AGPL-3.0-only
import type { z } from 'zod';

/**
 * Validate external/untrusted data (service responses, parsed config, tool inputs)
 * at the trust boundary, turning a violation into a typed, secret-safe error.
 *
 * Adapters, the pipeline, and any future MCP-tool/HTTP-response handler funnel
 * untrusted input through {@link parseAtBoundary}/{@link safeParseAtBoundary} so the
 * rest of the codebase only ever sees data that matches a declared Zod schema.
 *
 * Secret hygiene (the load-bearing reason this wraps Zod rather than re-throwing
 * `ZodError`): a {@link TrustBoundaryError} carries only WHERE ({@link BoundaryIssue.path})
 * and WHAT KIND ({@link BoundaryIssue.code}) of violation — never the offending value
 * and never Zod's human-readable message (which can embed received input). This
 * mirrors the "never carry the value" posture of `@getreceipt/auth`'s `ConfigError`
 * so a secret in untrusted data cannot leak into logs or stack traces via an error.
 *
 * Design rule — fixed-shape schemas only. A Zod path segment is safe to surface
 * only when it is a developer-authored field name. Record/map KEYS become path
 * segments too, so a schema keyed by untrusted data (e.g. `z.record(secretKey, …)`)
 * would put that key into {@link BoundaryIssue.path} and leak it. Validate untrusted
 * maps as an array of entries instead — `z.array(z.object({ key, value }))` — so the
 * key travels as a VALUE (never echoed) rather than a path segment.
 */

/**
 * One sanitized validation issue: the location and kind of a single violation,
 * with no value material. See the module note on secret hygiene.
 */
export interface BoundaryIssue {
    /** Dotted location of the violation, e.g. `receipts[0].issuedAt` (or `<root>`). */
    readonly path: string;
    /** Zod issue code (e.g. `invalid_type`, `too_small`) — the kind of violation, value-free. */
    readonly code: string;
}

/** A Zod-shaped raw issue. Structural so this module needs no value import of zod. */
interface RawIssue {
    readonly path: ReadonlyArray<PropertyKey>;
    readonly code: string;
}

/**
 * Thrown when untrusted data fails boundary validation. Carries the {@link boundary}
 * label (where the data entered, e.g. `free.fr:list`) and the sanitized
 * {@link issues} — never the offending value or Zod's value-bearing messages.
 */
export class TrustBoundaryError extends Error {
    override readonly name = 'TrustBoundaryError';

    constructor(
        /** Caller-supplied label for the boundary the data crossed, e.g. `free.fr:list`, `config`. */
        readonly boundary: string,
        /** Sanitized issues — {@link BoundaryIssue} carries no value material. */
        readonly issues: readonly BoundaryIssue[],
    ) {
        super(`validation failed at ${boundary}: ${summarize(issues)}`);
    }
}

/** The non-throwing outcome of a boundary check: typed data, or the same sanitized error. */
export type BoundaryResult<T> =
    | { readonly ok: true; readonly data: T }
    | { readonly ok: false; readonly error: TrustBoundaryError };

/**
 * Validate `data` against `schema`, returning a discriminated result instead of
 * throwing. The failure branch carries the SAME sanitized {@link TrustBoundaryError}
 * that {@link parseAtBoundary} throws — the non-throwing path is never a side door
 * around sanitization.
 */
export function safeParseAtBoundary<T extends z.ZodType>(
    schema: T,
    data: unknown,
    boundary: string,
): BoundaryResult<z.infer<T>> {
    const result = schema.safeParse(data);
    if (result.success) {
        return { ok: true, data: result.data };
    }
    return { ok: false, error: new TrustBoundaryError(boundary, sanitize(result.error.issues)) };
}

/**
 * Validate `data` against `schema`, returning the typed value or throwing a
 * {@link TrustBoundaryError}. Use when a violation is a hard failure; use
 * {@link safeParseAtBoundary} when the caller wants to branch (warn vs. fail).
 */
export function parseAtBoundary<T extends z.ZodType>(schema: T, data: unknown, boundary: string): z.infer<T> {
    const result = safeParseAtBoundary(schema, data, boundary);
    if (!result.ok) {
        throw result.error;
    }
    return result.data;
}

/** Project Zod issues down to value-free {@link BoundaryIssue}s (path + code only). */
function sanitize(issues: readonly RawIssue[]): readonly BoundaryIssue[] {
    return issues.map((issue) => ({ path: renderPath(issue.path), code: issue.code }));
}

/** Render a Zod path as a dotted string: object keys join with `.`, array indices as `[n]`; empty → `<root>`. */
function renderPath(path: ReadonlyArray<PropertyKey>): string {
    if (path.length === 0) {
        return '<root>';
    }
    let rendered = '';
    for (const segment of path) {
        if (typeof segment === 'number') {
            rendered += `[${segment}]`;
        } else {
            rendered += rendered === '' ? String(segment) : `.${String(segment)}`;
        }
    }
    return rendered;
}

/** One-line summary for the error message: count plus each `path (code)`, value-free. */
function summarize(issues: readonly BoundaryIssue[]): string {
    const detail = issues.map((issue) => `${issue.path} (${issue.code})`).join(', ');
    return `${issues.length} issue(s): ${detail}`;
}
