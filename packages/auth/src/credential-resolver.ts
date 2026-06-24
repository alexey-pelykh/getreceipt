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

/** A login resolved from a single 1Password item: the username and the secret, each fenced in a {@link Secret}. */
export interface LoginSecrets {
    readonly username: Secret;
    readonly secret: Secret;
}

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

    /**
     * Resolve a single 1Password LOGIN item to its username + secret, via
     * `op item get … --format json` + field-`purpose` matching — the item-level
     * counterpart to {@link resolve} (which reads ONE field via `op read`). One
     * `op://[account/]vault/item` reference yields BOTH credentials. Fields are matched
     * by `purpose` (USERNAME / PASSWORD), NOT by label: browser-autosaved items inherit
     * their label from the HTML input name, so only `purpose` is canonical. The item must
     * be a LOGIN-category item (carries both purposes).
     */
    async resolveLogin(ref: string): Promise<LoginSecrets> {
        const parsed = parseOnePasswordItemRef(ref);
        if (parsed === undefined) {
            throw new CredentialResolutionError(
                // op:// refs are pointers (vault/item names), not secret material — safe to name the expected shape.
                'a single-item login reference must be op://[account/]vault/item — without a /field suffix',
                'unsupported-scheme',
            );
        }
        const args = ['item', 'get', parsed.item, '--vault', parsed.vault];
        if (parsed.account !== undefined) {
            args.push('--account', parsed.account);
        }
        args.push('--format', 'json');
        return classifyOnePasswordItem(ref, this.#runCommand('op', args));
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
    assertOpSpawned(result);
    if (result.status === 0) {
        // `--no-newline` → stdout is exactly the secret. Wrap immediately; never log it.
        return new Secret(result.stdout);
    }
    throw onePasswordFailure(ref, result);
}

/**
 * Classify `op item get --format json`'s outcome into a {@link LoginSecrets} pair, or a typed
 * error. Pure (no I/O). Matches the two credential fields by 1Password `purpose` (USERNAME /
 * PASSWORD), and never places the item's field values (secret material) into an error.
 */
function classifyOnePasswordItem(ref: string, result: CommandResult): LoginSecrets {
    assertOpSpawned(result);
    if (result.status !== 0) {
        throw onePasswordFailure(ref, result);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(result.stdout);
    } catch {
        // Never echo stdout — it carries the item's field values (secrets).
        throw new CredentialResolutionError(`1Password returned an unreadable item for ${ref}`, 'not-found');
    }
    const fields = extractOpFields(parsed);
    const username = fieldValueByPurpose(fields, 'USERNAME');
    const secret = fieldValueByPurpose(fields, 'PASSWORD');
    if (username === undefined || secret === undefined) {
        throw new CredentialResolutionError(
            `1Password item ${ref} is not a login item (no USERNAME and PASSWORD fields); a single-item reference needs a login-category item, or use per-field \`username\`/\`secret\` references`,
            'not-found',
        );
    }
    return { username: new Secret(username), secret: new Secret(secret) };
}

/** Throw a typed backend-unavailable error if `op` could not be spawned at all (missing binary, etc.). Shared by both `op` paths. */
function assertOpSpawned(result: CommandResult): void {
    if (result.spawnError === undefined) {
        return;
    }
    if (result.spawnError.code === 'ENOENT') {
        throw new CredentialBackendUnavailableError('the 1Password CLI (`op`) is not installed or not on PATH', 'op');
    }
    throw new CredentialBackendUnavailableError(
        `the 1Password CLI (\`op\`) could not be started (${result.spawnError.code ?? 'unknown error'})`,
        'op',
    );
}

/** Map a non-zero `op` exit to a typed resolution error — auth problem vs unresolved reference. Shared by both `op` paths; an op:// ref is a pointer, never secret material. */
function onePasswordFailure(ref: string, result: CommandResult): CredentialResolutionError {
    if (looksLikeNotSignedIn(result.stderr)) {
        return new CredentialResolutionError(
            `not signed in to 1Password; run \`op signin\` before resolving ${ref}`,
            'not-authenticated',
        );
    }
    return new CredentialResolutionError(`1Password could not resolve the reference ${ref}`, 'not-found');
}

/** Heuristic over `op`'s stderr: does a non-zero exit look like an auth problem (vs a missing item)? */
function looksLikeNotSignedIn(stderr: string): boolean {
    return /sign.?in|signed in|not currently|authenticat|authoriz|session/i.test(stderr);
}

interface ParsedItemRef {
    readonly account?: string;
    readonly vault: string;
    readonly item: string;
}

/**
 * Parse `op://[account/]vault/item` into its components. Returns undefined for any shape outside
 * the 2-segment (`vault/item`) or 3-segment (`account/vault/item`) grammar — in particular a
 * 4+-segment `op://vault/item/field`, which is a per-field reference (resolved via `op read`),
 * NOT a single-item login reference.
 */
function parseOnePasswordItemRef(ref: string): ParsedItemRef | undefined {
    if (!ref.startsWith(OP_SCHEME)) {
        return undefined;
    }
    const segments = ref.slice(OP_SCHEME.length).split('/');
    if (segments.some((segment) => segment.length === 0)) {
        return undefined;
    }
    if (segments.length === 2) {
        const [vault, item] = segments as [string, string];
        return { vault, item };
    }
    if (segments.length === 3) {
        const [account, vault, item] = segments as [string, string, string];
        return { account, vault, item };
    }
    return undefined;
}

/** One field of an `op item get --format json` payload — only the parts the login resolver reads. */
interface OpItemField {
    readonly purpose: string | undefined;
    readonly value: string | undefined;
}

/**
 * Pull the field array out of `op item get --format json` output, tolerating both the current
 * `{ fields: [...] }` shape and the bare-array shape older `op` CLIs returned.
 */
function extractOpFields(parsed: unknown): OpItemField[] {
    const raw = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.fields) ? parsed.fields : [];
    const fields: OpItemField[] = [];
    for (const entry of raw) {
        if (isRecord(entry)) {
            fields.push({
                purpose: typeof entry.purpose === 'string' ? entry.purpose : undefined,
                value: typeof entry.value === 'string' ? entry.value : undefined,
            });
        }
    }
    return fields;
}

/** The non-empty value of the first field with the given 1Password `purpose` (USERNAME / PASSWORD), or undefined. */
function fieldValueByPurpose(fields: readonly OpItemField[], purpose: string): string | undefined {
    const match = fields.find((field) => field.purpose === purpose);
    return match?.value !== undefined && match.value.length > 0 ? match.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
