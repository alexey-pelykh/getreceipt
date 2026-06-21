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

/**
 * Why a {@link CredentialResolutionError} happened. Lets a caller branch on the
 * cause without parsing the message:
 *  - `not-authenticated` — the backend is reachable but the caller is not signed in;
 *  - `not-found` — the reference resolves to nothing (no such item / file);
 *  - `decryption-failed` — the encrypted-file passphrase is wrong or the file is corrupt;
 *  - `unsupported-scheme` — the reference uses a scheme this resolver does not handle.
 */
export type CredentialResolutionReason = 'not-authenticated' | 'not-found' | 'decryption-failed' | 'unsupported-scheme';

/**
 * Thrown when the backend a credential reference needs is itself unavailable —
 * the 1Password CLI (`op`) is not installed, or no passphrase is configured to
 * unlock an encrypted-file credential. Distinct from {@link CredentialResolutionError}
 * (backend present, reference unresolved). Like every error here, it deliberately
 * NEVER carries the resolved secret value.
 */
export class CredentialBackendUnavailableError extends Error {
    override readonly name = 'CredentialBackendUnavailableError';

    constructor(
        message: string,
        /** Which backend is unavailable. */
        readonly backend: 'op' | 'encrypted-file',
    ) {
        super(message);
    }
}

/**
 * Thrown when a credential reference cannot be resolved even though its backend
 * is available — not signed in, item not found, wrong passphrase, or an
 * unsupported scheme. {@link reason} discriminates the cause. NEVER carries the
 * resolved secret value.
 */
export class CredentialResolutionError extends Error {
    override readonly name = 'CredentialResolutionError';

    constructor(
        message: string,
        /** The machine-readable cause; see {@link CredentialResolutionReason}. */
        readonly reason: CredentialResolutionReason,
    ) {
        super(message);
    }
}
