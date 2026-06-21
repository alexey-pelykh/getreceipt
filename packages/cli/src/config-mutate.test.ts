// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig, scanForSecrets } from '@getreceipt/auth';
import type { ConfigParseResult } from '@getreceipt/auth';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { createConfigCommand } from './config-command.js';
import type { ConfigCommandEnv } from './config-command.js';

/**
 * Build the `config` command and genuinely execute a mutating sub-verb through Commander — against a
 * REAL temp file on disk (default `writeConfigFile`/`readConfigFileRaw`/`loadConfig` unless a test
 * overrides them) — so each case exercises the real action → fs → re-validate path. The `$EDITOR`
 * spawn is the only seam stubbed by default-bearing tests: a fake `launchEditor` mutates the temp
 * file exactly as a real editor would, keeping the suite child-process-free (the codebase's
 * Windows-flake-avoidance posture; cf. e2e umbrella-bin-smoke / published-tarball dropping spawns).
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
    cmd.exitOverride();
    for (const sub of cmd.commands) {
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

/** A minimal valid config used as a starting / snapshot state for `edit` tests. */
const VALID_CONFIG = [
    'profiles:',
    '  default:',
    '    sources:',
    '      example.com:',
    '        auth:',
    '          kind: password',
    '          secret:',
    '            ref: op://Personal/example.com/password',
    '',
].join('\n');

function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'gr-cli-cfg-'));
}

/** A `launchEditor` seam that simulates an editor by writing `newContent` to the file, then exiting cleanly. */
function editorWriting(newContent: string): ConfigCommandEnv['launchEditor'] {
    return (_editor, path) => {
        writeFileSync(path, newContent);
        return { ok: true, detail: '' };
    };
}

describe('config init', () => {
    it('writes a VALID, parseable starter when no file exists, which `config validate` accepts [AC2]', async () => {
        const dir = tempDir();
        const path = join(dir, '.getreceipt.yaml');
        try {
            const { out, err, error } = await runConfig(['init'], {
                resolveConfigPath: () => path,
                isInteractive: () => false,
            });

            expect(error).toBeUndefined();
            expect(existsSync(path)).toBe(true);
            expect(out).toContain('wrote starter config');
            // The post-write hint goes to stderr (keeping stdout to just the confirmation line).
            expect(err).toContain('Edit it to match your sources');

            // The file genuinely parses + validates (no warnings — the active example uses an op:// ref).
            const result = parseConfig(parseYaml(readFileSync(path, 'utf8')));
            expect(result.config.profiles.default).toBeDefined();
            expect(result.warnings).toEqual([]);

            // …and the read-only `validate` verb, run over the same file, agrees it is valid.
            const validate = await runConfig(['validate'], { resolveConfigPath: () => path });
            expect(validate.error).toBeUndefined();
            expect(validate.out).toContain('valid');

            // Config can hold credentials → written owner-only (0600). Skip on Windows (no POSIX mode bits).
            if (process.platform !== 'win32') {
                expect(statSync(path).mode & 0o777).toBe(0o600);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('refuses to overwrite an existing file without --force, non-interactively (never clobbers) [AC2]', async () => {
        const dir = tempDir();
        const path = join(dir, '.getreceipt.yaml');
        writeFileSync(path, 'sentinel: keep-me\n');
        try {
            const { err, error } = await runConfig(['init'], {
                resolveConfigPath: () => path,
                isInteractive: () => false,
            });

            expect(error).toMatchObject({ exitCode: 1, code: 'getreceipt.config.init-exists' });
            expect(err).toContain('refusing to overwrite');
            // The existing file is untouched.
            expect(readFileSync(path, 'utf8')).toBe('sentinel: keep-me\n');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('overwrites an existing file when --force is given [AC2]', async () => {
        const dir = tempDir();
        const path = join(dir, '.getreceipt.yaml');
        writeFileSync(path, 'sentinel: replace-me\n');
        try {
            const { error } = await runConfig(['init', '--force'], {
                resolveConfigPath: () => path,
                isInteractive: () => false,
            });

            expect(error).toBeUndefined();
            const result = parseConfig(parseYaml(readFileSync(path, 'utf8')));
            expect(result.config.profiles.default).toBeDefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('prompts before overwriting when interactive — overwrites on yes [AC2]', async () => {
        const dir = tempDir();
        const path = join(dir, '.getreceipt.yaml');
        writeFileSync(path, 'sentinel: replace-me\n');
        try {
            const { error } = await runConfig(['init'], {
                resolveConfigPath: () => path,
                isInteractive: () => true,
                confirm: () => Promise.resolve(true),
            });

            expect(error).toBeUndefined();
            expect(parseConfig(parseYaml(readFileSync(path, 'utf8'))).config.profiles.default).toBeDefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('prompts before overwriting when interactive — aborts on no, leaving the file intact [AC2]', async () => {
        const dir = tempDir();
        const path = join(dir, '.getreceipt.yaml');
        writeFileSync(path, 'sentinel: keep-me\n');
        try {
            const { err, error } = await runConfig(['init'], {
                resolveConfigPath: () => path,
                isInteractive: () => true,
                confirm: () => Promise.resolve(false),
            });

            expect(error).toMatchObject({ exitCode: 1, code: 'getreceipt.config.init-declined' });
            expect(err).toContain('aborted');
            expect(readFileSync(path, 'utf8')).toBe('sentinel: keep-me\n');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('keys the scaffold by --profile', async () => {
        const dir = tempDir();
        const path = join(dir, '.getreceipt.yaml');
        try {
            const { error } = await runConfig(['init', '--profile', 'work'], {
                resolveConfigPath: () => path,
                isInteractive: () => false,
            });

            expect(error).toBeUndefined();
            const result = parseConfig(parseYaml(readFileSync(path, 'utf8')));
            expect(result.config.profiles.work).toBeDefined();
            expect(result.config.profiles.default).toBeUndefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('config edit', () => {
    it('re-validates on save; a valid edit is persisted [AC1]', async () => {
        const dir = tempDir();
        const path = join(dir, '.getreceipt.yaml');
        writeFileSync(path, VALID_CONFIG);
        const edited = VALID_CONFIG.replace('example.com', 'shop.example');
        try {
            const { out, error } = await runConfig(['edit'], {
                resolveConfigPath: () => path,
                resolveEditor: () => 'fake-editor',
                launchEditor: editorWriting(edited),
            });

            expect(error).toBeUndefined();
            expect(out).toContain('configuration is valid');
            expect(readFileSync(path, 'utf8')).toBe(edited);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('refuses to persist an INVALID edit and round-trips to the previous content [AC1]', async () => {
        const dir = tempDir();
        const path = join(dir, '.getreceipt.yaml');
        writeFileSync(path, VALID_CONFIG);
        const broken = [
            'profiles:',
            '  default:',
            '    sources:',
            '      example.com:',
            '        auth:',
            '          kind: not-a-real-kind',
            '',
        ].join('\n');
        try {
            const { err, error } = await runConfig(['edit'], {
                resolveConfigPath: () => path,
                resolveEditor: () => 'fake-editor',
                launchEditor: editorWriting(broken),
            });

            expect(error).toMatchObject({ exitCode: 1, code: 'getreceipt.config.edit-invalid' });
            expect(err).toContain('auth kind');
            expect(err).toContain('restored');
            // Round-trip: the on-disk file is the pre-edit content, never the broken edit.
            expect(readFileSync(path, 'utf8')).toBe(VALID_CONFIG);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('refuses when there is no file to edit, guiding the user to `config init` [AC1]', async () => {
        const dir = tempDir();
        const path = join(dir, 'absent.yaml');
        try {
            const { err, error } = await runConfig(['edit'], {
                resolveConfigPath: () => path,
                resolveEditor: () => 'fake-editor',
            });

            expect(error).toMatchObject({ exitCode: 1, code: 'getreceipt.config.edit-missing' });
            expect(err).toContain('config init');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('refuses when no editor is configured', async () => {
        const dir = tempDir();
        const path = join(dir, '.getreceipt.yaml');
        writeFileSync(path, VALID_CONFIG);
        try {
            const { err, error } = await runConfig(['edit'], {
                resolveConfigPath: () => path,
                resolveEditor: () => undefined,
            });

            expect(error).toMatchObject({ exitCode: 1, code: 'getreceipt.config.edit-no-editor' });
            expect(err).toContain('EDITOR');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('aborts without validating when the editor exits non-zero, leaving the file untouched [AC1]', async () => {
        const dir = tempDir();
        const path = join(dir, '.getreceipt.yaml');
        writeFileSync(path, VALID_CONFIG);
        try {
            const { err, error } = await runConfig(['edit'], {
                resolveConfigPath: () => path,
                resolveEditor: () => 'fake-editor',
                launchEditor: () => ({ ok: false, detail: 'editor exited with code 1' }),
            });

            expect(error).toMatchObject({ exitCode: 1, code: 'getreceipt.config.edit-editor-failed' });
            expect(err).toContain('exited with code 1');
            expect(readFileSync(path, 'utf8')).toBe(VALID_CONFIG);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('restores the snapshot if the editor writes then exits non-zero (never leaves a half-finished edit) [AC1]', async () => {
        const dir = tempDir();
        const path = join(dir, '.getreceipt.yaml');
        writeFileSync(path, VALID_CONFIG);
        try {
            const { err, error } = await runConfig(['edit'], {
                resolveConfigPath: () => path,
                resolveEditor: () => 'fake-editor',
                // Simulate an editor that mangles the file and THEN crashes (non-zero exit).
                launchEditor: (_editor, p) => {
                    writeFileSync(p, 'profiles: {} # half-written garbage\n');
                    return { ok: false, detail: 'editor terminated by signal SIGKILL' };
                },
            });

            expect(error).toMatchObject({ exitCode: 1, code: 'getreceipt.config.edit-editor-failed' });
            expect(err).toContain('left unchanged');
            // The half-written bytes are rolled back to the pre-edit content.
            expect(readFileSync(path, 'utf8')).toBe(VALID_CONFIG);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('warns when --profile is not present after the edit (but still succeeds)', async () => {
        const dir = tempDir();
        const path = join(dir, '.getreceipt.yaml');
        writeFileSync(path, VALID_CONFIG);
        try {
            const { out, err, error } = await runConfig(['edit', '--profile', 'work'], {
                resolveConfigPath: () => path,
                resolveEditor: () => 'fake-editor',
                launchEditor: editorWriting(VALID_CONFIG), // leaves a valid file WITHOUT a `work` profile
            });

            expect(error).toBeUndefined();
            expect(out).toContain('configuration is valid');
            expect(err).toContain('profile "work" is not present');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('config edit — secret redaction (#7/#22)', () => {
    // Assembled at runtime so the secret-shaped literal is never committed contiguously (else the
    // clean-tree scan in @getreceipt/auth would flag this test file).
    const stripeShaped = 'sk' + '_live_' + 'A'.repeat(28);

    it('echoes no secret-shaped value even when the edited file holds an inline secret [AC1/redaction]', async () => {
        const dir = tempDir();
        const path = join(dir, '.getreceipt.yaml');
        writeFileSync(path, VALID_CONFIG);
        const withInlineSecret = [
            'profiles:',
            '  default:',
            '    sources:',
            '      shop.example:',
            '        auth:',
            '          kind: api-token',
            `          secret: ${stripeShaped}`,
            '',
        ].join('\n');
        try {
            const { out, err, error } = await runConfig(['edit'], {
                resolveConfigPath: () => path,
                resolveEditor: () => 'fake-editor',
                launchEditor: editorWriting(withInlineSecret),
            });

            // The inline secret is valid config (it just warns), so the edit succeeds…
            expect(error).toBeUndefined();
            expect(err).toContain('inline literal'); // the warning — path-only, never the value
            // …and NO channel carries the secret-shaped value.
            expect(out).not.toContain(stripeShaped);
            expect(err).not.toContain(stripeShaped);
            expect(scanForSecrets([{ path: 'config-edit-out', content: out + err }])).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('refuses to print (exit 1, value withheld) if an echoed warning would expose a secret [backstop]', async () => {
        const dir = tempDir();
        const path = join(dir, '.getreceipt.yaml');
        writeFileSync(path, VALID_CONFIG);
        // A contrived loader whose warning message carries a secret-shaped value — proves the #7 scan
        // backstop refuses rather than emit it (warnings are path-only by contract; this is defense in depth).
        const leakyLoad = (): ConfigParseResult => ({
            config: { profiles: {} },
            warnings: [
                {
                    code: 'inline-credential',
                    path: 'profiles.default.sources.x.auth.secret',
                    message: `leak ${stripeShaped}`,
                },
            ],
        });
        try {
            const { out, err, error } = await runConfig(['edit'], {
                resolveConfigPath: () => path,
                resolveEditor: () => 'fake-editor',
                launchEditor: () => ({ ok: true, detail: '' }),
                loadConfig: leakyLoad,
            });

            expect(error).toMatchObject({ exitCode: 1, code: 'getreceipt.config.leak-blocked' });
            expect(err).toContain('refusing to print');
            expect(out).toBe('');
            expect(out + err).not.toContain(stripeShaped);
            expect(scanForSecrets([{ path: 'config-edit-refusal', content: out + err }])).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
