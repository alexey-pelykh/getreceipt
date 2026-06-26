// SPDX-License-Identifier: AGPL-3.0-only
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
    CookieReadError,
    decryptChromeCookie,
    deriveChromeSafeStorageKey,
    readChromeCookies,
    Secret,
} from './index.js';
import type { BrowserCookie, CookieReadReason } from './index.js';

/** Chromium's fixed cookie IV (16 spaces) — mirrored here so fixtures encrypt exactly as the reader decrypts. */
const IV = Buffer.alloc(16, ' ');
/** A synthetic Safe Storage password + its derived key. Used to build fixtures and injected so no real Keychain is touched. */
const PASSWORD = 'test-safe-storage-password';
const KEY = deriveChromeSafeStorageKey(PASSWORD);

/** Temp dirs created per test; removed in `afterEach`. */
const tempDirs: string[] = [];

afterEach(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'getreceipt-cookies-test-'));
    tempDirs.push(dir);
    return dir;
}

/**
 * Encrypt a value the way macOS Chromium does: optional 32-byte SHA-256(host) domain prefix (M118+), AES-128-CBC with the
 * fixed all-spaces IV and PKCS#7 padding, behind a `v10` tag. The inverse of {@link decryptChromeCookie}.
 */
function encryptV10(value: string, key: Buffer, hostKey: string, withDomainPrefix = true): Buffer {
    const prefix = withDomainPrefix ? createHash('sha256').update(hostKey).digest() : Buffer.alloc(0);
    const cipher = createCipheriv('aes-128-cbc', key, IV);
    const body = Buffer.concat([cipher.update(Buffer.concat([prefix, Buffer.from(value, 'utf8')])), cipher.final()]);
    return Buffer.concat([Buffer.from('v10', 'ascii'), body]);
}

interface FixtureCookie {
    readonly host_key: string;
    readonly name: string;
    readonly encrypted_value?: Buffer;
    readonly value?: string;
    readonly path?: string;
    readonly is_secure?: number;
    readonly is_httponly?: number;
    readonly expires_utc?: number | bigint;
}

/** Write a Chromium-shaped `cookies` table to `dbPath` and insert `cookies`. */
function writeCookiesDb(dbPath: string, cookies: readonly FixtureCookie[]): void {
    const db = new DatabaseSync(dbPath);
    db.exec(
        `CREATE TABLE cookies (
            host_key TEXT NOT NULL,
            name TEXT NOT NULL,
            encrypted_value BLOB,
            value TEXT NOT NULL DEFAULT '',
            path TEXT NOT NULL DEFAULT '/',
            is_secure INTEGER NOT NULL DEFAULT 0,
            is_httponly INTEGER NOT NULL DEFAULT 0,
            expires_utc INTEGER NOT NULL DEFAULT 0
        )`,
    );
    const statement = db.prepare(
        'INSERT INTO cookies (host_key, name, encrypted_value, value, path, is_secure, is_httponly, expires_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const cookie of cookies) {
        statement.run(
            cookie.host_key,
            cookie.name,
            cookie.encrypted_value ?? null,
            cookie.value ?? '',
            cookie.path ?? '/',
            cookie.is_secure ?? 0,
            cookie.is_httponly ?? 0,
            cookie.expires_utc ?? 0,
        );
    }
    db.close();
}

/** A standalone `Cookies` DB file (for `cookiesPath` injection), pre-loaded with `cookies`. */
function cookiesDbFile(cookies: readonly FixtureCookie[]): string {
    const path = join(freshDir(), 'Cookies');
    writeCookiesDb(path, cookies);
    return path;
}

function byName(cookies: readonly BrowserCookie[], name: string): BrowserCookie {
    const found = cookies.find((cookie) => cookie.name === name);
    if (found === undefined) {
        throw new Error(`expected a cookie named "${name}", found: ${cookies.map((c) => c.name).join(', ')}`);
    }
    return found;
}

/** Run `fn`, returning the thrown error (failing the test if it does not throw). */
function catchError(fn: () => unknown): unknown {
    try {
        fn();
    } catch (error) {
        return error;
    }
    throw new Error('expected the call to throw, but it returned');
}

/** Assert the call throws a {@link CookieReadError} with the given `reason`, returning it for further checks. */
function expectReason(fn: () => unknown, reason: CookieReadReason): CookieReadError {
    const error = catchError(fn);
    expect(error).toBeInstanceOf(CookieReadError);
    expect((error as CookieReadError).reason).toBe(reason);
    return error as CookieReadError;
}

describe('deriveChromeSafeStorageKey', () => {
    it('derives a 16-byte AES-128 key with Chromium PBKDF2 parameters (saltysalt / 1003 / SHA-1)', () => {
        const key = deriveChromeSafeStorageKey(PASSWORD);
        expect(key).toHaveLength(16);
        // Pin the exact parameters: an independent derivation must match byte-for-byte.
        expect(key.equals(pbkdf2Sync(PASSWORD, 'saltysalt', 1003, 16, 'sha1'))).toBe(true);
    });
});

describe('decryptChromeCookie', () => {
    it('round-trips a v10 value with no domain prefix', () => {
        const encrypted = encryptV10('session-token', KEY, '.example.com', false);
        expect(decryptChromeCookie(encrypted, KEY, '.example.com')).toBe('session-token');
    });

    it('strips the 32-byte SHA-256(host) domain prefix (Chrome M118+)', () => {
        const encrypted = encryptV10('session-token', KEY, '.example.com', true);
        expect(decryptChromeCookie(encrypted, KEY, '.example.com')).toBe('session-token');
    });

    it('throws app-bound-encryption for a non-v10 scheme (e.g. Windows App-Bound v20) without circumventing it', () => {
        const appBound = Buffer.concat([Buffer.from('v20', 'ascii'), Buffer.alloc(32, 7)]);
        expectReason(() => decryptChromeCookie(appBound, KEY, '.example.com'), 'app-bound-encryption');
    });

    it('throws decryption-failed under the wrong key', () => {
        const encrypted = encryptV10('session-token', KEY, '.example.com', true);
        const wrongKey = deriveChromeSafeStorageKey('a-different-password');
        expectReason(() => decryptChromeCookie(encrypted, wrongKey, '.example.com'), 'decryption-failed');
    });
});

describe('readChromeCookies — domain-scoped filter', () => {
    it('returns only cookies scoped to the target registrable domain and its subdomains, never the whole jar', () => {
        const cookiesPath = cookiesDbFile([
            { host_key: '.amazon.fr', name: 'session', encrypted_value: encryptV10('S', KEY, '.amazon.fr') },
            { host_key: 'www.amazon.fr', name: 'ubid', encrypted_value: encryptV10('U', KEY, 'www.amazon.fr') },
            { host_key: 'amazon.fr', name: 'host-only', encrypted_value: encryptV10('H', KEY, 'amazon.fr') },
            // Decoys that must NOT match a naive substring/suffix filter:
            { host_key: '.notamazon.fr', name: 'decoy-prefix', encrypted_value: encryptV10('X', KEY, '.notamazon.fr') },
            { host_key: 'evil-amazon.fr', name: 'decoy-dash', encrypted_value: encryptV10('X', KEY, 'evil-amazon.fr') },
            { host_key: 'google.com', name: 'unrelated', encrypted_value: encryptV10('X', KEY, 'google.com') },
        ]);

        const cookies = readChromeCookies('chrome', '/unused', 'amazon.fr', { key: KEY, cookiesPath });

        expect(cookies.map((c) => c.name).sort()).toEqual(['host-only', 'session', 'ubid']);
        expect(cookies.some((c) => c.name.startsWith('decoy') || c.name === 'unrelated')).toBe(false);
    });

    it('throws invalid-domain for an empty target domain', () => {
        const cookiesPath = cookiesDbFile([{ host_key: '.example.com', name: 'a', value: 'b' }]);
        expectReason(() => readChromeCookies('chrome', '/unused', '', { key: KEY, cookiesPath }), 'invalid-domain');
    });
});

describe('readChromeCookies — value fencing (cookie values never leak)', () => {
    it('fences the value in a Secret that redacts on stringify/JSON but exposes the plaintext on demand', () => {
        const cookiesPath = cookiesDbFile([
            {
                host_key: '.example.com',
                name: 'session',
                encrypted_value: encryptV10('super-secret', KEY, '.example.com'),
            },
        ]);

        const cookie = byName(
            readChromeCookies('chrome', '/unused', 'example.com', { key: KEY, cookiesPath }),
            'session',
        );

        expect(cookie.value).toBeInstanceOf(Secret);
        expect(String(cookie.value)).toBe('[redacted]');
        expect(JSON.stringify(cookie.value)).toBe('"[redacted]"');
        expect(JSON.stringify(cookie)).not.toContain('super-secret');
        expect(cookie.value.expose()).toBe('super-secret');
    });

    it('keeps the cookie value out of a decryption-failure error message and stack', () => {
        // A value encrypted under a different key: the error must surface the failure without echoing any plaintext.
        const encrypted = encryptV10('super-secret-value', deriveChromeSafeStorageKey('other'), '.example.com');
        const cookiesPath = cookiesDbFile([{ host_key: '.example.com', name: 'session', encrypted_value: encrypted }]);

        const error = expectReason(
            () => readChromeCookies('chrome', '/unused', 'example.com', { key: KEY, cookiesPath }),
            'decryption-failed',
        );
        expect(`${error.message}${error.stack ?? ''}`).not.toContain('super-secret-value');
    });
});

describe('readChromeCookies — cookie attributes', () => {
    it('maps secure / httpOnly flags and converts expires_utc to Unix seconds (null for session cookies)', () => {
        const cookiesPath = cookiesDbFile([
            {
                host_key: '.example.com',
                name: 'persistent',
                encrypted_value: encryptV10('P', KEY, '.example.com'),
                path: '/account',
                is_secure: 1,
                is_httponly: 1,
                expires_utc: 13_350_000_000_000_000n, // µs since 1601 → 1705526400 Unix seconds
            },
            {
                host_key: '.example.com',
                name: 'session',
                encrypted_value: encryptV10('S', KEY, '.example.com'),
                is_secure: 0,
                is_httponly: 0,
                expires_utc: 0,
            },
        ]);

        const cookies = readChromeCookies('chrome', '/unused', 'example.com', { key: KEY, cookiesPath });
        const persistent = byName(cookies, 'persistent');
        const session = byName(cookies, 'session');

        expect(persistent.domain).toBe('.example.com');
        expect(persistent.path).toBe('/account');
        expect(persistent.secure).toBe(true);
        expect(persistent.httpOnly).toBe(true);
        expect(persistent.expires).toBe(1_705_526_400);

        expect(session.secure).toBe(false);
        expect(session.httpOnly).toBe(false);
        expect(session.expires).toBeNull();
    });

    it('reads a non-encrypted cookie from the plaintext value column', () => {
        const cookiesPath = cookiesDbFile([{ host_key: '.example.com', name: 'plain', value: 'plaintext-value' }]);
        const cookie = byName(
            readChromeCookies('chrome', '/unused', 'example.com', { key: KEY, cookiesPath }),
            'plain',
        );
        expect(cookie.value.expose()).toBe('plaintext-value');
    });
});

describe('readChromeCookies — key resolution and platform gating', () => {
    it('derives the key from an injected Safe Storage password (no Keychain)', () => {
        const cookiesPath = cookiesDbFile([
            {
                host_key: '.example.com',
                name: 'session',
                encrypted_value: encryptV10('via-password', KEY, '.example.com'),
            },
        ]);
        const cookie = byName(
            readChromeCookies('chrome', '/unused', 'example.com', { safeStoragePassword: PASSWORD, cookiesPath }),
            'session',
        );
        expect(cookie.value.expose()).toBe('via-password');
    });

    it('decrypts on any platform when a key is injected (hermetic, cross-platform)', () => {
        const cookiesPath = cookiesDbFile([
            {
                host_key: '.example.com',
                name: 'session',
                encrypted_value: encryptV10('cross-platform', KEY, '.example.com'),
            },
        ]);
        for (const platform of ['linux', 'win32', 'darwin'] as const) {
            const cookie = byName(
                readChromeCookies('chrome', '/unused', 'example.com', { key: KEY, cookiesPath, platform }),
                'session',
            );
            expect(cookie.value.expose()).toBe('cross-platform');
        }
    });

    it('fails closed with unsupported-platform off macOS when no key/password is injected', () => {
        const cookiesPath = cookiesDbFile([{ host_key: '.example.com', name: 'a', value: 'b' }]);
        expectReason(
            () => readChromeCookies('chrome', '/unused', 'example.com', { platform: 'linux', cookiesPath }),
            'unsupported-platform',
        );
    });

    it('uses the injected Keychain reader on macOS (its prompt is the consent gate)', () => {
        const cookiesPath = cookiesDbFile([
            {
                host_key: '.example.com',
                name: 'session',
                encrypted_value: encryptV10('via-keychain', KEY, '.example.com'),
            },
        ]);
        const cookie = byName(
            readChromeCookies('chrome', '/unused', 'example.com', {
                platform: 'darwin',
                cookiesPath,
                readSafeStoragePassword: () => PASSWORD,
            }),
            'session',
        );
        expect(cookie.value.expose()).toBe('via-keychain');
    });

    it('fails closed with keychain-unavailable when the Keychain read throws (e.g. access denied)', () => {
        const cookiesPath = cookiesDbFile([{ host_key: '.example.com', name: 'a', value: 'b' }]);
        expectReason(
            () =>
                readChromeCookies('chrome', '/unused', 'example.com', {
                    platform: 'darwin',
                    cookiesPath,
                    readSafeStoragePassword: () => {
                        throw new Error('user denied Keychain access');
                    },
                }),
            'keychain-unavailable',
        );
    });
});

describe('readChromeCookies — store resolution and failures', () => {
    it('rejects Firefox with unsupported-browser', () => {
        const cookiesPath = cookiesDbFile([{ host_key: '.example.com', name: 'a', value: 'b' }]);
        expectReason(
            () => readChromeCookies('firefox', '/unused', 'example.com', { key: KEY, cookiesPath }),
            'unsupported-browser',
        );
    });

    it('fails closed with cookie-store-unreadable when the store is missing', () => {
        expectReason(
            () => readChromeCookies('chrome', '/unused', 'example.com', { key: KEY, cookiesPath: '/no/such/Cookies' }),
            'cookie-store-unreadable',
        );
    });

    it('prefers <profile>/Network/Cookies when present', () => {
        const profileDir = freshDir();
        mkdirSync(join(profileDir, 'Network'));
        writeCookiesDb(join(profileDir, 'Network', 'Cookies'), [
            { host_key: '.example.com', name: 'modern', encrypted_value: encryptV10('N', KEY, '.example.com') },
        ]);
        const cookies = readChromeCookies('chrome', profileDir, 'example.com', { key: KEY });
        expect(cookies.map((c) => c.name)).toEqual(['modern']);
    });

    it('falls back to <profile>/Cookies when there is no Network subdirectory', () => {
        const profileDir = freshDir();
        writeCookiesDb(join(profileDir, 'Cookies'), [
            { host_key: '.example.com', name: 'legacy', encrypted_value: encryptV10('L', KEY, '.example.com') },
        ]);
        const cookies = readChromeCookies('chrome', profileDir, 'example.com', { key: KEY });
        expect(cookies.map((c) => c.name)).toEqual(['legacy']);
    });

    it('propagates app-bound-encryption from a store whose values are OS-protected', () => {
        const cookiesPath = cookiesDbFile([
            {
                host_key: '.example.com',
                name: 'app-bound',
                encrypted_value: Buffer.concat([Buffer.from('v20', 'ascii'), Buffer.alloc(48, 9)]),
            },
        ]);
        expectReason(
            () => readChromeCookies('chrome', '/unused', 'example.com', { key: KEY, cookiesPath }),
            'app-bound-encryption',
        );
    });
});

describe('readChromeCookies — read-only via snapshot copy', () => {
    it('reads via a copy and leaves the original store byte-for-byte unchanged', () => {
        const cookiesPath = cookiesDbFile([
            { host_key: '.example.com', name: 'session', encrypted_value: encryptV10('S', KEY, '.example.com') },
        ]);
        const before = readFileSync(cookiesPath);
        const beforeStat = statSync(cookiesPath);

        const cookies = readChromeCookies('chrome', '/unused', 'example.com', { key: KEY, cookiesPath });

        expect(cookies).toHaveLength(1);
        expect(readFileSync(cookiesPath).equals(before)).toBe(true);
        expect(statSync(cookiesPath).size).toBe(beforeStat.size);
    });
});
