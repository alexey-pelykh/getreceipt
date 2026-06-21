// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import type { CredentialValue } from './config.js';
import { CredentialBackendUnavailableError, CredentialResolutionError } from './errors.js';
import { openEnvelope } from './secret-envelope.js';
import { Secret } from './secret.js';

/** The env var an unattended run reads to unlock `encrypted-file:` credentials. */
export const ENCRYPTED_FILE_PASSPHRASE_ENV = 'GETRECEIPT_SECRET_PASSPHRASE';

const OP_SCHEME = 'op://';
const ENCRYPTED_FILE_SCHEME = 'encrypted-file:';

/** The subset of a spawned command's outcome the resolver classifies. Injectable so the `op://` path is testable without the CLI. */
export interface CommandResult {
    /** Set when the process could not be spawned at all (e.g. ENOENT — the binary is missing). */
    readonly spawnError?: NodeJS.ErrnoException;
    /** Exit status, or null if the process never spawned / was killed by a signal. */
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

/** Runs a command to completion and returns its {@link CommandResult}. The seam the `op://` backend is injected through. */
export type CommandRunner = (command: string, args: readonly string[]) => CommandResult;

/** Supplies the encrypted-file passphrase, or undefined when none is configured. */
export type PassphraseProvider = () => string | undefined;

/** Production {@link CommandRunner}: a thin `spawnSync` wrapper, mirroring the repo idiom (see `@getreceipt/release` idempotency). */
export const defaultCommandRunner: CommandRunner = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    const base = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    return result.error ? { ...base, spawnError: result.error } : base;
};

/** Construction-time dependencies; each has a production default, so `new CredentialResolver()` works as-is. */
export interface CredentialResolverOptions {
    /** Runs the 1Password CLI. Defaults to a `spawnSync` runner. */
    readonly commandRunner?: CommandRunner;
    /** Supplies the encrypted-file passphrase. Defaults to reading {@link ENCRYPTED_FILE_PASSPHRASE_ENV}. */
    readonly passphraseProvider?: PassphraseProvider;
}

/**
 * Resolves a configured {@link CredentialValue} to a {@link Secret} at call-time,
 * across three backends — selected by the reference's shape and scheme:
 *
 *  - an inline string literal → `rawtext` (discouraged; the value is taken as-is);
 *  - `{ ref: 'op://…' }` → the 1Password CLI (`op read`);
 *  - `{ ref: 'encrypted-file:<path>' }` → an AES-256-GCM file unlocked by a passphrase.
 *
 * The resolved value is ALWAYS returned wrapped in a {@link Secret}; it is never
 * logged and never placed in an error. Failures are typed:
 * {@link CredentialBackendUnavailableError} (backend absent) is distinct from
 * {@link CredentialResolutionError} (backend present, but the reference could not
 * be resolved).
 *
 * `resolve` is async to keep a stable I/O-shaped contract (future SDK / remote
 * backends); the 0.1.0 backends happen to be synchronous under the hood.
 */
export class CredentialResolver {
    readonly #runCommand: CommandRunner;
    readonly #passphrase: PassphraseProvider;

    constructor(options: CredentialResolverOptions = {}) {
        this.#runCommand = options.commandRunner ?? defaultCommandRunner;
        this.#passphrase = options.passphraseProvider ?? (() => process.env[ENCRYPTED_FILE_PASSPHRASE_ENV]);
    }

    /** Resolve a credential reference to its secret value. */
    async resolve(credential: CredentialValue): Promise<Secret> {
        if (typeof credential === 'string') {
            // Inline rawtext: the literal IS the value. Discouraged, but supported.
            return new Secret(credential);
        }
        const { ref } = credential;
        if (ref.startsWith(OP_SCHEME)) {
            return this.#resolveOnePassword(ref);
        }
        if (ref.startsWith(ENCRYPTED_FILE_SCHEME)) {
            return this.#resolveEncryptedFile(ref);
        }
        throw new CredentialResolutionError(
            // Name the supported forms, but NEVER echo the reference itself — a misused `{ ref }` could hold secret material.
            'unsupported credential reference scheme; expected an inline literal, "op://…", or "encrypted-file:<path>"',
            'unsupported-scheme',
        );
    }

    #resolveOnePassword(ref: string): Secret {
        const result = this.#runCommand('op', ['read', '--no-newline', ref]);
        return classifyOnePasswordResult(ref, result);
    }

    #resolveEncryptedFile(ref: string): Secret {
        const passphrase = this.#passphrase();
        if (passphrase === undefined || passphrase.length === 0) {
            throw new CredentialBackendUnavailableError(
                `no passphrase configured to unlock encrypted-file credentials; set ${ENCRYPTED_FILE_PASSPHRASE_ENV}`,
                'encrypted-file',
            );
        }
        const path = ref.slice(ENCRYPTED_FILE_SCHEME.length);
        let serialized: string;
        try {
            serialized = readFileSync(path, 'utf8');
        } catch {
            throw new CredentialResolutionError(`encrypted-file credential not found at ${path}`, 'not-found');
        }
        const opened = openEnvelope(serialized, passphrase);
        if (!opened.ok) {
            throw new CredentialResolutionError(
                opened.reason === 'malformed'
                    ? `encrypted-file envelope at ${path} is malformed or an unsupported version`
                    : `encrypted-file credential at ${path} could not be decrypted (wrong passphrase or corrupt file)`,
                'decryption-failed',
            );
        }
        return new Secret(opened.plaintext);
    }
}

/**
 * Classify `op read`'s outcome into a {@link Secret} or a typed error. Pure (no I/O),
 * so the resolver's `op://` branch is fully exercisable via an injected runner — and it
 * never places the command's stdout (the secret, on success) into an error.
 */
function classifyOnePasswordResult(ref: string, result: CommandResult): Secret {
    if (result.spawnError !== undefined) {
        if (result.spawnError.code === 'ENOENT') {
            throw new CredentialBackendUnavailableError(
                'the 1Password CLI (`op`) is not installed or not on PATH',
                'op',
            );
        }
        throw new CredentialBackendUnavailableError(
            `the 1Password CLI (\`op\`) could not be started (${result.spawnError.code ?? 'unknown error'})`,
            'op',
        );
    }
    if (result.status === 0) {
        // `--no-newline` → stdout is exactly the secret. Wrap immediately; never log it.
        return new Secret(result.stdout);
    }
    if (looksLikeNotSignedIn(result.stderr)) {
        throw new CredentialResolutionError(
            `not signed in to 1Password; run \`op signin\` before resolving ${ref}`,
            'not-authenticated',
        );
    }
    throw new CredentialResolutionError(`1Password could not resolve the reference ${ref}`, 'not-found');
}

/** Heuristic over `op`'s stderr: does a non-zero exit look like an auth problem (vs a missing item)? */
function looksLikeNotSignedIn(stderr: string): boolean {
    return /sign.?in|signed in|not currently|authenticat|authoriz|session/i.test(stderr);
}
