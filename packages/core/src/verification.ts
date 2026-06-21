// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An adapter's TRUST-STATE: whether its reverse-engineered flow is currently
 * verified against the live source. This is adapter trust-state (surfaced per-source
 * by {@link listSources}) — NOT per-artifact integrity, which is the writer's
 * content hash. The state is operational, set by the future live-E2E harness
 * (0.3.0); it is deliberately NOT a {@link SourceDescriptor} field an adapter
 * declares about itself.
 *
 *  - `unverified`   — the flow has never been machine-confirmed against the live source.
 *  - `e2e-verified` — confirmed current against the live source by the e2e harness.
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
 * Policy (0.2.0 — WARN-ONLY): `unverified` → warn + proceed; `stale` → warn + proceed
 * (distinct copy); `e2e-verified` → ok + proceed. Nothing blocks. Blocking would be
 * wrong here: `e2e-verified` is unreachable until the 0.3.0 live-E2E harness exists,
 * so a fail-safe default would block every adapter — and the asset is the user's own
 * receipts fetched with the user's own credentials, so there is no third party to
 * protect by blocking.
 *
 * Planned tightening (0.3.0): once the harness can produce `e2e-verified`/`stale`,
 * `stale` is expected to escalate to BLOCK behind a config opt-in — a deliberate,
 * changelogged change, never a silent default flip. The `unverified` vs `stale`
 * wording is already distinct so that future divergence is not a surprise.
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
