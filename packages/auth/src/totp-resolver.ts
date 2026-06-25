// SPDX-License-Identifier: AGPL-3.0-only
import { RoutingChallengeResolver } from '@getreceipt/core';
import type { AuthChallenge, ChallengeResolution, ChallengeResolver } from '@getreceipt/core';

import type { CredentialValue, MfaConfig } from './config.js';
import { TotpError } from './errors.js';
import type { Secret } from './secret.js';
import { decodeBase32, generateTotp } from './totp.js';
import type { TotpParams } from './totp.js';

/**
 * The `in-process` {@link ChallengeResolver} (#135's headless surface): it answers an `otp-totp`
 * challenge by computing the code locally from the configured seed — fully unattended, no human, no
 * prompt (#137). The seed is resolved through the SAME secret path as any other credential, but
 * LAZILY: {@link TotpChallengeResolverOptions.resolveSeed} runs only when a challenge actually fires,
 * so a source that never reaches its TOTP step pays no `op read`.
 *
 * Neither the seed nor the derived code is ever logged or persisted: the seed lives only as long as
 * one `resolve` call, and the code leaves solely as the {@link ChallengeResolution.response} the auth
 * flow submits.
 */
export interface TotpChallengeResolverOptions {
    /** Resolves the TOTP shared secret, on demand. Invoked only when an `otp-totp` challenge fires. */
    readonly resolveSeed: () => Promise<Secret>;
    /** Clock used to pick the time step; defaults to real time. Injectable for deterministic tests. */
    readonly now?: () => Date;
    /** When the source offers "remember this device" ({@link AuthChallenge.trustOption}), opt in. */
    readonly trustDevice?: boolean;
    /** RFC 6238 parameters; defaults to 30s / 6 digits / T0=0. */
    readonly params?: TotpParams;
}

export class TotpChallengeResolver implements ChallengeResolver {
    readonly #resolveSeed: () => Promise<Secret>;
    readonly #now: () => Date;
    readonly #trustDevice: boolean;
    readonly #params: TotpParams;

    constructor(options: TotpChallengeResolverOptions) {
        this.#resolveSeed = options.resolveSeed;
        this.#now = options.now ?? (() => new Date());
        this.#trustDevice = options.trustDevice ?? false;
        this.#params = options.params ?? {};
    }

    async resolve(challenge: AuthChallenge): Promise<ChallengeResolution> {
        // Defensive: this resolver IS the `in-process` surface, whose only member is `otp-totp`. The
        // router never sends another type here, but guard so a future in-process type can't be
        // silently mis-answered with a TOTP code.
        if (challenge.type !== 'otp-totp') {
            throw new TotpError(
                `the TOTP resolver cannot answer a "${challenge.type}" challenge`,
                'unsupported-challenge',
            );
        }
        const seed = await this.#resolveSeed();
        const key = decodeBase32(seed.expose());
        const response = generateTotp(key, this.#now().getTime(), this.#params);
        // Opt into "remember this device" only when the source offered it AND config asked for it.
        return this.#trustDevice && challenge.trustOption === true ? { response, trustThisDevice: true } : { response };
    }
}

/** Collaborators {@link createMfaChallengeResolver} needs to build (and later run) the resolver. */
export interface MfaChallengeResolverDeps {
    /** Resolves a configured credential reference (here, the seed) to its fenced {@link Secret}. */
    readonly resolveCredential: (value: CredentialValue) => Promise<Secret>;
    /** Clock for the TOTP step; defaults to real time. */
    readonly now?: () => Date;
}

/**
 * Build the {@link ChallengeResolver} for a source's `mfa` config, or `undefined` when none applies.
 * Only `totp` is resolvable in-process today, so it is the only type wired: the result is a
 * {@link RoutingChallengeResolver} with the `in-process` surface bound to a {@link TotpChallengeResolver}
 * — the SAME one port the pipeline (`collect()`) and the `login` ceremony already accept.
 *
 * `sms` / `email` / `push` deliver their code out-of-band and need a (not-yet-built) out-of-band
 * resolver; returning `undefined` for them (and for a source with no `mfa`) means an issued challenge
 * surfaces as the structured `reauth-required` (#134) rather than a wrong or empty answer.
 */
export function createMfaChallengeResolver(
    mfa: MfaConfig | undefined,
    deps: MfaChallengeResolverDeps,
): ChallengeResolver | undefined {
    // `seed` is guaranteed for `totp` by config validation (#130); the guard is defensive.
    if (mfa === undefined || mfa.type !== 'totp' || mfa.seed === undefined) {
        return undefined;
    }
    const seed = mfa.seed;
    const totp = new TotpChallengeResolver({
        resolveSeed: () => deps.resolveCredential(seed),
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(mfa.trustDevice === undefined ? {} : { trustDevice: mfa.trustDevice }),
    });
    return new RoutingChallengeResolver({ 'in-process': totp });
}
