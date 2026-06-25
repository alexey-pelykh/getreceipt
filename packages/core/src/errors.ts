// SPDX-License-Identifier: AGPL-3.0-only
import type { CredentialShape } from './source-adapter.js';

/** Thrown when a requested domain resolves to no registered source adapter. */
export class UnknownSourceError extends Error {
    override readonly name = 'UnknownSourceError';

    /** The normalized domain that failed to resolve. */
    constructor(readonly domain: string) {
        super(`No source adapter is registered for domain "${domain}".`);
    }
}

/** Thrown when two adapters claim the same canonical or alias domain. */
export class DuplicateSourceError extends Error {
    override readonly name = 'DuplicateSourceError';

    /** The normalized domain claimed more than once. */
    constructor(readonly domain: string) {
        super(`A source adapter is already registered for domain "${domain}".`);
    }
}

/**
 * The re-auth seam's typed signal: a source's stored session is terminally expired
 * and only fresh interactive credentials can recover it. An adapter throws this
 * from any stage; `collect()` catches it and surfaces a single structured
 * `reauth-required` result to the caller — it never prompts or blocks inline.
 */
export class ReauthRequiredError extends Error {
    override readonly name = 'ReauthRequiredError';

    /**
     * @param domain Canonical domain whose session expired.
     * @param reason Optional human-readable detail; carries no secret material.
     */
    constructor(
        readonly domain: string,
        readonly reason?: string,
    ) {
        super(
            reason === undefined
                ? `Re-authentication required for "${domain}".`
                : `Re-authentication required for "${domain}": ${reason}`,
        );
    }
}

/**
 * The fail-closed signal of the resolve-time credential-shape gate (#169): a source is configured with
 * a credential shape its adapter does not accept. Raised BEFORE `authenticate()` so a mis-shaped source
 * is rejected at setup with an actionable message — naming what was configured AND what the adapter
 * accepts — rather than failing opaquely deep inside the auth flow. Carries only the closed
 * {@link CredentialShape} vocabulary (never a credential value), so it is safe to surface verbatim.
 */
export class UnsupportedCredentialShapeError extends Error {
    override readonly name = 'UnsupportedCredentialShapeError';

    /**
     * @param domain Canonical domain of the misconfigured source.
     * @param configuredShapes The shape(s) the configured credential could be — more than one only for
     *   the genuinely-ambiguous lone-`secret:` (`password` or `api-token`); empty when the configured
     *   kind has no 0.1.0 shape (e.g. `passkey`, the #150 spike).
     * @param supportedShapes The shapes the adapter declares it accepts.
     */
    constructor(
        readonly domain: string,
        readonly configuredShapes: readonly CredentialShape[],
        readonly supportedShapes: readonly CredentialShape[],
    ) {
        super(
            `source "${domain}" is configured with ${describeConfigured(configuredShapes)}, ` +
                `but its adapter accepts ${describeSupported(supportedShapes)}`,
        );
    }
}

/** Human phrase for the configured side: the lone shape, the ambiguous pair, or the no-modeled-shape case. */
function describeConfigured(shapes: readonly CredentialShape[]): string {
    if (shapes.length === 0) {
        return 'an unsupported credential shape';
    }
    if (shapes.length === 1) {
        return `the "${shapes[0]}" credential shape`;
    }
    return `an ambiguous credential shape (${shapes.join(' or ')})`;
}

/** Human phrase for the accepted side: the declared set, or an explicit note when the adapter declared none. */
function describeSupported(shapes: readonly CredentialShape[]): string {
    if (shapes.length === 0) {
        return 'no credential shape';
    }
    return shapes.map((shape) => `"${shape}"`).join(', ');
}
