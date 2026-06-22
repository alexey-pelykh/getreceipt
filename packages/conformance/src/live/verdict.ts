// SPDX-License-Identifier: AGPL-3.0-only
import { TrustBoundaryError } from '@getreceipt/core';
import type { AdapterVerificationState, CollectResult } from '@getreceipt/core';

/**
 * What ONE live run tells us about an adapter's trust-state — the mapping the harness
 * applies to PROMOTE a source's {@link AdapterVerificationState} (the value `listSources`
 * surfaces and `verificationAdvisory` gates on). Only an actual success promotes to
 * `e2e-verified`; nothing else does, so the harness can never overstate confidence.
 *
 * It is deliberately a pure function so it is exercised in CI from synthetic
 * {@link CollectResult}s — no live run, no network, no fabricated capture (the honesty
 * constraint #19 turns on).
 *
 *  - `succeeded`                                → `e2e-verified` (the reverse-engineered flow
 *    is machine-confirmed current against the live source).
 *  - `failed` caused by a {@link TrustBoundaryError} → `stale` (the live shape diverged from the
 *    adapter's model — the adapter's own drift signal; "was working, now out of date").
 *  - `failed` (any other cause) / `reauth-required` → `unverified` (INCONCLUSIVE: a transport
 *    error or an expired operator session means we cannot confirm either way, so we never claim
 *    verified).
 */
export interface LiveVerdict {
    readonly state: AdapterVerificationState;
    /** One short, secret-free line explaining the state, for the harness to surface. */
    readonly detail: string;
}

/** Map a raw {@link CollectResult} to the trust-state it justifies. See {@link LiveVerdict} for the policy. */
export function verdictFor(result: CollectResult): LiveVerdict {
    switch (result.outcome) {
        case 'succeeded':
            return {
                state: 'e2e-verified',
                detail: `verified: ${String(result.written.length)} written, ${String(result.skipped.length)} skipped`,
            };
        case 'reauth-required':
            return {
                state: 'unverified',
                detail: `inconclusive: source requires re-authentication${result.reason === undefined ? '' : ` (${result.reason})`}`,
            };
        case 'failed':
            // A boundary failure means the live response no longer matches the adapter's model — drift,
            // not a transport hiccup — so a previously-trusted flow is now stale rather than merely unconfirmed.
            return result.cause instanceof TrustBoundaryError
                ? { state: 'stale', detail: `drift detected: ${result.reason}` }
                : { state: 'unverified', detail: `inconclusive: ${result.reason}` };
        default: {
            const exhaustive: never = result;
            throw new Error(`unhandled collect outcome: ${String(exhaustive)}`);
        }
    }
}
