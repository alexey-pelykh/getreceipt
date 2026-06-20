// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Thrown when the config is structurally invalid. Carries the offending location
 * (`path`) and an actionable message — and deliberately NEVER the offending value,
 * so a configured secret can't leak into logs or stack traces via an error.
 */
export class ConfigError extends Error {
    override readonly name = 'ConfigError';

    constructor(
        message: string,
        /** Dotted path to the offending node, e.g. `profiles.default.sources.<domain>.auth.kind`. */
        readonly path: string,
    ) {
        super(`${path}: ${message}`);
    }
}

/** Thrown when no auth driver is registered for a source's declared auth kind. */
export class UnsupportedAuthKindError extends Error {
    override readonly name = 'UnsupportedAuthKindError';

    constructor(readonly kind: string) {
        super(`No auth driver is registered for auth kind "${kind}".`);
    }
}
