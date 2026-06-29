// SPDX-License-Identifier: AGPL-3.0-only
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import {
    addGlobalConfigOptions,
    buildConfigSelection,
    resolveConfigSelection,
    resolveGlobalOptions,
} from './resolve-options.js';

/** A parent program + child subcommand, both carrying the global options, parsed from argv. */
function parsed(argv: string[]): Command {
    const program = new Command('getreceipt');
    addGlobalConfigOptions(program);
    const child = new Command('from').argument('[domain]').action(() => {});
    addGlobalConfigOptions(child);
    program.addCommand(child);
    program.exitOverride();
    child.exitOverride();
    program.parse(argv, { from: 'user' });
    // Return the leaf the user actually invoked (the subcommand).
    return program.commands.find((c) => c.name() === 'from') ?? program;
}

describe('resolveGlobalOptions — child-over-parent inheritance', () => {
    it('reads a global written BEFORE the verb (on the program)', () => {
        expect(resolveGlobalOptions(parsed(['--profile', 'work', 'from', 'x']))).toEqual({ profile: 'work' });
    });

    it('reads a global written AFTER the verb (on the subcommand)', () => {
        expect(resolveGlobalOptions(parsed(['from', 'x', '--profile', 'work']))).toEqual({ profile: 'work' });
    });

    it('lets the leaf (subcommand) value override the parent value', () => {
        // --profile a on the program, --profile b on the verb → b wins (closest to the verb).
        expect(resolveGlobalOptions(parsed(['--profile', 'a', 'from', 'x', '--profile', 'b']))).toEqual({
            profile: 'b',
        });
    });

    it('carries --config the same way', () => {
        expect(resolveGlobalOptions(parsed(['from', 'x', '--config', '/c.yaml']))).toEqual({ config: '/c.yaml' });
    });

    it('is empty when neither global is given', () => {
        expect(resolveGlobalOptions(parsed(['from', 'x']))).toEqual({});
    });

    it('projects --strict as { strict: true } (the latch), on either side of the verb', () => {
        expect(resolveGlobalOptions(parsed(['--strict', 'from', 'x']))).toEqual({ strict: true });
        expect(resolveGlobalOptions(parsed(['from', 'x', '--strict']))).toEqual({ strict: true });
    });

    it('omits the strict key entirely when --strict is absent (exact-equality callers keep their shape)', () => {
        expect(resolveGlobalOptions(parsed(['from', 'x', '--profile', 'work']))).toEqual({ profile: 'work' });
    });
});

describe('buildConfigSelection — precedence + divergence warnings', () => {
    it('maps a profile to a { profile } selection (no warning)', () => {
        const warnings: string[] = [];
        const selection = buildConfigSelection({ profile: 'work' }, { env: {}, stderr: (m) => warnings.push(m) });
        expect(selection).toEqual({ profile: 'work' });
        expect(warnings).toEqual([]);
    });

    it('maps --config to a { path } selection, dropping the profile so the explicit path is unambiguous', () => {
        const warnings: string[] = [];
        const selection = buildConfigSelection(
            { config: '/explicit.yaml', profile: 'work' },
            { env: {}, stderr: (m) => warnings.push(m) },
        );
        expect(selection).toEqual({ path: '/explicit.yaml' });
        // …and it warns that --config overrides the profile.
        expect(warnings.join('')).toContain('--config "/explicit.yaml" overrides --profile "work"');
    });

    it('warns that --config overrides a divergent GETRECEIPT_CONFIG_FILE env var', () => {
        const warnings: string[] = [];
        buildConfigSelection(
            { config: '/explicit.yaml' },
            { env: { GETRECEIPT_CONFIG_FILE: '/env.yaml' }, stderr: (m) => warnings.push(m) },
        );
        expect(warnings.join('')).toContain('--config "/explicit.yaml" overrides GETRECEIPT_CONFIG_FILE="/env.yaml"');
    });

    it('does NOT warn when --config matches the env var exactly (no real divergence)', () => {
        const warnings: string[] = [];
        buildConfigSelection(
            { config: '/same.yaml' },
            { env: { GETRECEIPT_CONFIG_FILE: '/same.yaml' }, stderr: (m) => warnings.push(m) },
        );
        expect(warnings).toEqual([]);
    });

    it('treats an empty --config / --profile as unset', () => {
        expect(buildConfigSelection({ config: '', profile: '' }, { env: {} })).toEqual({});
    });

    it('is an empty selection when nothing is given (→ home default downstream)', () => {
        expect(buildConfigSelection({}, { env: {} })).toEqual({});
    });
});

describe('resolveConfigSelection — merge + build in one step', () => {
    it('resolves the leaf-merged options into a selection (profile → { profile })', () => {
        const selection = resolveConfigSelection(parsed(['from', 'x', '--profile', 'work']), { env: {} });
        expect(selection).toEqual({ profile: 'work' });
    });

    it('--config (after the verb) wins over a parent --profile, with a warning', () => {
        const warnings: string[] = [];
        const selection = resolveConfigSelection(parsed(['--profile', 'work', 'from', 'x', '--config', '/c.yaml']), {
            env: {},
            stderr: (m) => warnings.push(m),
        });
        expect(selection).toEqual({ path: '/c.yaml' });
        expect(warnings.join('')).toContain('overrides --profile "work"');
    });

    it('carries --strict onto the selection (alongside the resolved file)', () => {
        expect(resolveConfigSelection(parsed(['from', 'x', '--strict', '--profile', 'work']), { env: {} })).toEqual({
            profile: 'work',
            strict: true,
        });
    });

    it('omits strict from the selection when --strict is absent', () => {
        expect(resolveConfigSelection(parsed(['from', 'x', '--profile', 'work']), { env: {} })).toEqual({
            profile: 'work',
        });
    });
});
