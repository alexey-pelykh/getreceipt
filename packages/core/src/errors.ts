// SPDX-License-Identifier: AGPL-3.0-only

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
