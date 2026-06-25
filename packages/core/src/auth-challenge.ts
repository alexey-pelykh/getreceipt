// SPDX-License-Identifier: AGPL-3.0-only
import type { ChallengeLifecycleEvent, ChallengeObserver, ChallengeResolutionMode } from './challenge-observer.js';
import type { ChallengeResolver, ChallengeType } from './challenge.js';
import type { AuthHandle, AuthResult } from './source-adapter.js';
import { isAuthChallengeRequired } from './source-adapter.js';

/**
 * Upper bound on how many challenges one authentication may chain before it is treated as a
 * misbehaving source. A real flow resolves in one or two factors; this ceiling only stops an
 * adapter that returns challenges without end from looping forever.
 */
export const MAX_AUTH_CHALLENGE_ROUNDS = 8;

/** Why {@link resolveAuthChallenges} could not turn an {@link AuthResult} into a session. */
export type UnresolvedChallengeReason = 'no-resolver' | 'exhausted';

/**
 * An interactive challenge could not be resolved into a session: either none of a
 * {@link ChallengeResolver} was supplied to answer it (`no-resolver`), or the source chained more
 * than {@link MAX_AUTH_CHALLENGE_ROUNDS} challenges without establishing one (`exhausted`). Carries
 * no secret material — only the redaction-safe {@link ChallengeType}. `collect()` catches it and
 * surfaces a structured `reauth-required` result pointing at the `login` ceremony (#134); it never
 * escapes the pipeline boundary.
 */
export class UnresolvedChallengeError extends Error {
    override readonly name = 'UnresolvedChallengeError';

    constructor(
        readonly reason: UnresolvedChallengeReason,
        /** The challenge type in play when resolution failed; omitted for `exhausted`. */
        readonly challengeType?: ChallengeType,
    ) {
        super(
            reason === 'no-resolver'
                ? `An authentication challenge${challengeType ? ` (${challengeType})` : ''} was issued but no ChallengeResolver was provided to resolve it.`
                : `Authentication exceeded ${MAX_AUTH_CHALLENGE_ROUNDS} challenge rounds without establishing a session.`,
        );
    }
}

/** Observability + attribution knobs for {@link resolveAuthChallenges}; all optional (omit → silent). */
export interface ResolveAuthChallengesOptions {
    /** Canonical domain of the source being authenticated — stamped on every emitted event. */
    readonly source?: string;
    /** Sink for the challenge lifecycle (emitted / resolved / degraded). Omit to run silently (#142). */
    readonly observer?: ChallengeObserver;
}

/**
 * The redaction-safe resolution mode for a resolved challenge, by its type. Exhaustive over
 * {@link ChallengeType} (the `never` guard makes a new type a compile error here), so the mode can
 * never silently default: a future locally-computed factor must declare its own mode rather than
 * inherit TOTP's. A device-trust resolution — satisfied with no human and no computed code — is not
 * derivable from the type alone, so it arrives with its own producer + mode in #140, not here.
 */
function resolutionMode(type: ChallengeType): ChallengeResolutionMode {
    switch (type) {
        case 'otp-totp':
            return 'totp-computed';
        case 'otp-sms':
        case 'otp-email':
        case 'push':
        case 'captcha':
        case 'webauthn':
            return 'human-entered';
    }
    const unhandled: never = type;
    throw new Error(`unhandled challenge type: ${String(unhandled)}`);
}

/**
 * Drive an {@link AuthResult} to an established {@link AuthHandle}, resolving any
 * {@link AuthChallengeRequired} through the injected `resolver` and resuming — the orchestrator
 * half of the interactive-login-challenge seam (#133). A bare {@link AuthHandle} (the common,
 * backward-compatible case) is returned untouched, so a non-challenge adapter needs no `resolver`
 * at all. A challenge with no `resolver`, or a source that chains past
 * {@link MAX_AUTH_CHALLENGE_ROUNDS}, raises {@link UnresolvedChallengeError}.
 *
 * As it runs it streams the challenge lifecycle to `options.observer` (#142): `emitted` when a
 * challenge appears, `resolved` once a resolver answers it, `degraded` just before it raises
 * {@link UnresolvedChallengeError}. Every event carries only the redaction-safe source + type +
 * mode/reason — never the resolved code, which travels solely on the {@link ChallengeResolution}
 * the resolver returns and is never read here.
 *
 * @param initial The value `authenticate()` resolved to.
 * @param resolver Turns a challenge into a resolution; required only once a challenge appears.
 * @param options Optional source label + lifecycle observer; omit for the silent, unobserved path.
 */
export async function resolveAuthChallenges(
    initial: AuthResult,
    resolver?: ChallengeResolver,
    options?: ResolveAuthChallengesOptions,
): Promise<AuthHandle> {
    const source = options?.source ?? '';
    const emit = (event: ChallengeLifecycleEvent): void => options?.observer?.(event);
    let result = initial;
    let rounds = 0;
    while (isAuthChallengeRequired(result)) {
        const { type } = result.challenge;
        emit({ phase: 'emitted', source, type });
        if (resolver === undefined) {
            emit({ phase: 'degraded', source, reason: 'no-resolver', type });
            throw new UnresolvedChallengeError('no-resolver', type);
        }
        if (rounds >= MAX_AUTH_CHALLENGE_ROUNDS) {
            // `exhausted` names no type — mirrors UnresolvedChallengeError('exhausted'), which omits it.
            emit({ phase: 'degraded', source, reason: 'exhausted' });
            throw new UnresolvedChallengeError('exhausted');
        }
        rounds++;
        const resolution = await resolver.resolve(result.challenge);
        emit({ phase: 'resolved', source, type, mode: resolutionMode(type) });
        result = await result.resume(resolution);
    }
    return result;
}
