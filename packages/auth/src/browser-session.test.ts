// SPDX-License-Identifier: AGPL-3.0-only
import { createCipheriv, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { collect, ReauthRequiredError } from '@getreceipt/core';
import type {
    ArtifactHandle,
    AuthHandle,
    CredentialContext,
    ReceiptRef,
    ReceiptWriter,
    SourceAdapter,
    SourceDescriptor,
} from '@getreceipt/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
    asCredentialContext,
    BrowserCookieStoreError,
    browserSessionReauthRequired,
    deriveChromeSafeStorageKey,
    fromBrowserSession,
    fromCredentialContext,
    importBrowserSession,
    importBrowserSessionMulti,
    importPastedSession,
    importSession,
    resolveBrowserSession,
    Secret,
} from './index.js';
import type { BrowserCookie, BrowserCookieStoreReason, BrowserSession } from './index.js';

/** Chromium's fixed cookie IV (16 spaces) — mirrored so fixtures encrypt exactly as the reader decrypts. */
const IV = Buffer.alloc(16, ' ');
/** A synthetic Safe Storage password + its derived key — built into fixtures and injected so no real Keychain is touched. */
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
    const dir = mkdtempSync(join(tmpdir(), 'getreceipt-session-test-'));
    tempDirs.push(dir);
    return dir;
}

/** Encrypt a value the macOS-Chromium way: optional 32-byte SHA-256(host) prefix (M118+), AES-128-CBC, behind a `v10` tag. */
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
    const statement = db.prepare('INSERT INTO cookies (host_key, name, encrypted_value, value) VALUES (?, ?, ?, ?)');
    for (const cookie of cookies) {
        statement.run(cookie.host_key, cookie.name, cookie.encrypted_value ?? null, cookie.value ?? '');
    }
    db.close();
}

/** A `Local State` `profile.info_cache` whose `Default` dir is signed into `alice@personal.example`. */
const INFO_CACHE = {
    profile: { info_cache: { Default: { name: 'Personal', user_name: 'alice@personal.example' } } },
};

interface UserDataDirSpec {
    /** Profile subdirectories to create on disk (default: just `Default`). */
    readonly profiles?: readonly string[];
    /** Drop a `Cookies` DB into this profile subdirectory (must be one of `profiles`). */
    readonly cookiesIn?: string;
    /** Rows for the dropped `Cookies` DB. */
    readonly cookies?: readonly FixtureCookie[];
    /** Override the `Local State` body (default {@link INFO_CACHE}); a no-`info_cache` object exercises the malformed path. */
    readonly localState?: unknown;
}

/** Build a user-data dir: a `Local State` file, the requested profile dirs, and (optionally) a `Cookies` DB inside one. */
function makeUserDataDir(spec: UserDataDirSpec = {}): string {
    const dir = freshDir();
    writeFileSync(join(dir, 'Local State'), JSON.stringify(spec.localState ?? INFO_CACHE), 'utf8');
    for (const profile of spec.profiles ?? ['Default']) {
        mkdirSync(join(dir, profile));
    }
    if (spec.cookiesIn !== undefined) {
        writeCookiesDb(join(dir, spec.cookiesIn, 'Cookies'), spec.cookies ?? []);
    }
    return dir;
}

/** The amazon.fr-scoped cookies (plus decoys that must NOT match) used by the success fixtures. */
const AMAZON_COOKIES: readonly FixtureCookie[] = [
    { host_key: '.amazon.fr', name: 'session', encrypted_value: encryptV10('S', KEY, '.amazon.fr') },
    { host_key: 'www.amazon.fr', name: 'ubid', encrypted_value: encryptV10('U', KEY, 'www.amazon.fr') },
    { host_key: 'amazon.fr', name: 'host-only', encrypted_value: encryptV10('H', KEY, 'amazon.fr') },
    { host_key: '.notamazon.fr', name: 'decoy-prefix', encrypted_value: encryptV10('X', KEY, '.notamazon.fr') },
    { host_key: 'google.com', name: 'unrelated', encrypted_value: encryptV10('X', KEY, 'google.com') },
];

/** A Firefox `moz_cookies` row — plaintext value, no encryption (the Firefox store has no key). */
interface FirefoxFixtureCookie {
    readonly host: string;
    readonly name: string;
    readonly value: string;
}

/** Write a Firefox-shaped `moz_cookies` table (plaintext values) to `dbPath`. */
function writeFirefoxCookiesDb(dbPath: string, cookies: readonly FirefoxFixtureCookie[]): void {
    const db = new DatabaseSync(dbPath);
    db.exec(
        `CREATE TABLE moz_cookies (
            id INTEGER PRIMARY KEY,
            host TEXT NOT NULL,
            name TEXT NOT NULL,
            value TEXT NOT NULL DEFAULT '',
            path TEXT NOT NULL DEFAULT '/',
            isSecure INTEGER NOT NULL DEFAULT 0,
            isHttpOnly INTEGER NOT NULL DEFAULT 0,
            expiry INTEGER NOT NULL DEFAULT 0
        )`,
    );
    const statement = db.prepare('INSERT INTO moz_cookies (host, name, value) VALUES (?, ?, ?)');
    for (const cookie of cookies) {
        statement.run(cookie.host, cookie.name, cookie.value);
    }
    db.close();
}

interface FirefoxRootSpec {
    /** Cookies for the default profile's `cookies.sqlite` (omit to skip writing one — exercises cookie-store-unreadable). */
    readonly cookies?: readonly FirefoxFixtureCookie[];
    /** Write `profiles.ini` at all (default true) — false exercises profiles-ini-unreadable. */
    readonly writeIni?: boolean;
}

/** The default profile's directory under the synthetic Firefox root (the install default in the fixture profiles.ini). */
const FIREFOX_PROFILE_REL = ['Profiles', '8f9d2a1b.default-release'];

/** Build a synthetic Firefox root: a `profiles.ini` whose install default is `default-release`, that profile's dir, and (optionally) its `cookies.sqlite`. */
function makeFirefoxRoot(spec: FirefoxRootSpec = {}): string {
    const dir = freshDir();
    if (spec.writeIni ?? true) {
        writeFileSync(
            join(dir, 'profiles.ini'),
            [
                '[Install0]',
                'Default=Profiles/8f9d2a1b.default-release',
                '',
                '[Profile0]',
                'Name=default-release',
                'IsRelative=1',
                'Path=Profiles/8f9d2a1b.default-release',
                'Default=1',
                '',
            ].join('\n'),
            'utf8',
        );
    }
    const profileDir = join(dir, ...FIREFOX_PROFILE_REL);
    mkdirSync(profileDir, { recursive: true });
    if (spec.cookies !== undefined) {
        writeFirefoxCookiesDb(join(profileDir, 'cookies.sqlite'), spec.cookies);
    }
    return dir;
}

/** The amazon.fr-scoped Firefox cookies (plus decoys that must NOT match) — plaintext values. */
const FIREFOX_AMAZON_COOKIES: readonly FirefoxFixtureCookie[] = [
    { host: '.amazon.fr', name: 'session', value: 'FF-S' },
    { host: 'www.amazon.fr', name: 'ubid', value: 'FF-U' },
    { host: 'amazon.fr', name: 'host-only', value: 'FF-H' },
    { host: '.notamazon.fr', name: 'decoy-prefix', value: 'X' },
    { host: 'google.com', name: 'unrelated', value: 'X' },
];

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

/** Assert the call throws a {@link BrowserCookieStoreError} with the given `reason` and non-empty `guidance`. */
function expectStoreError(fn: () => unknown, reason: BrowserCookieStoreReason): BrowserCookieStoreError {
    const error = catchError(fn);
    expect(error).toBeInstanceOf(BrowserCookieStoreError);
    expect((error as BrowserCookieStoreError).reason).toBe(reason);
    expect((error as BrowserCookieStoreError).guidance.length).toBeGreaterThan(0);
    return error as BrowserCookieStoreError;
}

describe('importBrowserSession — success (composes resolve #176 + read #177)', () => {
    it('resolves a profile by account email, reads the domain-scoped cookies, and mints a handle the adapter reads back', () => {
        const userDataDir = makeUserDataDir({ cookiesIn: 'Default', cookies: AMAZON_COOKIES });

        const auth = importBrowserSession({ browser: 'chrome', profile: 'alice@personal.example' }, 'amazon.fr', {
            userDataDir,
            key: KEY,
        });
        const session = fromBrowserSession(auth);

        expect(session.browser).toBe('chrome');
        expect(session.domain).toBe('amazon.fr');
        // Domain-scoped: the registrable domain and its subdomains only — never the decoys or the unrelated jar.
        expect(session.cookies.map((c) => c.name).sort()).toEqual(['host-only', 'session', 'ubid']);
        expect(byName(session.cookies, 'session').value.expose()).toBe('S');
        expect(byName(session.cookies, 'session').domain).toBe('.amazon.fr');
    });

    it('resolves a profile by directory name too (the non-@ branch of the descriptor)', () => {
        const userDataDir = makeUserDataDir({ cookiesIn: 'Default', cookies: AMAZON_COOKIES });

        const session = fromBrowserSession(
            importBrowserSession({ browser: 'chrome', profile: 'Default' }, 'amazon.fr', { userDataDir, key: KEY }),
        );

        expect(session.cookies.map((c) => c.name).sort()).toEqual(['host-only', 'session', 'ubid']);
    });
});

describe('importBrowserSessionMulti — shared multi-marketplace jar (#190)', () => {
    // One store holding THREE registrable domains' cookies — what a single Amazon sign-in populates.
    const MULTI: readonly FixtureCookie[] = [
        { host_key: '.amazon.com', name: 'at-com', encrypted_value: encryptV10('COM', KEY, '.amazon.com') },
        { host_key: 'www.amazon.fr', name: 'at-fr', encrypted_value: encryptV10('FR', KEY, 'www.amazon.fr') },
        { host_key: '.amazon.de', name: 'at-de', encrypted_value: encryptV10('DE', KEY, '.amazon.de') },
        { host_key: 'google.com', name: 'unrelated', encrypted_value: encryptV10('X', KEY, 'google.com') },
    ];

    it('merges each registrable domain into ONE jar, every cookie keeping its own host-key; unrelated domains excluded', () => {
        const userDataDir = makeUserDataDir({ cookiesIn: 'Default', cookies: MULTI });

        const session = fromBrowserSession(
            importBrowserSessionMulti(
                { browser: 'chrome', profile: 'Default' },
                ['amazon.com', 'amazon.fr', 'amazon.de'],
                {
                    userDataDir,
                    key: KEY,
                },
            ),
        );

        // The union spans all three marketplaces; the unrelated jar never rides along.
        expect(session.cookies.map((c) => c.name).sort()).toEqual(['at-com', 'at-de', 'at-fr']);
        // Each cookie kept ITS OWN domain host-key — the property that lets the per-request filter scope by instance.
        expect(byName(session.cookies, 'at-com').domain).toBe('.amazon.com');
        expect(byName(session.cookies, 'at-fr').domain).toBe('www.amazon.fr');
        expect(byName(session.cookies, 'at-de').domain).toBe('.amazon.de');
        // Handle identity is the FIRST (canonical) domain — the persistence/store key, not a travel filter.
        expect(session.domain).toBe('amazon.com');
        expect(session.browser).toBe('chrome');
        // Values stay Secret-fenced through the merge (exposed only at the point of use).
        expect(byName(session.cookies, 'at-com').value.expose()).toBe('COM');
    });

    it('a domain with no cookies in the store contributes an empty jar (no throw); the others still merge', () => {
        // .fr-only store → the .com and .de reads are empty, so the union is just the .fr cookie.
        const userDataDir = makeUserDataDir({
            cookiesIn: 'Default',
            cookies: [{ host_key: '.amazon.fr', name: 'at-fr', encrypted_value: encryptV10('FR', KEY, '.amazon.fr') }],
        });

        const session = fromBrowserSession(
            importBrowserSessionMulti(
                { browser: 'chrome', profile: 'Default' },
                ['amazon.com', 'amazon.fr', 'amazon.de'],
                {
                    userDataDir,
                    key: KEY,
                },
            ),
        );

        expect(session.cookies.map((c) => c.name)).toEqual(['at-fr']);
    });

    it('rejects an empty domain list with a typed, value-free error', () => {
        const userDataDir = makeUserDataDir({ cookiesIn: 'Default', cookies: MULTI });

        expectStoreError(
            () => importBrowserSessionMulti({ browser: 'chrome', profile: 'Default' }, [], { userDataDir, key: KEY }),
            'invalid-domain',
        );
    });
});

describe('importBrowserSession — cookie values never leak (AC5)', () => {
    it('keeps every value Secret-fenced through the handle — redacted on stringify/JSON, exposable on demand', () => {
        const userDataDir = makeUserDataDir({
            cookiesIn: 'Default',
            cookies: [
                {
                    host_key: '.amazon.fr',
                    name: 'session',
                    encrypted_value: encryptV10('super-secret', KEY, '.amazon.fr'),
                },
            ],
        });

        const auth = importBrowserSession({ browser: 'chrome', profile: 'Default' }, 'amazon.fr', {
            userDataDir,
            key: KEY,
        });
        const cookie = byName(fromBrowserSession(auth).cookies, 'session');

        expect(cookie.value).toBeInstanceOf(Secret);
        expect(String(cookie.value)).toBe('[redacted]');
        // Neither the unpacked session NOR the opaque handle serializes the plaintext.
        expect(JSON.stringify(fromBrowserSession(auth))).not.toContain('super-secret');
        expect(JSON.stringify(auth)).not.toContain('super-secret');
        expect(cookie.value.expose()).toBe('super-secret');
    });
});

describe('importBrowserSession — structured failures via BrowserCookieStoreError (#178)', () => {
    // --- resolve half (#176) ---
    it('surfaces a profile-resolution failure (account-not-found) without echoing the configured account', () => {
        const userDataDir = makeUserDataDir({ cookiesIn: 'Default', cookies: AMAZON_COOKIES });
        const error = expectStoreError(
            () =>
                importBrowserSession({ browser: 'chrome', profile: 'nobody@nowhere.example' }, 'amazon.fr', {
                    userDataDir,
                    key: KEY,
                }),
            'account-not-found',
        );
        expect(error.message).not.toContain('nobody@nowhere.example');
    });

    it('surfaces profile-not-found when the named profile directory is absent', () => {
        const userDataDir = makeUserDataDir({ cookiesIn: 'Default', cookies: AMAZON_COOKIES });
        expectStoreError(
            () =>
                importBrowserSession({ browser: 'chrome', profile: 'Profile 9' }, 'amazon.fr', {
                    userDataDir,
                    key: KEY,
                }),
            'profile-not-found',
        );
    });

    it('propagates a Local State failure (local-state-malformed) from the @-account resolution path', () => {
        // An `@` profile forces the Local State read; a body with no `profile.info_cache` is the malformed case.
        const userDataDir = makeUserDataDir({ localState: { profile: {} } });
        expectStoreError(
            () =>
                importBrowserSession({ browser: 'chrome', profile: 'alice@personal.example' }, 'amazon.fr', {
                    userDataDir,
                    key: KEY,
                }),
            'local-state-malformed',
        );
    });

    // (Firefox is no longer rejected here — it routes to its own resolve+read pair; see the Firefox describe
    // block below. The Chromium-path defensive guards for Firefox live in cookie-reader.test / errors.test.)

    // --- read half (#177) ---
    it('surfaces cookie-store-unreadable when the resolved profile has no cookie store', () => {
        const userDataDir = makeUserDataDir(); // Default dir exists, but no Cookies DB inside it
        expectStoreError(
            () =>
                importBrowserSession({ browser: 'chrome', profile: 'Default' }, 'amazon.fr', { userDataDir, key: KEY }),
            'cookie-store-unreadable',
        );
    });

    it('rejects an empty target domain with invalid-domain', () => {
        const userDataDir = makeUserDataDir({ cookiesIn: 'Default', cookies: AMAZON_COOKIES });
        expectStoreError(
            () => importBrowserSession({ browser: 'chrome', profile: 'Default' }, '', { userDataDir, key: KEY }),
            'invalid-domain',
        );
    });

    it('fails closed with app-bound-encryption on Windows when no key is injected (App-Bound / DPAPI not bypassed)', () => {
        // Windows seals Chromium cookies with OS-level encryption this reader will not bypass — it fails closed
        // at key resolution, before the store is read (so the fixture content is irrelevant and no DPAPI is touched).
        const userDataDir = makeUserDataDir({ cookiesIn: 'Default', cookies: AMAZON_COOKIES });
        expectStoreError(
            () =>
                importBrowserSession({ browser: 'chrome', profile: 'Default' }, 'amazon.fr', {
                    userDataDir,
                    platform: 'win32',
                }),
            'app-bound-encryption',
        );
    });

    it('surfaces keychain-unavailable when the macOS Keychain read is denied (the consent gate)', () => {
        const userDataDir = makeUserDataDir(); // Default dir resolves; the key read fails before the store is touched.
        expectStoreError(
            () =>
                importBrowserSession({ browser: 'chrome', profile: 'Default' }, 'amazon.fr', {
                    userDataDir,
                    platform: 'darwin',
                    readSafeStoragePassword: () => {
                        throw new Error('user denied Keychain access');
                    },
                }),
            'keychain-unavailable',
        );
    });

    it('surfaces app-bound-encryption from an OS-protected store without circumventing it', () => {
        const userDataDir = makeUserDataDir({
            cookiesIn: 'Default',
            cookies: [
                {
                    host_key: '.amazon.fr',
                    name: 'app-bound',
                    encrypted_value: Buffer.concat([Buffer.from('v20'), Buffer.alloc(48, 9)]),
                },
            ],
        });
        expectStoreError(
            () =>
                importBrowserSession({ browser: 'chrome', profile: 'Default' }, 'amazon.fr', { userDataDir, key: KEY }),
            'app-bound-encryption',
        );
    });

    it('surfaces decryption-failed (and hides the plaintext) when a value will not decrypt under the key', () => {
        const underOtherKey = encryptV10('super-secret-value', deriveChromeSafeStorageKey('other'), '.amazon.fr');
        const userDataDir = makeUserDataDir({
            cookiesIn: 'Default',
            cookies: [{ host_key: '.amazon.fr', name: 'session', encrypted_value: underOtherKey }],
        });
        const error = expectStoreError(
            () =>
                importBrowserSession({ browser: 'chrome', profile: 'Default' }, 'amazon.fr', { userDataDir, key: KEY }),
            'decryption-failed',
        );
        expect(`${error.message}${error.stack ?? ''}`).not.toContain('super-secret-value');
    });
});

describe('importBrowserSession — Firefox (plaintext profiles.ini + cookies.sqlite, #219)', () => {
    it('resolves the default profile, reads the domain-scoped plaintext cookies, and mints a handle (no key needed)', () => {
        const firefoxDir = makeFirefoxRoot({ cookies: FIREFOX_AMAZON_COOKIES });

        const session = fromBrowserSession(
            importBrowserSession({ browser: 'firefox', profile: 'default' }, 'amazon.fr', { firefoxDir }),
        );

        expect(session.browser).toBe('firefox');
        expect(session.domain).toBe('amazon.fr');
        // Domain-scoped: the registrable domain + subdomains only — never the decoys or the unrelated jar.
        expect(session.cookies.map((c) => c.name).sort()).toEqual(['host-only', 'session', 'ubid']);
        expect(byName(session.cookies, 'session').value.expose()).toBe('FF-S');
        expect(byName(session.cookies, 'session').domain).toBe('.amazon.fr');
    });

    it('resolves a Firefox profile by its Name too', () => {
        const firefoxDir = makeFirefoxRoot({ cookies: FIREFOX_AMAZON_COOKIES });
        const session = fromBrowserSession(
            importBrowserSession({ browser: 'firefox', profile: 'default-release' }, 'amazon.fr', { firefoxDir }),
        );
        expect(session.cookies.map((c) => c.name).sort()).toEqual(['host-only', 'session', 'ubid']);
    });

    it('keeps every Firefox cookie value Secret-fenced through the handle (same posture as Chromium)', () => {
        const firefoxDir = makeFirefoxRoot({
            cookies: [{ host: '.amazon.fr', name: 'session', value: 'super-secret-firefox' }],
        });

        const auth = importBrowserSession({ browser: 'firefox', profile: 'default' }, 'amazon.fr', { firefoxDir });
        const cookie = byName(fromBrowserSession(auth).cookies, 'session');

        expect(cookie.value).toBeInstanceOf(Secret);
        expect(String(cookie.value)).toBe('[redacted]');
        // Neither the unpacked session NOR the opaque handle serializes the plaintext.
        expect(JSON.stringify(fromBrowserSession(auth))).not.toContain('super-secret-firefox');
        expect(JSON.stringify(auth)).not.toContain('super-secret-firefox');
        expect(cookie.value.expose()).toBe('super-secret-firefox');
    });

    it('routes a Firefox descriptor through the unified importSession entry too', () => {
        const firefoxDir = makeFirefoxRoot({ cookies: FIREFOX_AMAZON_COOKIES });
        const session = fromBrowserSession(
            importSession({ browser: 'firefox', profile: 'default' }, 'amazon.fr', { firefoxDir }),
        );
        expect(session.browser).toBe('firefox');
        expect(session.cookies.map((c) => c.name).sort()).toEqual(['host-only', 'session', 'ubid']);
    });

    it('surfaces a Firefox profile-resolution failure (profile-not-found) without echoing the configured value', () => {
        const firefoxDir = makeFirefoxRoot({ cookies: FIREFOX_AMAZON_COOKIES });
        const error = expectStoreError(
            () => importBrowserSession({ browser: 'firefox', profile: 'no-such-profile' }, 'amazon.fr', { firefoxDir }),
            'profile-not-found',
        );
        expect(error.message).not.toContain('no-such-profile');
    });

    it('surfaces profiles-ini-unreadable when the Firefox root has no profiles.ini', () => {
        const firefoxDir = makeFirefoxRoot({ writeIni: false });
        expectStoreError(
            () => importBrowserSession({ browser: 'firefox', profile: 'default' }, 'amazon.fr', { firefoxDir }),
            'profiles-ini-unreadable',
        );
    });

    it('surfaces cookie-store-unreadable when the resolved Firefox profile has no cookies.sqlite', () => {
        const firefoxDir = makeFirefoxRoot(); // profile dir exists, but no cookies.sqlite inside it
        expectStoreError(
            () => importBrowserSession({ browser: 'firefox', profile: 'default' }, 'amazon.fr', { firefoxDir }),
            'cookie-store-unreadable',
        );
    });

    it('rejects an empty target domain with invalid-domain (Firefox path)', () => {
        const firefoxDir = makeFirefoxRoot({ cookies: FIREFOX_AMAZON_COOKIES });
        expectStoreError(
            () => importBrowserSession({ browser: 'firefox', profile: 'default' }, '', { firefoxDir }),
            'invalid-domain',
        );
    });
});

describe('importSession — unified browser + paste entry (#218)', () => {
    it('delegates a browser descriptor to the cookie-store import (same handle as importBrowserSession)', () => {
        const userDataDir = makeUserDataDir({ cookiesIn: 'Default', cookies: AMAZON_COOKIES });
        const viaUnified = fromBrowserSession(
            importSession({ browser: 'chrome', profile: 'Default' }, 'amazon.fr', { userDataDir, key: KEY }),
        );
        // The same domain-scoped jar the direct browser import yields — importSession is a pass-through here.
        expect(viaUnified.browser).toBe('chrome');
        expect(viaUnified.domain).toBe('amazon.fr');
        expect(viaUnified.cookies.map((c) => c.name).sort()).toEqual(['host-only', 'session', 'ubid']);
        expect(byName(viaUnified.cookies, 'session').value.expose()).toBe('S');
    });

    it('parses a pasted `Cookie:` header descriptor into the SAME domain-scoped session handle', () => {
        const session = fromBrowserSession(
            importSession({ paste: new Secret('Cookie: session=abc123; ubid=u-42') }, 'amazon.fr'),
        );
        // A pasted session has NO originating browser — but is otherwise the identical handle shape.
        expect(session.browser).toBeUndefined();
        expect(session.domain).toBe('amazon.fr');
        expect(session.cookies.map((c) => c.name).sort()).toEqual(['session', 'ubid']);
        // Every pasted pair is scoped to the target domain (a Cookie header is already browser-scoped to its site).
        expect(session.cookies.every((c) => c.domain === 'amazon.fr')).toBe(true);
        // Value reachable only via expose() at the point of use.
        expect(byName(session.cookies, 'session').value.expose()).toBe('abc123');
    });

    it('parses a pasted Netscape cookies.txt descriptor, dropping out-of-scope rows', () => {
        const cookiesTxt = [
            '# Netscape HTTP Cookie File',
            '.amazon.fr\tTRUE\t/\tTRUE\t0\tsession\tin-scope',
            'google.com\tFALSE\t/\tFALSE\t0\tunrelated\tout-of-scope',
        ].join('\n');
        const session = fromBrowserSession(importSession({ paste: new Secret(cookiesTxt) }, 'amazon.fr'));
        // Only the amazon.fr row survives the domain scope; the google.com row is dropped, exactly as the store reader scopes a jar.
        expect(session.cookies.map((c) => c.name)).toEqual(['session']);
        expect(byName(session.cookies, 'session').value.expose()).toBe('in-scope');
    });

    it('keeps the pasted material fenced — the minted handle never serializes a cookie value (#218)', () => {
        const handle = importSession({ paste: new Secret('Cookie: session=super-secret-paste') }, 'amazon.fr');
        // The handle redacts through JSON — the raw paste never reaches a log or a persisted artifact.
        expect(JSON.stringify(fromBrowserSession(handle))).not.toContain('super-secret-paste');
    });

    it('routes a pasted descriptor identically to importPastedSession (parity with the direct provider)', () => {
        const raw = 'Cookie: a=1; b=2';
        const viaUnified = fromBrowserSession(importSession({ paste: new Secret(raw) }, 'amazon.fr'));
        const viaDirect = fromBrowserSession(importPastedSession(raw, 'amazon.fr'));
        expect(viaUnified.cookies.map((c) => `${c.name}=${c.value.expose()}`)).toEqual(
            viaDirect.cookies.map((c) => `${c.name}=${c.value.expose()}`),
        );
    });
});

// --- the session-kind auth contract on the REAL collect path (#180) --------
// A fake `session` source proving the contract end-to-end against core's real `collect()`: the resolver
// yields the descriptor, `authenticate()` imports-and-returns via importSession (no login), and
// `list`/`fetch` read the session back. All data is synthetic — a temp user-data dir + an injected Safe
// Storage key (KEY) — so no real Keychain is touched and CI stays hermetic.

const SESSION_DESCRIPTOR: SourceDescriptor = {
    canonicalDomain: 'amazon.fr',
    aliasDomains: [],
    authKind: 'session',
    // Unused on the collect path: a session source bypasses the #169 credential-shape gate (it supplies no
    // credential). Present only because the descriptor field is required + non-empty.
    credentialShapes: ['none'],
    transportTier: 'headless-browser',
    artifactMode: 'pdf-download',
    dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
    defaultWindow: { days: 90 },
    pagination: 'none',
};

const NOW = new Date('2026-06-21T00:00:00.000Z');

interface SessionAdapterScript {
    readonly userDataDir: string;
    /** Observe the session `list()` reads back from the imported handle. */
    readonly onList?: (session: BrowserSession) => void;
    /** Observe the session `fetch()` reads — proves a cookie value is exposable at the point of use. */
    readonly onFetch?: (session: BrowserSession) => void;
    /** When set, `list()` throws this instead of listing — models a stale imported session rejected later. */
    readonly listError?: () => Error;
}

/** A fake `session` adapter whose `authenticate()` imports via the #179 helper and returns the handle. */
function sessionAdapter(script: SessionAdapterScript): SourceAdapter {
    return {
        descriptor: SESSION_DESCRIPTOR,
        authenticate: async (credentials): Promise<AuthHandle> => {
            const resolved = fromCredentialContext(credentials);
            if (resolved.session === undefined) {
                throw new Error('expected a resolved session descriptor on the credential context');
            }
            // Import-and-return via the unified entry (#218): a browser descriptor reads the cookie store; a
            // pasted descriptor parses the resolved paste. No credential exchange, no browser launch either way.
            return importSession(resolved.session, SESSION_DESCRIPTOR.canonicalDomain, {
                userDataDir: script.userDataDir,
                key: KEY,
            });
        },
        list: async (auth): Promise<readonly ReceiptRef[]> => {
            if (script.listError !== undefined) {
                throw script.listError();
            }
            const session = fromBrowserSession(auth);
            script.onList?.(session);
            // One ref per imported cookie, so a written-set assertion proves the session threaded through.
            return session.cookies.map((cookie) => ({
                id: `receipt-${cookie.name}`,
                issuedAt: new Date('2026-03-01T00:00:00.000Z'),
            }));
        },
        fetch: async (auth, receiptRef): Promise<ArtifactHandle> => {
            script.onFetch?.(fromBrowserSession(auth));
            return { id: receiptRef.id } as unknown as ArtifactHandle;
        },
    };
}

/** A writer that records what it was asked to persist; never inspects the artifact. */
function recordingWriter(): { writer: ReceiptWriter; written: string[] } {
    const written: string[] = [];
    const writer: ReceiptWriter = {
        has: async () => false,
        write: async (_source, receiptRef) => {
            written.push(receiptRef.id);
        },
    };
    return { writer, written };
}

/** The credential context a front-end resolves for a session source — via the real {@link resolveBrowserSession}. */
function sessionCredentials(profile: string): CredentialContext {
    return asCredentialContext({
        kind: 'session',
        session: resolveBrowserSession({ kind: 'session', browser: 'chrome', profile }),
    });
}

describe('resolveBrowserSession — the session credential resolver (#180)', () => {
    it('lifts the { browser, profile } pair out of a session config arm (no secret to dereference)', () => {
        expect(resolveBrowserSession({ kind: 'session', browser: 'brave', profile: 'Profile 1' })).toEqual({
            browser: 'brave',
            profile: 'Profile 1',
        });
    });
});

describe('browserSessionReauthRequired — a stale session reuses the existing reauth seam (#180)', () => {
    it('mints a ReauthRequiredError with browser-pointing, PII-free guidance (no parallel error type)', () => {
        const error = browserSessionReauthRequired('amazon.fr');
        expect(error).toBeInstanceOf(ReauthRequiredError);
        expect(error.domain).toBe('amazon.fr');
        expect(error.reason).toContain('browser');
        // The reason never echoes a configured profile / account / cookie.
        expect(error.reason).not.toContain('Default');
    });
});

describe('session-kind adapter on the real collect path (#180)', () => {
    it('authenticates via importBrowserSession, then lists + fetches the session end-to-end [AC5]', async () => {
        const userDataDir = makeUserDataDir({ cookiesIn: 'Default', cookies: AMAZON_COOKIES });
        let listed: string[] | undefined;
        const adapter = sessionAdapter({
            userDataDir,
            onList: (session) => {
                listed = session.cookies.map((c) => c.name).sort();
            },
        });
        const { writer, written } = recordingWriter();

        // Resolve by account email — exercises the resolver -> context -> authenticate -> import chain.
        const result = await collect({
            adapter,
            credentials: sessionCredentials('alice@personal.example'),
            writer,
            now: NOW,
        });

        expect(result.outcome).toBe('succeeded');
        // The imported, domain-scoped session threaded authenticate -> list.
        expect(listed).toEqual(['host-only', 'session', 'ubid']);
        // Every listed receipt fetched + written — the AuthHandle carried the session to fetch too.
        expect(written.sort()).toEqual(['receipt-host-only', 'receipt-session', 'receipt-ubid']);
    });

    it('keeps cookie values Secret-fenced end-to-end — exposable at point of use, never in the result [no-leak]', async () => {
        const userDataDir = makeUserDataDir({
            cookiesIn: 'Default',
            cookies: [
                {
                    host_key: '.amazon.fr',
                    name: 'session',
                    encrypted_value: encryptV10('LEAK-SENTINEL-cookie', KEY, '.amazon.fr'),
                },
            ],
        });
        let exposedInFetch: string | undefined;
        const adapter = sessionAdapter({
            userDataDir,
            onFetch: (session) => {
                exposedInFetch = byName(session.cookies, 'session').value.expose();
            },
        });
        const { writer } = recordingWriter();

        const result = await collect({ adapter, credentials: sessionCredentials('Default'), writer, now: NOW });

        expect(result.outcome).toBe('succeeded');
        // The fence is a fence, not deletion — the value is reachable where it is used...
        expect(exposedInFetch).toBe('LEAK-SENTINEL-cookie');
        // ...but the structured result never serializes it.
        expect(JSON.stringify(result)).not.toContain('LEAK-SENTINEL-cookie');
    });

    it('maps a stale imported session to the existing reauth-required outcome [AC4]', async () => {
        const userDataDir = makeUserDataDir({ cookiesIn: 'Default', cookies: AMAZON_COOKIES });
        // Import succeeds (cookies present), but the source rejects them at list time — a stale session.
        const adapter = sessionAdapter({ userDataDir, listError: () => browserSessionReauthRequired('amazon.fr') });
        const { writer, written } = recordingWriter();

        const result = await collect({ adapter, credentials: sessionCredentials('Default'), writer, now: NOW });

        expect(result.outcome).toBe('reauth-required');
        if (result.outcome === 'reauth-required') {
            expect(result.reason).toContain('browser');
        }
        // A re-auth signal at list time means nothing was written.
        expect(written).toEqual([]);
    });
});
