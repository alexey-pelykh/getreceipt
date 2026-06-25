// SPDX-License-Identifier: AGPL-3.0-only
import type { UnresolvedChallengeReason } from './auth-challenge.js';
import type { ChallengeType } from './challenge.js';

/**
 * How an emitted challenge was resolved — the redaction-safe "how", never the answer itself. The
 * orchestrator derives it from the challenge `type` (it never reads the resolved code): `otp-totp`
 * → `totp-computed` (a code computed locally, unattended); every other type → `human-entered` (a
 * human typed a code, approved a push, or passed a ceremony).
 *
 * This is an OUTPUT enum — it enumerates the modes our code actually produces, so every value is
 * reachable and every exhaustive consumer has a live branch. A future unattended device-trust
 * resolution (#140) widens it with its own mode; widening an output union is backward-compatible,
 * so it is added there WITH its producer rather than pre-declared dead here.
 */
export type ChallengeResolutionMode = 'totp-computed' | 'human-entered';

/**
 * One moment in an interactive challenge's lifecycle, streamed to an injected {@link ChallengeObserver}
 * by {@link @getreceipt/core!resolveAuthChallenges}. The discriminant is `phase`:
 *  - `emitted`  — a source demanded a challenge (carries its {@link ChallengeType}).
 *  - `resolved` — a resolver answered it (carries the {@link ChallengeResolutionMode}).
 *  - `degraded` — it could not be resolved on this surface, so the run surfaces `reauth-required`
 *    (#134); carries the {@link UnresolvedChallengeReason}, plus the type when one was in play.
 *
 * Redaction-safe BY CONSTRUCTION: every field is a closed enum or the canonical source domain. There
 * is deliberately NO field for the OTP code, the TOTP seed, the session, the device-trust artifact,
 * or the challenge `prompt`/`metadata` — so a secret is *unrepresentable* in an event, not merely
 * unread. AC2's secret-leakage fence holds at the type level, not by discipline.
 */
export type ChallengeLifecycleEvent =
    | { readonly phase: 'emitted'; readonly source: string; readonly type: ChallengeType }
    | {
          readonly phase: 'resolved';
          readonly source: string;
          readonly type: ChallengeType;
          readonly mode: ChallengeResolutionMode;
      }
    | {
          readonly phase: 'degraded';
          readonly source: string;
          readonly reason: UnresolvedChallengeReason;
          readonly type?: ChallengeType;
      };

/**
 * The injected sink for {@link ChallengeLifecycleEvent}s — the observability port the orchestrator
 * calls as a challenge is emitted, resolved, or degrades. Side-effecting (a log line, a counter) and
 * expected not to throw or block the auth flow; it never receives credential material (see
 * {@link ChallengeLifecycleEvent}). Optional everywhere — omit it and the lifecycle runs silently.
 */
export type ChallengeObserver = (event: ChallengeLifecycleEvent) => void;

/**
 * The terminal disposition of ONE challenge, for the structured per-source report
 * ({@link @getreceipt/core!OperationResult.challenges}, #142 AC3) — distinct from the live
 * {@link ChallengeLifecycleEvent} stream: source-less (it is nested under a source-keyed result) and
 * carries only the OUTCOME, not the intermediate `emitted` moment. Kept minimal and separate so the
 * report's parity-gated shape (the CLI↔MCP `OperationResult` contract) does not couple to the
 * evolving live-event union. Same closed-domain redaction guarantee as the event.
 *
 * `resolved` is a per-CHALLENGE disposition — "a resolver answered this challenge" — NOT a verdict on the
 * run: a challenge can resolve and the run still end `failed`/`reauth-required` for a later reason, leaving
 * a `resolved` outcome on a non-succeeded result.
 */
export type ChallengeOutcome =
    | { readonly outcome: 'resolved'; readonly type: ChallengeType; readonly mode: ChallengeResolutionMode }
    | { readonly outcome: 'degraded'; readonly reason: UnresolvedChallengeReason; readonly type?: ChallengeType };

/**
 * Render a {@link ChallengeLifecycleEvent} as one redaction-safe log line, e.g.
 * `challenge resolved source=free.fr type=otp-totp mode=totp-computed`. The single serializer every
 * log sink shares, so the format is defined and tested once. Pure; emits only the event's closed-enum
 * and domain fields.
 */
export function formatChallengeEvent(event: ChallengeLifecycleEvent): string {
    switch (event.phase) {
        case 'emitted':
            return `challenge emitted source=${event.source} type=${event.type}`;
        case 'resolved':
            return `challenge resolved source=${event.source} type=${event.type} mode=${event.mode}`;
        case 'degraded':
            return `challenge degraded source=${event.source} reason=${event.reason}${event.type === undefined ? '' : ` type=${event.type}`}`;
    }
    // `event` narrows to `never` only while every phase is handled above; a new phase without a branch
    // makes this a compile error rather than a silent unformatted fall-through.
    const unhandled: never = event;
    throw new Error(`unhandled challenge phase: ${String(unhandled)}`);
}
