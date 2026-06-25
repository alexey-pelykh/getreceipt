// SPDX-License-Identifier: AGPL-3.0-only
import {
    ConfigError,
    CredentialBackendUnavailableError,
    decodeBase32,
    fromCredentialContext,
    generateTotp,
    Secret,
} from '@getreceipt/auth';
import type { ConfigParseResult, CredentialValue } from '@getreceipt/auth';
import { collect, SourceAdapterRegistry, SourceResolver } from '@getreceipt/core';
import type {
    ArtifactHandle,
    AuthHandle,
    AuthResult,
    ChallengeResolution,
    CollectRequest,
    CollectResult,
    ReceiptRef,
    SourceAdapter,
} from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import { OperationError, runOperation, type OperationRunnerDeps } from './operation-runner.js';

const WINDOW = { from: new Date('2024-01-01T00:00:00.000Z'), to: new Date('2024-01-31T00:00:00.000Z') };
const SUCCEEDED: CollectResult = {
    outcome: 'succeeded',
    source: 'shop.example',
    window: WINDOW,
    written: [],
    skipped: [],
};

function adapter(timezone?: string): SourceAdapter {
    return {
        descriptor: {
            canonicalDomain: 'shop.example',
            aliasDomains: ['www.shop.example'],
            authKind: 'password',
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
            ...(timezone === undefined ? {} : { timezone }),
            defaultWindow: { days: 30 },
            pagination: 'none',
        },
        authenticate: async () => ({}) as unknown as AuthHandle,
        list: async (): Promise<readonly ReceiptRef[]> => [],
        fetch: async () =>
            ({ bytes: new Uint8Array([1]), contentType: 'application/pdf' }) as unknown as ArtifactHandle,
    };
}

function resolverWith(source: SourceAdapter): SourceResolver {
    const registry = new SourceAdapterRegistry();
    registry.register(source);
    return new SourceResolver(registry);
}

const config: ConfigParseResult = {
    config: {
        sources: { 'shop.example': { kind: 'password', username: 'alice@shop.example', secret: 'inline' } },
    },
    warnings: [],
};

function deps(overrides: Partial<OperationRunnerDeps> = {}): OperationRunnerDeps {
    return {
        resolver: resolverWith(adapter()),
        resolveConfigPath: () => '/test/.getreceipt.yaml',
        loadConfig: () => config,
        resolveCredential: () => Promise.resolve(new Secret('resolved')),
        resolveLogin: () =>
            Promise.resolve({ username: new Secret('resolved-user'), secret: new Secret('resolved-secret') }),
        createWriter: () => ({ has: async () => false, write: async () => {} }),
        collect: () => Promise.resolve(SUCCEEDED),
        now: () => new Date('2024-02-01T00:00:00.000Z'),
        ...overrides,
    };
}

/** A `collect` stub that records the request it was given, so window/adapter wiring can be asserted. */
function capturingCollect(): { collect: OperationRunnerDeps['collect']; request: () => CollectRequest | undefined } {
    let captured: CollectRequest | undefined;
    return {
        collect: (request) => {
            captured = request;
            return Promise.resolve(SUCCEEDED);
        },
        request: () => captured,
    };
}

describe('runOperation — single-item form (the `ref` reference)', () => {
    const loginConfig: ConfigParseResult = {
        config: { sources: { 'shop.example': { kind: 'password', ref: 'op://Vault/Item' } } },
        warnings: [],
    };

    it('resolves BOTH username and secret from one login reference via resolveLogin', async () => {
        const seen: string[] = [];
        const capture = capturingCollect();
        await runOperation(
            { source: 'shop.example', profile: 'default' },
            undefined,
            deps({
                loadConfig: () => loginConfig,
                collect: capture.collect,
                // The per-field path MUST NOT run for a single-item source.
                resolveCredential: () => Promise.reject(new Error('per-field resolveCredential must not be called')),
                resolveLogin: (ref) => {
                    seen.push(ref);
                    return Promise.resolve({
                        username: new Secret('alice@shop.example'),
                        secret: new Secret('s3cr3t'),
                    });
                },
            }),
        );

        expect(seen).toEqual(['op://Vault/Item']);
        const resolved = fromCredentialContext(capture.request()!.credentials);
        expect(resolved.username).toBe('alice@shop.example');
        expect(resolved.secret?.expose()).toBe('s3cr3t');
    });

    it('uses the per-field path (resolveCredential, NOT resolveLogin) when no login reference is set', async () => {
        let loginCalled = false;
        const capture = capturingCollect();
        await runOperation(
            { source: 'shop.example', profile: 'default' },
            undefined,
            deps({
                collect: capture.collect,
                resolveCredential: (value) =>
                    Promise.resolve(new Secret(typeof value === 'string' ? value : `ref:${value.ref}`)),
                resolveLogin: () => {
                    loginCalled = true;
                    return Promise.resolve({ username: new Secret('x'), secret: new Secret('y') });
                },
            }),
        );

        expect(loginCalled).toBe(false);
        // The default config carries an inline username 'alice@shop.example'.
        expect(fromCredentialContext(capture.request()!.credentials).username).toBe('alice@shop.example');
    });
});

describe('runOperation — happy path', () => {
    it('resolves the calendar window to start-of-day / end-of-day instants for collect', async () => {
        const capture = capturingCollect();
        const result = await runOperation(
            { source: 'shop.example', profile: 'default', window: { since: '2024-01-01', until: '2024-01-31' } },
            undefined,
            // A UTC-declaring adapter pins the instants via the source's own zone, host-independent.
            deps({ resolver: resolverWith(adapter('UTC')), collect: capture.collect }),
        );

        expect(result.outcome).toBe('succeeded');
        expect(capture.request()?.window?.from.toISOString()).toBe('2024-01-01T00:00:00.000Z');
        // until is the LAST instant of the named day, not its first — the whole day is inside the window (#127).
        expect(capture.request()?.window?.to.toISOString()).toBe('2024-01-31T23:59:59.999Z');
    });

    it("resolves the window in the source's declared zone, so a local month-start is NOT missed (#127)", async () => {
        const capture = capturingCollect();
        await runOperation(
            { source: 'shop.example', profile: 'default', window: { since: '2026-06-01', until: '2026-06-24' } },
            undefined,
            deps({ resolver: resolverWith(adapter('Europe/Paris')), collect: capture.collect }),
        );
        // 2026-06-01 00:00 Europe/Paris (CEST, +02:00) = 2026-05-31T22:00:00Z — exactly the invoice instant.
        expect(capture.request()?.window?.from.toISOString()).toBe('2026-05-31T22:00:00.000Z');
        expect(capture.request()?.window?.to.toISOString()).toBe('2026-06-24T21:59:59.999Z');
    });

    it('leaves the window open-ended to now when the spec carries since only', async () => {
        const capture = capturingCollect();
        await runOperation(
            { source: 'shop.example', profile: 'default', window: { since: '2026-06-01' } },
            undefined,
            // now is AFTER since, so the open-ended window is non-empty (a future since would be rejected).
            deps({
                resolver: resolverWith(adapter('Europe/Paris')),
                collect: capture.collect,
                now: () => new Date('2026-06-15T00:00:00.000Z'),
            }),
        );
        expect(capture.request()?.window?.from.toISOString()).toBe('2026-05-31T22:00:00.000Z');
        // the open end is exactly the injected now.
        expect(capture.request()?.window?.to.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    });

    it('falls back to the host zone when the source declares none', async () => {
        const capture = capturingCollect();
        // adapter() declares no zone → the window resolves in the REAL host zone via hostTimeZone(). Pin TZ
        // so the defense-in-depth fallback (#127/#146) is deterministic without a test-only injection seam.
        const originalTz = process.env.TZ;
        process.env.TZ = 'America/New_York';
        try {
            await runOperation(
                { source: 'shop.example', profile: 'default', window: { since: '2026-06-01', until: '2026-06-01' } },
                undefined,
                deps({ collect: capture.collect }),
            );
        } finally {
            if (originalTz === undefined) {
                delete process.env.TZ;
            } else {
                process.env.TZ = originalTz;
            }
        }
        // New York is EDT (−04:00) on 2026-06-01, so the local day maps to these UTC instants.
        expect(capture.request()?.window?.from.toISOString()).toBe('2026-06-01T04:00:00.000Z');
        expect(capture.request()?.window?.to.toISOString()).toBe('2026-06-02T03:59:59.999Z');
    });

    it('omits the window (adapter default applies) when the spec carries none', async () => {
        const capture = capturingCollect();
        await runOperation(
            { source: 'shop.example', profile: 'default' },
            undefined,
            deps({ collect: capture.collect }),
        );
        expect(capture.request()?.window).toBeUndefined();
    });

    it('passes the config selection through to the resolveConfigPath seam', async () => {
        let seen: { config?: string; profile?: string } | undefined;
        await runOperation(
            { source: 'shop.example', profile: 'work' },
            { profile: 'work' },
            deps({
                resolveConfigPath: (selection) => {
                    seen = selection;
                    return '/test/.getreceipt/work.yaml';
                },
            }),
        );
        expect(seen).toEqual({ profile: 'work' });
    });

    it('applies the instrument wrapper to the adapter before collecting', async () => {
        let wrapped = false;
        await runOperation(
            { source: 'shop.example', profile: 'default' },
            undefined,
            deps({
                instrument: (a) => {
                    wrapped = true;
                    return a;
                },
            }),
        );
        expect(wrapped).toBe(true);
    });
});

describe('runOperation — pre-flight failures throw typed OperationError', () => {
    it('unknown-source when the domain resolves to no adapter', async () => {
        const promise = runOperation(
            { source: 'no-such.example', profile: 'default' },
            undefined,
            deps({ resolver: new SourceResolver(new SourceAdapterRegistry()) }),
        );
        await expect(promise).rejects.toMatchObject({ name: 'OperationError', kind: 'unknown-source' });
    });

    it('config when the config file cannot be loaded (path preserved)', async () => {
        const promise = runOperation(
            { source: 'shop.example', profile: 'default' },
            undefined,
            deps({
                loadConfig: () => {
                    throw new ConfigError('config file could not be read', '/test/.getreceipt.yaml');
                },
            }),
        );
        await expect(promise).rejects.toMatchObject({ kind: 'config' });
        await expect(promise).rejects.toThrow('/test/.getreceipt.yaml');
    });

    it('not-configured when the (registered) source is absent from the file (names the file, not a profile)', async () => {
        // shop.example resolves to an adapter, but this file configures no sources → not-configured.
        const emptyConfig: ConfigParseResult = { config: { sources: {} }, warnings: [] };
        const promise = runOperation(
            { source: 'shop.example', profile: 'default' },
            undefined,
            deps({ loadConfig: () => emptyConfig }),
        );
        await expect(promise).rejects.toMatchObject({ kind: 'not-configured' });
        await expect(promise).rejects.toThrow('/test/.getreceipt.yaml');
    });

    it('credentials when the credential cannot be resolved (message carries no secret)', async () => {
        const error = await runOperation(
            { source: 'shop.example', profile: 'default' },
            undefined,
            deps({
                resolveCredential: () =>
                    Promise.reject(
                        new CredentialBackendUnavailableError('the 1Password CLI (`op`) is not installed', 'op'),
                    ),
            }),
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(OperationError);
        expect((error as OperationError).kind).toBe('credentials');
        expect((error as OperationError).message).not.toContain('inline');
    });

    it('window when --since alone resolves to a start after now (an open-ended future window matches nothing)', async () => {
        // now = 2024-02-01; --since 2099-01-01 alone → from in the future, to = now → from > to.
        // Without this guard the adapter filters everything out and reports `succeeded` — the #127 silent miss.
        const promise = runOperation(
            { source: 'shop.example', profile: 'default', window: { since: '2099-01-01' } },
            undefined,
            deps({ resolver: resolverWith(adapter('UTC')) }),
        );
        await expect(promise).rejects.toMatchObject({ name: 'OperationError', kind: 'window' });
    });
});

describe('runOperation — username resolves on the same path as the secret', () => {
    /** Config whose username is a reference (not an inline literal), exercising call-time resolution. */
    const refUsernameConfig: ConfigParseResult = {
        config: {
            sources: {
                'shop.example': {
                    kind: 'password',
                    username: { ref: 'op://Personal/shop/username' },
                    secret: { ref: 'op://Personal/shop/password' },
                },
            },
        },
        warnings: [],
    };

    /** A resolver that maps each reference to a distinct value, so a passed-through ref (vs a resolved value) is detectable. */
    function resolverByRef(value: CredentialValue): Promise<Secret> {
        const ref = typeof value === 'string' ? value : value.ref;
        if (ref === 'op://Personal/shop/username') return Promise.resolve(new Secret('resolved-alice'));
        if (ref === 'op://Personal/shop/password') return Promise.resolve(new Secret('resolved-pw'));
        return Promise.resolve(new Secret('unexpected'));
    }

    it('resolves a username reference and lands it as a plain string in the credential context', async () => {
        const capture = capturingCollect();
        await runOperation(
            { source: 'shop.example', profile: 'default' },
            undefined,
            deps({ loadConfig: () => refUsernameConfig, resolveCredential: resolverByRef, collect: capture.collect }),
        );

        const packed = fromCredentialContext(capture.request()!.credentials);
        // The reference was dereferenced (not passed through) and exposed to a plain string.
        expect(packed.username).toBe('resolved-alice');
        expect(typeof packed.username).toBe('string');
        expect(packed.secret?.expose()).toBe('resolved-pw');
    });

    it('surfaces a username-resolution failure as OperationError(credentials), carrying no value', async () => {
        const error = await runOperation(
            { source: 'shop.example', profile: 'default' },
            undefined,
            deps({
                loadConfig: () => refUsernameConfig,
                resolveCredential: (value) => {
                    const ref = typeof value === 'string' ? value : value.ref;
                    // Only the USERNAME reference fails — proving the username path is wired through the same catch.
                    if (ref === 'op://Personal/shop/username') {
                        return Promise.reject(
                            new CredentialBackendUnavailableError('the 1Password CLI (`op`) is not installed', 'op'),
                        );
                    }
                    return Promise.resolve(new Secret('resolved-pw'));
                },
            }),
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(OperationError);
        expect((error as OperationError).kind).toBe('credentials');
        // The resolver error names the backend, never the username reference or value.
        expect((error as OperationError).message).not.toContain('shop/username');
    });
});

describe('runOperation — #127 behavioral proof through real collect()', () => {
    // Two invoices at the Paris month-start: collect() drives the REAL window resolution AND a
    // realistic inclusive issued-date filter, so this composes what the unit tests prove separately.
    const MAY: ReceiptRef = { id: 'may', issuedAt: new Date('2026-04-30T22:00:00.000Z') }; // 2026-05-01 00:00 Paris
    const JUNE: ReceiptRef = { id: 'june', issuedAt: new Date('2026-05-31T22:00:00.000Z') }; // 2026-06-01 00:00 Paris

    /** The fake adapter, but `list` applies the canonical inclusive filter (`< from || > to`) against the resolved range. */
    function filteringAdapter(timezone: string): SourceAdapter {
        return {
            ...adapter(timezone),
            list: async (_auth, range) => {
                const fromMs = range.from.getTime();
                const toMs = range.to.getTime();
                return [MAY, JUNE].filter((ref) => !(ref.issuedAt.getTime() < fromMs || ref.issuedAt.getTime() > toMs));
            },
        };
    }

    it('keeps the local-month-start June invoice a UTC window silently dropped', async () => {
        // Europe/Paris: --since 2026-06-01 resolves to 2026-05-31T22:00Z — exactly the June invoice
        // instant — so the inclusive lower bound keeps it; May (a month earlier) is excluded.
        const paris = await runOperation(
            { source: 'shop.example', profile: 'default', window: { since: '2026-06-01', until: '2026-06-30' } },
            undefined,
            deps({ resolver: resolverWith(filteringAdapter('Europe/Paris')), collect }),
        );
        expect(paris.outcome).toBe('succeeded');
        expect(paris.written.map((r) => r.id)).toEqual(['june']);

        // The OLD bug reproduced: a UTC-resolved window starts at 2026-06-01T00:00Z — AFTER the June
        // invoice — so collect() returns it empty yet `succeeded`: the silent month-start miss.
        const utc = await runOperation(
            { source: 'shop.example', profile: 'default', window: { since: '2026-06-01', until: '2026-06-30' } },
            undefined,
            deps({ resolver: resolverWith(filteringAdapter('UTC')), collect }),
        );
        expect(utc.outcome).toBe('succeeded');
        expect(utc.written.map((r) => r.id)).toEqual([]);
    });
});

describe('runOperation — unattended TOTP (mfa.type: totp) through real collect() (AC1, #137)', () => {
    // RFC 6238 reference seed (canonical Base32). Codes are validated like a real server would: the
    // current 30s step ±1 (clock-skew tolerance), so the assertion never flakes across a step boundary.
    const TOTP_SEED_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

    function acceptsCurrentTotp(seedBase32: string, code: string): boolean {
        const key = decodeBase32(seedBase32);
        const nowMs = Date.now();
        return [-1, 0, 1].some((step) => generateTotp(key, nowMs + step * 30_000) === code);
    }

    const totpConfig: ConfigParseResult = {
        config: {
            sources: {
                'shop.example': {
                    kind: 'password',
                    username: 'alice@shop.example',
                    secret: 'pw',
                    mfa: { type: 'totp', seed: { ref: 'op://Vault/totp' } },
                },
            },
        },
        warnings: [],
    };

    /** A source that demands an otp-totp factor on authenticate, then validates the resolved code like a server. */
    function totpChallengingAdapter(seen: { resolution?: ChallengeResolution }): SourceAdapter {
        return {
            ...adapter(),
            authenticate: (): Promise<AuthResult> =>
                Promise.resolve({
                    challenge: { type: 'otp-totp', prompt: 'Enter your 6-digit code' },
                    resume: (resolution) => {
                        seen.resolution = resolution;
                        if (!acceptsCurrentTotp(TOTP_SEED_BASE32, resolution.response)) {
                            return Promise.reject(new Error('source rejected the TOTP code'));
                        }
                        return Promise.resolve({} as unknown as AuthHandle);
                    },
                }),
            list: async () => [],
        };
    }

    it('collects fully unattended — code computed locally from the seed, no human, no prompt', async () => {
        const seen: { resolution?: ChallengeResolution } = {};
        const result = await runOperation(
            { source: 'shop.example', profile: 'default' },
            undefined,
            deps({
                loadConfig: () => totpConfig,
                resolver: resolverWith(totpChallengingAdapter(seen)),
                resolveCredential: () => Promise.resolve(new Secret(TOTP_SEED_BASE32)),
                collect,
            }),
        );

        expect(result.outcome).toBe('succeeded');
        // The challenge was answered with a locally computed 6-digit code — no prompt was ever involved.
        expect(seen.resolution?.response).toMatch(/^\d{6}$/);
    });

    it('wires an in-process resolver into the collect request only for a totp source', async () => {
        const totpCapture = capturingCollect();
        await runOperation(
            { source: 'shop.example', profile: 'default' },
            undefined,
            deps({
                loadConfig: () => totpConfig,
                resolveCredential: () => Promise.resolve(new Secret(TOTP_SEED_BASE32)),
                collect: totpCapture.collect,
            }),
        );
        expect(totpCapture.request()?.challengeResolver).toBeDefined();

        // The default config has no mfa block → no resolver is attached.
        const plainCapture = capturingCollect();
        await runOperation(
            { source: 'shop.example', profile: 'default' },
            undefined,
            deps({ collect: plainCapture.collect }),
        );
        expect(plainCapture.request()?.challengeResolver).toBeUndefined();
    });

    it('a source with no mfa that still issues a challenge surfaces reauth-required, never hangs (#134)', async () => {
        const seen: { resolution?: ChallengeResolution } = {};
        const result = await runOperation(
            { source: 'shop.example', profile: 'default' },
            undefined,
            // Default config: no mfa block, so no resolver is wired for the challenge the adapter raises.
            deps({ resolver: resolverWith(totpChallengingAdapter(seen)), collect }),
        );

        expect(result.outcome).toBe('reauth-required');
        expect(seen.resolution).toBeUndefined();
    });
});

describe('runOperation — out-of-band challenge stays reauth-required on the unattended collect path (AC2, #138)', () => {
    // An `mfa.type: sms` source: the code is delivered out-of-band, so the config yields NO in-process
    // resolver — and the collect path never wires the interactive prompt (that lives in `login`).
    const smsConfig: ConfigParseResult = {
        config: {
            sources: {
                'shop.example': {
                    kind: 'password',
                    username: 'alice@shop.example',
                    secret: 'pw',
                    mfa: { type: 'sms' },
                },
            },
        },
        warnings: [],
    };

    /** A source that demands an out-of-band factor; `resumed` flips only if something tried to answer it. */
    function outOfBandChallengingAdapter(
        seen: { resumed: boolean },
        type: 'otp-sms' | 'push' = 'otp-sms',
    ): SourceAdapter {
        return {
            ...adapter(),
            authenticate: (): Promise<AuthResult> =>
                Promise.resolve({
                    challenge: { type, prompt: 'Enter the code we sent you' },
                    resume: () => {
                        seen.resumed = true;
                        return Promise.resolve({} as unknown as AuthHandle);
                    },
                }),
            list: async () => [],
        };
    }

    it('yields reauth-required and NEVER prompts (resume is never reached) for an SMS challenge', async () => {
        const seen = { resumed: false };
        const result = await runOperation(
            { source: 'shop.example', profile: 'default' },
            undefined,
            deps({ loadConfig: () => smsConfig, resolver: resolverWith(outOfBandChallengingAdapter(seen)), collect }),
        );

        expect(result.outcome).toBe('reauth-required');
        // No out-of-band resolver is wired on the collect path, so the challenge is never answered.
        expect(seen.resumed).toBe(false);
    });

    it('does the same for a push challenge — an unattended run never blocks on a device approval', async () => {
        const seen = { resumed: false };
        const result = await runOperation(
            { source: 'shop.example', profile: 'default' },
            undefined,
            deps({
                loadConfig: () => smsConfig,
                resolver: resolverWith(outOfBandChallengingAdapter(seen, 'push')),
                collect,
            }),
        );

        expect(result.outcome).toBe('reauth-required');
        expect(seen.resumed).toBe(false);
    });

    it('wires NO challenge resolver into the collect request for an out-of-band mfa source', async () => {
        const capture = capturingCollect();
        await runOperation(
            { source: 'shop.example', profile: 'default' },
            undefined,
            deps({ loadConfig: () => smsConfig, collect: capture.collect }),
        );
        // sms/email/push are not config-resolvable in-process, and the collect path never adds the
        // out-of-band interactive prompt — so the request carries no resolver (login is where it lives).
        expect(capture.request()?.challengeResolver).toBeUndefined();
    });
});
