// SPDX-License-Identifier: AGPL-3.0-only
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ConfigError } from '@getreceipt/auth';
import type { ConfigParseResult, GetReceiptConfig } from '@getreceipt/auth';
import { describe, expect, it } from 'vitest';

import {
    CONFIG_ENV,
    OPT_IN_ENV,
    PROFILE_ENV,
    resolveLiveGate,
    SECRET_ENV,
    SOURCE_ENV,
    USERNAME_ENV,
    type GateEnv,
    type LiveGateDeps,
} from './gate.js';

/**
 * Self-test of the gating / skip / source-discovery logic (#19 AC2 + the per-file dogfood refactor).
 * This is the genuinely-executing proof that the harness is off by default, skips cleanly when nothing
 * is configured, and turns the configured PRODUCT config (one flat profile per file) into the right
 * plan list — driven over synthetic environments and a FAKE `loadConfig`, so it runs in CI with no
 * opt-in, no file on disk, and no credentials. (The live test that actually contacts a service is
 * gated ON this decision and stays skipped here.)
 */

/** A `loadConfig` double: returns the given config (or throws the given error). Satisfies the injected `deps.loadConfig` seam. */
function fakeLoadConfig(
    result: GetReceiptConfig | Error,
    spy?: { calledWith?: string | undefined; called?: boolean },
): LiveGateDeps['loadConfig'] {
    return ((filePath?: string): ConfigParseResult => {
        if (spy) {
            spy.called = true;
            spy.calledWith = filePath;
        }
        if (result instanceof Error) {
            throw result;
        }
        return { config: result, warnings: [] };
    }) as LiveGateDeps['loadConfig'];
}

/** A flat config (one profile per file) with the given sources — used as the happy-path baseline. */
function configWith(sources: GetReceiptConfig['sources']): GetReceiptConfig {
    return { sources };
}

const ONE_SOURCE = configWith({
    'grandfrais.com': {
        kind: 'password',
        username: 'shopper@example.com',
        secret: { ref: 'op://Private/gf/pw' },
    },
});

describe('resolveLiveGate — off by default', () => {
    it('skips when the opt-in flag is absent (the CI default), without ever loading config', () => {
        const spy = { called: false };
        const decision = resolveLiveGate({}, { loadConfig: fakeLoadConfig(ONE_SOURCE, spy) });
        expect(decision.run).toBe(false);
        if (!decision.run) {
            expect(decision.reason).toContain(OPT_IN_ENV);
            expect(decision.reason).toContain('off by default');
        }
        // The opt-in short-circuits before any I/O — config is never read when not opted in.
        expect(spy.called).toBe(false);
    });

    it.each(['0', 'false', 'no', 'off', '', '  ', 'enabled-ish'])('treats %j as NOT opted in', (flag) => {
        const env: GateEnv = {
            [OPT_IN_ENV]: flag,
            [SOURCE_ENV]: 'grandfrais.com',
            [USERNAME_ENV]: 'shopper@example.com',
            [SECRET_ENV]: 'op://Private/gf/pw',
        };
        expect(resolveLiveGate(env, { loadConfig: fakeLoadConfig(ONE_SOURCE) }).run).toBe(false);
    });

    it.each(['1', 'true', 'yes', 'on', 'TRUE', ' On '])(
        'treats %j as opted in (via the env-triple override)',
        (flag) => {
            const env: GateEnv = {
                [OPT_IN_ENV]: flag,
                [SOURCE_ENV]: 'grandfrais.com',
                [USERNAME_ENV]: 'shopper@example.com',
                [SECRET_ENV]: 'op://Private/gf/pw',
            };
            expect(resolveLiveGate(env, { loadConfig: fakeLoadConfig(ONE_SOURCE) }).run).toBe(true);
        },
    );
});

describe('resolveLiveGate — single-source env override (the #81 fast-path)', () => {
    const overrideEnv = (secret: string): GateEnv => ({
        [OPT_IN_ENV]: '1',
        [SOURCE_ENV]: '  grandfrais.com  ',
        [USERNAME_ENV]: '  shopper@example.com  ',
        [SECRET_ENV]: secret,
    });

    it('produces a single plan with the trimmed source and username, WITHOUT loading config', () => {
        const spy = { called: false };
        const decision = resolveLiveGate(overrideEnv('op://Private/gf/pw'), {
            loadConfig: fakeLoadConfig(ONE_SOURCE, spy),
        });
        expect(decision.run).toBe(true);
        if (decision.run) {
            expect(decision.plans).toHaveLength(1);
            expect(decision.plans[0]?.source).toBe('grandfrais.com');
            expect(decision.plans[0]?.username).toBe('shopper@example.com');
        }
        // The complete triple short-circuits the config path entirely.
        expect(spy.called).toBe(false);
    });

    it('carries an op:// secret as a backend reference (resolved at call-time, not here)', () => {
        const decision = resolveLiveGate(overrideEnv('op://Private/gf/pw'), { loadConfig: fakeLoadConfig(ONE_SOURCE) });
        expect(decision.run).toBe(true);
        if (decision.run) {
            expect(decision.plans[0]?.secret).toEqual({ ref: 'op://Private/gf/pw' });
        }
    });

    it('carries an encrypted-file: secret as a backend reference', () => {
        const decision = resolveLiveGate(overrideEnv('encrypted-file:/secrets/gf.age'), {
            loadConfig: fakeLoadConfig(ONE_SOURCE),
        });
        expect(decision.run).toBe(true);
        if (decision.run) {
            expect(decision.plans[0]?.secret).toEqual({ ref: 'encrypted-file:/secrets/gf.age' });
        }
    });

    it('carries any other secret as an inline literal (matching the resolver dispatch)', () => {
        const decision = resolveLiveGate(overrideEnv('literal-password'), { loadConfig: fakeLoadConfig(ONE_SOURCE) });
        expect(decision.run).toBe(true);
        if (decision.run) {
            expect(decision.plans[0]?.secret).toBe('literal-password');
        }
    });

    it('wraps an op:// env username as a backend reference (resolved at call-time, like the secret)', () => {
        const env: GateEnv = {
            [OPT_IN_ENV]: '1',
            [SOURCE_ENV]: 'grandfrais.com',
            [USERNAME_ENV]: 'op://Private/gf/username',
            [SECRET_ENV]: 'op://Private/gf/pw',
        };
        const decision = resolveLiveGate(env, { loadConfig: fakeLoadConfig(ONE_SOURCE) });
        expect(decision.run).toBe(true);
        if (decision.run) {
            expect(decision.plans[0]?.username).toEqual({ ref: 'op://Private/gf/username' });
        }
    });

    it('keeps a plain env username as an inline literal (matching the resolver dispatch)', () => {
        const decision = resolveLiveGate(overrideEnv('op://Private/gf/pw'), { loadConfig: fakeLoadConfig(ONE_SOURCE) });
        expect(decision.run).toBe(true);
        if (decision.run) {
            // A non-`op://` / non-`encrypted-file:` username stays a literal — back-compat for plain emails.
            expect(decision.plans[0]?.username).toBe('shopper@example.com');
        }
    });

    it('falls through to config when the triple is incomplete (only source + username, no secret)', () => {
        const spy = { called: false };
        const env: GateEnv = {
            [OPT_IN_ENV]: '1',
            [SOURCE_ENV]: 'grandfrais.com',
            [USERNAME_ENV]: 'shopper@example.com',
            // no SECRET_ENV → not a complete override → config path is used
        };
        const decision = resolveLiveGate(env, { loadConfig: fakeLoadConfig(ONE_SOURCE, spy) });
        expect(decision.run).toBe(true);
        expect(spy.called).toBe(true);
        if (decision.run) {
            expect(decision.plans).toHaveLength(1);
            expect(decision.plans[0]?.source).toBe('grandfrais.com');
        }
    });
});

describe('resolveLiveGate — config-sourced (dogfood) multi-source', () => {
    const TWO_SOURCES = configWith({
        'grandfrais.com': {
            kind: 'password',
            username: 'a@example.com',
            secret: { ref: 'op://Private/gf/pw' },
        },
        'monoprix.fr': { kind: 'password', username: 'b@example.com', secret: { ref: 'op://Private/mp/pw' } },
    });

    it('maps every configured source (with creds) to a plan', () => {
        const decision = resolveLiveGate({ [OPT_IN_ENV]: '1' }, { loadConfig: fakeLoadConfig(TWO_SOURCES) });
        expect(decision.run).toBe(true);
        if (decision.run) {
            expect(decision.plans).toHaveLength(2);
            expect(decision.plans.map((p) => p.source)).toEqual(['grandfrais.com', 'monoprix.fr']);
            expect(decision.plans.map((p) => p.username)).toEqual(['a@example.com', 'b@example.com']);
            expect(decision.plans[0]?.secret).toEqual({ ref: 'op://Private/gf/pw' });
        }
    });

    it('passes an explicit GETRECEIPT_E2E_CONFIG path straight through to loadConfig (tier 1)', () => {
        const spy: { calledWith?: string | undefined; called?: boolean } = {};
        resolveLiveGate(
            { [OPT_IN_ENV]: '1', [CONFIG_ENV]: '/tmp/custom.getreceipt.yaml' },
            { loadConfig: fakeLoadConfig(TWO_SOURCES, spy) },
        );
        expect(spy.calledWith).toBe('/tmp/custom.getreceipt.yaml');
    });

    it('loads the home-default file (~/.getreceipt.yaml) when neither config path nor profile is set', () => {
        const spy: { calledWith?: string | undefined; called?: boolean } = {};
        resolveLiveGate({ [OPT_IN_ENV]: '1' }, { loadConfig: fakeLoadConfig(TWO_SOURCES, spy) });
        expect(spy.called).toBe(true);
        // Per-file model: with nothing set, the gate resolves the product home default and loads THAT path.
        expect(spy.calledWith).toBe(join(homedir(), '.getreceipt.yaml'));
    });

    it('selects the profile FILE named by GETRECEIPT_E2E_PROFILE (~/.getreceipt/<profile>.yaml)', () => {
        const spy: { calledWith?: string | undefined; called?: boolean } = {};
        resolveLiveGate(
            { [OPT_IN_ENV]: '1', [PROFILE_ENV]: 'staging' },
            {
                loadConfig: fakeLoadConfig(
                    configWith({ 'monoprix.fr': { kind: 'password', username: 'b@x', secret: { ref: 'op://b' } } }),
                    spy,
                ),
            },
        );
        // The profile selects a per-file path; the gate loads exactly that file.
        expect(spy.calledWith).toBe(join(homedir(), '.getreceipt', 'staging.yaml'));
    });

    it('skips a source missing its secret, keeping the fully-configured ones (not a hard error)', () => {
        const mixed = configWith({
            'grandfrais.com': {
                kind: 'password',
                username: 'a@example.com',
                secret: { ref: 'op://Private/gf/pw' },
            },
            'monoprix.fr': { kind: 'password', username: 'b@example.com' }, // no secret
        });
        const decision = resolveLiveGate({ [OPT_IN_ENV]: '1' }, { loadConfig: fakeLoadConfig(mixed) });
        expect(decision.run).toBe(true);
        if (decision.run) {
            expect(decision.plans.map((p) => p.source)).toEqual(['grandfrais.com']);
        }
    });

    it('skips a source missing its username too', () => {
        const mixed = configWith({
            'grandfrais.com': { kind: 'password', secret: { ref: 'op://Private/gf/pw' } }, // no username
            'monoprix.fr': {
                kind: 'password',
                username: 'b@example.com',
                secret: { ref: 'op://Private/mp/pw' },
            },
        });
        const decision = resolveLiveGate({ [OPT_IN_ENV]: '1' }, { loadConfig: fakeLoadConfig(mixed) });
        expect(decision.run).toBe(true);
        if (decision.run) {
            expect(decision.plans.map((p) => p.source)).toEqual(['monoprix.fr']);
        }
    });

    it('carries an inline-literal config secret through unchanged (the resolver still handles it)', () => {
        const inline = configWith({
            'grandfrais.com': { kind: 'password', username: 'a@x', secret: 'literal-pw' },
        });
        const decision = resolveLiveGate({ [OPT_IN_ENV]: '1' }, { loadConfig: fakeLoadConfig(inline) });
        expect(decision.run).toBe(true);
        if (decision.run) {
            expect(decision.plans[0]?.secret).toBe('literal-pw');
        }
    });

    it('maps a config username reference straight into the plan (resolved at call-time, not here)', () => {
        const refUsername = configWith({
            'grandfrais.com': {
                kind: 'password',
                username: { ref: 'op://Private/gf/username' },
                secret: { ref: 'op://Private/gf/pw' },
            },
        });
        const decision = resolveLiveGate({ [OPT_IN_ENV]: '1' }, { loadConfig: fakeLoadConfig(refUsername) });
        expect(decision.run).toBe(true);
        if (decision.run) {
            expect(decision.plans[0]?.username).toEqual({ ref: 'op://Private/gf/username' });
        }
    });
});

describe('resolveLiveGate — session sources (no credential to resolve)', () => {
    const SESSION_ONLY = configWith({
        'amazon.fr': { kind: 'session', browser: 'chrome', profile: 'Default' },
    });

    it('maps a configured session source to a session plan carrying its { browser, profile } (no username/secret)', () => {
        const decision = resolveLiveGate({ [OPT_IN_ENV]: '1' }, { loadConfig: fakeLoadConfig(SESSION_ONLY) });
        expect(decision.run).toBe(true);
        if (decision.run) {
            expect(decision.plans).toHaveLength(1);
            // A bare session source carries no username/secret — it must NOT be dropped by the password
            // "missing creds" skip; the { browser, profile } pair IS the whole plan (#180).
            expect(decision.plans[0]).toEqual({
                kind: 'session',
                source: 'amazon.fr',
                browser: 'chrome',
                profile: 'Default',
            });
        }
    });

    it('maps a mixed profile (password + session) to one plan each, in config order', () => {
        const mixed = configWith({
            'grandfrais.com': { kind: 'password', username: 'a@example.com', secret: { ref: 'op://Private/gf/pw' } },
            'amazon.fr': { kind: 'session', browser: 'chrome', profile: 'shopper@example.com' },
        });
        const decision = resolveLiveGate({ [OPT_IN_ENV]: '1' }, { loadConfig: fakeLoadConfig(mixed) });
        expect(decision.run).toBe(true);
        if (decision.run) {
            expect(decision.plans.map((p) => p.kind)).toEqual(['password', 'session']);
            expect(decision.plans.map((p) => p.source)).toEqual(['grandfrais.com', 'amazon.fr']);
            // The session plan carries the profile (an account email is a valid profile value), no secret.
            expect(decision.plans[1]).toMatchObject({
                kind: 'session',
                browser: 'chrome',
                profile: 'shopper@example.com',
            });
        }
    });
});

describe('resolveLiveGate — clean skip (never a failure) when config yields nothing usable', () => {
    it('skips with a secret-free reason when the config file cannot be loaded', () => {
        const decision = resolveLiveGate(
            { [OPT_IN_ENV]: '1' },
            { loadConfig: fakeLoadConfig(new ConfigError('config file could not be read', '/no/such.yaml')) },
        );
        expect(decision.run).toBe(false);
        if (!decision.run) {
            expect(decision.reason).toContain(OPT_IN_ENV);
            expect(decision.reason).toContain('could not load config');
            // The reason carries no secret material (ConfigError never echoes values).
            expect(decision.reason).not.toContain('op://');
        }
    });

    it('skips (could-not-load) when the named profile FILE does not exist', () => {
        // A missing profile is now a missing FILE, surfaced as a secret-free load failure.
        const decision = resolveLiveGate(
            { [OPT_IN_ENV]: '1', [PROFILE_ENV]: 'nope' },
            {
                loadConfig: fakeLoadConfig(
                    new ConfigError('config file could not be read', join(homedir(), '.getreceipt', 'nope.yaml')),
                ),
            },
        );
        expect(decision.run).toBe(false);
        if (!decision.run) {
            expect(decision.reason).toContain('could not load config');
            expect(decision.reason).toContain('nope.yaml');
        }
    });

    it('skips when the selected file has no usable source (all missing credentials)', () => {
        const allBare = configWith({ 'grandfrais.com': { kind: 'password' }, 'monoprix.fr': { kind: 'password' } });
        const decision = resolveLiveGate({ [OPT_IN_ENV]: '1' }, { loadConfig: fakeLoadConfig(allBare) });
        expect(decision.run).toBe(false);
        if (!decision.run) {
            expect(decision.reason).toContain('no usable source');
            expect(decision.reason).toContain('grandfrais.com');
        }
    });

    it('skips when the file has no sources at all', () => {
        const empty = configWith({});
        const decision = resolveLiveGate({ [OPT_IN_ENV]: '1' }, { loadConfig: fakeLoadConfig(empty) });
        expect(decision.run).toBe(false);
        if (!decision.run) {
            expect(decision.reason).toContain('no usable source');
        }
    });
});
