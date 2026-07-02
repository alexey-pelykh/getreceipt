// SPDX-License-Identifier: AGPL-3.0-only
import { AuthenticationError } from '@getreceipt/auth';
import { TrustBoundaryError } from '@getreceipt/core';
import type { AdapterVerificationState, CollectFailed, CollectResult, CollectSucceeded } from '@getreceipt/core';

/**
 * The distinct, actionable signal ONE live run produces about an adapter — never a bare
 * red/green (#89). A bare pass/fail relearns nothing from the original incident; the signal
 * tells the operator WHICH lever to pull, and crucially separates the one adapter-fault
 * (contract drift) from the environmental conditions that masquerade as failure.
 *
 *  - `verified`           — succeeded with ≥1 receipt that crossed the `wire.ts` boundary; the
 *    reverse-engineered flow is machine-confirmed current.
 *  - `inconclusive-empty` — succeeded but ZERO receipts in the window. A degenerate subject:
 *    nothing was validated, so a green here would be vacuous (cardinality-zero is not evidence).
 *    NOT a pass.
 *  - `contract-drift`     — a `wire.ts` Zod mismatch on real data ({@link TrustBoundaryError}).
 *    THE real adapter-fault signal — the live shape diverged from the model.
 *  - `tls-blocked`        — a Cloudflare / TLS-fingerprint reject (the `Cf403` case). The TLS
 *    identity is stale; refresh impersonation. NOT a contract fault.
 *  - `auth`               — an expired token / OIDC hiccup / rejected session. Re-mint credentials.
 *    NOT a contract fault.
 *  - `inconclusive`       — any other transport/runtime error: cannot confirm either way.
 */
export type LiveSignal = 'verified' | 'inconclusive-empty' | 'contract-drift' | 'tls-blocked' | 'auth' | 'inconclusive';

/** What ONE live run tells us: the classified {@link LiveSignal}, the trust-state it justifies, and why. */
export interface LiveVerdict {
    readonly signal: LiveSignal;
    /** The {@link AdapterVerificationState} this run promotes the source to (the value `listSources` surfaces). */
    readonly state: AdapterVerificationState;
    /** One short, secret-free line explaining the verdict, for the harness to surface. */
    readonly detail: string;
    /**
     * The instant the source was confirmed current — present ONLY when {@link signal} is `verified`.
     * This is the "last-verified date" #90 surfaces for staleness (it downgrades `e2e-verified → stale`
     * past a freshness horizon). Absent on every non-verified signal, so a non-pass can never carry a date.
     */
    readonly verifiedAt?: Date;
}

/** A clock seam so the `verifiedAt` stamp is deterministic in tests; defaults to the wall clock. */
export type Clock = () => Date;

/**
 * Map a raw {@link CollectResult} to the trust-state + signal it justifies — the policy the harness
 * applies to PROMOTE a source's {@link AdapterVerificationState}. Only a non-empty success promotes to
 * `e2e-verified`; everything else stays `unverified` (or `stale` for drift), so the oracle can never
 * overstate confidence — and, decisively, CAN fail (a real Zod mismatch ⇒ `contract-drift` ⇒ `stale`).
 *
 * Pure (modulo the injected {@link Clock}): exercised in CI from SYNTHETIC results — no live run, no
 * network — which is what lets the classification/flip behavior be proven without fabricating any claim.
 */
export function verdictFor(result: CollectResult, now: Clock = () => new Date()): LiveVerdict {
    switch (result.outcome) {
        case 'succeeded': {
            // outOfWindow receipts (#243, coarse-list path) WERE fetched — the wire.ts boundary was crossed —
            // so they count toward "something was validated" even though none were written. Without this, a
            // coarse run that fetched real receipts but wrote none (all fell outside the window) would be
            // mis-classified `inconclusive-empty` ("nothing crossed the boundary"), which is factually wrong.
            const receiptCount = result.written.length + result.skipped.length + (result.outOfWindow?.length ?? 0);
            if (receiptCount === 0) {
                // Degenerate subject — nothing crossed the wire.ts boundary, so "succeeded" proves nothing.
                return {
                    signal: 'inconclusive-empty',
                    state: 'unverified',
                    detail: 'inconclusive: zero receipts in the retention window (nothing to validate)',
                };
            }
            const outOfWindow = result.outOfWindow?.length ?? 0;
            const outOfWindowDetail = outOfWindow === 0 ? '' : `, ${String(outOfWindow)} out-of-window`;
            return {
                signal: 'verified',
                state: 'e2e-verified',
                detail: `verified: ${String(result.written.length)} written, ${String(result.skipped.length)} skipped${outOfWindowDetail}${describeDateResolution(result.resolvedDates)}`,
                verifiedAt: now(),
            };
        }
        case 'reauth-required':
            // The stored session is terminally expired — re-mint, not a contract fault.
            return {
                signal: 'auth',
                state: 'unverified',
                detail: `auth: re-authentication required${result.reason === undefined ? '' : ` (${result.reason})`}`,
            };
        case 'failed':
            return classifyFailure(result);
        default: {
            const exhaustive: never = result;
            throw new Error(`unhandled collect outcome: ${String(exhaustive)}`);
        }
    }
}

/**
 * A warn-only note on a coarse-list run's date-resolution (#243 fast-follow). The window-filter gates on
 * each receipt's fetched date; when NONE resolve — a wholesale `parseInvoiceOrderDate` regression, #244's
 * known limitation — the filter degrades to over-collection, silently until now. Surface the ratio so that
 * degrade is VISIBLE, but never flip the verdict on it: an all-undateable run still fetched real receipts
 * across the wire boundary, so it stays `verified`; the ⚠ tells the operator the WINDOW bound was not
 * honored this run, not that the adapter is broken. Absent for the exact-list path (no `resolvedDates`).
 */
function describeDateResolution(resolvedDates: CollectSucceeded['resolvedDates']): string {
    if (resolvedDates === undefined) {
        return '';
    }
    const { resolved, total } = resolvedDates;
    const warn = resolved === 0 ? ' ⚠ no dates resolved — window filter degraded to over-collection' : '';
    return `, ${String(resolved)}/${String(total)} dates resolved${warn}`;
}

/**
 * Classify a `failed` run into its distinct signal. Order matters: the adapter-fault check
 * ({@link TrustBoundaryError}) is FIRST so a genuine contract drift is never masked by a
 * coincidental keyword; the environmental checks (TLS, auth) follow; anything left is inconclusive.
 *
 * Secret hygiene: classification reads only the error TYPE and the ALREADY-sanitized
 * {@link CollectFailed.reason} (core/the adapter strip values before it lands here), and the surfaced
 * `detail` echoes only that sanitized reason — never a raw `cause` value. Keyword matches are booleans
 * over the sanitized reason, never re-emitted.
 */
function classifyFailure(result: CollectFailed): LiveVerdict {
    if (result.cause instanceof TrustBoundaryError) {
        // The live shape no longer matches the adapter's wire.ts model — the real drift signal.
        return { signal: 'contract-drift', state: 'stale', detail: `contract drift: ${result.reason}` };
    }
    if (isTlsFingerprintReject(result)) {
        return {
            signal: 'tls-blocked',
            state: 'unverified',
            detail: `tls-blocked: Cloudflare/TLS-fingerprint reject — refresh impersonation (${result.reason})`,
        };
    }
    if (isAuthFailure(result)) {
        return { signal: 'auth', state: 'unverified', detail: `auth: re-mint credentials (${result.reason})` };
    }
    return { signal: 'inconclusive', state: 'unverified', detail: `inconclusive: ${result.reason}` };
}

/**
 * A Cloudflare WAF / TLS-fingerprint rejection (the `Cf403` case) — environmental, not a contract
 * fault: the request never reached the application as a real browser would, so refreshing the TLS
 * impersonation (not editing the adapter) is the fix. Recognized from value-free markers in the
 * sanitized reason; a `cloudflare`/`ja3`/`ja4`/`cf-ray`/`tls-fingerprint` mention is the strong tell.
 */
function isTlsFingerprintReject(result: CollectFailed): boolean {
    return /cloudflare|cf-ray|tls[ -]?fingerprint|\bja3\b|\bja4\b|just a moment|attention required/i.test(
        result.reason,
    );
}

/**
 * An authentication / session failure — re-mint, not a contract fault. A typed
 * {@link AuthenticationError} is authoritative (except `transport-error`, which is a network/DNS/TLS
 * failure ⇒ inconclusive, never "fix your credentials"); otherwise fall back to value-free 401/403/token
 * markers in the sanitized reason.
 */
function isAuthFailure(result: CollectFailed): boolean {
    if (result.cause instanceof AuthenticationError) {
        return result.cause.reason !== 'transport-error';
    }
    return /\b401\b|\b403\b|unauthor|forbidden|\btoken\b|oidc|re-?auth|session (?:was )?(?:expired|rejected)/i.test(
        result.reason,
    );
}
