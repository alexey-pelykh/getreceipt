// SPDX-License-Identifier: AGPL-3.0-only
import type { z } from 'zod';

/**
 * Anti-circularity test support (#88).
 *
 * The original adapter failure passed CI because the adapter invented an endpoint AND the MSW
 * fixtures encoded the SAME invented shape — two hand-authorings that happened to agree, so the
 * suite was green against a contract that diverged from reality ("circular green"). The fix is to
 * make every adapter test DERIVE from the one in-repo contract (`wire.ts`) instead of re-authoring
 * it beside the adapter:
 *
 *  - {@link wireFixture} forces a positive response fixture THROUGH the adapter's own wire Zod
 *    schema, so a fixture the contract would reject cannot reach MSW.
 *  - {@link findHandAuthoredEndpointLiterals} is the URL half: it flags an absolute-URL string
 *    literal hand-typed in a test (endpoints must be sourced from `wire.ts`, never re-typed).
 */

/**
 * Thrown by {@link wireFixture} when a candidate fixture does not conform to its wire schema. The
 * rejecting Zod error is carried on the native {@link Error.cause} for callers that want the raw issues.
 */
export class WireFixtureError extends Error {
    override readonly name = 'WireFixtureError';
}

/**
 * Validate `candidate` against a wire-contract `schema`, returning the candidate UNCHANGED so the
 * served bytes stay exactly as the test authored them (preserving control over optional / defaulted
 * fields — e.g. a receipt that omits a defaulted `type` still reaches the adapter without it). A
 * candidate that diverges from the contract throws {@link WireFixtureError} at fixture-build time
 * rather than passing silently. THIS is the derivation: a fixture only exists if the schema accepts
 * it, so the test can never encode a shape the contract rejects.
 *
 * Negative-path fixtures (deliberately malformed bodies that assert the adapter's boundary rejects
 * them) must NOT go through this helper — they are supposed to diverge.
 */
export function wireFixture<Schema extends z.ZodType>(schema: Schema, candidate: z.input<Schema>): z.input<Schema> {
    const result = schema.safeParse(candidate);
    if (!result.success) {
        throw new WireFixtureError(`fixture does not match its wire schema: ${summarizeIssues(result.error)}`, {
            cause: result.error,
        });
    }
    return candidate;
}

/** One-line, path-qualified summary of a Zod error (fixtures are synthetic, so values are safe to show). */
function summarizeIssues(error: z.ZodError): string {
    return error.issues
        .map((issue) => {
            const path = issue.path.length === 0 ? '<root>' : issue.path.join('.');
            return `${path}: ${issue.message}`;
        })
        .join('; ');
}

/**
 * Scan TypeScript/JavaScript `source` for hand-authored absolute-URL string literals — the
 * "circular green" vector (#88): an endpoint hand-typed in a test instead of sourced from `wire.ts`.
 * Returns the content of every string literal (`'`, `"`, or `` ` ``) whose text contains an
 * `http(s)://` URL; an empty array means the test sources all endpoints from the contract.
 *
 * A small scanner (not a bare regex) tracks string vs. comment state, so a `//` inside a URL string
 * is not mistaken for a comment and a commented-out URL is not mistaken for a literal.
 */
export function findHandAuthoredEndpointLiterals(source: string): string[] {
    const found: string[] = [];
    const n = source.length;
    let i = 0;
    while (i < n) {
        const ch = source.charAt(i);
        const next = source.charAt(i + 1);
        if (ch === '/' && next === '/') {
            i += 2;
            while (i < n && source.charAt(i) !== '\n') i += 1;
            continue;
        }
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < n && !(source.charAt(i) === '*' && source.charAt(i + 1) === '/')) i += 1;
            i += 2;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            const quote = ch;
            i += 1;
            let content = '';
            while (i < n && source.charAt(i) !== quote) {
                if (source.charAt(i) === '\\') {
                    content += source.charAt(i) + source.charAt(i + 1);
                    i += 2;
                    continue;
                }
                content += source.charAt(i);
                i += 1;
            }
            i += 1;
            if (/https?:\/\//.test(content)) {
                found.push(content);
            }
            continue;
        }
        i += 1;
    }
    return found;
}
