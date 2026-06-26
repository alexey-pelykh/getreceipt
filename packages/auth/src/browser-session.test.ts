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

    it('rejects Firefox with unsupported-browser (the reason shared by both halves)', () => {
        const userDataDir = makeUserDataDir({ cookiesIn: 'Default', cookies: AMAZON_COOKIES });
        expectStoreError(
            () =>
                importBrowserSession({ browser: 'firefox', profile: 'Default' }, 'amazon.fr', {
                    userDataDir,
                    key: KEY,
                }),
            'unsupported-browser',
        );
    });

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

    it('fails closed with unsupported-platform off macOS when no key is injected', () => {
        const userDataDir = makeUserDataDir({ cookiesIn: 'Default', cookies: AMAZON_COOKIES });
        expectStoreError(
            () =>
                importBrowserSession({ browser: 'chrome', profile: 'Default' }, 'amazon.fr', {
                    userDataDir,
                    platform: 'linux',
                }),
            'unsupported-platform',
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

// --- the session-kind auth contract on the REAL collect path (#180) --------
// A fake `session` source proving the contract end-to-end against core's real `collect()`: the resolver
// yields the descriptor, `authenticate()` imports-and-returns via importBrowserSession (no login), and
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
            // Import-and-return: no credential exchange, no browser launch — just read the cookie store.
            return importBrowserSession(resolved.session, SESSION_DESCRIPTOR.canonicalDomain, {
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
