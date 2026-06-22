// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { listSources, SourceAdapterRegistry, TrustBoundaryError, verificationAdvisory } from '@getreceipt/core';
import type { CollectResult, DateRange, SourceAdapter } from '@getreceipt/core';

import { verdictFor } from './verdict.js';

/**
 * Self-test of the result mapping (#19). Genuinely executes in CI: it maps SYNTHETIC
 * {@link CollectResult}s — never a live run — to the trust-state each justifies, and then
 * proves that state flows through the real `listSources` / `verificationAdvisory` seam.
 * Synthetic-not-live is the whole point: it asserts the mapping without fabricating any
 * claim about a real service.
 */

const WINDOW: DateRange = { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-04-01T00:00:00Z') };
const SOURCE = 'grandfrais.com';

/** A minimal adapter so `listSources` has something to surface; its stages must never run in these mapping tests. */
function fakeAdapter(canonicalDomain: string): SourceAdapter {
    const unusedStage = (): never => {
        throw new Error('adapter stage must not be invoked in verdict-mapping tests');
    };
    return {
        descriptor: {
            canonicalDomain,
            aliasDomains: [],
            authKind: 'password',
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
            defaultWindow: { days: 90 },
            pagination: 'none',
        },
        authenticate: unusedStage,
        list: unusedStage,
        fetch: unusedStage,
    };
}

describe('verdictFor — promotion policy', () => {
    it('promotes a succeeded run to e2e-verified', () => {
        const result: CollectResult = {
            outcome: 'succeeded',
            source: SOURCE,
            window: WINDOW,
            written: [],
            skipped: [],
        };
        expect(verdictFor(result).state).toBe('e2e-verified');
    });

    it('marks a trust-boundary failure as stale (drift), not merely unverified', () => {
        const result: CollectResult = {
            outcome: 'failed',
            source: SOURCE,
            window: WINDOW,
            reason: 'grandfrais.com:fetch failed the boundary',
            cause: new TrustBoundaryError('grandfrais.com:fetch', [{ path: '<root>', code: 'not_a_pdf' }]),
            written: [],
            skipped: [],
        };
        const verdict = verdictFor(result);
        expect(verdict.state).toBe('stale');
        expect(verdict.detail).toContain('drift');
    });

    it('leaves a generic transport failure unverified (inconclusive)', () => {
        const result: CollectResult = {
            outcome: 'failed',
            source: SOURCE,
            window: WINDOW,
            reason: 'request to /api/account/receipts failed',
            cause: new Error('socket hang up'),
            written: [],
            skipped: [],
        };
        expect(verdictFor(result).state).toBe('unverified');
    });

    it('leaves a reauth-required outcome unverified (inconclusive)', () => {
        const result: CollectResult = {
            outcome: 'reauth-required',
            source: SOURCE,
            window: WINDOW,
            reason: 'the stored session was rejected',
        };
        const verdict = verdictFor(result);
        expect(verdict.state).toBe('unverified');
        expect(verdict.detail).toContain('re-authentication');
    });
});

describe('verdictFor — integrates with the verification seam', () => {
    it('promotes a source from the default unverified to e2e-verified through listSources', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(fakeAdapter(SOURCE));

        // Before any run, the source defaults to unverified (no lookup supplied).
        expect(listSources(registry)[0]?.verificationState).toBe('unverified');

        // The harness's verdict becomes the VerificationLookup the seam reads — the documented
        // integration point — so a successful live run surfaces the source as e2e-verified.
        const verdict = verdictFor({ outcome: 'succeeded', source: SOURCE, window: WINDOW, written: [], skipped: [] });
        const surfaced = listSources(registry, (domain) => (domain === SOURCE ? verdict.state : undefined));

        expect(surfaced[0]?.verificationState).toBe('e2e-verified');
        // ...and an e2e-verified source warrants no advisory warning.
        expect(verificationAdvisory(verdict.state)).toMatchObject({ level: 'ok', proceed: true });
    });
});
