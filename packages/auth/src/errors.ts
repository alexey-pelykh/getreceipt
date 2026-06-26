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
        /** Dotted path to the offending node, e.g. `sources.<domain>.auth.kind` (per-file model — no `profiles.` prefix). */
        readonly path: string,
    ) {
        super(`${path}: ${message}`);
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

/**
 * Why a {@link SessionStoreError} happened. Lets a caller branch on the cause
 * without parsing the message:
 *  - `no-passphrase` — the encrypted-file fallback has no passphrase configured to seal/open sessions;
 *  - `decryption-failed` — a session envelope's passphrase is wrong or the file is corrupt;
 *  - `malformed` — the stored bytes are not a recognizable session envelope / session;
 *  - `no-backend` — neither a keyring nor a fallback directory was provided to {@link createSessionStore}.
 */
export type SessionStoreFailureReason = 'no-passphrase' | 'decryption-failed' | 'malformed' | 'no-backend';

/**
 * Thrown when a session cannot be persisted, loaded, or unlocked. Like every error
 * in this subsystem, it deliberately NEVER carries the session token or any other
 * credential material — only the offending key, a human-readable message, and a
 * machine-readable {@link reason}.
 */
export class SessionStoreError extends Error {
    override readonly name = 'SessionStoreError';

    constructor(
        message: string,
        /** The machine-readable cause; see {@link SessionStoreFailureReason}. */
        readonly reason: SessionStoreFailureReason,
    ) {
        super(message);
    }
}

/**
 * Why an {@link AuthenticationError} happened. Lets a caller branch on the cause
 * without parsing the message:
 *  - `invalid-credentials` — the source replied but rejected the email/password (HTTP 401/403);
 *  - `unexpected-response` — the source replied, but not in a way we can turn into a
 *    session (an unexpected status, or a success body carrying no token);
 *  - `transport-error` — the request never produced a response (network, DNS, or TLS failure).
 */
export type AuthenticationFailureReason = 'invalid-credentials' | 'unexpected-response' | 'transport-error';

/**
 * Thrown when an auth driver cannot establish a session. Like every error in this
 * subsystem, it deliberately NEVER carries credential material — not the password,
 * not the session token, not the response body (which can echo either) — only the
 * endpoint, the HTTP status (in the message, when there was one), and a
 * machine-readable {@link reason}.
 */
export class AuthenticationError extends Error {
    override readonly name = 'AuthenticationError';

    constructor(
        message: string,
        /** The machine-readable cause; see {@link AuthenticationFailureReason}. */
        readonly reason: AuthenticationFailureReason,
    ) {
        super(message);
    }
}

/**
 * Why a {@link TotpError} happened:
 *  - `invalid-seed` — the configured TOTP seed is empty or not valid Base32;
 *  - `unsupported-challenge` — the in-process TOTP resolver was handed a non-`otp-totp` challenge.
 */
export type TotpFailureReason = 'invalid-seed' | 'unsupported-challenge';

/**
 * Thrown while computing or resolving a TOTP code. Like every error in this subsystem, it
 * deliberately NEVER carries the seed or the derived code — only a human-readable message and a
 * machine-readable {@link reason}.
 */
export class TotpError extends Error {
    override readonly name = 'TotpError';

    constructor(
        message: string,
        /** The machine-readable cause; see {@link TotpFailureReason}. */
        readonly reason: TotpFailureReason,
    ) {
        super(message);
    }
}
