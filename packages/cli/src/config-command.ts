// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs';

import { ConfigError, defaultConfigPath, loadConfig as authLoadConfig, scanForSecrets } from '@getreceipt/auth';
import type { ConfigParseResult } from '@getreceipt/auth';
import { Command, CommanderError } from 'commander';

import {
    buildValidateVerdict,
    ProfileNotFoundError,
    renderConfigPathText,
    renderConfigShow,
    renderValidateJson,
    renderValidateText,
    resolveActiveProfile,
    type ConfigPathInfo,
} from './config-render.js';

/** Where the command writes; injectable so output is captured in tests instead of hitting the process streams. */
export interface CliIO {
    readonly writeOut: (text: string) => void;
    readonly writeErr: (text: string) => void;
}

/**
 * The command's collaborators. Every field has a production default, so
 * `createConfigCommand()` works as-is; tests override individual seams (a fixture
 * path, a capturing {@link CliIO}) without touching the process or the real home dir.
 */
export interface ConfigCommandEnv {
    readonly io: CliIO;
    /** Resolve the config file path. Defaults to `~/.getreceipt.yaml`. */
    readonly resolveConfigPath: () => string;
    /** Load + validate a config file (ConfigLoader #6). */
    readonly loadConfig: (path: string) => ConfigParseResult;
    /** Whether the config file exists on disk. */
    readonly fileExists: (path: string) => boolean;
}

function defaultEnv(): ConfigCommandEnv {
    return {
        io: {
            writeOut: (text) => void process.stdout.write(text),
            writeErr: (text) => void process.stderr.write(text),
        },
        resolveConfigPath: defaultConfigPath,
        loadConfig: authLoadConfig,
        fileExists: existsSync,
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

/**
 * Build the read-only `config` command: `show` (redacted config), `validate`
 * (schema check + warnings + exit code + `--json`), and `path` (location, active
 * profile, existence). No subcommand writes to disk. Returns a fresh
 * {@link Command} per call (test-friendly).
 */
export function createConfigCommand(overrides: Partial<ConfigCommandEnv> = {}): Command {
    const env: ConfigCommandEnv = { ...defaultEnv(), ...overrides };

    const config = new Command('config').description('Inspect the resolved configuration (read-only).');

    config
        .command('show')
        .description('Print the resolved configuration with secrets redacted.')
        .option('-p, --profile <name>', 'profile to show')
        .action((options: { profile?: string }) => {
            const path = env.resolveConfigPath();
            let parsed: ConfigParseResult;
            try {
                parsed = env.loadConfig(path);
            } catch (error) {
                env.io.writeErr(`✗ ${path}: ${loadErrorDetail(error, path)}\n`);
                throw exitFailure('getreceipt.config.load-failed');
            }

            let rendered: string;
            try {
                rendered = renderConfigShow(parsed.config, resolveActiveProfile(options.profile));
            } catch (error) {
                if (error instanceof ProfileNotFoundError) {
                    env.io.writeErr(`✗ ${error.message}\n`);
                    throw exitFailure('getreceipt.config.unknown-profile');
                }
                throw error;
            }

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
        .description('Validate the resolved configuration file; non-zero exit when invalid.')
        .option('--json', 'emit a machine-readable verdict')
        .action((options: { json?: boolean }) => {
            const path = env.resolveConfigPath();
            const verdict = (() => {
                try {
                    const parsed = env.loadConfig(path);
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
        .option('-p, --profile <name>', 'profile to report as active')
        .action((options: { profile?: string }) => {
            const path = env.resolveConfigPath();
            const info: ConfigPathInfo = {
                path,
                profile: resolveActiveProfile(options.profile),
                exists: env.fileExists(path),
            };
            env.io.writeOut(renderConfigPathText(info));
        });

    return config;
}
