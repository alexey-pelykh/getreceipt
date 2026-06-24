// SPDX-License-Identifier: AGPL-3.0-only
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanForSecrets } from '@getreceipt/auth';
import { describe, expect, it } from 'vitest';

import { createConfigCommand } from './config-command.js';
import type { ConfigCommandEnv } from './config-command.js';
import { addGlobalConfigOptions } from './resolve-options.js';

const validFixture = fileURLToPath(new URL('./__fixtures__/valid.getreceipt.yaml', import.meta.url));
const workFixture = fileURLToPath(new URL('./__fixtures__/valid.work.getreceipt.yaml', import.meta.url));
const invalidFixture = fileURLToPath(new URL('./__fixtures__/invalid.getreceipt.yaml', import.meta.url));

/** Selection-aware resolver: `--config` path wins; `--profile work` → the work fixture; else the default valid fixture. */
function fixtureResolver(selection?: { path?: string; profile?: string }): string {
    if (selection?.path !== undefined && selection.path !== '') {
        return selection.path;
    }
    return selection?.profile === 'work' ? workFixture : validFixture;
}

/**
 * Build the `config` command and genuinely execute it through Commander — capturing
 * everything it writes and any non-zero-exit signal — so each test exercises the real
 * parse → action → render path (with the real ConfigLoader #6 unless overridden).
 */
async function runConfig(
    args: string[],
    overrides: Omit<Partial<ConfigCommandEnv>, 'io'> = {},
): Promise<{ out: string; err: string; error: unknown }> {
    const out: string[] = [];
    const err: string[] = [];
    const cmd = createConfigCommand({
        io: { writeOut: (text) => out.push(text), writeErr: (text) => err.push(text) },
        ...overrides,
    });
    // Standalone command tree (not via createProgram): the program adds the global --config/--profile
    // to the root AND every (sub)command, so mirror that on the `config` subcommands here.
    addGlobalConfigOptions(cmd);
    cmd.exitOverride();
    for (const sub of cmd.commands) {
        addGlobalConfigOptions(sub);
        sub.exitOverride();
    }

    let error: unknown;
    try {
        await cmd.parseAsync([...args], { from: 'user' });
    } catch (caught) {
        error = caught;
    }
    return { out: out.join(''), err: err.join(''), error };
}

describe('config show', () => {
    it('masks inline literals and prints references unresolved (default profile)', async () => {
        const { out, err, error } = await runConfig(['show'], { resolveConfigPath: () => validFixture });

        expect(error).toBeUndefined();
        expect(err).toBe('');
        expect(out).toContain('profile: default');
        // op:// reference shown verbatim, NOT resolved.
        expect(out).toContain('op://Personal/free.fr/password');
        // Inline literal masked: placeholder present, raw value absent.
        expect(out).toContain('[redacted]');
        expect(out).not.toContain('inline-token-value');
    });

    it('--profile selects which FILE is shown (the work profile)', async () => {
        const { out, error } = await runConfig(['show', '--profile', 'work'], {
            resolveConfigPath: fixtureResolver,
        });

        expect(error).toBeUndefined();
        expect(out).toContain('profile: work');
        expect(out).toContain('corp.example');
        expect(out).toContain('WORK_PASSWORD');
        expect(out).not.toContain('free.fr');
    });

    it('exits non-zero when the requested profile FILE is missing (per-file model)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'gr-cli-show-missing-'));
        try {
            // --config pins an explicit missing path; show can't read it → exit 1, nothing on stdout.
            const { out, err, error } = await runConfig(['show', '--config', join(dir, 'absent.yaml')]);

            expect(error).toMatchObject({ exitCode: 1 });
            expect(err).toContain('could not be read');
            expect(out).toBe('');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('exits non-zero when the config file cannot be loaded', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'gr-cli-missing-'));
        try {
            const { out, err, error } = await runConfig(['show'], {
                resolveConfigPath: () => join(dir, 'absent.yaml'),
            });
            expect(error).toMatchObject({ exitCode: 1 });
            expect(err).toContain('could not be read');
            expect(out).toBe('');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('config validate', () => {
    it('passes (exit 0) and warns on an inline credential', async () => {
        const { out, err, error } = await runConfig(['validate'], { resolveConfigPath: () => validFixture });

        expect(error).toBeUndefined();
        expect(out).toContain('valid');
        expect(err).toContain('inline literal');
    });

    it('fails (exit 1) with a clear message on an invalid file', async () => {
        const { out, err, error } = await runConfig(['validate'], { resolveConfigPath: () => invalidFixture });

        expect(error).toMatchObject({ exitCode: 1 });
        expect(err).toContain('auth kind');
        expect(out).toBe('');
    });

    it('does not double the config-file path in a file-level error', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'gr-cli-dbl-'));
        const missing = join(dir, 'absent.yaml');
        try {
            const { err } = await runConfig(['validate'], { resolveConfigPath: () => missing });
            expect(err).toContain('could not be read');
            // The path appears exactly once — no `<file>: <file>:` doubling.
            expect(err.split(missing).length - 1).toBe(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('--json emits a structured verdict for a valid file', async () => {
        const { out, err, error } = await runConfig(['validate', '--json'], {
            resolveConfigPath: () => validFixture,
        });

        expect(error).toBeUndefined();
        expect(err).toBe('');
        const verdict = JSON.parse(out) as { valid: boolean; path: string; warnings: unknown[]; error: unknown };
        expect(verdict.valid).toBe(true);
        expect(verdict.path).toBe(validFixture);
        expect(verdict.warnings.length).toBeGreaterThan(0);
        expect(verdict.error).toBeNull();
    });

    it('--json emits a structured verdict and exits 1 for an invalid file', async () => {
        const { out, err, error } = await runConfig(['validate', '--json'], {
            resolveConfigPath: () => invalidFixture,
        });

        expect(error).toMatchObject({ exitCode: 1 });
        expect(err).toBe('');
        const verdict = JSON.parse(out) as { valid: boolean; error: { message: string } | null };
        expect(verdict.valid).toBe(false);
        expect(verdict.error?.message).toContain('auth kind');
    });
});

describe('config path', () => {
    it('reports the resolved path, active profile, and existence', async () => {
        const { out, error } = await runConfig(['path'], { resolveConfigPath: () => validFixture });

        expect(error).toBeUndefined();
        expect(out).toContain(validFixture);
        expect(out).toContain('default');
        expect(out).toContain('yes');
    });

    it('reports the requested profile and absence for a missing file', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'gr-cli-path-'));
        const missing = join(dir, 'absent.yaml');
        try {
            const { out, error } = await runConfig(['path', '--profile', 'work'], {
                resolveConfigPath: () => missing,
            });
            expect(error).toBeUndefined();
            expect(out).toContain(missing);
            expect(out).toContain('work');
            expect(out).toContain('no');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('leakage-lint coverage (#7 over config output)', () => {
    // Assembled at runtime so the secret-shaped literal is never committed contiguously
    // (otherwise the clean-tree scan in @getreceipt/auth would flag this file).
    const stripeShaped = 'sk' + '_live_' + 'A'.repeat(28);

    function writeSecretShapedConfig(): { dir: string; path: string } {
        const dir = mkdtempSync(join(tmpdir(), 'gr-cli-leak-'));
        const path = join(dir, 'config.yaml');
        writeFileSync(
            path,
            ['sources:', '  shop.example:', '    auth:', '      kind: api-token', `      secret: ${stripeShaped}`, ''].join(
                '\n',
            ),
        );
        return { dir, path };
    }

    it('show output carries no secret-shaped value even when the config holds one', async () => {
        const { dir, path } = writeSecretShapedConfig();
        try {
            const { out, err, error } = await runConfig(['show'], { resolveConfigPath: () => path });
            expect(error).toBeUndefined();
            expect(out).not.toContain(stripeShaped);
            expect(scanForSecrets([{ path: 'config-show-stdout', content: out }])).toEqual([]);
            expect(scanForSecrets([{ path: 'config-show-stderr', content: err }])).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('validate output carries no secret-shaped value (paths only, never values)', async () => {
        const { dir, path } = writeSecretShapedConfig();
        try {
            const { out, err } = await runConfig(['validate'], { resolveConfigPath: () => path });
            expect(out).not.toContain(stripeShaped);
            expect(err).not.toContain(stripeShaped);
            expect(scanForSecrets([{ path: 'config-validate-out', content: out + err }])).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('show refuses (exit 1, no value) when a reference is mis-set to a secret-shaped literal', async () => {
        // A reference is a pointer by contract, but nothing stops a user putting a raw secret in it.
        // The runtime backstop must catch that rather than print it verbatim.
        const dir = mkdtempSync(join(tmpdir(), 'gr-cli-refleak-'));
        const path = join(dir, 'config.yaml');
        try {
            writeFileSync(
                path,
                [
                    'sources:',
                    '  shop.example:',
                    '    auth:',
                    '      kind: api-token',
                    '      secret:',
                    `        ref: ${stripeShaped}`,
                    '',
                ].join('\n'),
            );
            const { out, err, error } = await runConfig(['show'], { resolveConfigPath: () => path });
            expect(error).toMatchObject({ exitCode: 1 });
            expect(out).toBe('');
            expect(err).toContain('refusing to print');
            // The refusal names the rule, never the value; nothing secret-shaped reaches any channel.
            expect(err).not.toContain(stripeShaped);
            expect(scanForSecrets([{ path: 'config-show-refusal', content: out + err }])).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('read-only guarantee', () => {
    it('no subcommand writes to disk', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'gr-cli-ro-'));
        const path = join(dir, 'config.yaml');
        copyFileSync(validFixture, path);

        const snapshot = (): { name: string; content: string }[] =>
            readdirSync(dir)
                .sort()
                .map((name) => ({ name, content: readFileSync(join(dir, name), 'utf8') }));

        try {
            const before = snapshot();
            for (const args of [
                ['show'],
                ['show', '--profile', 'work'],
                ['validate'],
                ['validate', '--json'],
                ['path'],
            ]) {
                await runConfig(args, { resolveConfigPath: () => path });
            }
            expect(snapshot()).toEqual(before);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
