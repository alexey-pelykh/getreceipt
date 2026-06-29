// SPDX-License-Identifier: AGPL-3.0-only
import { CONFIG_FILE_ENV } from '@getreceipt/auth';
import type { ConfigSelection } from '@getreceipt/auth';
import { Command, Option } from 'commander';

/**
 * The two GLOBAL config-resolution options — `--config <path>` and `-p, --profile <name>` — added
 * to the root program AND every subcommand so a user can write them on either side
 * (`getreceipt --profile work from x` or `getreceipt from x --profile work`). Commander does not
 * inherit options across the parent/child boundary, so each command carries its own copy and
 * {@link resolveGlobalOptions} reconciles them child-over-parent.
 */
export interface GlobalConfigOptions {
    readonly config?: string;
    readonly profile?: string;
    /** `--strict`: fail closed if the selected config carries an inline-literal secret. A boolean flag (no value). */
    readonly strict?: boolean;
}

/**
 * Add the global `--config` / `-p, --profile` / `--strict` options to a command. Applied to the root
 * program and every subcommand: a subcommand's own copy lets the flag appear after the verb, and
 * {@link resolveGlobalOptions} merges parent + child with the child winning. No Commander default is
 * set — an absent profile must fall through to the home-default file (`~/.getreceipt.yaml`), NOT a
 * file literally named `default` (that distinction is the whole point of the per-file model).
 */
export function addGlobalConfigOptions(command: Command): Command {
    return command
        .addOption(new Option('--config <path>', 'path to the config file (overrides --profile and the env var)'))
        .addOption(new Option('-p, --profile <name>', 'named profile → ~/.getreceipt/<name>.yaml'))
        .addOption(
            new Option(
                '--strict',
                'fail closed if the config contains an inline-literal secret (forbid on-disk secrets for CI/production)',
            ),
        );
}

/**
 * Merge the global `--config`/`--profile`/`--strict` from a command and ALL its ancestors, root→leaf,
 * so the value written closest to the verb wins (`getreceipt --profile a from x --profile b` → `b`).
 * Reads each command's parsed `opts()`; only the three global keys are projected (a verb's own
 * `--out`/`--json`/etc. are never folded in). `--strict` is a latch — set on ANY level turns it on,
 * and (unlike `--config`/`--profile`) the key is omitted entirely when unset, so callers that compare
 * the result by exact equality keep their existing shape.
 */
export function resolveGlobalOptions(command: Command): GlobalConfigOptions {
    // Walk leaf → root collecting commands, then assign root → leaf so the leaf overrides ancestors.
    const chain: Command[] = [];
    for (let current: Command | null = command; current !== null; current = current.parent) {
        chain.push(current);
    }

    const merged: { config?: string; profile?: string; strict?: boolean } = {};
    for (let i = chain.length - 1; i >= 0; i--) {
        const opts = chain[i]?.opts<{ config?: string; profile?: string; strict?: boolean }>();
        if (opts?.config !== undefined) {
            merged.config = opts.config;
        }
        if (opts?.profile !== undefined) {
            merged.profile = opts.profile;
        }
        if (opts?.strict === true) {
            merged.strict = true;
        }
    }
    return merged;
}

/**
 * Turn the merged global options into the {@link ConfigSelection} the operation layer resolves a
 * file path from, applying the precedence at the CLI boundary AND emitting the one-line divergence
 * warnings (the pure path resolver and the shared operation layer must never write to stderr):
 *
 *  - `--config ""` is treated as absent (a shell expanding an empty var shouldn't pin a path).
 *  - When `--config` is set alongside a divergent `GETRECEIPT_CONFIG_FILE`, or alongside a
 *    `--profile` whose derived path differs, warn that `--config` wins — then drop the profile so
 *    the resolver uses the explicit path unambiguously.
 *  - Otherwise the selection carries whichever of `{ config, profile }` were given; an absent
 *    profile falls through to the home default downstream.
 *
 * The returned selection uses `path` (not `config`) to match {@link ConfigSelection}; profile is
 * preserved ONLY when `--config` is not winning.
 */
export function buildConfigSelection(
    options: GlobalConfigOptions,
    context: { readonly env?: Record<string, string | undefined>; readonly stderr?: (message: string) => void } = {},
): ConfigSelection {
    const env = context.env ?? process.env;
    const warn = context.stderr ?? ((message: string) => process.stderr.write(message));

    const config = options.config !== undefined && options.config !== '' ? options.config : undefined;
    const profile = options.profile !== undefined && options.profile !== '' ? options.profile : undefined;

    if (config === undefined) {
        // No explicit path: profile (when given) selects ~/.getreceipt/<profile>.yaml; else home default.
        return profile === undefined ? {} : { profile };
    }

    // --config wins over the env var and over a --profile-derived path; warn on a real divergence.
    const envPath = env[CONFIG_FILE_ENV];
    if (envPath !== undefined && envPath !== '' && envPath !== config) {
        warn(`warning: --config "${config}" overrides ${CONFIG_FILE_ENV}="${envPath}"\n`);
    }
    if (profile !== undefined) {
        warn(`warning: --config "${config}" overrides --profile "${profile}"\n`);
    }

    return { path: config };
}

/**
 * Resolve the global options of a command into a {@link ConfigSelection} in one step — the helper
 * each verb's action calls. Combines {@link resolveGlobalOptions} (merge across the ancestor chain)
 * and {@link buildConfigSelection} (precedence + divergence warnings), then carries `--strict` onto
 * the selection so the operation layer parses the chosen file fail-closed. `--strict` is path-agnostic
 * (it shapes HOW the file is parsed, not WHICH), so it rides alongside the path resolution rather than
 * through it; the key is added only when set, keeping the non-strict selection shape unchanged.
 */
export function resolveConfigSelection(
    command: Command,
    context: { readonly env?: Record<string, string | undefined>; readonly stderr?: (message: string) => void } = {},
): ConfigSelection {
    const options = resolveGlobalOptions(command);
    const selection = buildConfigSelection(options, context);
    return options.strict === true ? { ...selection, strict: true } : selection;
}
