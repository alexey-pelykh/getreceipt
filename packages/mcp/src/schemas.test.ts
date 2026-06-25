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

    it('collectOutputSchema accepts a canonical OperationResult (incl. reauth-required + optional fields + metadata #97)', () => {
        const result: OperationResult = {
            source: 'example.com',
            outcome: 'reauth-required',
            window: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T00:00:00.000Z' },
            written: [
                {
                    id: 'r1',
                    issuedAt: '2026-01-02T00:00:00.000Z',
                    title: 'Order #1',
                    // The load-bearing MCP exposure: voluntary metadata must round-trip through the tool's output schema.
                    metadata: [
                        { key: 'merchant', label: 'Merchant', value: 'Grand Frais Lyon' },
                        { key: 'total', label: 'Total', value: '42.50 EUR' },
                    ],
                },
            ],
            // A receipt without metadata omits the field entirely — the optional half of the contract.
            skipped: [{ id: 'r0', issuedAt: '2026-01-01T00:00:00.000Z' }],
            reason: 'session expired; re-authenticate',
        };
        expect(collectOutputSchema.parse(result)).toEqual(result);
    });

    it('collectOutputSchema carries per-source challenge outcomes through MCP structured content (#142 AC3)', () => {
        const result: OperationResult = {
            source: 'example.com',
            outcome: 'reauth-required',
            window: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T00:00:00.000Z' },
            written: [],
            skipped: [],
            reason: 'an interactive otp-sms challenge could not be completed on this surface',
            challenges: [
                { outcome: 'resolved', type: 'otp-totp', mode: 'totp-computed' },
                { outcome: 'degraded', reason: 'no-resolver', type: 'otp-sms' },
            ],
        };
        // The SDK validates structured content against this schema; the outcomes must survive verbatim.
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

describe('the two tools advertise their distinct `window` echo shape (#145)', () => {
    // `collect` echoes RESOLVED ISO-8601 instants; `collect_all` echoes REQUESTED YYYY-MM-DD calendar dates
    // (no single instant pair fits N differently-zoned sources). The shapes are structurally identical, so the
    // compile-time drift guard above stays green and the ONLY thing distinguishing them in the advertised
    // output contract is these field descriptions — pin them so a future edit can't silently drop the intent.
    const collectWindow = collectOutputSchema.shape.window;
    const batchWindow = collectAllOutputSchema.shape.window.unwrap();

    it('describes the single-source window as resolved ISO-8601 instants (end-of-day only for an explicit `until`, #127)', () => {
        expect(collectWindow.shape.from.description).toMatch(/ISO-8601 instant/);
        expect(collectWindow.shape.to.description).toMatch(/ISO-8601 instant/);
        // `to` is end-of-day ONLY for an explicit `until`; an open-ended / default run echoes `now`
        // (operation-runner.ts: `until === undefined ? now : zonedDayEnd(...)`). Pin BOTH halves so the
        // description can't regress to telling a client "end-of-day" for what is really a mid-day `now`.
        expect(collectWindow.shape.to.description).toMatch(/end-of-day/);
        expect(collectWindow.shape.to.description).toMatch(/\bnow\b/);
    });

    it('describes the batch window as requested YYYY-MM-DD calendar dates', () => {
        expect(batchWindow.shape.from.description).toMatch(/YYYY-MM-DD calendar date/);
        expect(batchWindow.shape.to.description).toMatch(/YYYY-MM-DD calendar date/);
    });

    it('keeps both window shapes permissive `{ from, to }: string` — the description, not validation, carries the intent', () => {
        const instants = { from: '2026-05-31T22:00:00.000Z', to: '2026-06-24T21:59:59.999Z' };
        const dates = { from: '2024-01-01', to: '2024-01-31' };
        expect(collectWindow.parse(instants)).toEqual(instants);
        expect(batchWindow.parse(dates)).toEqual(dates);
        // Neither field is regex-narrowed: the batch `from` flows from un-narrowed user input, so a strict
        // format would over-reject. Each schema therefore accepts the other's shape — guards that nobody
        // accidentally tightens one side into rejecting valid input while "disambiguating".
        expect(collectWindow.parse(dates)).toEqual(dates);
        expect(batchWindow.parse(instants)).toEqual(instants);
    });
});
