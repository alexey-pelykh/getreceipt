// SPDX-License-Identifier: AGPL-3.0-only
import { AUTH_KINDS, parseConfig, scanForSecrets } from '@getreceipt/auth';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { decideInitDisposition, parseEditorCommand, renderStarterConfig } from './config-init.js';

describe('renderStarterConfig', () => {
    it('renders a FLAT starter that parses + validates with NO warnings [AC: valid starter]', () => {
        const result = parseConfig(parseYaml(renderStarterConfig('default')));

        // Flat per-file profile: sources live at the top level (no `profiles:` map).
        expect(result.config.sources['example.com']?.kind).toBe('password');
        // The active example uses an op:// reference, so a freshly scaffolded file is warning-clean.
        expect(result.warnings).toEqual([]);
    });

    it('names the profile in the header comment (the file IS that profile)', () => {
        const text = renderStarterConfig('work');

        // The profile name appears as a comment label, not a YAML key — and there is NO `profiles:` map.
        expect(text).toContain('profile: work');
        expect(text).not.toMatch(/^profiles:/m);
        // It still parses as the same flat shape regardless of the profile name.
        expect(parseConfig(parseYaml(text)).config.sources['example.com']).toBeDefined();
    });

    it('parses to the same flat shape even for an unusual profile name (name is only a comment)', () => {
        const result = parseConfig(parseYaml(renderStarterConfig('needs: quoting')));

        expect(result.config.sources['example.com']).toBeDefined();
    });

    it('shows the op:// reference (active) and the inline-literal form (commented, discouraged)', () => {
        const text = renderStarterConfig('default');

        expect(text).toContain('ref: op://Personal/example.com/password');
        // The literal form appears only as a comment, with its discouraged framing.
        expect(text).toContain('#   secret: your-secret-here');
        expect(text).toMatch(/Discouraged/);
        expect(text).toMatch(/Recommended/);
    });

    it('advertises only the reference schemes the resolver actually supports (op:// and encrypted-file:)', () => {
        const text = renderStarterConfig('default');

        // The CredentialResolver accepts exactly: inline literal, `op://…`, `encrypted-file:<path>`.
        expect(text).toContain('op://');
        expect(text).toContain('encrypted-file:');
        // It must NOT claim a bare env-var name is a valid reference — that throws `unsupported-scheme`
        // at collection time while passing `config validate` (a silent footgun).
        expect(text).not.toMatch(/environment[- ]variable/i);
    });

    it('carries the unofficial / personal-use posture and the config-guide pointer', () => {
        const text = renderStarterConfig('default');

        expect(text).toMatch(/Unofficial/);
        expect(text).toContain('personal use');
        expect(text).toContain('docs/configuration.md');
    });

    it('contains no secret-shaped value (#7 lint over the template)', () => {
        expect(scanForSecrets([{ path: 'starter', content: renderStarterConfig('default') }])).toEqual([]);
    });

    it('derives the auth-kind vocab comment from AUTH_KINDS, so it cannot advertise a dropped kind [#149]', () => {
        const text = renderStarterConfig('default');

        // The `# one of: …` comment is interpolated from the single AUTH_KINDS source, so it tracks the
        // enum automatically. Pin the wiring (derived list) AND the concrete vocabulary, and assert the
        // dropped `oauth2` is absent anywhere in the scaffold.
        expect(text).toContain(`# one of: ${AUTH_KINDS.join(', ')}`);
        expect(text).toContain('# one of: none, password, api-token, passkey');
        expect(text).not.toContain('oauth2');
    });
});

describe('decideInitDisposition', () => {
    it('writes when the file does not exist (regardless of interactivity / force)', () => {
        expect(decideInitDisposition({ exists: false, force: false, interactive: false })).toBe('write');
        expect(decideInitDisposition({ exists: false, force: false, interactive: true })).toBe('write');
    });

    it('writes (overwrites) when --force is given', () => {
        expect(decideInitDisposition({ exists: true, force: true, interactive: false })).toBe('write');
    });

    it('prompts when the file exists, no --force, and the session is interactive', () => {
        expect(decideInitDisposition({ exists: true, force: false, interactive: true })).toBe('prompt');
    });

    it('blocks (no stdin read) when the file exists, no --force, and not interactive', () => {
        expect(decideInitDisposition({ exists: true, force: false, interactive: false })).toBe('blocked');
    });
});

describe('parseEditorCommand', () => {
    it('parses a bare command', () => {
        expect(parseEditorCommand('vim')).toEqual({ command: 'vim', args: [] });
    });

    it('parses a command with flags', () => {
        expect(parseEditorCommand('code --wait')).toEqual({ command: 'code', args: ['--wait'] });
    });

    it('collapses runs of whitespace between tokens', () => {
        expect(parseEditorCommand('  nano   -w  ')).toEqual({ command: 'nano', args: ['-w'] });
    });

    it('returns undefined for an empty / whitespace value', () => {
        expect(parseEditorCommand('')).toBeUndefined();
        expect(parseEditorCommand('   ')).toBeUndefined();
    });
});
