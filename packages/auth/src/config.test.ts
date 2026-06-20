// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, parseConfig } from './index.js';

describe('parseConfig', () => {
    it('parses a valid config into typed profiles and per-domain auth', () => {
        const { config, warnings } = parseConfig({
            profiles: {
                default: {
                    sources: {
                        'free.fr': {
                            auth: { kind: 'password', username: 'alice', secret: { ref: 'FREE_PW' } },
                        },
                    },
                },
            },
        });

        expect(warnings).toEqual([]);
        const source = config.profiles.default?.sources['free.fr'];
        expect(source?.kind).toBe('password');
        expect(source?.username).toBe('alice');
        expect(source?.secret).toEqual({ ref: 'FREE_PW' });
    });

    it('throws an actionable ConfigError, naming the path, when `profiles` is missing', () => {
        expect(() => parseConfig({})).toThrow(ConfigError);

        let caught: unknown;
        try {
            parseConfig({});
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('profiles');
    });

    it('throws a ConfigError naming the offending path for an unknown auth kind', () => {
        let caught: unknown;
        try {
            parseConfig({ profiles: { default: { sources: { 'free.fr': { auth: { kind: 'magic' } } } } } });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        expect((caught as ConfigError).path).toBe('profiles.default.sources.free.fr.auth.kind');
        expect((caught as ConfigError).message).toContain('password');
    });

    it('warns — without echoing the value — when a credential is an inline literal', () => {
        const secret = 'super-secret-password';
        const { warnings } = parseConfig({
            profiles: { default: { sources: { 'free.fr': { auth: { kind: 'password', secret } } } } },
        });

        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.code).toBe('inline-credential');
        expect(warnings[0]?.path).toBe('profiles.default.sources.free.fr.auth.secret');
        expect(warnings[0]?.message).not.toContain(secret);
    });

    it('does not warn when a credential is a secret reference', () => {
        const { warnings } = parseConfig({
            profiles: {
                default: { sources: { 'free.fr': { auth: { kind: 'password', secret: { ref: 'PW' } } } } },
            },
        });

        expect(warnings).toEqual([]);
    });

    it('never includes a configured secret value in a validation error', () => {
        const secret = 'top-secret-do-not-leak';
        let caught: unknown;
        try {
            parseConfig({
                profiles: {
                    default: {
                        sources: { 'free.fr': { auth: { kind: 'password', username: 123, secret } } },
                    },
                },
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
        { label: 'profiles is a sequence', raw: { profiles: [] }, path: 'profiles' },
        {
            label: 'sources is a sequence',
            raw: { profiles: { default: { sources: [] } } },
            path: 'profiles.default.sources',
        },
        {
            label: 'a source is null',
            raw: { profiles: { default: { sources: { 'free.fr': null } } } },
            path: 'profiles.default.sources.free.fr',
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

describe('loadConfig', () => {
    it('loads and validates a YAML config file from disk', () => {
        const fixturePath = fileURLToPath(new URL('./__fixtures__/valid.getreceipt.yaml', import.meta.url));

        const { config, warnings } = loadConfig(fixturePath);

        expect(Object.keys(config.profiles)).toEqual(['default']);
        expect(config.profiles.default?.sources['free.fr']?.kind).toBe('password');
        expect(config.profiles.default?.sources['free.fr']?.secret).toEqual({ ref: 'FREE_PASSWORD' });
        // The fixture configures amazon.fr with an inline literal → exactly one warning, value not echoed.
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.path).toBe('profiles.default.sources.amazon.fr.auth.secret');
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
