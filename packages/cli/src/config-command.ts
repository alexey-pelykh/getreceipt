// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import { ConfigError, loadConfig as authLoadConfig, resolveConfigFilePath, scanForSecrets } from '@getreceipt/auth';
import type { ConfigParseOptions, ConfigParseResult, ConfigSelection } from '@getreceipt/auth';
import { Command, CommanderError } from 'commander';

import {
    buildValidateVerdict,
    renderConfigPathText,
    renderConfigShow,
    renderValidateJson,
    renderValidateText,
    resolveActiveProfile,
    type ConfigPathInfo,
} from './config-render.js';
import { decideInitDisposition, parseEditorCommand, renderStarterConfig, type EditorCommand } from './config-init.js';
import { processStreamsIO, type CliIO } from './io.js';
import { resolveConfigSelection, resolveGlobalOptions } from './resolve-options.js';

/** The outcome of launching the editor: whether it exited cleanly, and a value-free reason when it did not. */
export interface EditorLaunchResult {
    readonly ok: boolean;
    readonly detail: string;
}

/** Config can hold inline credentials, so it is written owner read/write only — mirrors the receipt writer (#5). */
const CONFIG_FILE_MODE = 0o600;

/** Write the config file with {@link CONFIG_FILE_MODE}, re-pinning perms on an overwrite (the `mode` option only applies at create). */
function writeConfigFile(path: string, content: string): void {
    writeFileSync(path, content, { mode: CONFIG_FILE_MODE });
    chmodSync(path, CONFIG_FILE_MODE);
}

/** Spawn `$EDITOR <file>` with inherited stdio (the editor takes over the terminal) and map its exit to an {@link EditorLaunchResult}. The detail names the editor command, never file contents. */
function spawnEditor(editor: EditorCommand, path: string): EditorLaunchResult {
    const result = spawnSync(editor.command, [...editor.args, path], { stdio: 'inherit' });
    if (result.error !== undefined) {
        const code = (result.error as NodeJS.ErrnoException).code;
        return { ok: false, detail: code === 'ENOENT' ? `editor not found: ${editor.command}` : result.error.message };
    }
    if (result.status === 0) {
        return { ok: true, detail: '' };
    }
    if (result.signal !== null) {
        return { ok: false, detail: `editor terminated by signal ${result.signal}` };
    }
    return { ok: false, detail: `editor exited with code ${result.status ?? 'unknown'}` };
}

/** Default overwrite confirmation: write the prompt via {@link CliIO} (captured/testable), read one line of stdin. Only ever reached on the interactive path. */
async function readlineConfirm(io: CliIO, input: NodeJS.ReadableStream = process.stdin): Promise<boolean> {
    io.writeErr('Overwrite? [y/N] ');
    const rl = createInterface({ input, terminal: false });
    try {
        const answer = await rl.question('');
        return /^\s*y(es)?\s*$/i.test(answer);
    } finally {
        rl.close();
    }
}

/**
 * The command's collaborators. Every field has a production default, so
 * `createConfigCommand()` works as-is; tests override individual seams (a fixture
 * path, a capturing {@link CliIO}) without touching the process or the real home dir.
 */
export interface ConfigCommandEnv {
    readonly io: CliIO;
    /** Resolve WHICH config file to operate on from a {@link ConfigSelection} (`--config`/`--profile`/env/home default). */
    readonly resolveConfigPath: (selection?: ConfigSelection) => string;
    /** Load + validate a config file (ConfigLoader #6). `options.strict` (from `--strict`) makes an inline-literal secret fail closed. */
    readonly loadConfig: (path: string, options?: ConfigParseOptions) => ConfigParseResult;
    /** Whether the config file exists on disk. */
    readonly fileExists: (path: string) => boolean;
    /** Read the raw config bytes — the `edit` snapshot taken before launching the editor (for round-trip on invalid). Defaults to a UTF-8 read. */
    readonly readConfigFileRaw: (path: string) => string;
    /** Write the config file owner-only (0600). Used by `init` (scaffold) and `edit` (round-trip restore). Defaults to a real write + chmod. */
    readonly writeConfigFile: (path: string, content: string) => void;
    /** Resolve the user's editor command — `$VISUAL` then `$EDITOR`. Defaults to those env vars; `undefined` when neither is set. */
    readonly resolveEditor: () => string | undefined;
    /** Launch the editor against the file and wait for it. Defaults to a `spawnSync` with inherited stdio. */
    readonly launchEditor: (editor: EditorCommand, path: string) => EditorLaunchResult | Promise<EditorLaunchResult>;
    /** Whether `init` may prompt before overwriting — stdin AND stderr are TTYs. Defaults to the process streams. */
    readonly isInteractive: () => boolean;
    /** Confirm an `init` overwrite; resolves true on a yes. Only invoked on the interactive path. Defaults to a readline prompt. */
    readonly confirm: (io: CliIO) => Promise<boolean>;
}

function defaultEnv(): ConfigCommandEnv {
    return {
        io: processStreamsIO(),
        resolveConfigPath: resolveConfigFilePath,
        loadConfig: authLoadConfig,
        fileExists: existsSync,
        readConfigFileRaw: (path) => readFileSync(path, 'utf8'),
        writeConfigFile,
        resolveEditor: () => process.env.VISUAL || process.env.EDITOR || undefined,
        launchEditor: spawnEditor,
        isInteractive: () => process.stdin.isTTY === true && process.stderr.isTTY === true,
        confirm: (io) => readlineConfirm(io),
    };
}

/** A non-zero exit signal whose user-facing text has ALREADY been written via {@link CliIO} — carries no message of its own. */
function exitFailure(code: string): CommanderError {
    return new CommanderError(1, code, '');
}

/**
 * The detail of a load failure, safe to print, WITHOUT the config-file path — callers prefix the
 * path themselves, so keeping it here would double it. {@link ConfigError} is pre-sanitized (#6) and
 * its message is `${path}: ${reason}`: strip the prefix when the offending path IS the file (a
 * read/parse failure); keep it for a structural error, where the path is a dotted node locator.
 */
function loadErrorDetail(error: unknown, path: string): string {
    if (error instanceof ConfigError) {
        return error.path === path ? error.message.slice(error.path.length + 2) : error.message;
    }
    return 'config file could not be read';
}

/** Roll the config file back to its pre-edit bytes, warning (but never throwing) if even that fails. */
function restoreConfig(env: ConfigCommandEnv, path: string, snapshot: string): void {
    try {
        env.writeConfigFile(path, snapshot);
    } catch {
        env.io.writeErr(`✗ ${path}: could not restore the previous contents.\n`);
    }
}

/**
 * Build the `config` command. Read-only verbs: `show` (redacted config), `validate` (schema check +
 * warnings + exit code + `--json`), `path` (location, active profile, existence). Mutating verbs:
 * `init` (scaffold a starter file, never clobbering without confirmation) and `edit` (open `$EDITOR`,
 * re-validate on save, round-trip an invalid edit). Returns a fresh {@link Command} per call
 * (test-friendly).
 */
export function createConfigCommand(overrides: Partial<ConfigCommandEnv> = {}): Command {
    const env: ConfigCommandEnv = { ...defaultEnv(), ...overrides };

    const config = new Command('config').description('Inspect and manage the configuration file.');

    config
        .command('show')
        .description('Print the resolved configuration with secrets redacted.')
        .action((_options: Record<string, never>, command: Command) => {
            const selection = resolveConfigSelection(command, { stderr: env.io.writeErr });
            const path = env.resolveConfigPath(selection);
            let parsed: ConfigParseResult;
            try {
                parsed = env.loadConfig(path);
            } catch (error) {
                env.io.writeErr(`✗ ${path}: ${loadErrorDetail(error, path)}\n`);
                throw exitFailure('getreceipt.config.load-failed');
            }

            const rendered = renderConfigShow(
                parsed.config,
                resolveActiveProfile(resolveGlobalOptions(command).profile),
            );

            // Defense in depth: `show` is a secret-egress surface. Literals are masked and refs are
            // pointers by contract — but a reference mis-set to a literal secret would print verbatim.
            // Scan the rendered output through the #7 lint and refuse rather than emit a leak.
            const leaks = scanForSecrets([{ path: 'config-show', content: rendered }]);
            if (leaks.length > 0) {
                const rules = [...new Set(leaks.map((leak) => leak.rule))].join(', ');
                env.io.writeErr(
                    `✗ refusing to print: output would expose a secret-shaped value (${rules}); a reference is likely mis-configured with a literal secret\n`,
                );
                throw exitFailure('getreceipt.config.leak-blocked');
            }
            env.io.writeOut(rendered);
        });

    config
        .command('validate')
        .description(
            'Validate the resolved configuration file; non-zero exit when invalid (or, under --strict, when it holds an inline-literal secret).',
        )
        .option('--json', 'emit a machine-readable verdict')
        .action((options: { json?: boolean }, command: Command) => {
            const selection = resolveConfigSelection(command, { stderr: env.io.writeErr });
            const path = env.resolveConfigPath(selection);
            // `--strict` turns an inline-literal secret from a warning into an invalid verdict — `validate`
            // is the natural enforcement point for "this config must carry no on-disk secrets".
            const verdict = (() => {
                try {
                    const parsed = env.loadConfig(path, { strict: selection.strict === true });
                    return buildValidateVerdict(path, { ok: true, warnings: parsed.warnings });
                } catch (error) {
                    return buildValidateVerdict(path, { ok: false, message: loadErrorDetail(error, path) });
                }
            })();

            if (options.json) {
                env.io.writeOut(renderValidateJson(verdict));
            } else {
                const { out, err } = renderValidateText(verdict);
                if (out) {
                    env.io.writeOut(out);
                }
                if (err) {
                    env.io.writeErr(err);
                }
            }

            if (!verdict.valid) {
                throw exitFailure('getreceipt.config.invalid');
            }
        });

    config
        .command('path')
        .description('Print the resolved config path, active profile, and whether it exists.')
        .action((_options: Record<string, never>, command: Command) => {
            const selection = resolveConfigSelection(command, { stderr: env.io.writeErr });
            const path = env.resolveConfigPath(selection);
            const info: ConfigPathInfo = {
                path,
                profile: resolveActiveProfile(resolveGlobalOptions(command).profile),
                exists: env.fileExists(path),
            };
            env.io.writeOut(renderConfigPathText(info));
        });

    config
        .command('init')
        .description('Scaffold a starter configuration file (refuses to overwrite an existing one without --force).')
        .option('-f, --force', 'overwrite an existing config file')
        .action(async (options: { force?: boolean }, command: Command) => {
            const selection = resolveConfigSelection(command, { stderr: env.io.writeErr });
            const path = env.resolveConfigPath(selection);
            const profile = resolveActiveProfile(resolveGlobalOptions(command).profile);

            const disposition = decideInitDisposition({
                exists: env.fileExists(path),
                force: options.force === true,
                interactive: env.isInteractive(),
            });
            if (disposition === 'blocked') {
                env.io.writeErr(
                    `✗ ${path} already exists; refusing to overwrite.\n` +
                        '  Pass --force to overwrite, or edit it with `getreceipt config edit`.\n',
                );
                throw exitFailure('getreceipt.config.init-exists');
            }
            if (disposition === 'prompt') {
                env.io.writeErr(`⚠ ${path} already exists.\n`);
                if (!(await env.confirm(env.io))) {
                    env.io.writeErr('✗ aborted; the existing file was left unchanged.\n');
                    throw exitFailure('getreceipt.config.init-declined');
                }
            }

            try {
                env.writeConfigFile(path, renderStarterConfig(profile));
            } catch (error) {
                env.io.writeErr(
                    `✗ ${path}: ${error instanceof Error ? error.message : 'could not write the config file'}\n`,
                );
                throw exitFailure('getreceipt.config.init-write-failed');
            }

            // Re-validate what was just written (AC: re-validate after writing): a self-check that the
            // scaffold parses, so a template regression surfaces here rather than at the user's first run.
            try {
                env.loadConfig(path);
            } catch (error) {
                env.io.writeErr(
                    `✗ ${path}: wrote starter config but it failed validation: ${loadErrorDetail(error, path)}\n`,
                );
                throw exitFailure('getreceipt.config.init-invalid');
            }

            env.io.writeOut(`✓ wrote starter config to ${path} (profile: ${profile})\n`);
            env.io.writeErr('  Edit it to match your sources, then run `getreceipt config validate`.\n');
        });

    config
        .command('edit')
        .description('Open the configuration in $EDITOR and re-validate on save (never persists an invalid file).')
        .action(async (_options: Record<string, never>, command: Command) => {
            const selection = resolveConfigSelection(command, { stderr: env.io.writeErr });
            const path = env.resolveConfigPath(selection);

            if (!env.fileExists(path)) {
                env.io.writeErr(
                    `✗ ${path}: no configuration file to edit.\n  Run \`getreceipt config init\` to create one.\n`,
                );
                throw exitFailure('getreceipt.config.edit-missing');
            }

            const editorValue = env.resolveEditor();
            const editor = editorValue === undefined ? undefined : parseEditorCommand(editorValue);
            if (editor === undefined) {
                env.io.writeErr('✗ no editor configured; set $VISUAL or $EDITOR to your editor command.\n');
                throw exitFailure('getreceipt.config.edit-no-editor');
            }

            // Snapshot the current bytes BEFORE editing so an edit that breaks validation can be rolled
            // back — the file on disk is never left in a state `config validate` would reject.
            let snapshot: string;
            try {
                snapshot = env.readConfigFileRaw(path);
            } catch (error) {
                env.io.writeErr(
                    `✗ ${path}: ${error instanceof Error ? error.message : 'could not read the config file'}\n`,
                );
                throw exitFailure('getreceipt.config.edit-read-failed');
            }

            const launch = await env.launchEditor(editor, path);
            if (!launch.ok) {
                // The editor may have written before failing; restore the snapshot so a non-zero exit
                // truly leaves the config unchanged, never a half-finished edit.
                restoreConfig(env, path, snapshot);
                env.io.writeErr(`✗ ${launch.detail}; configuration left unchanged.\n`);
                throw exitFailure('getreceipt.config.edit-editor-failed');
            }

            let parsed: ConfigParseResult;
            try {
                parsed = env.loadConfig(path);
            } catch (error) {
                // Round-trip: restore the pre-edit bytes so a broken file is never silently persisted.
                const detail = loadErrorDetail(error, path);
                restoreConfig(env, path, snapshot);
                env.io.writeErr(
                    `✗ ${path}: ${detail}\n` +
                        '  Your changes were not applied (the file was restored to its previous valid state).\n',
                );
                throw exitFailure('getreceipt.config.edit-invalid');
            }

            const out = `✓ ${path}: configuration is valid\n`;
            const warnings = parsed.warnings.map((w) => `⚠ ${w.message}\n`);

            // Defense in depth: warnings carry only paths by contract, but `edit` is secret-adjacent — scan
            // the composed output through the #7 lint and refuse rather than emit a leak (as `show` does).
            const leaks = scanForSecrets([{ path: 'config-edit', content: out + warnings.join('') }]);
            if (leaks.length > 0) {
                const rules = [...new Set(leaks.map((leak) => leak.rule))].join(', ');
                env.io.writeErr(`✗ refusing to print: output would expose a secret-shaped value (${rules})\n`);
                throw exitFailure('getreceipt.config.leak-blocked');
            }
            env.io.writeOut(out);
            for (const line of warnings) {
                env.io.writeErr(line);
            }
        });

    return config;
}
