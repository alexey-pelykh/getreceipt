// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { AuthenticationError } from '@getreceipt/auth';
import { listSources, SourceAdapterRegistry, TrustBoundaryError, verificationAdvisory } from '@getreceipt/core';
import type { CollectResult, DateRange, ReceiptRef, SourceAdapter } from '@getreceipt/core';

import { verdictFor } from './verdict.js';

/**
 * Self-test of the classification + flip policy (#89). Genuinely executes in CI: it maps SYNTHETIC
 * {@link CollectResult}s — never a live run — to the signal + trust-state each justifies,
 * proves the degenerate-subject guard (zero receipts is NOT a pass), proves a real Zod mismatch CAN
 * fail (drift → stale), and proves the state then flows through the real `listSources` /
 * `verificationAdvisory` seam. Synthetic-not-live is the point: it asserts the mapping without
 * fabricating any claim about a real service.
 */

const WINDOW: DateRange = { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-04-01T00:00:00Z') };
const SOURCE = 'grandfrais.com';

/** A frozen clock so the `verifiedAt` stamp is assertable. */
const FIXED = new Date('2026-06-22T12:00:00Z');
const fixedClock = (): Date => FIXED;

/** One receipt ref, so a `succeeded` run is non-empty (≥1 receipt actually crossed the wire.ts boundary). */
const REF: ReceiptRef = { id: 'r1', issuedAt: new Date('2026-02-01T00:00:00Z'), title: 'Shop' };

function succeeded(written: readonly ReceiptRef[], skipped: readonly ReceiptRef[] = []): CollectResult {
    return { outcome: 'succeeded', source: SOURCE, window: WINDOW, written, skipped };
}

function failed(reason: string, cause: unknown): CollectResult {
    return { outcome: 'failed', source: SOURCE, window: WINDOW, reason, cause, written: [], skipped: [] };
}

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

describe('verdictFor — success promotes only on real evidence', () => {
    it('promotes a non-empty success to e2e-verified and stamps the last-verified date', () => {
        const verdict = verdictFor(succeeded([REF]), fixedClock);
        expect(verdict.signal).toBe('verified');
        expect(verdict.state).toBe('e2e-verified');
        expect(verdict.verifiedAt).toEqual(FIXED);
    });

    it('counts skipped (already-present) receipts as evidence — the listing was still validated', () => {
        const verdict = verdictFor(succeeded([], [REF]), fixedClock);
        expect(verdict.signal).toBe('verified');
        expect(verdict.state).toBe('e2e-verified');
    });

    it('treats a zero-receipt success as INCONCLUSIVE, never a pass (degenerate subject — cardinality-zero is not evidence)', () => {
        const verdict = verdictFor(succeeded([], []), fixedClock);
        expect(verdict.signal).toBe('inconclusive-empty');
        expect(verdict.state).toBe('unverified');
        // A non-pass must NEVER carry a last-verified date.
        expect(verdict.verifiedAt).toBeUndefined();
        expect(verdict.detail).toContain('zero receipts');
    });
});

describe('verdictFor — failure classification (distinct signals, no bare red/green)', () => {
    it('classifies a wire.ts Zod mismatch as contract-drift → stale (THE adapter-fault signal)', () => {
        const cause = new TrustBoundaryError('grandfrais.com:list', [
            { path: 'receipts[0].amount', code: 'invalid_type' },
        ]);
        const verdict = verdictFor(failed('validation failed at grandfrais.com:list', cause), fixedClock);
        expect(verdict.signal).toBe('contract-drift');
        expect(verdict.state).toBe('stale');
        expect(verdict.verifiedAt).toBeUndefined();
    });

    it('classifies a Cloudflare / TLS-fingerprint reject as tls-blocked (refresh impersonation, not a contract fault)', () => {
        const verdict = verdictFor(
            failed('grandfrais: blocked by Cloudflare (cf-ray 8x) — HTTP 403', new Error('cf')),
            fixedClock,
        );
        expect(verdict.signal).toBe('tls-blocked');
        expect(verdict.state).toBe('unverified');
    });

    it('does not let a coincidental 403 keyword mask a genuine contract drift', () => {
        // Even though the reason mentions 403, a TrustBoundaryError cause must still win — drift is checked first.
        const cause = new TrustBoundaryError('grandfrais.com:fetch', [{ path: '<root>', code: 'not_a_pdf' }]);
        const verdict = verdictFor(failed('grandfrais: /pdf returned HTTP 403 then bad shape', cause), fixedClock);
        expect(verdict.signal).toBe('contract-drift');
    });

    it('classifies a typed AuthenticationError (invalid-credentials) as auth (re-mint)', () => {
        const verdict = verdictFor(
            failed('grandfrais: login rejected', new AuthenticationError('rejected', 'invalid-credentials')),
            fixedClock,
        );
        expect(verdict.signal).toBe('auth');
        expect(verdict.state).toBe('unverified');
    });

    it('treats an AuthenticationError(transport-error) as inconclusive, NOT auth (a network/DNS/TLS failure is not "fix your credentials")', () => {
        const verdict = verdictFor(
            failed('grandfrais: request failed', new AuthenticationError('no response', 'transport-error')),
            fixedClock,
        );
        expect(verdict.signal).toBe('inconclusive');
    });

    it('classifies an expired-token / 401 reason as auth (re-mint) even without a typed error', () => {
        const verdict = verdictFor(failed('grandfrais: bearer token expired — HTTP 401', new Error('401')), fixedClock);
        expect(verdict.signal).toBe('auth');
    });

    it('leaves a generic transport failure inconclusive (cannot confirm either way)', () => {
        const verdict = verdictFor(failed('grandfrais: /v1/receipts returned HTTP 500', new Error('500')), fixedClock);
        expect(verdict.signal).toBe('inconclusive');
        expect(verdict.state).toBe('unverified');
    });
});

describe('verdictFor — reauth-required', () => {
    it('classifies the typed re-auth outcome as auth (re-mint), never a contract fault', () => {
        const result: CollectResult = {
            outcome: 'reauth-required',
            source: SOURCE,
            window: WINDOW,
            reason: 'the stored session was rejected',
        };
        const verdict = verdictFor(result, fixedClock);
        expect(verdict.signal).toBe('auth');
        expect(verdict.state).toBe('unverified');
        expect(verdict.detail).toContain('re-authentication');
    });
});

describe('verdictFor — integrates with the verification seam', () => {
    it('flips a source from the default unverified to e2e-verified through listSources', () => {
        const registry = new SourceAdapterRegistry();
        registry.register(fakeAdapter(SOURCE));

        // Before any run, the source defaults to unverified (no lookup supplied).
        expect(listSources(registry)[0]?.verificationState).toBe('unverified');

        // The harness's verdict becomes the VerificationLookup the seam reads — the documented
        // integration point — so a successful live run surfaces the source as e2e-verified.
        const verdict = verdictFor(succeeded([REF]), fixedClock);
        const surfaced = listSources(registry, (domain) => (domain === SOURCE ? verdict.state : undefined));

        expect(surfaced[0]?.verificationState).toBe('e2e-verified');
        // ...and an e2e-verified source warrants no advisory warning.
        expect(verificationAdvisory(verdict.state)).toMatchObject({ level: 'ok', proceed: true });
    });
});
