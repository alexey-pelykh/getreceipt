// SPDX-License-Identifier: AGPL-3.0-only
import { RoutingChallengeResolver } from '@getreceipt/core';
import type { AuthChallenge, ChallengeResolution, ChallengeResolver, ChallengeSurface } from '@getreceipt/core';

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
 * The per-{@link ChallengeSurface} resolvers a source's `mfa` config yields ON ITS OWN — today only
 * the unattended `in-process` surface (a {@link TotpChallengeResolver} computed from the seed). The
 * `out-of-band` and `browser-ceremony` surfaces deliver their code/approval through a human or a
 * browser, so they are NOT config-derivable here: the composition root injects them (the `login`
 * ceremony adds an interactive prompt for `out-of-band`, #138).
 *
 * Returns a fresh, possibly-empty map by design — a composition root spreads it and ADDS its own
 * surfaces before wrapping the whole in one {@link RoutingChallengeResolver} (the documented "one
 * port, assembled from per-surface resolvers" pattern). {@link createMfaChallengeResolver} is the
 * unattended convenience over it, used by the collect path.
 */
export function mfaSurfaceResolvers(
    mfa: MfaConfig | undefined,
    deps: MfaChallengeResolverDeps,
): Partial<Record<ChallengeSurface, ChallengeResolver>> {
    // `seed` is guaranteed for `totp` by config validation (#130); the guard is defensive.
    if (mfa === undefined || mfa.type !== 'totp' || mfa.seed === undefined) {
        return {};
    }
    const seed = mfa.seed;
    const totp = new TotpChallengeResolver({
        resolveSeed: () => deps.resolveCredential(seed),
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(mfa.trustDevice === undefined ? {} : { trustDevice: mfa.trustDevice }),
    });
    return { 'in-process': totp };
}

/**
 * Build the unattended {@link ChallengeResolver} for a source's `mfa` config, or `undefined` when the
 * config yields no surface (no `mfa`, or an `sms`/`email`/`push` type that delivers its code
 * out-of-band). `undefined` is load-bearing on the collect path: an issued challenge with no resolver
 * surfaces as the structured `reauth-required` (#134) rather than a wrong or empty answer — and an
 * out-of-band challenge never opens an inline prompt during an unattended run. The `login` ceremony
 * does NOT use this — it assembles its own {@link RoutingChallengeResolver} from
 * {@link mfaSurfaceResolvers} plus an interactive `out-of-band` resolver (#138).
 */
export function createMfaChallengeResolver(
    mfa: MfaConfig | undefined,
    deps: MfaChallengeResolverDeps,
): ChallengeResolver | undefined {
    const surfaces = mfaSurfaceResolvers(mfa, deps);
    return Object.keys(surfaces).length === 0 ? undefined : new RoutingChallengeResolver(surfaces);
}
