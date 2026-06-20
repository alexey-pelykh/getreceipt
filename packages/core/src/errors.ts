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
