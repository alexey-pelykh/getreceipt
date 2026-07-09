// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
    BROWSER_KINDS,
    ConfigError,
    CredentialResolver,
    loadConfig,
    parseConfig,
    resolveConfigFilePath,
    TRANSPORT_TIERS,
} from './index.js';

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
            parseConfig({ sources: { 'shop.example': { auth: { kind: 'api-token', ref: 'op://Vault/Item' } } } });
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

describe('parseConfig — #151 shape-discriminated union + derived kind', () => {
    // --- Bare-ref sugar: a bare string source value IS a single-item login reference. ---
    it('desugars a bare reference string to a single-item login (kind derives to password)', () => {
        const { config, warnings } = parseConfig({ sources: { 'pro.free.fr': 'op://Personal/pro.free.fr' } });

        expect(warnings).toEqual([]);
        const source = config.sources['pro.free.fr'];
        expect(source?.kind).toBe('password');
        expect(source?.ref).toBe('op://Personal/pro.free.fr');
        expect(source?.username).toBeUndefined();
        expect(source?.secret).toBeUndefined();
    });

    it('rejects an empty bare reference string, naming the source path', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { 'pro.free.fr': '' } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.pro.free.fr');
    });

    // --- `kind` is DERIVED from the shape when omitted. ---
    it('derives `password` from a single-item `ref` when `kind` is omitted', () => {
        const { config } = parseConfig({ sources: { x: { auth: { ref: 'op://V/i' } } } });
        expect(config.sources['x']?.kind).toBe('password');
        expect(config.sources['x']?.ref).toBe('op://V/i');
    });

    it('derives `password` from per-field `username`/`secret` when `kind` is omitted', () => {
        const { config } = parseConfig({ sources: { x: { auth: { username: 'alice', secret: { ref: 'PW' } } } } });
        expect(config.sources['x']?.kind).toBe('password');
        expect(config.sources['x']?.username).toBe('alice');
    });

    it('derives `none` from an empty `auth` block when `kind` is omitted', () => {
        const { config } = parseConfig({ sources: { x: { auth: {} } } });
        expect(config.sources['x']?.kind).toBe('none');
    });

    // --- The single-opaque-secret shape is ambiguous: config derives the password default (#169). ---
    it('derives the `password` default for a single opaque `secret` (the adapter disambiguates)', () => {
        const { config, warnings } = parseConfig({ sources: { x: { auth: { secret: { ref: 'TOKEN' } } } } });
        expect(warnings).toEqual([]);
        expect(config.sources['x']?.kind).toBe('password');
        expect(config.sources['x']?.secret).toEqual({ ref: 'TOKEN' });
    });

    it('keeps an explicit `kind: api-token` for the single opaque-secret shape (rc-window, validated)', () => {
        const { config } = parseConfig({ sources: { x: { auth: { kind: 'api-token', secret: { ref: 'TOKEN' } } } } });
        expect(config.sources['x']?.kind).toBe('api-token');
        expect(config.sources['x']?.secret).toEqual({ ref: 'TOKEN' });
    });

    // --- An explicit `kind:` is VALIDATED against the shape, never trusted as the source of truth. ---
    it('rejects `kind: none` carrying a credential (shape disagrees)', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { auth: { kind: 'none', secret: { ref: 'PW' } } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.auth');
        expect((caught as ConfigError).message).toContain('none');
    });

    it('rejects `kind: api-token` carrying a `username` (a token has no username)', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { auth: { kind: 'api-token', username: 'alice', secret: { ref: 'T' } } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.auth');
        expect((caught as ConfigError).message).toContain('username');
    });

    it('rejects `kind: api-token` with no `secret` (the token is missing)', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { auth: { kind: 'api-token' } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.auth.secret');
    });

    it('parses `kind: passkey` with no credential (the placeholder arm)', () => {
        const { config, warnings } = parseConfig({ sources: { x: { auth: { kind: 'passkey' } } } });
        expect(warnings).toEqual([]);
        expect(config.sources['x']?.kind).toBe('passkey');
    });

    it('rejects `kind: passkey` carrying a credential', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { auth: { kind: 'passkey', ref: 'op://V/i' } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.auth');
        expect((caught as ConfigError).message).toContain('passkey');
    });

    // --- References stay explicit: NO `op://` scheme auto-detection (the string IS the reference). ---
    it('parses a non-op:// reference (a bare env-var name) as a single-item login — no scheme branching', () => {
        const { config, warnings } = parseConfig({ sources: { x: 'FREE_FR_LOGIN_REF' } });
        expect(warnings).toEqual([]);
        expect(config.sources['x']?.kind).toBe('password');
        expect(config.sources['x']?.ref).toBe('FREE_FR_LOGIN_REF');
    });

    it('parses an `encrypted-file:` reference under `ref` — no scheme branching', () => {
        const { config } = parseConfig({ sources: { x: { auth: { ref: 'encrypted-file:/path/to/login' } } } });
        expect(config.sources['x']?.ref).toBe('encrypted-file:/path/to/login');
        expect(config.sources['x']?.kind).toBe('password');
    });

    // --- Backward compatibility: the existing explicit-kind forms validate unchanged (additive). ---
    it('still parses the existing explicit `kind: password` per-field form unchanged', () => {
        const { config } = parseConfig({
            sources: { 'free.fr': { auth: { kind: 'password', username: 'alice', secret: { ref: 'PW' } } } },
        });
        expect(config.sources['free.fr']?.kind).toBe('password');
        expect(config.sources['free.fr']?.secret).toEqual({ ref: 'PW' });
    });

    it('still parses the existing explicit `kind: api-token` + inline secret form (with its warning)', () => {
        const { config, warnings } = parseConfig({
            sources: { 'amazon.fr': { auth: { kind: 'api-token', secret: 'inline-token' } } },
        });
        expect(config.sources['amazon.fr']?.kind).toBe('api-token');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.path).toBe('sources.amazon.fr.auth.secret');
    });

    // --- parseConfig is PURE: no registry / adapter import (the collision is the adapter's, #169). ---
    it('parseConfig imports no adapter or source registry (it parses shape, never resolves it)', () => {
        const source = readFileSync(fileURLToPath(new URL('./config.ts', import.meta.url)), 'utf8');
        expect(source).not.toMatch(/from '@getreceipt\/(cli|adapter-)/);
        expect(source).not.toMatch(/SourceAdapterRegistry|SourceResolver|BUNDLED_ADAPTERS/);
    });
});

describe('parseConfig — #174 browser-session arm + derived `session` kind', () => {
    // --- `session` derives from the `browser`/`profile` pair, in either the `auth:` block or the sugar. ---
    it('derives `session` from an `auth: { browser, profile }` block when `kind` is omitted', () => {
        const { config, warnings } = parseConfig({
            sources: { 'amazon.fr': { auth: { browser: 'chrome', profile: 'Profile 1' } } },
        });
        expect(warnings).toEqual([]);
        const source = config.sources['amazon.fr'];
        expect(source?.kind).toBe('session');
        expect(source?.browser).toBe('chrome');
        expect(source?.profile).toBe('Profile 1');
        // A session carries NO credential.
        expect(source?.ref).toBeUndefined();
        expect(source?.username).toBeUndefined();
        expect(source?.secret).toBeUndefined();
    });

    it('desugars the top-level `{ browser, profile }` shorthand to the session arm (no `auth:` block)', () => {
        const { config, warnings } = parseConfig({
            sources: { 'amazon.fr': { browser: 'firefox', profile: 'default-release' } },
        });
        expect(warnings).toEqual([]);
        const source = config.sources['amazon.fr'];
        expect(source?.kind).toBe('session');
        expect(source?.browser).toBe('firefox');
        expect(source?.profile).toBe('default-release');
    });

    it('accepts an explicit `kind: session` validated against the shape (rc-window)', () => {
        const { config } = parseConfig({
            sources: { 'amazon.fr': { auth: { kind: 'session', browser: 'brave', profile: 'Default' } } },
        });
        expect(config.sources['amazon.fr']?.kind).toBe('session');
        expect(config.sources['amazon.fr']?.browser).toBe('brave');
    });

    it('accepts every browser in the closed BROWSER_KINDS vocabulary', () => {
        for (const browser of BROWSER_KINDS) {
            const { config } = parseConfig({ sources: { x: { browser, profile: 'P' } } });
            expect(config.sources['x']?.browser).toBe(browser);
            expect(config.sources['x']?.kind).toBe('session');
        }
    });

    // --- `session` is DERIVED, never summoned from a bare `kind:` (consistent with #151). ---
    it('rejects `kind: session` with no `browser`/`profile` (not declarable from thin air)', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { auth: { kind: 'session' } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.auth');
        expect((caught as ConfigError).message).toContain('session');
    });

    // --- Skew: a browser session and a credential are mutually exclusive (the compile-error, at runtime). ---
    it('rejects a session block carrying a credential `ref` (browser + ref skew)', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { auth: { browser: 'chrome', profile: 'P', ref: 'op://V/i' } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.auth');
        expect((caught as ConfigError).message).toContain('credential');
    });

    it('rejects a declared non-session kind carrying `browser`/`profile` (kind: password + browser)', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { auth: { kind: 'password', browser: 'chrome', profile: 'P' } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.auth');
        expect((caught as ConfigError).message).toContain('session');
    });

    // --- The arm needs BOTH fields — each alone is incomplete. ---
    it('rejects `browser` without `profile`, naming the missing field', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { auth: { browser: 'chrome' } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.auth.profile');
    });

    it('rejects `profile` without `browser`, naming the missing field', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { auth: { profile: 'Default' } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.auth.browser');
    });

    it('rejects an off-vocabulary `browser` value, naming the path (never echoing the value)', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { auth: { browser: 'safari', profile: 'P' } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.auth.browser');
        expect((caught as ConfigError).message).not.toContain('safari');
    });

    it('rejects an empty `profile` string, naming the path', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { auth: { browser: 'chrome', profile: '' } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.auth.profile');
    });

    // --- The top-level sugar and an `auth:` block are mutually exclusive — two credential sources is ambiguous. ---
    it('rejects mixing the top-level sugar with an `auth:` block', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { browser: 'chrome', profile: 'P', auth: { ref: 'op://V/i' } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x');
    });

    // --- `mfa` stays orthogonal — it attaches to the session arm like any other. ---
    it('accepts `mfa` alongside a session (orthogonal to the credential/session choice)', () => {
        const { config } = parseConfig({
            sources: { x: { auth: { browser: 'edge', profile: 'Work', mfa: { type: 'push' } } } },
        });
        expect(config.sources['x']?.kind).toBe('session');
        expect(config.sources['x']?.mfa?.type).toBe('push');
    });
});

describe('parseConfig — #218 manual-paste session arm + secure-supply', () => {
    // --- `session` derives from a `paste` reference, in either the `auth:` block or the sugar. ---
    it('derives `session` from an `auth: { paste: { ref } }` block when `kind` is omitted', () => {
        const { config, warnings } = parseConfig({
            sources: { 'amazon.fr': { auth: { paste: { ref: 'op://Private/amazon-session' } } } },
        });
        // A `paste` ref is a reference, NOT an inline secret — it resolves at run-time, so it never warns.
        expect(warnings).toEqual([]);
        const source = config.sources['amazon.fr'];
        expect(source?.kind).toBe('session');
        expect(source?.paste).toEqual({ ref: 'op://Private/amazon-session' });
        // A paste session carries no browser/profile and no password-style credential.
        expect(source?.browser).toBeUndefined();
        expect(source?.profile).toBeUndefined();
        expect(source?.ref).toBeUndefined();
        expect(source?.secret).toBeUndefined();
    });

    it('desugars the top-level `{ paste: { ref } }` shorthand to the session arm (no `auth:` block)', () => {
        const { config, warnings } = parseConfig({
            sources: { 'amazon.fr': { paste: { ref: 'COOKIES_ENV_VAR' } } },
        });
        expect(warnings).toEqual([]);
        const source = config.sources['amazon.fr'];
        expect(source?.kind).toBe('session');
        expect(source?.paste).toEqual({ ref: 'COOKIES_ENV_VAR' });
    });

    it('accepts an explicit `kind: session` validated against the paste shape (rc-window)', () => {
        const { config } = parseConfig({
            sources: { 'amazon.fr': { auth: { kind: 'session', paste: { ref: 'encrypted-file:cookies' } } } },
        });
        expect(config.sources['amazon.fr']?.kind).toBe('session');
        expect(config.sources['amazon.fr']?.paste).toEqual({ ref: 'encrypted-file:cookies' });
    });

    // --- Secure-supply: the pasted material is a live credential, so ONLY a `{ ref }` is accepted. ---
    it('rejects an INLINE pasted cookie value, never echoing it (secure-supply, #218)', () => {
        let caught: unknown;
        const inlineCookie = 'session-id=Atza|THE-LIVE-COOKIE-VALUE; ubid-acbfr=257';
        try {
            parseConfig({ sources: { x: { auth: { paste: inlineCookie } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.auth.paste');
        // Value-free: the rejection NEVER carries the inlined cookie (the whole point of forbidding it).
        expect((caught as ConfigError).message).not.toContain('THE-LIVE-COOKIE-VALUE');
        expect((caught as ConfigError).message).not.toContain('Atza');
        // Guidance points at the secure form.
        expect((caught as ConfigError).message).toContain('ref');
    });

    it('rejects a BARE-STRING paste value (ambiguous ref-vs-inline) — the `{ ref }` form is required', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { paste: 'op://Private/amazon-session' } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.paste');
    });

    it('rejects an empty `paste.ref`, naming the path', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { auth: { paste: { ref: '' } } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.auth.paste');
    });

    // --- Skew: the two session shapes are mutually exclusive, and a session takes no credential. ---
    it('rejects mixing `paste` with `browser`/`profile` (two session shapes)', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { auth: { paste: { ref: 'op://V/i' }, browser: 'chrome', profile: 'P' } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.auth');
        expect((caught as ConfigError).message).toContain('paste');
    });

    it('rejects a paste session carrying a credential `secret` (paste + secret skew)', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { auth: { paste: { ref: 'op://V/i' }, secret: { ref: 'op://V/s' } } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.auth');
        expect((caught as ConfigError).message).toContain('credential');
    });

    it('rejects a declared non-session kind carrying `paste` (kind: password + paste)', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { auth: { kind: 'password', paste: { ref: 'op://V/i' } } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.auth');
        expect((caught as ConfigError).message).toContain('session');
    });

    it('names `paste` as an option when `kind: session` is declared with no session shape', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { auth: { kind: 'session' } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        // The message now offers BOTH session shapes — browser/profile OR paste.
        expect((caught as ConfigError).message).toContain('paste');
    });

    // --- `mfa` stays orthogonal — it attaches to the paste arm like any other. ---
    it('accepts `mfa` alongside a paste session (orthogonal to the session shape)', () => {
        const { config } = parseConfig({
            sources: { x: { auth: { paste: { ref: 'op://V/i' }, mfa: { type: 'push' } } } },
        });
        expect(config.sources['x']?.kind).toBe('session');
        expect(config.sources['x']?.mfa?.type).toBe('push');
    });

    // --- multi-instance is orthogonal too (#190): one pasted session, data per instance. ---
    it('accepts an `instances` list alongside a paste session (#190 × #218)', () => {
        const { config } = parseConfig({
            sources: { 'amazon.fr': { paste: { ref: 'op://V/i' }, instances: ['amazon.fr', 'amazon.com'] } },
        });
        expect(config.sources['amazon.fr']?.kind).toBe('session');
        expect(config.sources['amazon.fr']?.instances).toEqual(['amazon.fr', 'amazon.com']);
    });
});

describe('parseConfig — #254 multi-account (`accounts:` outer key)', () => {
    it('[AC2] parses an `accounts:` list to N account-scoped session credentials (account + browser + profile + instances)', () => {
        const { config, warnings } = parseConfig({
            sources: {
                amazon: {
                    accounts: [
                        {
                            account: 'personal',
                            browser: 'chrome',
                            profile: 'personal',
                            instances: ['amazon.com', 'amazon.fr'],
                        },
                        { account: 'business', browser: 'chrome', profile: 'business', instances: ['amazon.de'] },
                    ],
                },
            },
        });
        expect(warnings).toEqual([]);
        const source = config.sources['amazon'];
        expect(source?.kind).toBe('session');
        expect(source?.accounts).toHaveLength(2);
        expect(source?.accounts?.[0]).toEqual({
            account: 'personal',
            browser: 'chrome',
            profile: 'personal',
            instances: ['amazon.com', 'amazon.fr'],
        });
        expect(source?.accounts?.[1]).toEqual({
            account: 'business',
            browser: 'chrome',
            profile: 'business',
            instances: ['amazon.de'],
        });
    });

    it('[AC2] accepts an account without an explicit `instances` list (a single-instance account)', () => {
        const { config } = parseConfig({
            sources: { amazon: { accounts: [{ account: 'solo', browser: 'firefox', profile: 'default-release' }] } },
        });
        const account = config.sources['amazon']?.accounts?.[0];
        expect(account).toEqual({ account: 'solo', browser: 'firefox', profile: 'default-release' });
        expect(account?.instances).toBeUndefined();
    });

    it('[AC2] honors a redundant literal `kind: session` alongside `accounts:` (derived, never summoned)', () => {
        const { config } = parseConfig({
            sources: { amazon: { kind: 'session', accounts: [{ account: 'a', browser: 'chrome', profile: 'p' }] } },
        });
        expect(config.sources['amazon']?.kind).toBe('session');
        expect(config.sources['amazon']?.accounts).toHaveLength(1);
    });

    it('[AC3] a single-account `{browser, profile, instances}` config parses IDENTICALLY to today — no `accounts` key materializes', () => {
        const { config } = parseConfig({
            sources: { amazon: { browser: 'chrome', profile: 'Profile 1', instances: ['amazon.com', 'amazon.fr'] } },
        });
        const source = config.sources['amazon'];
        expect(source?.kind).toBe('session');
        expect(source?.browser).toBe('chrome');
        expect(source?.profile).toBe('Profile 1');
        expect(source?.instances).toEqual(['amazon.com', 'amazon.fr']);
        // The additive branch leaves the single-account shape untouched — the `accounts` KEY is absent, not just undefined.
        expect(source?.accounts).toBeUndefined();
        expect('accounts' in (source ?? {})).toBe(false);
    });

    it('[AC4] rejects two accounts with a duplicate `account` key (value-free, path-localized)', () => {
        let caught: unknown;
        try {
            parseConfig({
                sources: {
                    amazon: {
                        accounts: [
                            { account: 'acct-x9', browser: 'chrome', profile: 'one' },
                            { account: 'acct-x9', browser: 'chrome', profile: 'two' },
                        ],
                    },
                },
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.amazon.accounts[1].account');
        expect((caught as ConfigError).message).toContain('unique');
        // Value-free: the path localizes WHICH entry; the account key (which can be an email) is never echoed.
        expect((caught as ConfigError).message).not.toContain('acct-x9');
    });

    it('[AC4] rejects two accounts sharing one browser `profile` (a shared cookie jar cross-contaminates)', () => {
        let caught: unknown;
        try {
            parseConfig({
                sources: {
                    amazon: {
                        accounts: [
                            { account: 'personal', browser: 'chrome', profile: 'dir-alpha' },
                            { account: 'business', browser: 'chrome', profile: 'dir-alpha' },
                        ],
                    },
                },
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.amazon.accounts[1].profile');
        expect((caught as ConfigError).message).toContain('cross-contaminate');
        // Value-free: the profile (which can be an account email) is never echoed — only the path localizes it.
        expect((caught as ConfigError).message).not.toContain('dir-alpha');
    });

    it('[AC4] rejects an empty `accounts:` list', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { amazon: { accounts: [] } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.amazon.accounts');
        expect((caught as ConfigError).message).toContain('at least one');
    });

    it('[AC4] rejects `accounts:` mixed with a top-level `browser`/`profile` (one account OR a list, not both)', () => {
        let caught: unknown;
        try {
            parseConfig({
                sources: {
                    amazon: {
                        browser: 'chrome',
                        profile: 'p',
                        accounts: [{ account: 'a', browser: 'chrome', profile: 'q' }],
                    },
                },
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.amazon');
        expect((caught as ConfigError).message).toContain('not both');
    });

    it('[AC4] rejects a source-level `instances:` alongside `accounts:` (instances move UNDER each account)', () => {
        let caught: unknown;
        try {
            parseConfig({
                sources: {
                    amazon: {
                        accounts: [{ account: 'a', browser: 'chrome', profile: 'p' }],
                        instances: ['amazon.com'],
                    },
                },
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.amazon.instances');
    });

    it('[AC4] rejects a non-`session` `kind:` alongside `accounts:`', () => {
        let caught: unknown;
        try {
            parseConfig({
                sources: {
                    amazon: { kind: 'password', accounts: [{ account: 'a', browser: 'chrome', profile: 'p' }] },
                },
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.amazon.kind');
    });

    it('[AC4] rejects an account entry carrying a credential (an account is a browser session, not a login)', () => {
        let caught: unknown;
        try {
            parseConfig({
                sources: { amazon: { accounts: [{ account: 'a', browser: 'chrome', profile: 'p', ref: 'op://V/i' }] } },
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.amazon.accounts[0]');
    });

    it('[AC4] rejects an account entry missing its `account` key', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { amazon: { accounts: [{ browser: 'chrome', profile: 'p' }] } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.amazon.accounts[0].account');
    });

    it('[AC4] rejects an off-vocabulary `browser` in an account entry (reuses the closed BrowserKind vocab)', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { amazon: { accounts: [{ account: 'a', browser: 'safari', profile: 'p' }] } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.amazon.accounts[0].browser');
    });
});

describe('parseConfig — #155 strict mode (fail closed on inline-literal secrets)', () => {
    const secret = 'super-secret-password';
    const inlineSecretConfig = { sources: { 'free.fr': { auth: { kind: 'password', secret } } } };

    it('rejects an inline-literal secret in strict mode — via the `--strict` option', () => {
        let caught: unknown;
        try {
            parseConfig(inlineSecretConfig, { strict: true });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.free.fr.auth.secret');
        // Value-free: the rejection names only the path, never the secret (so a `--strict` run can forbid
        // on-disk secrets without the rejection itself leaking one).
        expect((caught as ConfigError).message).not.toContain(secret);
        expect((caught as ConfigError).message).toContain('strict mode');
    });

    it('rejects an inline-literal secret in strict mode — via a config-level `strict: true` key', () => {
        let caught: unknown;
        try {
            parseConfig({ strict: true, ...inlineSecretConfig });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.free.fr.auth.secret');
        expect((caught as ConfigError).message).not.toContain(secret);
    });

    it('leaves default (non-strict) behavior unchanged — the SAME config warns + is accepted', () => {
        const { config, warnings } = parseConfig(inlineSecretConfig);
        // Parsing succeeds (the value is accepted) and the inline-credential warning is present.
        expect(config.sources['free.fr']?.secret).toBe(secret);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.code).toBe('inline-credential');
        expect(warnings[0]?.path).toBe('sources.free.fr.auth.secret');
    });

    it('accepts a secret REFERENCE in strict mode — only inline literals fail closed', () => {
        const { config, warnings } = parseConfig(
            { sources: { 'free.fr': { auth: { kind: 'password', secret: { ref: 'FREE_PW' } } } } },
            { strict: true },
        );
        expect(config.sources['free.fr']?.secret).toEqual({ ref: 'FREE_PW' });
        expect(warnings).toEqual([]);
    });

    it('rejects an inline-literal MFA `seed` in strict mode (the seed routes through the secret path)', () => {
        const seed = 'JBSWY3DPEHPK3PXP';
        let caught: unknown;
        try {
            parseConfig(
                {
                    sources: {
                        'free.fr': { auth: { kind: 'password', secret: { ref: 'PW' }, mfa: { type: 'totp', seed } } },
                    },
                },
                { strict: true },
            );
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.free.fr.auth.mfa.seed');
        expect((caught as ConfigError).message).not.toContain(seed);
    });

    it('rejects an inline-literal api-token `secret` in strict mode', () => {
        const token = 'tok-do-not-leak';
        let caught: unknown;
        try {
            parseConfig(
                { sources: { 'shop.example': { auth: { kind: 'api-token', secret: token } } } },
                { strict: true },
            );
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.shop.example.auth.secret');
        expect((caught as ConfigError).message).not.toContain(token);
    });

    it('does NOT reject an inline-literal username in strict mode (a username is not a secret)', () => {
        const { config, warnings } = parseConfig(
            {
                sources: {
                    'free.fr': { auth: { kind: 'password', username: 'alice@free.fr', secret: { ref: 'PW' } } },
                },
            },
            { strict: true },
        );
        expect(config.sources['free.fr']?.username).toBe('alice@free.fr');
        expect(warnings).toEqual([]);
    });

    it('keeps an inline paste REJECTED in BOTH modes — strict does not weaken #218', () => {
        const inlineCookie = 'session-id=Atza|THE-LIVE-COOKIE; ubid=257';
        for (const options of [undefined, { strict: true }]) {
            let caught: unknown;
            try {
                parseConfig({ sources: { x: { auth: { paste: inlineCookie } } } }, options);
            } catch (error) {
                caught = error;
            }
            expect(caught).toBeInstanceOf(ConfigError);
            expect((caught as ConfigError).path).toBe('sources.x.auth.paste');
            expect((caught as ConfigError).message).not.toContain(inlineCookie);
        }
    });

    it('rejects a non-boolean `strict:` key, naming the path (a typo must not silently disable the gate)', () => {
        let caught: unknown;
        try {
            parseConfig({ strict: 'true', ...inlineSecretConfig });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('strict');
    });

    it('a config `strict: false` key does not enable the gate (inline secret still merely warns)', () => {
        const { config, warnings } = parseConfig({ strict: false, ...inlineSecretConfig });
        expect(config.sources['free.fr']?.secret).toBe(secret);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.code).toBe('inline-credential');
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

    // #151 + #130: a bare-ref-sugar source and a ref-shorthand + mfa source parse together in one file.
    it('loads a bare-ref source alongside a ref-shorthand + mfa source', () => {
        const fixturePath = fileURLToPath(new URL('./__fixtures__/bare-ref-mfa.getreceipt.yaml', import.meta.url));

        const { config, warnings } = loadConfig(fixturePath);

        expect(warnings).toEqual([]);
        // Bare-ref sugar → single-item login, kind derived to password.
        expect(config.sources['pro.free.fr']?.kind).toBe('password');
        expect(config.sources['pro.free.fr']?.ref).toBe('op://Personal/pro.free.fr');
        // `ref` shorthand (kind derived) carrying an orthogonal mfa block — both parse together.
        expect(config.sources['free.fr']?.kind).toBe('password');
        expect(config.sources['free.fr']?.ref).toBe('op://Personal/free.fr');
        expect(config.sources['free.fr']?.mfa).toEqual({ type: 'totp', seed: { ref: 'op://Personal/free.fr/totp' } });
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

describe('parseConfig — #190 multi-instance `instances:` list', () => {
    it('parses an `instances` list beside the session shorthand (credential configured once)', () => {
        const { config, warnings } = parseConfig({
            sources: { 'amazon.fr': { browser: 'chrome', profile: 'Default', instances: ['amazon.fr', 'amazon.com'] } },
        });
        expect(warnings).toEqual([]);
        const source = config.sources['amazon.fr'];
        expect(source?.kind).toBe('session');
        expect(source?.browser).toBe('chrome');
        expect(source?.instances).toEqual(['amazon.fr', 'amazon.com']);
    });

    it('parses an `instances` list beside an explicit `auth:` block (source-level sibling)', () => {
        const { config } = parseConfig({
            sources: {
                'amazon.fr': {
                    auth: { browser: 'chrome', profile: 'Default' },
                    instances: ['amazon.fr', 'amazon.com'],
                },
            },
        });
        expect(config.sources['amazon.fr']?.instances).toEqual(['amazon.fr', 'amazon.com']);
    });

    it('leaves `instances` undefined for a single-instance source (omitted = unchanged)', () => {
        const { config } = parseConfig({ sources: { 'free.fr': { auth: { kind: 'password', ref: 'op://V/i' } } } });
        expect(config.sources['free.fr']?.instances).toBeUndefined();
    });

    it('allows `instances` on a non-session source too (orthogonal to the credential shape)', () => {
        const { config } = parseConfig({
            sources: { 'shop.example': { auth: { kind: 'password', ref: 'op://V/i' }, instances: ['shop.example'] } },
        });
        expect(config.sources['shop.example']?.instances).toEqual(['shop.example']);
    });

    it('rejects a non-array `instances`', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { browser: 'chrome', profile: 'P', instances: 'amazon.com' } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.instances');
    });

    it('rejects an empty `instances` list (omit it instead)', () => {
        expect(() => parseConfig({ sources: { x: { browser: 'chrome', profile: 'P', instances: [] } } })).toThrow(
            ConfigError,
        );
    });

    it('rejects a non-string / empty `instances` entry, pinpointing the index', () => {
        let caught: unknown;
        try {
            parseConfig({ sources: { x: { browser: 'chrome', profile: 'P', instances: ['amazon.fr', ''] } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.x.instances[1]');
    });
});

describe('parseConfig — #264 source-level `transport` tier selection', () => {
    it('parses `transport: headless-browser` beside a session shorthand (source-level sibling)', () => {
        const { config, warnings } = parseConfig({
            sources: { 'amazon.com': { browser: 'chrome', profile: 'Default', transport: 'headless-browser' } },
        });
        expect(warnings).toEqual([]);
        const source = config.sources['amazon.com'];
        expect(source?.kind).toBe('session');
        expect(source?.transport).toBe('headless-browser');
    });

    it('parses `transport` beside an explicit `auth:` block (read from the source mapping, not the auth block)', () => {
        const { config } = parseConfig({
            sources: {
                'amazon.com': { auth: { browser: 'chrome', profile: 'Default' }, transport: 'headless-browser' },
            },
        });
        expect(config.sources['amazon.com']?.transport).toBe('headless-browser');
    });

    it('carries `transport` on a multi-account (`accounts:`) source (fail-closed wiring is enforced downstream)', () => {
        const { config } = parseConfig({
            sources: {
                'amazon.com': {
                    accounts: [{ account: 'personal', browser: 'chrome', profile: 'personal' }],
                    transport: 'headless-browser',
                },
            },
        });
        const source = config.sources['amazon.com'];
        expect(source?.accounts).toHaveLength(1);
        expect(source?.transport).toBe('headless-browser');
    });

    it('accepts every tier in the closed vocabulary', () => {
        for (const tier of TRANSPORT_TIERS) {
            const { config } = parseConfig({ sources: { s: { browser: 'chrome', profile: 'P', transport: tier } } });
            expect(config.sources.s?.transport).toBe(tier);
        }
    });

    it('leaves `transport` undefined when omitted (the default HTTP path, unchanged)', () => {
        const { config } = parseConfig({ sources: { 'amazon.com': { browser: 'chrome', profile: 'Default' } } });
        expect(config.sources['amazon.com']?.transport).toBeUndefined();
    });

    it('rejects an unknown `transport` value, value-free (path only)', () => {
        let caught: unknown;
        try {
            parseConfig({
                sources: { 'amazon.com': { browser: 'chrome', profile: 'P', transport: 'quantum-teleport' } },
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('sources.amazon.com.transport');
        expect((caught as ConfigError).message).not.toContain('quantum-teleport');
    });
});
