// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    CredentialBackendUnavailableError,
    CredentialResolutionError,
    CredentialResolver,
    ENCRYPTED_FILE_PASSPHRASE_ENV,
    Secret,
    sealEnvelope,
} from './index.js';
import type { CommandResult, CommandRunner } from './index.js';
// defaultCommandRunner is the production seam; exercise it directly against real processes (never the real `op`).
import { defaultCommandRunner } from './credential-resolver.js';

/** A CommandRunner that always returns a fixed result — lets the op:// path be tested without the real CLI. */
function fixedRunner(result: CommandResult): CommandRunner {
    return () => result;
}

describe('CredentialResolver — rawtext (inline literal)', () => {
    it('resolves an inline literal to a Secret carrying that value', async () => {
        const secret = await new CredentialResolver().resolve('inline-password');
        expect(secret).toBeInstanceOf(Secret);
        expect(secret.expose()).toBe('inline-password');
    });
});

describe('CredentialResolver — op:// (1Password CLI)', () => {
    const ref = 'op://Private/Free/password';

    it('resolves a reference by reading it from the 1Password CLI', async () => {
        const resolver = new CredentialResolver({
            commandRunner: fixedRunner({ status: 0, stdout: 'op-secret-value', stderr: '' }),
        });
        expect((await resolver.resolve({ ref })).expose()).toBe('op-secret-value');
    });

    it('invokes `op read --no-newline <ref>`', async () => {
        const calls: Array<{ command: string; args: readonly string[] }> = [];
        const resolver = new CredentialResolver({
            commandRunner: (command, args) => {
                calls.push({ command, args });
                return { status: 0, stdout: 'v', stderr: '' };
            },
        });
        await resolver.resolve({ ref });
        expect(calls).toEqual([{ command: 'op', args: ['read', '--no-newline', ref] }]);
    });

    // AC2: "CLI missing" and "not signed in" must be DISTINCT typed errors. The next two tests assert the
    // actual classes (not just a matching shape) and that they differ.
    it('throws a distinct, typed CredentialBackendUnavailableError when the op CLI is missing (ENOENT)', async () => {
        const enoent: NodeJS.ErrnoException = Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' });
        const resolver = new CredentialResolver({
            commandRunner: fixedRunner({ spawnError: enoent, status: null, stdout: '', stderr: '' }),
        });
        let caught: unknown;
        try {
            await resolver.resolve({ ref });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(CredentialBackendUnavailableError);
        expect((caught as CredentialBackendUnavailableError).backend).toBe('op');
    });

    it('throws a distinct CredentialResolutionError(not-authenticated) when not signed in — NOT the CLI-missing type', async () => {
        const resolver = new CredentialResolver({
            commandRunner: fixedRunner({
                status: 1,
                stdout: '',
                stderr: '[ERROR] you are not currently signed in. Please run `op signin`.',
            }),
        });
        let caught: unknown;
        try {
            await resolver.resolve({ ref });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(CredentialResolutionError);
        expect(caught).not.toBeInstanceOf(CredentialBackendUnavailableError);
        expect((caught as CredentialResolutionError).reason).toBe('not-authenticated');
    });

    it('throws CredentialResolutionError(not-found) when the item does not exist', async () => {
        const resolver = new CredentialResolver({
            commandRunner: fixedRunner({
                status: 1,
                stdout: '',
                stderr: `[ERROR] "${ref}" isn't an item. Specify the item with its ID or name.`,
            }),
        });
        await expect(resolver.resolve({ ref })).rejects.toMatchObject({
            name: 'CredentialResolutionError',
            reason: 'not-found',
        });
    });

    it('keeps the resolved value out of every serialization of the returned Secret', async () => {
        const resolver = new CredentialResolver({
            commandRunner: fixedRunner({ status: 0, stdout: 'TOPSECRET', stderr: '' }),
        });
        const secret = await resolver.resolve({ ref });
        expect(JSON.stringify(secret)).not.toContain('TOPSECRET');
        expect(String(secret)).not.toContain('TOPSECRET');
    });
});

describe('defaultCommandRunner (real spawnSync, never the real `op`)', () => {
    it('captures status 0 and stdout from a real successful command', () => {
        const result = defaultCommandRunner(process.execPath, ['--version']);
        expect(result.spawnError).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('v'); // node prints e.g. "v24.3.0"
    });

    it('reports a spawnError with code ENOENT for a missing binary', () => {
        const result = defaultCommandRunner('getreceipt-definitely-not-a-real-binary', ['--nope']);
        expect(result.spawnError?.code).toBe('ENOENT');
    });
});

describe('CredentialResolver — encrypted-file', () => {
    const passphrase = 'unit-test-passphrase';
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'gr-cred-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function writeEncrypted(name: string, plaintext: string, withPassphrase = passphrase): string {
        const path = join(dir, name);
        writeFileSync(path, sealEnvelope(plaintext, withPassphrase), 'utf8');
        return path;
    }

    it('decrypts an encrypted-file credential with the configured passphrase (real crypto + real fs)', async () => {
        const path = writeEncrypted('free.enc', 'decrypted-secret-value');
        const resolver = new CredentialResolver({ passphraseProvider: () => passphrase });
        expect((await resolver.resolve({ ref: `encrypted-file:${path}` })).expose()).toBe('decrypted-secret-value');
    });

    it('reads the passphrase from the default env var when no provider is given', async () => {
        const path = writeEncrypted('env.enc', 'env-unlocked-secret');
        const previous = process.env[ENCRYPTED_FILE_PASSPHRASE_ENV];
        process.env[ENCRYPTED_FILE_PASSPHRASE_ENV] = passphrase;
        try {
            const secret = await new CredentialResolver().resolve({ ref: `encrypted-file:${path}` });
            expect(secret.expose()).toBe('env-unlocked-secret');
        } finally {
            if (previous === undefined) {
                delete process.env[ENCRYPTED_FILE_PASSPHRASE_ENV];
            } else {
                process.env[ENCRYPTED_FILE_PASSPHRASE_ENV] = previous;
            }
        }
    });

    it('throws CredentialBackendUnavailableError when no passphrase is configured', async () => {
        const path = writeEncrypted('np.enc', 'whatever');
        const resolver = new CredentialResolver({ passphraseProvider: () => undefined });
        await expect(resolver.resolve({ ref: `encrypted-file:${path}` })).rejects.toMatchObject({
            name: 'CredentialBackendUnavailableError',
            backend: 'encrypted-file',
        });
    });

    it('throws CredentialResolutionError(decryption-failed) for the wrong passphrase', async () => {
        const path = writeEncrypted('wrong.enc', 'secret');
        const resolver = new CredentialResolver({ passphraseProvider: () => 'the-wrong-passphrase' });
        await expect(resolver.resolve({ ref: `encrypted-file:${path}` })).rejects.toMatchObject({
            name: 'CredentialResolutionError',
            reason: 'decryption-failed',
        });
    });

    it('throws CredentialResolutionError(not-found) when the file is missing', async () => {
        const resolver = new CredentialResolver({ passphraseProvider: () => passphrase });
        await expect(resolver.resolve({ ref: `encrypted-file:${join(dir, 'missing.enc')}` })).rejects.toMatchObject({
            name: 'CredentialResolutionError',
            reason: 'not-found',
        });
    });

    it('throws CredentialResolutionError(decryption-failed) for a malformed envelope', async () => {
        const path = join(dir, 'malformed.enc');
        writeFileSync(path, 'this is not an envelope', 'utf8');
        const resolver = new CredentialResolver({ passphraseProvider: () => passphrase });
        await expect(resolver.resolve({ ref: `encrypted-file:${path}` })).rejects.toMatchObject({
            name: 'CredentialResolutionError',
            reason: 'decryption-failed',
        });
    });

    it('never leaks the plaintext into a decryption error', async () => {
        const plaintext = 'LEAK-CANARY-encfile';
        const path = writeEncrypted('canary.enc', plaintext);
        const resolver = new CredentialResolver({ passphraseProvider: () => 'wrong' });
        let caught: unknown;
        try {
            await resolver.resolve({ ref: `encrypted-file:${path}` });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(CredentialResolutionError);
        expect((caught as Error).message).not.toContain(plaintext);
    });
});

describe('CredentialResolver — unsupported scheme', () => {
    it('rejects an unknown reference scheme with a typed error that never echoes the reference', async () => {
        const ref = 'vault://team/SUPER-SECRET-do-not-echo';
        let caught: unknown;
        try {
            await new CredentialResolver().resolve({ ref });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(CredentialResolutionError);
        expect((caught as CredentialResolutionError).reason).toBe('unsupported-scheme');
        // Names the supported forms, but never echoes the (possibly misused) reference — defense-in-depth for AC1.
        expect((caught as Error).message).toContain('op://');
        expect((caught as Error).message).not.toContain('vault');
        expect((caught as Error).message).not.toContain('SUPER-SECRET-do-not-echo');
    });
});
