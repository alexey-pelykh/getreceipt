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

/** The Chromium-family browsers — those whose cookie store uses the "<Browser> Safe Storage" Keychain scheme. Firefox is excluded. */
type ChromiumBrowser = Exclude<BrowserKind, 'firefox'>;

/** Per-browser Keychain identity of the Safe Storage password — the `security` `-s` service and `-a` account names. */
const SAFE_STORAGE_KEYCHAIN: Record<ChromiumBrowser, { readonly service: string; readonly account: string }> = {
    chrome: { service: 'Chrome Safe Storage', account: 'Chrome' },
    brave: { service: 'Brave Safe Storage', account: 'Brave' },
    edge: { service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' },
    chromium: { service: 'Chromium Safe Storage', account: 'Chromium' },
};

// The macOS Safe Storage key-derivation parameters are fixed Chromium constants (os_crypt/keychain_password_mac.mm):
// a stretch of the Keychain password with these exact PBKDF2 inputs yields the 16-byte AES-128 key.
const SAFE_STORAGE_SALT = 'saltysalt';
const SAFE_STORAGE_ITERATIONS = 1003;
const SAFE_STORAGE_KEY_LENGTH = 16;
const SAFE_STORAGE_DIGEST = 'sha1';
/** Chromium encrypts cookie values with a fixed all-spaces IV (it carries no per-value IV). */
const COOKIE_AES_IV = Buffer.alloc(16, ' ');
/** The version tag Chromium prepends to a Keychain-encrypted value on macOS. Anything else is a scheme we do not decrypt. */
const V10_PREFIX = Buffer.from('v10', 'ascii');
/** M118+ prepends SHA-256(host_key) to the plaintext to bind a value to its domain; strip it when present. */
const DOMAIN_HASH_LENGTH = 32;
/** Microseconds between the Chromium (1601-01-01) and Unix (1970-01-01) epochs — to turn `expires_utc` into Unix seconds. */
const CHROME_EPOCH_OFFSET_MICROS = 11_644_473_600_000_000n;

/** A single cookie read from a browser profile, domain-scoped. The value is {@link Secret}-fenced so it cannot leak via logs/serialization. */
export interface BrowserCookie {
    readonly name: string;
    /** The decrypted value, fenced — reachable only via {@link Secret.expose}. */
    readonly value: Secret;
    /** The cookie's `host_key` exactly as stored (a leading `.` denotes a domain cookie). */
    readonly domain: string;
    readonly path: string;
    /** Whether the cookie is `Secure` (HTTPS only). */
    readonly secure: boolean;
    /** Whether the cookie is `HttpOnly`. */
    readonly httpOnly: boolean;
    /** Expiry as Unix seconds, or `null` for a session cookie (`expires_utc` 0). */
    readonly expires: number | null;
}

/**
 * Inputs for {@link readChromeCookies}. The defaults read the real macOS Keychain and derive the key; every seam is
 * injectable so the decrypt + domain-filter logic is unit-testable with a fixture DB, a synthetic key, and no Keychain.
 */
export interface ReadChromeCookiesOptions {
    /** Pin the `Cookies` SQLite path directly. Defaults to `<profileDir>/Network/Cookies`, then `<profileDir>/Cookies`. */
    readonly cookiesPath?: string;
    /** Platform; defaults to `process.platform`. A non-`darwin` platform without an injected key/password fails closed (this reader is macOS-only — Linux/Windows is a separate item). */
    readonly platform?: NodeJS.Platform;
    /** Inject the AES-128 key directly, bypassing the Keychain and derivation entirely. */
    readonly key?: Buffer;
    /** Inject the Safe Storage password, bypassing the Keychain but still running derivation. */
    readonly safeStoragePassword?: string;
    /** Inject the Keychain reader; defaults to the macOS `security` CLI (whose prompt is the user's consent gate). */
    readonly readSafeStoragePassword?: (browser: ChromiumBrowser) => string;
    /** Directory for the lock-avoiding DB snapshot copy; defaults to `os.tmpdir()`. */
    readonly tmpDir?: string;
}

/** Derive the macOS AES-128 cookie key from a Safe Storage password using Chromium's fixed PBKDF2 parameters. */
export function deriveChromeSafeStorageKey(password: string): Buffer {
    return pbkdf2Sync(
        password,
        SAFE_STORAGE_SALT,
        SAFE_STORAGE_ITERATIONS,
        SAFE_STORAGE_KEY_LENGTH,
        SAFE_STORAGE_DIGEST,
    );
}

/**
 * Decrypt one Chromium cookie `encrypted_value` (macOS `v10` scheme) with `key`. Strips the `v10` prefix, AES-128-CBC
 * decrypts (fixed all-spaces IV, PKCS#7 padding), and removes the 32-byte SHA-256(`hostKey`) domain prefix when present
 * (Chrome M118+). Throws {@link CookieReadError}: `app-bound-encryption` for any non-`v10` scheme (e.g. Windows App-Bound
 * `v20`) — which is NOT bypassed — and `decryption-failed` when the ciphertext does not decrypt under `key`.
 */
export function decryptChromeCookie(encryptedValue: Buffer, key: Buffer, hostKey: string): string {
    if (!encryptedValue.subarray(0, V10_PREFIX.length).equals(V10_PREFIX)) {
        throw new CookieReadError(
            'the cookie value uses an encryption scheme this reader does not decrypt (e.g. OS-level App-Bound Encryption); read the cookies from a more-readable browser or paste them manually — this tool will not circumvent OS-level cookie encryption',
            'app-bound-encryption',
        );
    }
    let plaintext: Buffer;
    try {
        const decipher = createDecipheriv('aes-128-cbc', key, COOKIE_AES_IV);
        plaintext = Buffer.concat([decipher.update(encryptedValue.subarray(V10_PREFIX.length)), decipher.final()]);
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
 * macOS only: the AES key is derived from the "<Browser> Safe Storage" Keychain password, whose access prompt is the
 * user's consent gate. The store is read-only (copied first to dodge Chromium's write lock). Throws {@link CookieReadError}
 * — which never carries a cookie value or the key — for an unsupported browser/platform, an unreadable store, an
 * un-decryptable value, or a non-`v10` (OS-protected) scheme, which is never circumvented.
 */
export function readChromeCookies(
    browser: BrowserKind,
    profileDir: string,
    domain: string,
    options: ReadChromeCookiesOptions = {},
): BrowserCookie[] {
    if (browser === 'firefox') {
        throw new CookieReadError(
            'Firefox cookie reading is not supported — only Chromium-family browsers use the "Safe Storage" cookie scheme',
            'unsupported-browser',
        );
    }
    if (domain === '') {
        throw new CookieReadError('the target domain is empty', 'invalid-domain');
    }
    const key = resolveKey(browser, options);
    const dbPath = resolveCookiesPath(profileDir, options);
    const matches = (hostKey: string): boolean => {
        const normalized = hostKey.startsWith('.') ? hostKey.slice(1) : hostKey;
        return normalized === domain || normalized.endsWith(`.${domain}`);
    };

    return withCookieSnapshot(dbPath, options.tmpDir, (db) => {
        // Pre-filter to the target domain in SQL so the store hands back only in-scope rows; `matches` is the authority.
        const statement = db.prepare(
            "SELECT host_key, name, encrypted_value, value, path, is_secure, is_httponly, expires_utc FROM cookies WHERE host_key = ? OR host_key LIKE ? ESCAPE '\\'",
        );
        statement.setReadBigInts(true); // `expires_utc` (µs since 1601) overflows a JS number — read every integer as bigint.
        const rows = statement.all(domain, `%.${escapeLike(domain)}`);

        const cookies: BrowserCookie[] = [];
        for (const row of rows) {
            const hostKey = asString(row.host_key);
            if (!matches(hostKey)) {
                continue;
            }
            const encrypted = asBytes(row.encrypted_value);
            // A non-encrypted cookie (rare on modern Chromium) carries its plaintext in `value`; otherwise decrypt.
            const value = encrypted.length === 0 ? asString(row.value) : decryptChromeCookie(encrypted, key, hostKey);
            cookies.push({
                name: asString(row.name),
                value: new Secret(value),
                domain: hostKey,
                path: asString(row.path),
                secure: asBigInt(row.is_secure) !== 0n,
                httpOnly: asBigInt(row.is_httponly) !== 0n,
                expires: toUnixSecondsOrNull(asBigInt(row.expires_utc)),
            });
        }
        return cookies;
    });
}

/** Resolve the AES key from the injected key/password, or (macOS only) by deriving it from the Keychain Safe Storage password. */
function resolveKey(browser: ChromiumBrowser, options: ReadChromeCookiesOptions): Buffer {
    if (options.key !== undefined) {
        return options.key;
    }
    if (options.safeStoragePassword !== undefined) {
        return deriveChromeSafeStorageKey(options.safeStoragePassword);
    }
    const platform = options.platform ?? process.platform;
    if (platform !== 'darwin') {
        throw new CookieReadError(
            'reading the browser cookie store is only supported on macOS (Linux/Windows is tracked separately)',
            'unsupported-platform',
        );
    }
    const read = options.readSafeStoragePassword ?? readKeychainSafeStoragePassword;
    let password: string;
    try {
        password = read(browser);
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
    return deriveChromeSafeStorageKey(password);
}

/** Read the "<Browser> Safe Storage" password from the macOS Keychain via the `security` CLI. The prompt is the consent gate. */
function readKeychainSafeStoragePassword(browser: ChromiumBrowser): string {
    const { service, account } = SAFE_STORAGE_KEYCHAIN[browser];
    // `-w` prints only the password; trim the trailing newline. The password is consumed for derivation and never logged.
    // A non-zero exit (key absent / access denied) throws; resolveKey turns it into a typed `keychain-unavailable`.
    return execFileSync('security', ['find-generic-password', '-w', '-a', account, '-s', service], {
        encoding: 'utf8',
    }).trimEnd();
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
 * Snapshot the cookie store to a temp dir (main DB plus any `-wal`/`-shm` siblings, so WAL-pending rows are included) and
 * open it read-only — Chromium holds a write lock on the live file. The snapshot is always removed.
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

/** Escape a value for a SQL `LIKE` pattern (with `ESCAPE '\'`), so a literal `%`/`_`/`\` cannot act as a wildcard. */
function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, '\\$&');
}

/** Convert a Chromium `expires_utc` (µs since 1601) to Unix seconds, or `null` for a session cookie (0). */
function toUnixSecondsOrNull(expiresUtc: bigint): number | null {
    if (expiresUtc === 0n) {
        return null;
    }
    return Number((expiresUtc - CHROME_EPOCH_OFFSET_MICROS) / 1_000_000n);
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
