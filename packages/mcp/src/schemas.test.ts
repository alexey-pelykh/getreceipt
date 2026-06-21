// SPDX-License-Identifier: AGPL-3.0-only
import type { BatchReport, SourcesReport, StatusReport } from '@getreceipt/cli';
import type { OperationResult } from '@getreceipt/core';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
    authStatusOutputSchema,
    collectAllOutputSchema,
    collectOutputSchema,
    listSourcesOutputSchema,
} from './schemas.js';

/**
 * Strip `readonly`, drop `| undefined` from optional properties (preserving the `?` itself), and
 * recurse — so a zod inference (mutable arrays, `?: T | undefined`) and a canonical domain type
 * (`readonly`, exact-optional `?: T`) compare equal IFF they describe the same JSON shape. Without
 * this normalization the two would always differ on readonly-ness and optional-undefined alone.
 */
type Normalize<T> = T extends readonly (infer E)[]
    ? Normalize<E>[]
    : T extends object
      ? { -readonly [K in keyof T]: Normalize<Exclude<T[K], undefined>> }
      : T;

/** True IFF A and B are the identical type (invariant) — stricter than mutual assignability. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * Compile-time drift guard: each hand-authored output schema's `z.infer` must equal the canonical
 * type it advertises. A drift — renamed field, changed enum member, optional/required flip, wrong
 * scalar — makes `Equals` resolve to `false`, so `const … : false = true` fails to compile and the
 * typecheck / build breaks. This is the static half; the CLI↔MCP parity gate is the runtime half.
 */
const collectEqualsOperationResult: Equals<
    Normalize<z.infer<typeof collectOutputSchema>>,
    Normalize<OperationResult>
> = true;
const collectAllEqualsBatchReport: Equals<
    Normalize<z.infer<typeof collectAllOutputSchema>>,
    Normalize<BatchReport>
> = true;
const listSourcesEqualsSourcesReport: Equals<
    Normalize<z.infer<typeof listSourcesOutputSchema>>,
    Normalize<SourcesReport>
> = true;
const authStatusEqualsStatusReport: Equals<
    Normalize<z.infer<typeof authStatusOutputSchema>>,
    Normalize<StatusReport>
> = true;

describe('MCP output schemas mirror the canonical domain types', () => {
    it('infer to OperationResult / BatchReport / SourcesReport / StatusReport (compile-time drift guard)', () => {
        // These constants are `true` only because the type-level `Equals` above held — tsc is the real
        // gate; this assertion makes the guard a genuinely-executing test and pins the intent at runtime.
        expect([
            collectEqualsOperationResult,
            collectAllEqualsBatchReport,
            listSourcesEqualsSourcesReport,
            authStatusEqualsStatusReport,
        ]).toEqual([true, true, true, true]);
    });

    it('collectOutputSchema accepts a canonical OperationResult (incl. reauth-required + optional fields)', () => {
        const result: OperationResult = {
            source: 'example.com',
            outcome: 'reauth-required',
            window: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T00:00:00.000Z' },
            written: [{ id: 'r1', issuedAt: '2026-01-02T00:00:00.000Z', title: 'Order #1' }],
            skipped: [{ id: 'r0', issuedAt: '2026-01-01T00:00:00.000Z' }],
            reason: 'session expired; re-authenticate',
        };
        expect(collectOutputSchema.parse(result)).toEqual(result);
    });

    it('collectAllOutputSchema accepts a canonical BatchReport (mixed ok/error sources)', () => {
        const report: BatchReport = {
            profile: 'default',
            outcome: 'partial',
            concurrency: 3,
            sources: [
                {
                    source: 'example.com',
                    ok: true,
                    result: {
                        source: 'example.com',
                        outcome: 'succeeded',
                        window: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T00:00:00.000Z' },
                        written: [],
                        skipped: [],
                    },
                },
                { source: 'broken.example', ok: false, error: { kind: 'not-configured', message: 'no credentials' } },
            ],
        };
        expect(collectAllOutputSchema.parse(report)).toEqual(report);
    });

    it('listSourcesOutputSchema accepts a canonical SourcesReport', () => {
        const report: SourcesReport = {
            profile: 'default',
            sources: [
                {
                    canonicalDomain: 'example.com',
                    aliasDomains: ['ex.com'],
                    authKind: 'password',
                    transportTier: 'http-api',
                    artifactMode: 'pdf-download',
                    verificationState: 'unverified',
                    configured: true,
                },
            ],
        };
        expect(listSourcesOutputSchema.parse(report)).toEqual(report);
    });

    it('authStatusOutputSchema accepts a canonical StatusReport (token never present)', () => {
        const report: StatusReport = {
            profile: 'default',
            sources: [
                {
                    source: 'example.com',
                    requested: 'example.com',
                    authKind: 'password',
                    registered: true,
                    session: 'expired',
                    expiresAt: '2026-01-01T00:00:00.000Z',
                    reason: 'expired 3 days ago',
                },
            ],
        };
        expect(authStatusOutputSchema.parse(report)).toEqual(report);
    });
});
