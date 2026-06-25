// SPDX-License-Identifier: AGPL-3.0-only
import {
    AuthenticationError,
    decodeBase32,
    generateTotp,
    InMemoryKeyring,
    KeyringSessionStore,
    ReauthDetector,
    reuseStoredSession,
    scanForSecrets,
    Secret,
} from '@getreceipt/auth';
import type { ConfigParseResult, SessionPersistableAdapter, SessionStore, StoredSession } from '@getreceipt/auth';
import { SourceAdapterRegistry, SourceResolver } from '@getreceipt/core';
import type {
    ArtifactHandle,
    AuthHandle,
    AuthResult,
    ChallengeResolution,
    ReceiptRef,
    SourceAdapter,
} from '@getreceipt/core';
import { describe, expect, it } from 'vitest';

import { ConsentRequiredError } from './consent-gate.js';
import { InteractivePromptChallengeResolver } from './interactive-challenge-resolver.js';
import { createLoginCommand } from './login-command.js';
import type { LoginCommandEnv } from './login-command.js';
import { addGlobalConfigOptions } from './resolve-options.js';

const TOKEN = 'login-session-token-LEAK-SENTINEL';

/** A flat config (one profile per file) that configures `shop.example` with a referenced (never inline) password. */
const CONFIG: ConfigParseResult = {
    config: {
        sources: { 'shop.example': { kind: 'password', username: 'shopper', secret: { ref: 'PW' } } },
    },
    warnings: [],
};

/**
 * A fake source adapter: authenticate yields a handle wrapping `token`, and (unless `persistable:
 * false`) it projects that handle into a StoredSession — the shape the real adapters use. `authError`
 * makes authenticate reject, exercising the login failure path.
 */
function fakeAdapter(
    opts: {
        canonicalDomain?: string;
        aliasDomains?: string[];
        token?: string;
        persistable?: boolean;
        authError?: Error;
    } = {},
): SourceAdapter {
    const base: SourceAdapter = {
        descriptor: {
            canonicalDomain: opts.canonicalDomain ?? 'shop.example',
            aliasDomains: opts.aliasDomains ?? [],
            authKind: 'password',
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
            defaultWindow: { days: 30 },
            pagination: 'none',
        },
        authenticate: async (): Promise<AuthHandle> => {
            if (opts.authError !== undefined) {
                throw opts.authError;
            }
            return { token: new Secret(opts.token ?? TOKEN) } as unknown as AuthHandle;
        },
        list: async (): Promise<readonly ReceiptRef[]> => [],
        fetch: async (): Promise<ArtifactHandle> => ({}) as unknown as ArtifactHandle,
    };
    if (opts.persistable === false) {
        return base;
    }
    const persistable: SourceAdapter & SessionPersistableAdapter = {
        ...base,
        toStoredSession: (auth: AuthHandle): StoredSession => auth as unknown as StoredSession,
    };
    return persistable;
}

function resolverWith(adapter: SourceAdapter): SourceResolver {
    const registry = new SourceAdapterRegistry();
    registry.register(adapter);
    return new SourceResolver(registry);
}

interface RunResult {
    out: string;
    err: string;
    error: unknown;
}

async function runLogin(args: string[], overrides: Partial<LoginCommandEnv> = {}): Promise<RunResult> {
    const out: string[] = [];
    const err: string[] = [];
    const env: Partial<LoginCommandEnv> = {
        io: { writeOut: (t) => out.push(t), writeErr: (t) => err.push(t) },
        consent: { ensure: () => Promise.resolve() },
        resolveConfigPath: () => '/test/.getreceipt.yaml',
        loadConfig: () => CONFIG,
        resolver: resolverWith(fakeAdapter()),
        resolveCredential: () => Promise.resolve(new Secret('resolved-pw-LEAK-SENTINEL')),
        sessionStore: new KeyringSessionStore(new InMemoryKeyring()),
        ...overrides,
    };
    const cmd = createLoginCommand(env);
    // Standalone command (not via createProgram), so add the global --config/--profile it inherits there.
    addGlobalConfigOptions(cmd);
    cmd.exitOverride();

    let error: unknown;
    try {
        await cmd.parseAsync([...args], { from: 'user' });
    } catch (caught) {
        error = caught;
    }
    return { out: out.join(''), err: err.join(''), error };
}

describe('login — establishes + persists a reusable session', () => {
    it('persists a session a later reuse finds without re-login [AC1]', async () => {
        const store = new KeyringSessionStore(new InMemoryKeyring());

        const { out, error } = await runLogin(['shop.example'], { sessionStore: store });

        expect(error).toBeUndefined();
        expect(out).toContain('logged in to shop.example');

        const reuse = await reuseStoredSession({ store, detector: new ReauthDetector(), key: 'shop.example' });
        expect(reuse.outcome).toBe('reuse');
        if (reuse.outcome === 'reuse') {
            expect(reuse.session.token.expose()).toBe(TOKEN);
        }
    });

    it('stores under the canonical key when an alias is requested [AC1]', async () => {
        const store = new KeyringSessionStore(new InMemoryKeyring());
        const resolver = resolverWith(fakeAdapter({ aliasDomains: ['www.shop.example'] }));

        await runLogin(['www.shop.example'], { sessionStore: store, resolver });

        // Persisted under the canonical domain, not the requested alias.
        expect((await reuseStoredSession({ store, detector: new ReauthDetector(), key: 'shop.example' })).outcome).toBe(
            'reuse',
        );
        expect(
            (await reuseStoredSession({ store, detector: new ReauthDetector(), key: 'www.shop.example' })).outcome,
        ).toBe('absent');
    });

    it('re-establishes a valid session after expiry — the re-auth path [AC3]', async () => {
        const store = new KeyringSessionStore(new InMemoryKeyring());
        const now = (): Date => new Date('2024-06-01T00:00:00.000Z');
        const detector = new ReauthDetector({ now });
        // Seed an expired session: reuse demands re-auth (the signal whose remedy names `login`).
        await store.save('shop.example', {
            token: new Secret('stale'),
            expiresAt: Date.parse('2024-01-01T00:00:00.000Z'),
        });
        expect((await reuseStoredSession({ store, detector, key: 'shop.example' })).outcome).toBe('reauth-required');

        await runLogin(['shop.example'], {
            sessionStore: store,
            resolver: resolverWith(fakeAdapter({ token: 'fresh' })),
        });

        const reuse = await reuseStoredSession({ store, detector, key: 'shop.example' });
        expect(reuse.outcome).toBe('reuse');
        if (reuse.outcome === 'reuse') {
            expect(reuse.session.token.expose()).toBe('fresh');
        }
    });

    it('NEVER prints the session token or the resolved credential [no-leak]', async () => {
        const secretToken = 'sk' + '_live_' + 'Z'.repeat(28);
        const { out, err } = await runLogin(['shop.example'], {
            resolver: resolverWith(fakeAdapter({ token: secretToken })),
        });

        expect(out).not.toContain(secretToken);
        expect(err).not.toContain(secretToken);
        expect(
            scanForSecrets([
                { path: 'login-out', content: out },
                { path: 'login-err', content: err },
            ]),
        ).toEqual([]);
    });
});

describe('login — gates + failure paths', () => {
    it('refuses at the consent gate before storing anything (exit 6) [consent]', async () => {
        const store = new KeyringSessionStore(new InMemoryKeyring());

        const { error } = await runLogin(['shop.example'], {
            sessionStore: store,
            consent: { ensure: () => Promise.reject(new ConsentRequiredError('non-interactive')) },
        });

        expect(error).toMatchObject({ exitCode: 6 });
        expect((await reuseStoredSession({ store, detector: new ReauthDetector(), key: 'shop.example' })).outcome).toBe(
            'absent',
        );
    });

    it('exits 1 for an unknown source', async () => {
        const { error } = await runLogin(['no-such.example'], {
            resolver: new SourceResolver(new SourceAdapterRegistry()),
        });
        expect(error).toMatchObject({ exitCode: 1 });
    });

    it('exits 1 when the source auth cannot be stored as a session', async () => {
        const { error, err } = await runLogin(['shop.example'], {
            resolver: resolverWith(fakeAdapter({ persistable: false })),
        });
        expect(error).toMatchObject({ exitCode: 1 });
        expect(err).toContain('cannot be stored as a reusable session');
    });

    it('exits 1 on an authentication failure, leaking no credential', async () => {
        const { error, err } = await runLogin(['shop.example'], {
            resolver: resolverWith(
                fakeAdapter({
                    authError: new AuthenticationError(
                        'the source rejected the supplied credentials (HTTP 401)',
                        'invalid-credentials',
                    ),
                }),
            ),
        });
        expect(error).toMatchObject({ exitCode: 1 });
        expect(err).toContain('rejected the supplied credentials');
        expect(err).not.toContain('resolved-pw-LEAK-SENTINEL');
    });

    it('exits 1 when the session cannot be stored, leaking neither token nor credential', async () => {
        const secretToken = 'sk' + '_live_' + 'Z'.repeat(28);
        const failing: SessionStore = {
            load: () => Promise.resolve(undefined),
            save: () => Promise.reject(new Error('disk on fire')),
            delete: () => Promise.resolve(),
        };

        const { error, err } = await runLogin(['shop.example'], {
            sessionStore: failing,
            resolver: resolverWith(fakeAdapter({ token: secretToken })),
        });

        expect(error).toMatchObject({ exitCode: 1 });
        expect(err).toContain('disk on fire');
        expect(err).not.toContain(secretToken);
        expect(err).not.toContain('resolved-pw-LEAK-SENTINEL');
        expect(scanForSecrets([{ path: 'login-err', content: err }])).toEqual([]);
    });
});

describe('login — unattended TOTP second factor (#137)', () => {
    const SEED_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

    /** A config that adds an `mfa.type: totp` block (seed via reference) to the shop source. */
    const TOTP_CONFIG: ConfigParseResult = {
        config: {
            sources: {
                'shop.example': {
                    kind: 'password',
                    username: 'shopper',
                    secret: { ref: 'PW' },
                    mfa: { type: 'totp', seed: { ref: 'SEED' } },
                },
            },
        },
        warnings: [],
    };

    function acceptsCurrentTotp(code: string): boolean {
        const key = decodeBase32(SEED_BASE32);
        const nowMs = Date.now();
        return [-1, 0, 1].some((step) => generateTotp(key, nowMs + step * 30_000) === code);
    }

    /** A persistable source that demands an otp-totp factor, then validates the resolved code like a server. */
    function totpChallengingAdapter(seen: { resolution?: ChallengeResolution }): SourceAdapter {
        const persistable = fakeAdapter() as SourceAdapter & SessionPersistableAdapter;
        return {
            ...persistable,
            authenticate: (): Promise<AuthResult> =>
                Promise.resolve({
                    challenge: { type: 'otp-totp', prompt: 'Enter your 6-digit code' },
                    resume: (resolution) => {
                        seen.resolution = resolution;
                        if (!acceptsCurrentTotp(resolution.response)) {
                            return Promise.reject(new AuthenticationError('bad code', 'invalid-credentials'));
                        }
                        return Promise.resolve({ token: new Secret(TOKEN) } as unknown as AuthHandle);
                    },
                }),
        };
    }

    it('resolves the challenge with a locally computed code and persists the session — no prompt', async () => {
        const seen: { resolution?: ChallengeResolution } = {};
        const store = new KeyringSessionStore(new InMemoryKeyring());

        const { out, error } = await runLogin(['shop.example'], {
            loadConfig: () => TOTP_CONFIG,
            resolver: resolverWith(totpChallengingAdapter(seen)),
            // The seed ref resolves to the Base32 seed; the password ref resolves to anything (unused).
            resolveCredential: (value) =>
                Promise.resolve(new Secret(typeof value === 'object' && value.ref === 'SEED' ? SEED_BASE32 : 'pw')),
            sessionStore: store,
        });

        expect(error).toBeUndefined();
        expect(out).toContain('logged in to shop.example');
        expect(seen.resolution?.response).toMatch(/^\d{6}$/);

        const reuse = await reuseStoredSession({ store, detector: new ReauthDetector(), key: 'shop.example' });
        expect(reuse.outcome).toBe('reuse');
    });
});

describe('login — interactive out-of-band second factor via CLI prompt (#138) [AC1]', () => {
    /** A flat config that adds an out-of-band `mfa` block (sms; no seed) to the shop source. */
    function smsConfig(trustDevice?: boolean): ConfigParseResult {
        return {
            config: {
                sources: {
                    'shop.example': {
                        kind: 'password',
                        username: 'shopper',
                        secret: { ref: 'PW' },
                        mfa: trustDevice === undefined ? { type: 'sms' } : { type: 'sms', trustDevice },
                    },
                },
            },
            warnings: [],
        };
    }

    /**
     * A persistable source that demands an out-of-band factor on authenticate, records the resolution
     * it is resumed with, and (when `expect` is set) validates the submitted code like a server would.
     */
    function challengingAdapter(
        seen: { resolution?: ChallengeResolution },
        opts: { type?: 'otp-sms' | 'push'; expect?: string; trustOption?: boolean } = {},
    ): SourceAdapter {
        const persistable = fakeAdapter() as SourceAdapter & SessionPersistableAdapter;
        const type = opts.type ?? 'otp-sms';
        return {
            ...persistable,
            authenticate: (): Promise<AuthResult> =>
                Promise.resolve({
                    challenge: {
                        type,
                        prompt: type === 'push' ? 'Approve the sign-in on your device' : 'Enter the texted code',
                        ...(opts.trustOption === undefined ? {} : { trustOption: opts.trustOption }),
                    },
                    resume: (resolution) => {
                        seen.resolution = resolution;
                        if (opts.expect !== undefined && resolution.response !== opts.expect) {
                            return Promise.reject(
                                new AuthenticationError('the code was rejected', 'invalid-credentials'),
                            );
                        }
                        return Promise.resolve({ token: new Secret(TOKEN) } as unknown as AuthHandle);
                    },
                }),
        };
    }

    /**
     * Wire login with the REAL {@link InteractivePromptChallengeResolver} but a scripted line reader +
     * forced interactivity, so the whole config→ceremony→prompt→election chain runs without a TTY. The
     * trustDevice the factory receives is the source's configured election (resolved internally).
     */
    function runOutOfBandLogin(args: {
        line: string;
        config: ConfigParseResult;
        adapter: SourceAdapter;
        sessionStore?: SessionStore;
    }): Promise<RunResult> {
        return runLogin(['shop.example'], {
            loadConfig: () => args.config,
            resolver: resolverWith(args.adapter),
            ...(args.sessionStore === undefined ? {} : { sessionStore: args.sessionStore }),
            buildOutOfBandResolver: (trustDevice) =>
                new InteractivePromptChallengeResolver({
                    io: { writeOut: () => {}, writeErr: () => {} },
                    isInteractive: () => true,
                    readLine: () => Promise.resolve(args.line),
                    trustDevice,
                }),
        });
    }

    it('prompts for the out-of-band code, completes auth, and persists the session', async () => {
        const seen: { resolution?: ChallengeResolution } = {};
        const store = new KeyringSessionStore(new InMemoryKeyring());

        const { out, error } = await runOutOfBandLogin({
            line: '  123456 \n',
            config: smsConfig(),
            adapter: challengingAdapter(seen, { expect: '123456' }),
            sessionStore: store,
        });

        expect(error).toBeUndefined();
        expect(out).toContain('logged in to shop.example');
        // The code typed at the prompt was submitted to the source (trimmed).
        expect(seen.resolution?.response).toBe('123456');
        expect((await reuseStoredSession({ store, detector: new ReauthDetector(), key: 'shop.example' })).outcome).toBe(
            'reuse',
        );
    });

    it('sends trust-this-device ONLY when the source set trustDevice (and the challenge offers it)', async () => {
        const withTrust: { resolution?: ChallengeResolution } = {};
        await runOutOfBandLogin({
            line: '123456',
            config: smsConfig(true),
            adapter: challengingAdapter(withTrust, { trustOption: true }),
        });
        expect(withTrust.resolution?.trustThisDevice).toBe(true);

        // Same offered challenge, but the source did NOT set trustDevice → election is not sent.
        const withoutTrust: { resolution?: ChallengeResolution } = {};
        await runOutOfBandLogin({
            line: '123456',
            config: smsConfig(),
            adapter: challengingAdapter(withoutTrust, { trustOption: true }),
        });
        expect(withoutTrust.resolution?.trustThisDevice).toBeUndefined();

        // Source set trustDevice, but THIS challenge did not offer it → still not sent (both must hold).
        const notOffered: { resolution?: ChallengeResolution } = {};
        await runOutOfBandLogin({
            line: '123456',
            config: smsConfig(true),
            adapter: challengingAdapter(notOffered),
        });
        expect(notOffered.resolution?.trustThisDevice).toBeUndefined();
    });

    it('completes a push challenge with no typed code — the operator approves on their device', async () => {
        const seen: { resolution?: ChallengeResolution } = {};

        const { out, error } = await runOutOfBandLogin({
            line: '',
            config: smsConfig(),
            adapter: challengingAdapter(seen, { type: 'push' }),
        });

        expect(error).toBeUndefined();
        expect(out).toContain('logged in to shop.example');
        expect(seen.resolution?.response).toBe('');
    });

    it('NEVER prints the entered code [no-leak]', async () => {
        const code = 'sk' + '_live_' + 'Y'.repeat(28);
        const seen: { resolution?: ChallengeResolution } = {};

        const { out, err } = await runOutOfBandLogin({
            line: code,
            config: smsConfig(),
            adapter: challengingAdapter(seen, { expect: code }),
        });

        expect(out).not.toContain(code);
        expect(err).not.toContain(code);
        expect(
            scanForSecrets([
                { path: 'login-out', content: out },
                { path: 'login-err', content: err },
            ]),
        ).toEqual([]);
    });
});
