// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An adapter's TRUST-STATE: whether its reverse-engineered flow is currently
 * verified against the live source. This is adapter trust-state (surfaced per-source
 * by {@link listSources}) — NOT per-artifact integrity, which is the writer's
 * content hash. The state is operational, promoted ONLY by the fenced live conformance
 * oracle (the `@getreceipt/conformance` live harness); it is deliberately NOT a
 * {@link SourceDescriptor} field an adapter declares about itself, and deliberately NOT
 * promoted by a user's `collect` — see {@link SourceVerification} (#144).
 *
 *  - `unverified`   — the flow has never been machine-confirmed against the live source.
 *  - `e2e-verified` — confirmed current against the live source by the live oracle.
 *  - `stale`        — was verified, but that verification is now out of date.
 */
export type AdapterVerificationState = 'unverified' | 'e2e-verified' | 'stale';

/** Every verification state — the source of truth a renderer (e.g. the `sources` command) iterates. */
export const ADAPTER_VERIFICATION_STATES: readonly AdapterVerificationState[] = ['unverified', 'e2e-verified', 'stale'];

/** Whether a state warrants surfacing a warning to the user. */
export type VerificationAdvisoryLevel = 'ok' | 'warn';

/** The gate/warn disposition for a verification state — see {@link verificationAdvisory}. */
export interface VerificationAdvisory {
    readonly state: AdapterVerificationState;
    readonly level: VerificationAdvisoryLevel;
    /** Whether collection may proceed. */
    readonly proceed: boolean;
    /** Human-readable advisory; omitted when {@link level} is `ok`. */
    readonly message?: string;
}

const UNVERIFIED_MESSAGE =
    'This source has not been verified end-to-end against the live service; its reverse-engineered flow may be out of date. Results are best-effort.';

const STALE_MESSAGE =
    'This source was verified end-to-end previously, but that verification is now stale; the live service may have changed since. Re-verification is recommended; results are best-effort.';

/**
 * Map a verification state to its gate/warn advisory — the documented semantics
 * AC2 requires the enum to drive.
 *
 * Policy (WARN-ONLY): `unverified` → warn + proceed; `stale` → warn + proceed
 * (distinct copy); `e2e-verified` → ok + proceed. Nothing blocks. Blocking would be
 * wrong here: until the live oracle's verdict is wired into a production lookup, every
 * source surfaces `unverified`, so a fail-safe block default would block every adapter —
 * and the asset is the user's own receipts fetched with the user's own credentials, so
 * there is no third party to protect by blocking.
 *
 * Planned tightening: once verified/stale states are surfaced in production, `stale` is
 * expected to escalate to BLOCK behind a config opt-in — a deliberate, changelogged
 * change, never a silent default flip. The `unverified` vs `stale` wording is already
 * distinct so that future divergence is not a surprise.
 */
export function verificationAdvisory(state: AdapterVerificationState): VerificationAdvisory {
    switch (state) {
        case 'e2e-verified':
            return { state, level: 'ok', proceed: true };
        case 'unverified':
            return { state, level: 'warn', proceed: true, message: UNVERIFIED_MESSAGE };
        case 'stale':
            return { state, level: 'warn', proceed: true, message: STALE_MESSAGE };
        default: {
            const exhaustive: never = state;
            throw new Error(`unhandled verification state: ${String(exhaustive)}`);
        }
    }
}

/**
 * A source's recorded verification provenance: its raw trust-state plus the instant it was last
 * confirmed current. `lastVerifiedAt` is the `verifiedAt` the live oracle stamps on a `verified`
 * run (#89) — present only when {@link state} is `e2e-verified`, absent when never verified.
 *
 * Produced ONLY by the fenced live conformance oracle, never by a user's `collect` (#144). The two
 * answer different questions at different scopes: a successful `collect` is per-installation LIVENESS
 * (it worked for you, on your machine, against your account, just now — not reproducible, not
 * committed), whereas this record is a SHIPPED, per-adapter FIDELITY claim that must read the same for
 * every user. Promoting it on a local collect would make the badge mean different things to different
 * users for the same adapter — so `collect` is deliberately not a source of it. "Did my collect work?"
 * is answered by the collection manifest and `auth_status`, not by this badge. See docs/verification.md.
 */
export interface SourceVerification {
    readonly state: AdapterVerificationState;
    readonly lastVerifiedAt?: Date;
}

/**
 * How long an `e2e-verified` confirmation stays current before it decays to `stale`. 30 days: the
 * live oracle runs operator-attended and intermittently, and a reverse-engineered web flow can drift
 * at any deploy, so a month-old confirmation is no longer a strong currency signal. The decay is
 * warn-only (never blocks), so erring short is the safe direction; override per-call via
 * {@link effectiveVerificationState}.
 */
export const DEFAULT_FRESHNESS_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Apply runtime staleness decay to a recorded verification — the date math #90 adds. An
 * `e2e-verified` source whose last confirmation is older than `horizonMs` surfaces as `stale`; one
 * carrying no date can't prove freshness, so it surfaces as `stale` too (loud, not silent).
 * `unverified` and already-`stale` pass through unchanged. Pure (the comparison instant `now` is
 * injected) and monotonic by design: decay can only LOWER confidence — only the harness (#89)
 * promotes to `e2e-verified`.
 */
export function effectiveVerificationState(
    verification: SourceVerification,
    now: Date,
    horizonMs: number = DEFAULT_FRESHNESS_HORIZON_MS,
): AdapterVerificationState {
    if (verification.state !== 'e2e-verified') {
        return verification.state;
    }
    if (verification.lastVerifiedAt === undefined) {
        return 'stale';
    }
    const age = now.getTime() - verification.lastVerifiedAt.getTime();
    return age > horizonMs ? 'stale' : 'e2e-verified';
}
