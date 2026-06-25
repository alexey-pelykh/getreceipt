// SPDX-License-Identifier: AGPL-3.0-only
import { UnresolvedChallengeError } from './auth-challenge.js';
import type { AuthChallenge, ChallengeResolution, ChallengeResolver, ChallengeType } from './challenge.js';

/**
 * Where a {@link ChallengeType} is resolved — the load-bearing axis behind the "one concept, one
 * port" unification. Each surface is a distinct resolver-CONSTRUCTION site, not a cosmetic grouping:
 *
 * - `in-process` — resolved unattended from user-held state, no human, no browser (a TOTP code
 *   computed locally from the stored seed).
 * - `out-of-band` — an external actor supplies the answer over a channel GetReceipt cannot read and
 *   must not try to: a human types the SMS/email code, or approves a push on their own device.
 *   Resolved by a CLI prompt or MCP elicitation — no browser.
 * - `browser-ceremony` — needs a real rendered, origin-bound browser: a human passes a CAPTCHA, or
 *   completes an interactive WebAuthn ceremony. The origin binding is the security property (a
 *   text prompt cannot carry it), which is why this is its own surface.
 *
 * The split is what lets a headless type never enter the browser path, and a browser-needing type
 * route to the headed-browser resolver — through the SAME {@link ChallengeResolver} port, never a
 * parallel per-challenge seam.
 */
export type ChallengeSurface = 'in-process' | 'out-of-band' | 'browser-ceremony';

/**
 * Classify a {@link ChallengeType} by the surface that resolves it. Total and exhaustive by
 * construction: a challenge type added to the union without a branch here fails to compile (the
 * `never` assignment), so a new type can never be silently misrouted onto the wrong surface.
 *
 * `webauthn` classifies as `browser-ceremony` — an interactive, human-passed ceremony in a headed
 * browser. This is deliberately distinct from a self-signed `passkey-self` assertion (a future,
 * headless auth-driver path): that is not a {@link ChallengeType} at all, so the abstraction
 * accommodates the `webauthn` challenge with zero dependency on the self-passkey work.
 */
export function challengeSurface(type: ChallengeType): ChallengeSurface {
    switch (type) {
        case 'otp-totp':
            return 'in-process';
        case 'otp-sms':
        case 'otp-email':
        case 'push':
            return 'out-of-band';
        case 'captcha':
        case 'webauthn':
            return 'browser-ceremony';
    }
    // `type` narrows to `never` only while every ChallengeType is handled above; adding a type
    // without a branch makes this a compile error rather than a silent runtime fall-through.
    const unhandled: never = type;
    throw new Error(`unhandled challenge type: ${String(unhandled)}`);
}

/**
 * A {@link ChallengeResolver} that routes each challenge to the sub-resolver for its
 * {@link ChallengeSurface} — the realization of "one concept, one port". Every challenge type
 * (TOTP, out-of-band OTP/push, CAPTCHA, interactive WebAuthn) is resolved through this ONE port,
 * never a parallel per-type seam: the composition root assembles one of these from whatever
 * per-surface resolvers it has wired and injects it as the single {@link ChallengeResolver} the
 * pipeline (`collect()`) and the `login` ceremony already accept — no contract change.
 *
 * A surface with no sub-resolver wired (e.g. `browser-ceremony` while `@getreceipt/browser` is not
 * installed, or before it is built at all) is NOT a hang and NOT a silent pass: `resolve` rejects
 * with {@link UnresolvedChallengeError}, which `collect()` already maps to a `reauth-required`
 * result pointing at the `login` ceremony (#134). The router NEVER solves a challenge itself — it
 * only dispatches — so the no-defeat / no-bypass posture lives entirely in the injected
 * sub-resolvers, and the resolution passes back through untouched (never logged, persisted, or
 * mutated: the `response` is credential material only the auth flow consuming it should see).
 *
 * The browser-backed cases route here rather than to a separate `CeremonyDriver` interface on
 * purpose: a CAPTCHA token and a serialized WebAuthn assertion are both just a
 * {@link ChallengeResolution} `response`, so the browser ceremony is one more {@link ChallengeResolver}
 * implementation, not a second port (ADR-004 §5's "CeremonyDriver" collapses into this one port).
 */
export class RoutingChallengeResolver implements ChallengeResolver {
    readonly #bySurface: Partial<Record<ChallengeSurface, ChallengeResolver>>;

    constructor(bySurface: Partial<Record<ChallengeSurface, ChallengeResolver>>) {
        this.#bySurface = bySurface;
    }

    resolve(challenge: AuthChallenge): Promise<ChallengeResolution> {
        const resolver = this.#bySurface[challengeSurface(challenge.type)];
        if (resolver === undefined) {
            return Promise.reject(new UnresolvedChallengeError('no-resolver', challenge.type));
        }
        // Pure pass-through: the sub-resolver's own promise (and the resolution it yields) is
        // returned unchanged, so nothing here observes or rewrites the credential-bearing response.
        return resolver.resolve(challenge);
    }
}
