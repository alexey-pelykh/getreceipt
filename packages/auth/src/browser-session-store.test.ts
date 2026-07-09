// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReauthRequiredError } from '@getreceipt/core';
import type { AuthHandle } from '@getreceipt/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
    browserSessionToStoredSession,
    EncryptedFileSessionStore,
    fromBrowserSession,
    InMemoryKeyring,
    KeyringSessionStore,
    ReauthDetector,
    reuseOrImportBrowserSession,
    Secret,
    SessionStoreError,
    storedSessionToBrowserSession,
} from './index.js';
import type { BrowserCookie, BrowserSession, SessionStore } from './index.js';

// The persist/reuse bridge (#189) operates on synthetic browser sessions + in-memory / temp-dir stores — no
// real cookie store, Keychain, or home dir is touched. Every cookie value is a leak sentinel so an at-rest
// artifact (AC3) or a serialized shape (Secret fence) can be asserted NOT to contain it.

const DOMAIN = 'amazon.fr';
/** Cookie values are sentinels: a plaintext leak (on disk, in a log, in JSON) shows up as a search hit. */
const SESSION_VALUE = 'session-value-SENTINEL-do-not-leak';
const CSRF_VALUE = 'csrf-value-SENTINEL-do-not-leak';
const FUTURE_SECONDS = Math.floor(Date.parse('2099-01-01T00:00:00.000Z') / 1000);
const SOONER_SECONDS = Math.floor(Date.parse('2098-01-01T00:00:00.000Z') / 1000);
const PAST_MS = Date.parse('2000-01-01T00:00:00.000Z');

const tempDirs: string[] = [];
afterEach(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'getreceipt-bss-test-'));
    tempDirs.push(dir);
    return dir;
}

/** Build a {@link BrowserCookie} with a fenced value and overridable attributes. */
function cookie(
    name: string,
    value: string,
    overrides: Partial<Omit<BrowserCookie, 'name' | 'value'>> = {},
): BrowserCookie {
    return {
        name,
        value: new Secret(value),
        domain: overrides.domain ?? `.${DOMAIN}`,
        path: overrides.path ?? '/',
        secure: overrides.secure ?? true,
        httpOnly: overrides.httpOnly ?? true,
        expires: overrides.expires ?? null,
    };
}

/** A representative imported browser session: a long-lived auth cookie + a session cookie, varied attributes. */
function sampleSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
    return {
        browser: 'chrome',
        domain: DOMAIN,
        cookies: [
            cookie('session-id', SESSION_VALUE, {
                expires: FUTURE_SECONDS,
                path: '/account',
                secure: true,
                httpOnly: true,
            }),
            cookie('csrf', CSRF_VALUE, { expires: null, path: '/', secure: false, httpOnly: false }),
        ],
        ...overrides,
    };
}

/** Cast a {@link BrowserSession} into the opaque handle the importers mint (the test-side of `asAuthHandle`). */
function handle(session: BrowserSession): AuthHandle {
    return session as unknown as AuthHandle;
}

/** Compare two browser sessions for value equality, exposing each fenced cookie value. */
function expectSameSession(actual: BrowserSession, expected: BrowserSession): void {
    expect(actual.browser).toBe(expected.browser);
    expect(actual.domain).toBe(expected.domain);
    expect(actual.cookies).toHaveLength(expected.cookies.length);
    actual.cookies.forEach((got, index) => {
        const want = expected.cookies[index]!;
        expect(got.value.expose()).toBe(want.value.expose());
        expect({ ...got, value: undefined }).toEqual({ ...want, value: undefined });
    });
}

describe('browserSessionToStoredSession / storedSessionToBrowserSession — the persistence bridge', () => {
    it('round-trips an imported browser session through a StoredSession, fence intact [AC1]', () => {
        const original = sampleSession();
        const stored = browserSessionToStoredSession(handle(original));
        const reconstructed = fromBrowserSession(storedSessionToBrowserSession(stored));
        expectSameSession(reconstructed, original);
    });

    it('derives the freshness window from the EARLIEST cookie expiry (ms) [AC1]', () => {
        const stored = browserSessionToStoredSession(
            handle(
                sampleSession({
                    cookies: [
                        cookie('a', 'a-val', { expires: FUTURE_SECONDS }),
                        cookie('b', 'b-val', { expires: SOONER_SECONDS }), // earliest → bounds the window
                    ],
                }),
            ),
        );
        expect(stored.expiresAt).toBe(SOONER_SECONDS * 1000);
    });

    it('carries no expiresAt when every cookie is a session cookie (no expiry) [AC1]', () => {
        const stored = browserSessionToStoredSession(
            handle(sampleSession({ cookies: [cookie('a', 'a-val', { expires: null })] })),
        );
        expect(stored.expiresAt).toBeUndefined();
    });

    it('round-trips a pasted session that has no originating browser [AC1]', () => {
        const pasted: BrowserSession = {
            domain: DOMAIN,
            cookies: [cookie('s', SESSION_VALUE, { expires: FUTURE_SECONDS })],
        };
        const reconstructed = fromBrowserSession(
            storedSessionToBrowserSession(browserSessionToStoredSession(handle(pasted))),
        );
        expect(reconstructed.browser).toBeUndefined();
        expectSameSession(reconstructed, pasted);
    });

    it('keeps cookie values fenced: the StoredSession redacts under String / JSON.stringify [Secret fence]', () => {
        const stored = browserSessionToStoredSession(handle(sampleSession()));
        expect(String(stored.token)).toBe('[redacted]');
        expect(JSON.stringify(stored)).not.toContain(SESSION_VALUE);
        expect(JSON.stringify(stored)).not.toContain(CSRF_VALUE);
        // The value is reachable only via the explicit expose() the bridge uses at the persistence boundary.
        expect(stored.token.expose()).toContain(SESSION_VALUE);
    });

    it('rejects a token whose inner shape is not a packed browser session [malformed]', () => {
        expect(() => storedSessionToBrowserSession({ token: new Secret('not json at all') })).toThrow(
            SessionStoreError,
        );
        expect(() => storedSessionToBrowserSession({ token: new Secret('{"token":"a-bearer"}') })).toThrow(
            SessionStoreError,
        );
        try {
            storedSessionToBrowserSession({ token: new Secret('{"token":"bearer-SENTINEL"}') });
        } catch (error) {
            expect((error as Error).message).not.toContain('SENTINEL'); // value-free error
        }
    });
});

describe('reuseOrImportBrowserSession — resolve an imported session through session-reuse [AC2]', () => {
    /** An importFresh that fails the test if invoked — proves the browser read was skipped. */
    const importMustNotRun = (): AuthHandle => {
        throw new Error('importFresh must not be called when a stored session resolves the request');
    };

    it('reuses a still-fresh stored session WITHOUT importing (skips the browser read) [AC1][reuse]', async () => {
        const store = new KeyringSessionStore(new InMemoryKeyring());
        await store.save(DOMAIN, browserSessionToStoredSession(handle(sampleSession())));

        const resolution = await reuseOrImportBrowserSession({
            store,
            detector: new ReauthDetector(),
            key: DOMAIN,
            domain: DOMAIN,
            importFresh: importMustNotRun,
        });

        expect(resolution.outcome).toBe('reused');
        if (resolution.outcome === 'reused') {
            expectSameSession(fromBrowserSession(resolution.auth), sampleSession());
        }
    });

    it('imports AND persists when nothing is stored, so the next run reuses it [AC1][absent]', async () => {
        const store = new KeyringSessionStore(new InMemoryKeyring());
        let imports = 0;
        const importFresh = (): AuthHandle => {
            imports += 1;
            return handle(sampleSession());
        };

        const first = await reuseOrImportBrowserSession({
            store,
            detector: new ReauthDetector(),
            key: DOMAIN,
            domain: DOMAIN,
            importFresh,
        });
        expect(first.outcome).toBe('imported');
        expect(imports).toBe(1);
        // It persisted: a second call reuses the stored session without importing again.
        const second = await reuseOrImportBrowserSession({
            store,
            detector: new ReauthDetector(),
            key: DOMAIN,
            domain: DOMAIN,
            importFresh,
        });
        expect(second.outcome).toBe('reused');
        expect(imports).toBe(1);
    });

    it('reports reauth-required for a stored session past its freshness window — no import [reauth-required]', async () => {
        const store = new KeyringSessionStore(new InMemoryKeyring());
        await store.save(
            DOMAIN,
            browserSessionToStoredSession(
                handle(
                    sampleSession({ cookies: [cookie('s', SESSION_VALUE, { expires: Math.floor(PAST_MS / 1000) })] }),
                ),
            ),
        );

        const resolution = await reuseOrImportBrowserSession({
            store,
            detector: new ReauthDetector(),
            key: DOMAIN,
            domain: DOMAIN,
            importFresh: importMustNotRun,
        });

        expect(resolution.outcome).toBe('reauth-required');
        if (resolution.outcome === 'reauth-required') {
            expect(resolution.error).toBeInstanceOf(ReauthRequiredError);
            expect(resolution.error.domain).toBe(DOMAIN);
            expect(resolution.error.message).not.toContain(SESSION_VALUE);
        }
    });
});

describe('at rest — encrypted, never plaintext [AC3]', () => {
    it('persists the session as an AES-256-GCM envelope with no plaintext cookie value on disk', async () => {
        const dir = freshDir();
        const store: SessionStore = new EncryptedFileSessionStore({ dir, passphraseProvider: () => 'test-passphrase' });

        await store.save(DOMAIN, browserSessionToStoredSession(handle(sampleSession())));

        // Inspect the on-disk bytes: they must be ciphertext, never the plaintext cookie sentinels.
        const files = readdirSync(dir).filter((name) => name.endsWith('.session'));
        expect(files).toHaveLength(1);
        const onDisk = readFileSync(join(dir, files[0]!), 'utf8');
        expect(onDisk).not.toContain(SESSION_VALUE);
        expect(onDisk).not.toContain(CSRF_VALUE);
        const envelope = JSON.parse(onDisk) as Record<string, unknown>;
        expect(envelope).toMatchObject({ v: 1 });
        expect(typeof envelope.salt).toBe('string');
        expect(typeof envelope.iv).toBe('string');
        expect(typeof envelope.tag).toBe('string');
        expect(typeof envelope.ciphertext).toBe('string');

        // And it decrypts back to the same session (proves the ciphertext is the real session, not a stub).
        const loaded = await store.load(DOMAIN);
        expect(loaded).toBeDefined();
        expectSameSession(fromBrowserSession(storedSessionToBrowserSession(loaded!)), sampleSession());
    });

    it('round-trips the reuse flow through an encrypted-file store [AC1][AC3]', async () => {
        const dir = freshDir();
        const detector = new ReauthDetector();
        const opts = {
            store: new EncryptedFileSessionStore({ dir, passphraseProvider: () => 'pw' }),
            detector,
            key: DOMAIN,
            domain: DOMAIN,
        };

        const imported = await reuseOrImportBrowserSession({ ...opts, importFresh: () => handle(sampleSession()) });
        expect(imported.outcome).toBe('imported');

        const reused = await reuseOrImportBrowserSession({
            ...opts,
            importFresh: () => {
                throw new Error('must reuse the encrypted-file session, not re-import');
            },
        });
        expect(reused.outcome).toBe('reused');
        if (reused.outcome === 'reused') {
            expectSameSession(fromBrowserSession(reused.auth), sampleSession());
        }
    });
});
