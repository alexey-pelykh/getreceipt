// SPDX-License-Identifier: AGPL-3.0-only
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ENCRYPTED_FILE_PASSPHRASE_ENV } from './credential-resolver.js';
import type { PassphraseProvider } from './credential-resolver.js';
import { SessionStoreError } from './errors.js';
import { openEnvelope, sealEnvelope } from './secret-envelope.js';
import { deserializeSession, serializeSession } from './session.js';
import type { SessionStore, StoredSession } from './session.js';

/** Session files are credential material: owner read/write only — the same posture the receipt writer pins. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const SESSION_EXTENSION = '.session';

/**
 * The OS keyring seam: a namespaced string→string secret map (the macOS Keychain,
 * the Linux Secret Service, and the Windows Credential Manager all fit). Abstracted as
 * a port — exactly as the credential resolver abstracts the 1Password CLI behind a
 * `CommandRunner` — so {@link KeyringSessionStore} is provable without a native module,
 * and the production OS binding can land with the `login` / `logout` verbs.
 */
export interface Keyring {
    get(account: string): Promise<string | undefined>;
    set(account: string, secret: string): Promise<void>;
    delete(account: string): Promise<void>;
}

/**
 * An in-process {@link Keyring} backed by a Map: the test double, and the contract a
 * production OS binding will satisfy. It does NOT itself encrypt — entries are held in
 * cleartext for the process lifetime; at-rest encryption is the OS keychain's job, which
 * the future binding delegates to. {@link EncryptedFileSessionStore} is the path that
 * demonstrates at-rest encryption directly, in this changeset.
 */
export class InMemoryKeyring implements Keyring {
    readonly #entries = new Map<string, string>();

    async get(account: string): Promise<string | undefined> {
        return this.#entries.get(account);
    }

    async set(account: string, secret: string): Promise<void> {
        this.#entries.set(account, secret);
    }

    async delete(account: string): Promise<void> {
        this.#entries.delete(account);
    }
}

/**
 * A {@link SessionStore} backed by an OS {@link Keyring}. Encryption at rest is the
 * keyring's responsibility — the OS keychain encrypts its own store — so this layer
 * only serializes the session in and out. The serialized form carries the exposed
 * token, so it is handed straight to the keyring and never logged.
 */
export class KeyringSessionStore implements SessionStore {
    readonly #keyring: Keyring;

    constructor(keyring: Keyring) {
        this.#keyring = keyring;
    }

    async load(key: string): Promise<StoredSession | undefined> {
        const serialized = await this.#keyring.get(key);
        if (serialized === undefined) {
            return undefined;
        }
        const session = deserializeSession(serialized);
        if (session === undefined) {
            throw new SessionStoreError(`stored session for "${key}" is malformed`, 'malformed');
        }
        return session;
    }

    async save(key: string, session: StoredSession): Promise<void> {
        await this.#keyring.set(key, serializeSession(session));
    }

    async delete(key: string): Promise<void> {
        await this.#keyring.delete(key);
    }
}

/** Construction-time dependencies for {@link EncryptedFileSessionStore}; the passphrase has a production default. */
export interface EncryptedFileSessionStoreOptions {
    /** Directory the per-key `<key>.session` envelopes live under. */
    readonly dir: string;
    /** Supplies the passphrase that seals / opens envelopes. Defaults to reading {@link ENCRYPTED_FILE_PASSPHRASE_ENV}. */
    readonly passphraseProvider?: PassphraseProvider;
}

/**
 * The fallback {@link SessionStore} for when no OS keyring is available (headless / CI
 * / unattended): each session is sealed into an AES-256-GCM envelope
 * ({@link sealEnvelope}) and written `0600`, unlocked by the same
 * {@link ENCRYPTED_FILE_PASSPHRASE_ENV} passphrase the credential resolver uses for
 * `encrypted-file:` credentials — so a run already configured to unlock credentials
 * unlocks sessions too. The on-disk bytes are ciphertext; the token never reaches the
 * disk in cleartext.
 */
export class EncryptedFileSessionStore implements SessionStore {
    readonly #dir: string;
    readonly #passphrase: PassphraseProvider;

    constructor(options: EncryptedFileSessionStoreOptions) {
        this.#dir = options.dir;
        this.#passphrase = options.passphraseProvider ?? (() => process.env[ENCRYPTED_FILE_PASSPHRASE_ENV]);
    }

    async load(key: string): Promise<StoredSession | undefined> {
        const passphrase = this.#requirePassphrase();
        let serialized: string;
        try {
            serialized = await readFile(this.#pathFor(key), 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return undefined; // nothing stored for this key
            }
            throw error;
        }
        const opened = openEnvelope(serialized, passphrase);
        if (!opened.ok) {
            throw new SessionStoreError(
                opened.reason === 'malformed'
                    ? `session envelope for "${key}" is malformed or an unsupported version`
                    : `session for "${key}" could not be decrypted (wrong passphrase or corrupt file)`,
                opened.reason,
            );
        }
        const session = deserializeSession(opened.plaintext);
        if (session === undefined) {
            throw new SessionStoreError(`decrypted session for "${key}" is malformed`, 'malformed');
        }
        return session;
    }

    async save(key: string, session: StoredSession): Promise<void> {
        const passphrase = this.#requirePassphrase();
        const sealed = sealEnvelope(serializeSession(session), passphrase);
        await mkdir(this.#dir, { recursive: true, mode: DIR_MODE });
        const path = this.#pathFor(key);
        await writeFile(path, sealed, { mode: FILE_MODE });
        await chmod(path, FILE_MODE); // pin perms in case umask cleared bits at create time
    }

    async delete(key: string): Promise<void> {
        await rm(this.#pathFor(key), { force: true });
    }

    #pathFor(key: string): string {
        return join(this.#dir, `${sanitizeKey(key)}${SESSION_EXTENSION}`);
    }

    #requirePassphrase(): string {
        const passphrase = this.#passphrase();
        if (passphrase === undefined || passphrase.length === 0) {
            throw new SessionStoreError(
                `no passphrase configured to unlock encrypted-file sessions; set ${ENCRYPTED_FILE_PASSPHRASE_ENV}`,
                'no-passphrase',
            );
        }
        return passphrase;
    }
}

/** Options for {@link createSessionStore}: a keyring selects the primary path; a dir selects the fallback. */
export interface CreateSessionStoreOptions {
    /** When present, the keyring-backed store is selected. */
    readonly keyring?: Keyring;
    /** Directory for the encrypted-file fallback. Required when no keyring is given. */
    readonly dir?: string;
    /** Passphrase provider for the encrypted-file fallback. */
    readonly passphraseProvider?: PassphraseProvider;
}

/**
 * Select a {@link SessionStore}: the keyring-backed store when a {@link Keyring} is
 * available, else the encrypted-file fallback. Realizes the issue's "keyring-backed;
 * encrypted-file fallback" posture in one decision point.
 *
 * @throws {@link SessionStoreError} (`no-backend`) when neither a keyring nor a fallback directory is given.
 */
export function createSessionStore(options: CreateSessionStoreOptions): SessionStore {
    if (options.keyring !== undefined) {
        return new KeyringSessionStore(options.keyring);
    }
    if (options.dir !== undefined) {
        return new EncryptedFileSessionStore({
            dir: options.dir,
            ...(options.passphraseProvider !== undefined ? { passphraseProvider: options.passphraseProvider } : {}),
        });
    }
    throw new SessionStoreError(
        'no session store backend available: provide a keyring or a fallback directory',
        'no-backend',
    );
}

/** Make a store key filesystem-safe: keep `[A-Za-z0-9._-]`, never empty / `.` / `..`. Mirrors the receipt writer's segment guard. */
function sanitizeKey(raw: string): string {
    const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_');
    return cleaned === '' || cleaned === '.' || cleaned === '..' ? '_' : cleaned;
}
