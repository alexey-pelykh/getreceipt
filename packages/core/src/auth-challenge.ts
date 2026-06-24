// SPDX-License-Identifier: AGPL-3.0-only
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
 * surfaces a structured `failed` result; it never escapes the pipeline boundary.
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

/**
 * Drive an {@link AuthResult} to an established {@link AuthHandle}, resolving any
 * {@link AuthChallengeRequired} through the injected `resolver` and resuming — the orchestrator
 * half of the interactive-login-challenge seam (#133). A bare {@link AuthHandle} (the common,
 * backward-compatible case) is returned untouched, so a non-challenge adapter needs no `resolver`
 * at all. A challenge with no `resolver`, or a source that chains past
 * {@link MAX_AUTH_CHALLENGE_ROUNDS}, raises {@link UnresolvedChallengeError}.
 *
 * @param initial The value `authenticate()` resolved to.
 * @param resolver Turns a challenge into a resolution; required only once a challenge appears.
 */
export async function resolveAuthChallenges(initial: AuthResult, resolver?: ChallengeResolver): Promise<AuthHandle> {
    let result = initial;
    let rounds = 0;
    while (isAuthChallengeRequired(result)) {
        if (resolver === undefined) {
            throw new UnresolvedChallengeError('no-resolver', result.challenge.type);
        }
        if (rounds >= MAX_AUTH_CHALLENGE_ROUNDS) {
            throw new UnresolvedChallengeError('exhausted');
        }
        rounds++;
        const resolution = await resolver.resolve(result.challenge);
        result = await result.resume(resolution);
    }
    return result;
}
