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
 * The unified machine-readable taxonomy for the browser-cookie-store auth path — every cause either
 * {@link ProfileResolutionError} (locating the profile directory, #176), {@link CookieReadError}
 * (reading and decrypting the store, #177), or {@link PastedSessionError} (parsing a manually-pasted
 * session, #188) can fail with. A caller branches on the value without parsing prose; `unsupported-browser`
 * and `invalid-domain`, shared across halves, each collapse to one member. (#178.)
 */
export type BrowserCookieStoreReason = ProfileResolutionReason | CookieReadReason | PastedSessionReason;

/**
 * Stable, actionable, per-reason recovery guidance for the browser-cookie-store path: what the USER can DO
 * about a failure, distinct from the per-incident {@link Error.message} (what happened). The strings are
 * STATIC with no interpolation — so, like every error here, this surface can never echo a cookie value,
 * decryption key, Keychain password, profile path, or account email. The `satisfies` makes coverage
 * exhaustive at compile time: add a reason to either union without a line here and this file stops
 * compiling. Module-private — reached only through {@link BrowserCookieStoreError.guidance}.
 */
const BROWSER_COOKIE_STORE_GUIDANCE = {
    'unsupported-browser':
        'Set `browser` to a supported browser — Chrome, Brave, Edge, or Chromium (read via the OS "Safe Storage" scheme), or Firefox (read via its own plaintext cookie store).',
    'user-data-dir-unset':
        'The browser user-data location could not be determined; on Windows ensure %LOCALAPPDATA% (Chromium) or %APPDATA% (Firefox) is set, or pin the directory explicitly.',
    'local-state-unreadable':
        'The browser profile cache could not be read; open the browser once to create it, and confirm the configured browser is the one installed.',
    'local-state-malformed':
        'The browser profile cache is corrupt or unrecognized; reopen the browser to rebuild it, or name the profile by its directory instead of an account.',
    'profiles-ini-unreadable':
        'The Firefox profiles.ini could not be read; open Firefox once to create your profile, and confirm Firefox is installed.',
    'profiles-ini-malformed':
        'The Firefox profiles.ini is corrupt or lists no usable profile; reopen Firefox to rebuild it, or name the profile by its directory.',
    'account-not-found':
        'No browser profile is signed into the configured account; sign into that account in the browser, or set the profile to its directory name.',
    'profile-not-found':
        'The configured browser profile does not exist; pick an existing profile, or sign in to create it.',
    'invalid-profile-value':
        'Set the profile to a non-empty, single-segment directory name or an account — it must not contain path separators.',
    'unsupported-platform':
        'Reading a Chromium-family cookie store is supported on macOS and Linux; on another platform, use a different auth method.',
    'invalid-domain':
        'No target domain was set for the cookie read; configure the site domain the source authenticates against.',
    'keychain-unavailable':
        'Approve the macOS prompt for the browser Safe Storage key, and confirm the browser is installed; denying it blocks cookie decryption.',
    'cookie-store-unreadable':
        'The browser cookie store could not be opened; visit the site in that profile at least once, and confirm the browser is installed.',
    'app-bound-encryption':
        "This browser's cookies are sealed with OS-level encryption (App-Bound Encryption, or Windows DPAPI) this tool will not bypass; supply the session another way — paste a session exported from that browser (a `Cookie:` request header or a cookies.txt export) — or use a browser profile whose cookies use the standard scheme.",
    'decryption-failed':
        'The cookie value could not be decrypted (wrong key or a corrupt store); confirm the configured browser matches the profile, then retry.',
    'empty-paste':
        'Paste a non-empty session — a `Cookie:` request header copied from your browser developer tools, or a cookies.txt export for the target site.',
    'malformed-paste':
        'The pasted text was not recognized as a `Cookie:` request header (`name=value; …`) or a Netscape cookies.txt export; copy the Cookie header from your browser network inspector and paste it whole.',
    'no-cookies-in-scope':
        'None of the pasted cookies are for the target site; paste the session for the correct domain (the cookies must belong to that site or its subdomains).',
} satisfies Record<BrowserCookieStoreReason, string>;

/**
 * Shared supertype for the two halves of the browser-cookie-store auth path — {@link ProfileResolutionError}
 * (locating the profile directory, #176) and {@link CookieReadError} (reading and decrypting the store, #177).
 * A consumer (CLI / MCP) catches both in one `instanceof BrowserCookieStoreError` branch and reads the
 * machine-readable {@link reason}, the human-readable {@link Error.message} (what happened), and the actionable
 * {@link guidance} (what to do). Like every error in this subsystem, it deliberately NEVER carries a secret or
 * configured value. (Unifies the taxonomy #176/#177 deferred; #178.)
 */
export abstract class BrowserCookieStoreError extends Error {
    /** The machine-readable cause, from the unified {@link BrowserCookieStoreReason} set. */
    abstract readonly reason: BrowserCookieStoreReason;

    /** Stable, PII-free, actionable recovery guidance for {@link reason} — what the user can do about it. */
    get guidance(): string {
        return BROWSER_COOKIE_STORE_GUIDANCE[this.reason];
    }
}

/**
 * Why a {@link ProfileResolutionError} happened. Lets a caller branch on the cause without parsing
 * the message:
 *  - `unsupported-browser` — the Chromium resolver was handed a browser with no `Local State` cache (Firefox, which is resolved by `resolveFirefoxProfile` instead);
 *  - `user-data-dir-unset` — the platform location of the profile root can't be determined (e.g. Windows `%LOCALAPPDATA%` (Chromium) or `%APPDATA%` (Firefox) is unset);
 *  - `local-state-unreadable` — the Chromium `Local State` file is missing or could not be read;
 *  - `local-state-malformed` — the Chromium `Local State` file is not valid JSON or lacks `profile.info_cache`;
 *  - `profiles-ini-unreadable` — the Firefox `profiles.ini` file is missing or could not be read;
 *  - `profiles-ini-malformed` — the Firefox `profiles.ini` could not be parsed or names no usable profile;
 *  - `account-not-found` — an `@` value matched no `info_cache` entry (by `user_name`/`name`);
 *  - `profile-not-found` — a directory-name value (or an account's / Firefox install's resolved directory) does not exist on disk;
 *  - `invalid-profile-value` — the value is empty or names something other than a single path segment.
 */
export type ProfileResolutionReason =
    | 'unsupported-browser'
    | 'user-data-dir-unset'
    | 'local-state-unreadable'
    | 'local-state-malformed'
    | 'profiles-ini-unreadable'
    | 'profiles-ini-malformed'
    | 'account-not-found'
    | 'profile-not-found'
    | 'invalid-profile-value';

/**
 * Thrown when a configured browser `profile` value cannot be resolved to a concrete profile directory.
 * Like every error in this subsystem, it deliberately NEVER carries the configured value (a profile
 * name or an account email) — only the {@link browser}, a human-readable message, and a machine-readable
 * {@link reason}. Extends {@link BrowserCookieStoreError}, the unified browser-cookie-store taxonomy (#178).
 */
export class ProfileResolutionError extends BrowserCookieStoreError {
    override readonly name = 'ProfileResolutionError';

    constructor(
        message: string,
        /** The machine-readable cause; see {@link ProfileResolutionReason}. */
        readonly reason: ProfileResolutionReason,
        /** Which browser's profile cache was being resolved (a {@link BrowserKind} value). */
        readonly browser: string,
    ) {
        super(message);
    }
}

/**
 * Why a {@link CookieReadError} happened. Lets a caller branch on the cause without parsing the message:
 *  - `unsupported-browser` — `readChromeCookies` was handed Firefox, which does not use the Chromium "Safe Storage" scheme (read it with `readFirefoxCookies`);
 *  - `unsupported-platform` — Chromium cookie reading was attempted on a platform with no supported key source (supported: macOS Keychain, Linux libsecret/peanuts) without an injected key;
 *  - `invalid-domain` — the target domain to scope the read to is empty;
 *  - `keychain-unavailable` — the macOS Keychain "Safe Storage" key could not be read (access denied / browser absent);
 *  - `cookie-store-unreadable` — the `Cookies` SQLite store is missing, locked, or not a readable database;
 *  - `app-bound-encryption` — a value's scheme is one this reader will not circumvent — a non-`v10`/`v11` tag (e.g. App-Bound `v20`), or any Chromium value on Windows (DPAPI / App-Bound, refused at key resolution);
 *  - `decryption-failed` — a tagged value did not decrypt under the derived key (wrong key or corrupt value).
 */
export type CookieReadReason =
    | 'unsupported-browser'
    | 'unsupported-platform'
    | 'invalid-domain'
    | 'keychain-unavailable'
    | 'cookie-store-unreadable'
    | 'app-bound-encryption'
    | 'decryption-failed';

/**
 * Thrown when a browser cookie store cannot be read or a cookie value cannot be decrypted. Like every error in this
 * subsystem, it deliberately NEVER carries a cookie value, the decryption key, or the Keychain password — only a
 * human-readable message and a machine-readable {@link reason}. Extends {@link BrowserCookieStoreError}, the unified
 * browser-cookie-store taxonomy (#178).
 */
export class CookieReadError extends BrowserCookieStoreError {
    override readonly name = 'CookieReadError';

    constructor(
        message: string,
        /** The machine-readable cause; see {@link CookieReadReason}. */
        readonly reason: CookieReadReason,
    ) {
        super(message);
    }
}

/**
 * Why a {@link PastedSessionError} happened — parsing a manually-pasted session (#188), the fallback when the
 * browser cookie store can't be read (e.g. Windows App-Bound Encryption). Lets a caller branch without parsing
 * the message:
 *  - `empty-paste` — the pasted text was empty or whitespace-only;
 *  - `malformed-paste` — the text was not a recognizable `Cookie:` request header or Netscape cookies.txt export;
 *  - `no-cookies-in-scope` — the paste parsed, but no cookie belongs to the target domain (all out-of-scope);
 *  - `invalid-domain` — the target domain to scope the paste to is empty (shared with {@link CookieReadReason}).
 */
export type PastedSessionReason = 'empty-paste' | 'malformed-paste' | 'no-cookies-in-scope' | 'invalid-domain';

/**
 * Thrown when a manually-pasted session cannot be parsed into a domain-scoped cookie set (#188). Like every
 * error in this subsystem, it deliberately NEVER carries a cookie value or any of the pasted material — only a
 * human-readable message and a machine-readable {@link reason}. Extends {@link BrowserCookieStoreError}, the
 * unified browser-cookie-store taxonomy (#178), so a consumer catches the paste fallback in the same branch as
 * the browser-store path.
 */
export class PastedSessionError extends BrowserCookieStoreError {
    override readonly name = 'PastedSessionError';

    constructor(
        message: string,
        /** The machine-readable cause; see {@link PastedSessionReason}. */
        readonly reason: PastedSessionReason,
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
