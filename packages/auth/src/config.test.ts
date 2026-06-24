// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ConfigError, CredentialResolver, loadConfig, parseConfig, resolveConfigFilePath } from './index.js';

describe('parseConfig', () => {
    it('parses a valid flat config into typed per-domain auth', () => {
        const { config, warnings } = parseConfig({
            sources: {
                'free.fr': {
                    auth: { kind: 'password', username: 'alice', secret: { ref: 'FREE_PW' } },
                },
            },
        });

        expect(warnings).toEqual([]);
        const source = config.sources['free.fr'];
        expect(source?.kind).toBe('password');
        expect(source?.username).toBe('alice');
        expect(source?.secret).toEqual({ ref: 'FREE_PW' });
    });

    it('parses a single-item `ref` reference (the item-level form)', () => {
        const { config, warnings } = parseConfig({
            sources: { 'shop.example': { auth: { kind: 'password', ref: 'op://Vault/Item' } } },
        });

        expect(warnings).toEqual([]);
        const source = config.sources['shop.example'];
        expect(source?.ref).toBe('op://Vault/Item');
        expect(source?.username).toBeUndefined();
        expect(source?.secret).toBeUndefined();
    });

    it('rejects `ref` together with `username`/`secret` — the two forms are mutually exclusive', () => {
        let caught: unknown;
        try {
            parseConfig({
                sources: {
                    'shop.example': {
                        auth: { kind: 'password', ref: 'op://Vault/Item', username: 'alice' },
                    },
                },
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.shop.example.auth');
        expect((caught as ConfigError).message).toContain('either');
    });

    it('rejects a single-item `ref` for a non-password kind (it reads a LOGIN item)', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { 'shop.example': { auth: { kind: 'oauth2', ref: 'op://Vault/Item' } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.shop.example.auth.ref');
        expect((caught as ConfigError).message).toContain('password');
    });

    it('rejects a `ref` given as a `{ ref }` wrapper instead of the reference string', () => {
        let caught: unknown;
        try {
            parseConfig({
                sources: { 'shop.example': { auth: { kind: 'password', ref: { ref: 'op://Vault/Item' } } } },
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.shop.example.auth.ref');
    });

    it('throws an actionable ConfigError, naming the path, when `sources` is missing', () => {
        expect(() => parseConfig({})).toThrow(ConfigError);

        let caught: unknown;
        try {
            parseConfig({});
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources');
    });

    it('rejects a legacy `profiles:`-map file with a migration error naming `profiles`', () => {
        let caught: unknown;
        try {
            parseConfig({ profiles: { default: { sources: { 'free.fr': { auth: { kind: 'password' } } } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('profiles');
        // Actionable: names the migration (one profile per file) and points at the docs.
        expect((caught as ConfigError).message).toContain('profiles');
        expect((caught as ConfigError).message).toContain('one profile per file');
        expect((caught as ConfigError).message).toContain('docs/configuration.md');
    });

    it('rejects a legacy `profiles:` sequence too (not just a mapping)', () => {
        let caught: unknown;
        try {
            parseConfig({ profiles: [] });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('profiles');
        expect((caught as ConfigError).message).toContain('one profile per file');
    });

    it('throws a ConfigError naming the offending path for an unknown auth kind', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { 'free.fr': { auth: { kind: 'magic' } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.free.fr.auth.kind');
        expect((caught as ConfigError).message).toContain('password');
    });

    it('warns — without echoing the value — when a credential is an inline literal', () => {
        const secret = 'super-secret-password';
        const { warnings } = parseConfig({
            sources: { 'free.fr': { auth: { kind: 'password', secret } } },
        });

        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.code).toBe('inline-credential');
        expect(warnings[0]?.path).toBe('sources.free.fr.auth.secret');
        expect(warnings[0]?.message).not.toContain(secret);
    });

    it('does not warn when a credential is a secret reference', () => {
        const { warnings } = parseConfig({
            sources: { 'free.fr': { auth: { kind: 'password', secret: { ref: 'PW' } } } },
        });

        expect(warnings).toEqual([]);
    });

    it('parses a username reference into a { ref } resolved at call-time', () => {
        const { config, warnings } = parseConfig({
            sources: {
                'free.fr': {
                    auth: { kind: 'password', username: { ref: 'op://Private/free/username' } },
                },
            },
        });

        expect(config.sources['free.fr']?.username).toEqual({ ref: 'op://Private/free/username' });
        expect(warnings).toEqual([]);
    });

    it('parses an inline-literal username WITHOUT warning (a username is not a secret)', () => {
        const { config, warnings } = parseConfig({
            sources: { 'free.fr': { auth: { kind: 'password', username: 'alice@free.fr' } } },
        });

        expect(config.sources['free.fr']?.username).toBe('alice@free.fr');
        // No inline-credential warning at the username path — unlike an inline secret.
        expect(warnings.some((w) => w.path === 'sources.free.fr.auth.username')).toBe(false);
        expect(warnings).toEqual([]);
    });

    it.each([
        { label: 'an empty ref', username: { ref: '' } },
        { label: 'a missing ref', username: { notRef: 'x' } },
        { label: 'a non-string ref', username: { ref: 123 } },
    ])('throws a path-named ConfigError for a malformed username reference ($label)', ({ username }) => {
        let caught: unknown;
        try {
            parseConfig({ sources: { 'free.fr': { auth: { kind: 'password', username } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.free.fr.auth.username');
    });

    it('throws a path-named ConfigError for a non-string / non-record username', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { 'free.fr': { auth: { kind: 'password', username: 123 } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.free.fr.auth.username');
    });

    it('never includes a configured secret value in a validation error', () => {
        const secret = 'top-secret-do-not-leak';
        let caught: unknown;
        try {
            parseConfig({
                sources: { 'free.fr': { auth: { kind: 'password', username: 123, secret } } },
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).message).not.toContain(secret);
    });

    // Guards the `!Array.isArray` + `!== null` checks in isRecord: simplifying it to a bare
    // `typeof === 'object'` would accept the arrays and crash on null — yet still pass every happy-path test.
    it.each([
        { label: 'sources is a sequence', raw: { sources: [] }, path: 'sources' },
        {
            label: 'a source is null',
            raw: { sources: { 'free.fr': null } },
            path: 'sources.free.fr',
        },
    ])('rejects a non-mapping with a path-named ConfigError when $label', ({ raw, path }) => {
        let caught: unknown;
        try {
            parseConfig(raw);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe(path);
        expect((caught as ConfigError).message).toContain(path);
    });
});

describe('parseConfig — mfa', () => {
    // AC1: `mfa.type: totp` + a `seed` ref parses (and resolves — see the resolution test below).
    it('parses `mfa.type: totp` with a seed reference, without warning', () => {
        const { config, warnings } = parseConfig({
            sources: {
                'free.fr': {
                    auth: {
                        kind: 'password',
                        username: 'alice',
                        secret: { ref: 'PW' },
                        mfa: { type: 'totp', seed: { ref: 'op://Private/free/totp' } },
                    },
                },
            },
        });

        expect(warnings).toEqual([]);
        expect(config.sources['free.fr']?.mfa).toEqual({ type: 'totp', seed: { ref: 'op://Private/free/totp' } });
    });

    // AC1: the parsed seed is a CredentialValue accepted by the EXISTING secret path (CredentialResolver),
    // so a totp seed resolves exactly like any other credential reference — no separate resolution channel.
    it('resolves a parsed `mfa.totp` seed through the existing CredentialResolver path', async () => {
        const { config } = parseConfig({
            sources: {
                'free.fr': {
                    auth: { kind: 'password', mfa: { type: 'totp', seed: { ref: 'op://Private/free/totp' } } },
                },
            },
        });
        const seed = config.sources['free.fr']?.mfa?.seed;
        if (seed === undefined) {
            throw new Error('expected the parsed config to carry an mfa seed');
        }

        // Stub the op:// backend so the seam is exercised without the real 1Password CLI.
        const resolver = new CredentialResolver({
            commandRunner: () => ({ status: 0, stdout: 'JBSWY3DPEHPK3PXP', stderr: '' }),
        });
        expect((await resolver.resolve(seed)).expose()).toBe('JBSWY3DPEHPK3PXP');
    });

    // AC2: sms | email | push need no stored secret, and accept an optional `trustDevice` flag.
    it.each(['sms', 'email', 'push'] as const)(
        'parses `mfa.type: %s` with no seed and an optional `trustDevice`',
        (type) => {
            const { config, warnings } = parseConfig({
                sources: { 'shop.example': { auth: { kind: 'password', mfa: { type, trustDevice: true } } } },
            });

            expect(warnings).toEqual([]);
            expect(config.sources['shop.example']?.mfa).toEqual({ type, trustDevice: true });
        },
    );

    it.each(['sms', 'email', 'push'] as const)(
        'parses `mfa.type: %s` without a `trustDevice` (it is optional)',
        (type) => {
            const { config } = parseConfig({
                sources: { 'shop.example': { auth: { kind: 'password', mfa: { type } } } },
            });

            expect(config.sources['shop.example']?.mfa).toEqual({ type });
        },
    );

    it.each(['sms', 'email', 'push'] as const)('rejects a `seed` on the non-totp `mfa.type: %s`', (type) => {
        let caught: unknown;
        try {
            parseConfig({
                sources: { 'shop.example': { auth: { kind: 'password', mfa: { type, seed: { ref: 'X' } } } } },
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.shop.example.auth.mfa.seed');
        expect((caught as ConfigError).message).toContain('out-of-band');
    });

    // AC3: mfa is optional and orthogonal to the credential choice — existing sources are unaffected.
    it('leaves a source without `mfa` unaffected (mfa is optional)', () => {
        const { config } = parseConfig({
            sources: { 'free.fr': { auth: { kind: 'password', username: 'alice', secret: { ref: 'PW' } } } },
        });
        expect(config.sources['free.fr']?.mfa).toBeUndefined();
    });

    it('accepts `mfa` alongside per-field `username`/`secret`', () => {
        const { config, warnings } = parseConfig({
            sources: {
                'free.fr': {
                    auth: {
                        kind: 'password',
                        username: 'alice',
                        secret: { ref: 'PW' },
                        mfa: { type: 'push' },
                    },
                },
            },
        });
        expect(warnings).toEqual([]);
        expect(config.sources['free.fr']?.secret).toEqual({ ref: 'PW' });
        expect(config.sources['free.fr']?.mfa).toEqual({ type: 'push' });
    });

    // Orthogonality past the single-item `ref` early-return: mfa must survive that path too.
    it('accepts `mfa` alongside a single-item `ref` (orthogonal to the credential choice)', () => {
        const { config, warnings } = parseConfig({
            sources: {
                'shop.example': {
                    auth: {
                        kind: 'password',
                        ref: 'op://Vault/Item',
                        mfa: { type: 'totp', seed: { ref: 'op://Vault/totp' } },
                    },
                },
            },
        });
        expect(warnings).toEqual([]);
        expect(config.sources['shop.example']?.ref).toBe('op://Vault/Item');
        expect(config.sources['shop.example']?.mfa).toEqual({ type: 'totp', seed: { ref: 'op://Vault/totp' } });
    });

    // AC4: an inline-literal seed warns (parity with an inline password) and never echoes the value.
    it('warns — without echoing the value — when an `mfa.totp` seed is an inline literal', () => {
        const seed = 'JBSWY3DPEHPK3PXP-inline-do-not-leak';
        const { warnings } = parseConfig({
            sources: { 'free.fr': { auth: { kind: 'password', mfa: { type: 'totp', seed } } } },
        });

        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.code).toBe('inline-credential');
        expect(warnings[0]?.path).toBe('sources.free.fr.auth.mfa.seed');
        expect(warnings[0]?.message).not.toContain(seed);
    });

    it('does not warn when an `mfa.totp` seed is a reference', () => {
        const { warnings } = parseConfig({
            sources: { 'free.fr': { auth: { kind: 'password', mfa: { type: 'totp', seed: { ref: 'op://V/totp' } } } } },
        });
        expect(warnings).toEqual([]);
    });

    // Validation edges.
    it('rejects `mfa.type: totp` with no seed (TOTP cannot be computed without one)', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { 'free.fr': { auth: { kind: 'password', mfa: { type: 'totp' } } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.free.fr.auth.mfa.seed');
        expect((caught as ConfigError).message).toContain('requires a `seed`');
    });

    it('rejects an unknown mfa type, naming the path', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { 'free.fr': { auth: { kind: 'password', mfa: { type: 'biometric' } } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.free.fr.auth.mfa.type');
        expect((caught as ConfigError).message).toContain('totp');
    });

    it('rejects a non-mapping `mfa`, naming the path', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { 'free.fr': { auth: { kind: 'password', mfa: 'totp' } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.free.fr.auth.mfa');
    });

    it.each([
        { label: 'a string', trustDevice: 'yes' },
        { label: 'a number', trustDevice: 1 },
    ])('rejects a non-boolean `trustDevice` ($label), naming the path', ({ trustDevice }) => {
        let caught: unknown;
        try {
            parseConfig({ sources: { 'free.fr': { auth: { kind: 'password', mfa: { type: 'push', trustDevice } } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.free.fr.auth.mfa.trustDevice');
    });

    it('never includes an inline seed value in a validation error raised on the same mfa block', () => {
        const seed = 'totp-seed-do-not-leak';
        let caught: unknown;
        try {
            // trustDevice is validated before the seed is consumed; the error must still not echo the seed.
            parseConfig({
                sources: { 'free.fr': { auth: { kind: 'password', mfa: { type: 'totp', seed, trustDevice: 'bad' } } } },
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).message).not.toContain(seed);
    });
});

describe('resolveConfigFilePath', () => {
    const HOME = '/home/tester';

    it('tier 1: an explicit path wins over everything', () => {
        expect(
            resolveConfigFilePath({
                path: '/explicit/config.yaml',
                profile: 'work',
                home: HOME,
                env: { GETRECEIPT_CONFIG_FILE: '/env/config.yaml' },
            }),
        ).toBe('/explicit/config.yaml');
    });

    it('tier 2: the GETRECEIPT_CONFIG_FILE env var wins over a profile / home default', () => {
        expect(
            resolveConfigFilePath({
                profile: 'work',
                home: HOME,
                env: { GETRECEIPT_CONFIG_FILE: '/env/config.yaml' },
            }),
        ).toBe('/env/config.yaml');
    });

    it('tier 3: a profile derives ~/.getreceipt/<profile>.yaml', () => {
        expect(resolveConfigFilePath({ profile: 'work', home: HOME, env: {} })).toBe(
            join(HOME, '.getreceipt', 'work.yaml'),
        );
    });

    it('tier 4: nothing set → the home-default ~/.getreceipt.yaml', () => {
        expect(resolveConfigFilePath({ home: HOME, env: {} })).toBe(join(HOME, '.getreceipt.yaml'));
    });

    it('treats an empty path / profile / env var as unset (falls through the tiers)', () => {
        // Empty --config falls through to the empty env var, which falls through to the empty profile,
        // which falls through to the home default.
        expect(resolveConfigFilePath({ path: '', profile: '', home: HOME, env: { GETRECEIPT_CONFIG_FILE: '' } })).toBe(
            join(HOME, '.getreceipt.yaml'),
        );
    });

    it('defaults home + env from the process when not injected', () => {
        // No injection at all → the real home default. (Does not read the file — pure path resolution.)
        const previous = process.env.GETRECEIPT_CONFIG_FILE;
        delete process.env.GETRECEIPT_CONFIG_FILE;
        try {
            expect(resolveConfigFilePath()).toBe(join(homedir(), '.getreceipt.yaml'));
        } finally {
            if (previous !== undefined) {
                process.env.GETRECEIPT_CONFIG_FILE = previous;
            }
        }
    });
});

describe('loadConfig', () => {
    it('loads and validates a flat YAML config file from disk', () => {
        const fixturePath = fileURLToPath(new URL('./__fixtures__/valid.getreceipt.yaml', import.meta.url));

        const { config, warnings } = loadConfig(fixturePath);

        expect(Object.keys(config.sources)).toEqual(['free.fr', 'amazon.fr']);
        expect(config.sources['free.fr']?.kind).toBe('password');
        expect(config.sources['free.fr']?.secret).toEqual({ ref: 'FREE_PASSWORD' });
        // The fixture configures amazon.fr with an inline literal → exactly one warning, value not echoed.
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.path).toBe('sources.amazon.fr.auth.secret');
        expect(warnings[0]?.message).not.toContain('inline-token-value');
    });

    it('throws a ConfigError for a missing file', () => {
        expect(() => loadConfig('/nonexistent/path/to/.getreceipt.yaml')).toThrow(ConfigError);
    });

    it('throws a ConfigError for malformed YAML without leaking file contents', () => {
        const fixturePath = fileURLToPath(new URL('./__fixtures__/malformed.getreceipt.yaml', import.meta.url));
        const sentinel = 'sk-LEAK-SENTINEL-9f3a2b';
        // Precondition: the fixture must exist AND still carry the sentinel — else this test passes
        // vacuously (a missing file also throws a sentinel-free ConfigError). readFileSync throws
        // loudly if the fixture vanished; this assertion catches one that lost its secret.
        expect(readFileSync(fixturePath, 'utf8')).toContain(sentinel);

        let caught: unknown;
        try {
            loadConfig(fixturePath);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        // The malformed-YAML path specifically (not the missing-file path), with the secret stripped.
        expect((caught as ConfigError).message).toContain('not valid YAML');
        expect((caught as ConfigError).message).not.toContain(sentinel);
    });
});
