// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { BrowserKind } from './config.js';
import { CookieReadError } from './errors.js';
import { Secret } from './secret.js';

// `node:sqlite` is a Node 24+ builtin reachable ONLY under the `node:` specifier — there is no bare `sqlite`
// alias. The @getreceipt umbrella bundles this package with esbuild, which strips the `node:` prefix from
// recognized builtins (harmless for `node:fs` → `fs`, but `node:sqlite` → `sqlite` is unresolvable). Loading
// it through a non-literal specifier keeps the bundler from reclassifying/rewriting it; Node resolves
// `node:sqlite` natively, and `createRequire` is synchronous so the reader stays sync. (The `import type`
// above is erased, so it adds no runtime import for esbuild to touch.)
const SQLITE_SPECIFIER = 'node:sqlite';
const sqlite = createRequire(import.meta.url)(SQLITE_SPECIFIER) as typeof import('node:sqlite');

/** The Chromium-family browsers — those whose cookie store uses the "<Browser> Safe Storage" key scheme. Firefox is excluded. */
type ChromiumBrowser = Exclude<BrowserKind, 'firefox'>;

/** Per-browser Keychain identity of the macOS Safe Storage password — the `security` `-s` service and `-a` account names. */
const SAFE_STORAGE_KEYCHAIN: Record<ChromiumBrowser, { readonly service: string; readonly account: string }> = {
    chrome: { service: 'Chrome Safe Storage', account: 'Chrome' },
    brave: { service: 'Brave Safe Storage', account: 'Brave' },
    edge: { service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' },
    chromium: { service: 'Chromium Safe Storage', account: 'Chromium' },
};

/**
 * Per-browser libsecret `application` attribute under which the Linux Safe Storage password is stored in the
 * Secret Service (gnome-keyring / kwallet, both fronted by libsecret). Best-effort — the `chrome`/`chromium`
 * values are well-known; `brave`/`edge` are derived by convention. A miss degrades safely (no v11 scheme →
 * the value is reported as App-Bound rather than mis-decrypted), and the keyring read is an injectable seam.
 */
const SAFE_STORAGE_LIBSECRET: Record<ChromiumBrowser, string> = {
    chrome: 'chrome',
    brave: 'brave',
    edge: 'microsoft-edge',
    chromium: 'chromium',
};

// The Safe Storage key-derivation parameters are fixed Chromium constants (os_crypt): a stretch of the
// platform password with these exact PBKDF2 inputs yields the 16-byte AES-128 key. Salt, key length, and
// digest are shared across platforms; only the iteration count differs (macOS 1003 vs Linux 1).
const SAFE_STORAGE_SALT = 'saltysalt';
const SAFE_STORAGE_KEY_LENGTH = 16;
const SAFE_STORAGE_DIGEST = 'sha1';
/** macOS PBKDF2 iterations (os_crypt/keychain_password_mac.mm). */
const MACOS_KEY_ITERATIONS = 1003;
/** Linux PBKDF2 iterations (os_crypt/os_crypt_linux.cc) — a single round, unlike macOS. */
const LINUX_KEY_ITERATIONS = 1;
/** The hardcoded password Chromium uses on Linux for the `v10` (no-keyring / basic-text store) scheme. */
const LINUX_NO_KEYRING_PASSWORD = 'peanuts';
/** Chromium encrypts cookie values with a fixed all-spaces IV (it carries no per-value IV). */
const COOKIE_AES_IV = Buffer.alloc(16, ' ');
/**
 * The version tag Chromium prepends to a cookie value. `v10` is the macOS Keychain scheme AND the Linux
 * no-keyring ("peanuts") scheme; `v11` is the Linux keyring-backed scheme. A value carrying any other tag
 * (e.g. Windows App-Bound `v20`) uses a scheme this reader does not decrypt.
 */
const V10_PREFIX = Buffer.from('v10', 'ascii');
const V11_PREFIX = Buffer.from('v11', 'ascii');
/** M118+ prepends SHA-256(host_key) to the plaintext to bind a value to its domain; strip it when present. */
const DOMAIN_HASH_LENGTH = 32;
/** Microseconds between the Chromium (1601-01-01) and Unix (1970-01-01) epochs — to turn `expires_utc` into Unix seconds. */
const CHROME_EPOCH_OFFSET_MICROS = 11_644_473_600_000_000n;
/** Firefox `cookies.sqlite`'s default filename under a profile directory. */
const FIREFOX_COOKIES_FILE = 'cookies.sqlite';

/** A single cookie read from a browser profile, domain-scoped. The value is {@link Secret}-fenced so it cannot leak via logs/serialization. */
export interface BrowserCookie {
    readonly name: string;
    /** The decrypted (or, for Firefox, plaintext) value, fenced — reachable only via {@link Secret.expose}. */
    readonly value: Secret;
    /** The cookie's host key exactly as stored (a leading `.` denotes a domain cookie). */
    readonly domain: string;
    readonly path: string;
    /** Whether the cookie is `Secure` (HTTPS only). */
    readonly secure: boolean;
    /** Whether the cookie is `HttpOnly`. */
    readonly httpOnly: boolean;
    /** Expiry as Unix seconds, or `null` for a session cookie. */
    readonly expires: number | null;
}

/**
 * A version-tagged decryption scheme: a value whose tag matches {@link prefix} decrypts under {@link key}.
 * A platform resolves a SET of these (macOS: one `v10`; Linux: `v10` plus, when a keyring is reachable,
 * `v11`); the matching key is selected per value by its tag.
 */
interface CookieScheme {
    readonly prefix: Buffer;
    readonly key: Buffer;
}

/**
 * Inputs for {@link readChromeCookies}. The defaults read the platform's real key source (macOS Keychain,
 * Linux libsecret) and derive the key; every seam is injectable so the decrypt + domain-filter logic is
 * unit-testable with a fixture DB, a synthetic key, and no Keychain/keyring.
 */
export interface ReadChromeCookiesOptions {
    /** Pin the `Cookies` SQLite path directly. Defaults to `<profileDir>/Network/Cookies`, then `<profileDir>/Cookies`. */
    readonly cookiesPath?: string;
    /**
     * Platform; defaults to `process.platform`. `darwin` derives the key from the Keychain, `linux` from the
     * libsecret keyring (with the "peanuts" no-keyring fallback). `win32` fails closed — Windows seals
     * Chromium cookies with DPAPI / App-Bound Encryption, which this reader does not bypass. An injected
     * key/password decrypts on any platform (trusted in-process seam).
     */
    readonly platform?: NodeJS.Platform;
    /** Inject the AES-128 key directly, bypassing the key source and derivation entirely (decrypts a `v10` value). */
    readonly key?: Buffer;
    /** Inject the Safe Storage password, bypassing the Keychain but still running macOS-style derivation (a `v10` value). */
    readonly safeStoragePassword?: string;
    /** Inject the macOS Keychain reader; defaults to the `security` CLI (whose prompt is the user's consent gate). */
    readonly readSafeStoragePassword?: (browser: ChromiumBrowser) => string;
    /**
     * Inject the Linux keyring reader (libsecret / Secret Service). Returns the browser's stored Safe Storage
     * password for the `v11` scheme, or `undefined` when no keyring is reachable — then only `v10` ("peanuts")
     * values decrypt. Defaults to a best-effort `secret-tool` lookup; injected in tests so no real keyring is touched.
     */
    readonly readLinuxKeyringPassword?: (browser: ChromiumBrowser) => string | undefined;
    /** Directory for the lock-avoiding DB snapshot copy; defaults to `os.tmpdir()`. */
    readonly tmpDir?: string;
}

/** Inputs for {@link readFirefoxCookies}. Firefox stores cookie values in plaintext, so there is no key seam — only the store path. */
export interface ReadFirefoxCookiesOptions {
    /** Pin the `cookies.sqlite` path directly. Defaults to `<profileDir>/cookies.sqlite`. */
    readonly cookiesPath?: string;
    /** Directory for the lock-avoiding DB snapshot copy; defaults to `os.tmpdir()`. */
    readonly tmpDir?: string;
}

/**
 * Derive a Chromium Safe Storage AES-128 key from `password` using Chromium's fixed PBKDF2 parameters
 * (salt `saltysalt`, SHA-1, 16-byte key). `iterations` defaults to the macOS count (1003); Linux uses 1.
 */
export function deriveChromeSafeStorageKey(password: string, iterations: number = MACOS_KEY_ITERATIONS): Buffer {
    return pbkdf2Sync(password, SAFE_STORAGE_SALT, iterations, SAFE_STORAGE_KEY_LENGTH, SAFE_STORAGE_DIGEST);
}

/**
 * Decrypt one Chromium cookie `encrypted_value` (macOS `v10` scheme) with `key`. Strips the `v10` prefix, AES-128-CBC
 * decrypts (fixed all-spaces IV, PKCS#7 padding), and removes the 32-byte SHA-256(`hostKey`) domain prefix when present
 * (Chrome M118+). Throws {@link CookieReadError}: `app-bound-encryption` for any non-`v10` scheme (e.g. Windows App-Bound
 * `v20`) — which is NOT bypassed — and `decryption-failed` when the ciphertext does not decrypt under `key`. The
 * single-scheme `v10` primitive; {@link readChromeCookies} resolves the full per-platform scheme set internally.
 */
export function decryptChromeCookie(encryptedValue: Buffer, key: Buffer, hostKey: string): string {
    return decryptCookieValue(encryptedValue, [{ prefix: V10_PREFIX, key }], hostKey);
}

/**
 * Decrypt a Chromium cookie value against a per-platform set of version-tagged {@link CookieScheme}s: match the
 * value's leading tag to a scheme and AES-128-CBC decrypt under that scheme's key, stripping the M118+ domain
 * prefix when present. A value whose tag matches NO provided scheme uses an encryption scheme this reader does
 * not decrypt (e.g. App-Bound `v20`, or any tag on a platform with no schemes) → `app-bound-encryption`, never
 * circumvented. A matched-but-undecryptable value → `decryption-failed`. Reveals nothing on either failure.
 */
function decryptCookieValue(encryptedValue: Buffer, schemes: readonly CookieScheme[], hostKey: string): string {
    const scheme = schemes.find((candidate) =>
        encryptedValue.subarray(0, candidate.prefix.length).equals(candidate.prefix),
    );
    if (scheme === undefined) {
        throw new CookieReadError(
            'the cookie value uses an encryption scheme this reader does not decrypt and will not bypass (e.g. OS-level App-Bound Encryption); supply the credentials another way',
            'app-bound-encryption',
        );
    }
    let plaintext: Buffer;
    try {
        const decipher = createDecipheriv('aes-128-cbc', scheme.key, COOKIE_AES_IV);
        plaintext = Buffer.concat([decipher.update(encryptedValue.subarray(scheme.prefix.length)), decipher.final()]);
    } catch {
        // Wrong key or corrupt value: CBC final() throws on bad PKCS#7 padding. Fail closed; reveal nothing.
        throw new CookieReadError('the cookie value could not be decrypted', 'decryption-failed');
    }
    const domainHash = createHash('sha256').update(hostKey).digest();
    if (plaintext.length >= DOMAIN_HASH_LENGTH && plaintext.subarray(0, DOMAIN_HASH_LENGTH).equals(domainHash)) {
        plaintext = plaintext.subarray(DOMAIN_HASH_LENGTH);
    }
    return plaintext.toString('utf8');
}

/**
 * Read and decrypt the cookies a Chromium-family browser holds for `domain`, from the profile directory `profileDir`
 * (typically resolved by `resolveProfile`). Scoped to the target registrable `domain` and its subdomains — the rest of
 * the cookie jar is never decrypted or returned. Returned values are {@link Secret}-fenced.
 *
 * The AES key comes from the platform's own protected store, whose access is the user's consent gate: the
 * "<Browser> Safe Storage" macOS Keychain password (1003-iteration derivation), or the Linux libsecret keyring
 * password (single-iteration `v11`), with Chromium's well-known no-keyring "peanuts" fallback (`v10`). Windows seals
 * cookies with DPAPI / App-Bound Encryption and fails closed — this reader does not bypass OS-level cookie encryption.
 * The store is read-only (copied first to dodge Chromium's write lock). Throws {@link CookieReadError} — which never
 * carries a cookie value, the key, or a keyring secret — for an unsupported browser/platform, an unreadable store, an
 * un-decryptable value, or a non-decryptable (OS-protected) scheme.
 */
export function readChromeCookies(
    browser: BrowserKind,
    profileDir: string,
    domain: string,
    options: ReadChromeCookiesOptions = {},
): BrowserCookie[] {
    if (browser === 'firefox') {
        throw new CookieReadError(
            'Firefox cookie reading is not supported here — only Chromium-family browsers use the "Safe Storage" cookie scheme; use readFirefoxCookies',
            'unsupported-browser',
        );
    }
    if (domain === '') {
        throw new CookieReadError('the target domain is empty', 'invalid-domain');
    }
    const schemes = resolveSchemes(browser, options);
    const dbPath = resolveCookiesPath(profileDir, options);

    return withCookieSnapshot(dbPath, options.tmpDir, (db) => {
        // Pre-filter to the target domain in SQL so the store hands back only in-scope rows; `domainMatches` is the authority.
        const statement = db.prepare(
            "SELECT host_key, name, encrypted_value, value, path, is_secure, is_httponly, expires_utc FROM cookies WHERE host_key = ? OR host_key LIKE ? ESCAPE '\\'",
        );
        statement.setReadBigInts(true); // `expires_utc` (µs since 1601) overflows a JS number — read every integer as bigint.
        const rows = statement.all(domain, `%.${escapeLike(domain)}`);

        const cookies: BrowserCookie[] = [];
        for (const row of rows) {
            const hostKey = asString(row.host_key);
            if (!domainMatches(hostKey, domain)) {
                continue;
            }
            const encrypted = asBytes(row.encrypted_value);
            // A non-encrypted cookie (rare on modern Chromium) carries its plaintext in `value`; otherwise decrypt.
            const value =
                encrypted.length === 0 ? asString(row.value) : decryptCookieValue(encrypted, schemes, hostKey);
            cookies.push({
                name: asString(row.name),
                value: new Secret(value),
                domain: hostKey,
                path: asString(row.path),
                secure: asBigInt(row.is_secure) !== 0n,
                httpOnly: asBigInt(row.is_httponly) !== 0n,
                expires: chromeExpiryToUnixSeconds(asBigInt(row.expires_utc)),
            });
        }
        return cookies;
    });
}

/**
 * Read the cookies Firefox holds for `domain`, from the profile directory `profileDir`. Firefox stores cookie
 * values in PLAINTEXT in `cookies.sqlite` (`moz_cookies`) — there is no encryption to undo and no key/keyring
 * to read, so this path is cross-platform. Scoped to the target registrable `domain` and its subdomains (the
 * rest of the jar is never read); returned values are still {@link Secret}-fenced, and the store is read-only
 * (copied first to dodge Firefox's write lock). Throws {@link CookieReadError} — value-free — for an empty
 * domain or an unreadable store.
 */
export function readFirefoxCookies(
    profileDir: string,
    domain: string,
    options: ReadFirefoxCookiesOptions = {},
): BrowserCookie[] {
    if (domain === '') {
        throw new CookieReadError('the target domain is empty', 'invalid-domain');
    }
    const dbPath = options.cookiesPath ?? join(profileDir, FIREFOX_COOKIES_FILE);

    return withCookieSnapshot(dbPath, options.tmpDir, (db) => {
        const statement = db.prepare(
            "SELECT host, name, value, path, isSecure, isHttpOnly, expiry FROM moz_cookies WHERE host = ? OR host LIKE ? ESCAPE '\\'",
        );
        statement.setReadBigInts(true);
        const rows = statement.all(domain, `%.${escapeLike(domain)}`);

        const cookies: BrowserCookie[] = [];
        for (const row of rows) {
            const host = asString(row.host);
            if (!domainMatches(host, domain)) {
                continue;
            }
            cookies.push({
                name: asString(row.name),
                value: new Secret(asString(row.value)),
                domain: host,
                path: asString(row.path),
                secure: asBigInt(row.isSecure) !== 0n,
                httpOnly: asBigInt(row.isHttpOnly) !== 0n,
                expires: firefoxExpiryToUnixSeconds(asBigInt(row.expiry)),
            });
        }
        return cookies;
    });
}

/**
 * Resolve the per-platform set of decryption {@link CookieScheme}s. An injected key/password short-circuits to a
 * single `v10` scheme (a trusted in-process seam, cross-platform). Otherwise: macOS derives one `v10` key from the
 * Keychain Safe Storage password; Linux derives `v10` from the hardcoded "peanuts" password and, when a keyring is
 * reachable, also `v11` from the keyring password; Windows fails closed (DPAPI / App-Bound, not bypassed); any other
 * platform is unsupported.
 */
function resolveSchemes(browser: ChromiumBrowser, options: ReadChromeCookiesOptions): CookieScheme[] {
    if (options.key !== undefined) {
        return [{ prefix: V10_PREFIX, key: options.key }];
    }
    if (options.safeStoragePassword !== undefined) {
        return [{ prefix: V10_PREFIX, key: deriveChromeSafeStorageKey(options.safeStoragePassword) }];
    }
    const platform = options.platform ?? process.platform;
    if (platform === 'darwin') {
        return [{ prefix: V10_PREFIX, key: deriveChromeSafeStorageKey(readMacosKeychainPassword(browser, options)) }];
    }
    if (platform === 'linux') {
        return resolveLinuxSchemes(browser, options);
    }
    if (platform === 'win32') {
        throw new CookieReadError(
            'Windows seals Chromium cookies with OS-level encryption (DPAPI, and App-Bound Encryption on current Chrome) that this tool will not bypass; supply the credentials another way',
            'app-bound-encryption',
        );
    }
    throw new CookieReadError(
        'reading a Chromium cookie store is supported on macOS and Linux; on this platform, use a different auth method',
        'unsupported-platform',
    );
}

/** Read the macOS "<Browser> Safe Storage" Keychain password via the (default or injected) reader, failing closed on denial. */
function readMacosKeychainPassword(browser: ChromiumBrowser, options: ReadChromeCookiesOptions): string {
    const read = options.readSafeStoragePassword ?? readKeychainSafeStoragePassword;
    try {
        return read(browser);
    } catch (error) {
        // Any failure of the (default or injected) Keychain read — denied consent, browser absent — fails closed as a typed error.
        if (error instanceof CookieReadError) {
            throw error;
        }
        throw new CookieReadError(
            `could not read the "${SAFE_STORAGE_KEYCHAIN[browser].service}" key from the macOS Keychain (access denied, or the browser is not installed)`,
            'keychain-unavailable',
        );
    }
}

/**
 * Build the Linux scheme set: always the `v10` "peanuts" scheme (the no-keyring / basic-text store), plus the
 * `v11` keyring scheme when the libsecret reader yields a password. A keyring read that fails or returns nothing
 * degrades to `v10`-only — then a genuinely keyring-backed (`v11`) value is reported as App-Bound rather than
 * mis-decrypted (no key leak, no wrong plaintext).
 */
function resolveLinuxSchemes(browser: ChromiumBrowser, options: ReadChromeCookiesOptions): CookieScheme[] {
    const schemes: CookieScheme[] = [
        { prefix: V10_PREFIX, key: deriveChromeSafeStorageKey(LINUX_NO_KEYRING_PASSWORD, LINUX_KEY_ITERATIONS) },
    ];
    const readKeyring = options.readLinuxKeyringPassword ?? readLibsecretSafeStoragePassword;
    let keyringPassword: string | undefined;
    try {
        keyringPassword = readKeyring(browser);
    } catch {
        // No keyring reachable (libsecret absent, locked, no entry): fall back to the "peanuts" v10 scheme only.
        keyringPassword = undefined;
    }
    if (keyringPassword !== undefined && keyringPassword !== '') {
        schemes.push({ prefix: V11_PREFIX, key: deriveChromeSafeStorageKey(keyringPassword, LINUX_KEY_ITERATIONS) });
    }
    return schemes;
}

/** Read the "<Browser> Safe Storage" password from the macOS Keychain via the `security` CLI. The prompt is the consent gate. */
function readKeychainSafeStoragePassword(browser: ChromiumBrowser): string {
    const { service, account } = SAFE_STORAGE_KEYCHAIN[browser];
    // `-w` prints only the password; trim the trailing newline. The password is consumed for derivation and never logged.
    // A non-zero exit (key absent / access denied) throws; readMacosKeychainPassword turns it into a typed `keychain-unavailable`.
    return execFileSync('security', ['find-generic-password', '-w', '-a', account, '-s', service], {
        encoding: 'utf8',
    }).trimEnd();
}

/**
 * Read the browser's Safe Storage password from the Linux Secret Service (gnome-keyring / kwallet, via libsecret)
 * with the `secret-tool` CLI — the consent gate is the keyring's own unlock prompt, mirroring macOS's Keychain.
 * Best-effort: a non-zero exit (no `secret-tool`, no entry, locked) throws, and the caller degrades to the
 * "peanuts" `v10` scheme. The password is consumed for derivation and never logged.
 */
function readLibsecretSafeStoragePassword(browser: ChromiumBrowser): string {
    // `secret-tool lookup` prints the secret with no trailing newline; do not trim (a keyring secret is opaque bytes).
    return execFileSync('secret-tool', ['lookup', 'application', SAFE_STORAGE_LIBSECRET[browser]], {
        encoding: 'utf8',
    });
}

/** Resolve the `Cookies` DB path: the injected path, else `<profileDir>/Network/Cookies` (modern Chromium), else `<profileDir>/Cookies`. */
function resolveCookiesPath(profileDir: string, options: ReadChromeCookiesOptions): string {
    if (options.cookiesPath !== undefined) {
        return options.cookiesPath;
    }
    const networkCookies = join(profileDir, 'Network', 'Cookies');
    return existsSync(networkCookies) ? networkCookies : join(profileDir, 'Cookies');
}

/**
 * Snapshot a cookie store to a temp dir (main DB plus any `-wal`/`-shm` siblings, so WAL-pending rows are included)
 * and open it read-only — the browser holds a write lock on the live file. The snapshot is always removed. Shared
 * by the Chromium and Firefox readers (both are SQLite stores with the same locking concern).
 */
function withCookieSnapshot<T>(dbPath: string, tmpDir: string | undefined, use: (db: DatabaseSync) => T): T {
    if (!existsSync(dbPath)) {
        throw new CookieReadError('the browser cookie store does not exist', 'cookie-store-unreadable');
    }
    const snapshotDir = mkdtempSync(join(tmpDir ?? tmpdir(), 'getreceipt-cookies-'));
    const snapshot = join(snapshotDir, 'Cookies');
    let db: DatabaseSync | undefined;
    try {
        copyFileSync(dbPath, snapshot);
        for (const suffix of ['-wal', '-shm']) {
            if (existsSync(dbPath + suffix)) {
                copyFileSync(dbPath + suffix, snapshot + suffix);
            }
        }
        db = new sqlite.DatabaseSync(snapshot, { readOnly: true });
        return use(db);
    } catch (error) {
        if (error instanceof CookieReadError) {
            throw error;
        }
        throw new CookieReadError('the browser cookie store could not be read', 'cookie-store-unreadable');
    } finally {
        db?.close();
        rmSync(snapshotDir, { recursive: true, force: true });
    }
}

/** Whether a stored host key is in scope for `domain` — an exact match or a subdomain (the leading `.` of a domain cookie is ignored). */
function domainMatches(hostKey: string, domain: string): boolean {
    const normalized = hostKey.startsWith('.') ? hostKey.slice(1) : hostKey;
    return normalized === domain || normalized.endsWith(`.${domain}`);
}

/** Escape a value for a SQL `LIKE` pattern (with `ESCAPE '\'`), so a literal `%`/`_`/`\` cannot act as a wildcard. */
function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, '\\$&');
}

/** Convert a Chromium `expires_utc` (µs since 1601) to Unix seconds, or `null` for a session cookie (0). */
function chromeExpiryToUnixSeconds(expiresUtc: bigint): number | null {
    if (expiresUtc === 0n) {
        return null;
    }
    return Number((expiresUtc - CHROME_EPOCH_OFFSET_MICROS) / 1_000_000n);
}

/** Convert a Firefox `expiry` (already Unix seconds) to a number, or `null` for a session cookie (0). */
function firefoxExpiryToUnixSeconds(expiry: bigint): number | null {
    if (expiry === 0n) {
        return null;
    }
    return Number(expiry);
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function asBytes(value: unknown): Buffer {
    return value instanceof Uint8Array ? Buffer.from(value) : Buffer.alloc(0);
}

function asBigInt(value: unknown): bigint {
    return typeof value === 'bigint' ? value : 0n;
}
