// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    createSessionStore,
    ENCRYPTED_FILE_PASSPHRASE_ENV,
    EncryptedFileSessionStore,
    InMemoryKeyring,
    KeyringSessionStore,
    sealEnvelope,
    Secret,
    SessionStoreError,
} from './index.js';
import type { StoredSession } from './index.js';

const TOKEN = 'store-token-SENTINEL-do-not-leak';
const PASSPHRASE = 'unit-test-session-passphrase';
const session = (overrides: Partial<StoredSession> = {}): StoredSession => ({ token: new Secret(TOKEN), ...overrides });
const itPosix = it.skipIf(process.platform === 'win32');

describe('KeyringSessionStore [AC3]', () => {
    it('round-trips a session through save then load, preserving the fenced token', async () => {
        const store = new KeyringSessionStore(new InMemoryKeyring());
        await store.save('grandfrais.com', session({ expiresAt: 1_900_000_000_000 }));

        const loaded = await store.load('grandfrais.com');
        expect(loaded?.token.expose()).toBe(TOKEN);
        expect(loaded?.expiresAt).toBe(1_900_000_000_000);
    });

    it('returns undefined when nothing is stored for the key', async () => {
        expect(await new KeyringSessionStore(new InMemoryKeyring()).load('absent.example')).toBeUndefined();
    });

    it('deletes a stored session', async () => {
        const store = new KeyringSessionStore(new InMemoryKeyring());
        await store.save('k', session());
        await store.delete('k');
        expect(await store.load('k')).toBeUndefined();
    });

    it('delegates encryption to the keyring — the stored payload is the serialized session', async () => {
        // The OS keyring encrypts at rest; this layer only serializes, so the payload carries the token verbatim.
        const keyring = new InMemoryKeyring();
        await new KeyringSessionStore(keyring).save('k', session());
        expect(await keyring.get('k')).toContain(TOKEN);
    });

    it('throws SessionStoreError(malformed) when the stored payload is not a session', async () => {
        const keyring = new InMemoryKeyring();
        await keyring.set('k', 'not a session at all');
        await expect(new KeyringSessionStore(keyring).load('k')).rejects.toMatchObject({
            name: 'SessionStoreError',
            reason: 'malformed',
        });
    });
});

describe('EncryptedFileSessionStore [AC2][AC3]', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'gr-session-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const store = (): EncryptedFileSessionStore =>
        new EncryptedFileSessionStore({ dir, passphraseProvider: () => PASSPHRASE });

    it('round-trips a session through real AES-256-GCM + real fs', async () => {
        await store().save('grandfrais.com', session({ expiresAt: 1_900_000_000_000, issuedAt: 1_800_000_000_000 }));

        const loaded = await store().load('grandfrais.com');
        expect(loaded?.token.expose()).toBe(TOKEN);
        expect(loaded?.expiresAt).toBe(1_900_000_000_000);
        expect(loaded?.issuedAt).toBe(1_800_000_000_000);
    });

    it('writes a real AES-256-GCM envelope — the token is absent even from the decoded ciphertext [AC2]', async () => {
        await store().save('grandfrais.com', session());
        const raw = readFileSync(join(dir, 'grandfrais.com.session'), 'utf8');
        expect(raw).not.toContain(TOKEN); // not present as a literal substring
        // A genuine sealed envelope — not base64-of-plaintext, which would also pass the substring check above.
        const envelope = JSON.parse(raw) as Record<string, unknown>;
        expect(Object.keys(envelope).sort()).toEqual(['ciphertext', 'iv', 'salt', 'tag', 'v']);
        expect(Buffer.from(envelope.ciphertext as string, 'base64').includes(Buffer.from(TOKEN))).toBe(false);
    });

    itPosix('writes the session file with 0600 permissions [AC2]', async () => {
        await store().save('grandfrais.com', session());
        expect(statSync(join(dir, 'grandfrais.com.session')).mode & 0o777).toBe(0o600);
    });

    it('returns undefined when no session file exists for the key', async () => {
        expect(await store().load('absent.example')).toBeUndefined();
    });

    it('reads the passphrase from the default env var when no provider is given', async () => {
        const previous = process.env[ENCRYPTED_FILE_PASSPHRASE_ENV];
        process.env[ENCRYPTED_FILE_PASSPHRASE_ENV] = PASSPHRASE;
        try {
            const envStore = new EncryptedFileSessionStore({ dir });
            await envStore.save('k', session());
            expect((await envStore.load('k'))?.token.expose()).toBe(TOKEN);
        } finally {
            if (previous === undefined) {
                delete process.env[ENCRYPTED_FILE_PASSPHRASE_ENV];
            } else {
                process.env[ENCRYPTED_FILE_PASSPHRASE_ENV] = previous;
            }
        }
    });

    it('throws SessionStoreError(no-passphrase) when no passphrase is configured', async () => {
        const noPass = new EncryptedFileSessionStore({ dir, passphraseProvider: () => undefined });
        await expect(noPass.save('k', session())).rejects.toMatchObject({
            name: 'SessionStoreError',
            reason: 'no-passphrase',
        });
    });

    it('throws SessionStoreError(decryption-failed) for the wrong passphrase, leaking nothing [AC2]', async () => {
        await store().save('k', session());
        const wrong = new EncryptedFileSessionStore({ dir, passphraseProvider: () => 'the-wrong-passphrase' });
        let caught: unknown;
        try {
            await wrong.load('k');
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(SessionStoreError);
        expect((caught as SessionStoreError).reason).toBe('decryption-failed');
        expect((caught as Error).message).not.toContain(TOKEN);
    });

    it('throws SessionStoreError(malformed) for a file that is not an envelope', async () => {
        writeFileSync(join(dir, 'junk.session'), 'this is not an envelope', 'utf8');
        await expect(store().load('junk')).rejects.toMatchObject({ name: 'SessionStoreError', reason: 'malformed' });
    });

    it('throws SessionStoreError(malformed) when an envelope decrypts to a non-session payload', async () => {
        writeFileSync(
            join(dir, 'wrong.session'),
            sealEnvelope(JSON.stringify({ notASession: true }), PASSPHRASE),
            'utf8',
        );
        await expect(store().load('wrong')).rejects.toMatchObject({ name: 'SessionStoreError', reason: 'malformed' });
    });

    it('deletes a stored session file and is a no-op when already absent', async () => {
        const s = store();
        await s.save('k', session());
        await s.delete('k');
        expect(await s.load('k')).toBeUndefined();
        await expect(s.delete('k')).resolves.toBeUndefined(); // no throw on absent
    });
});

describe('createSessionStore', () => {
    it('selects the keyring-backed store when a keyring is provided [AC3]', () => {
        expect(createSessionStore({ keyring: new InMemoryKeyring() })).toBeInstanceOf(KeyringSessionStore);
    });

    it('falls back to the encrypted-file store when only a dir is provided [AC3]', () => {
        const dir = mkdtempSync(join(tmpdir(), 'gr-session-factory-'));
        try {
            expect(createSessionStore({ dir, passphraseProvider: () => PASSPHRASE })).toBeInstanceOf(
                EncryptedFileSessionStore,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('prefers the keyring over a dir when both are provided', () => {
        const dir = mkdtempSync(join(tmpdir(), 'gr-session-factory-'));
        try {
            expect(createSessionStore({ keyring: new InMemoryKeyring(), dir })).toBeInstanceOf(KeyringSessionStore);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('throws SessionStoreError(no-backend) when neither a keyring nor a dir is given', () => {
        let caught: unknown;
        try {
            createSessionStore({});
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(SessionStoreError);
        expect((caught as SessionStoreError).reason).toBe('no-backend');
    });
});
