// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createConsentStore, scanForSecrets, Secret } from '@getreceipt/auth';
import type { ConfigParseResult } from '@getreceipt/auth';
import {
    FilesystemReceiptWriter,
    ReauthRequiredError,
    SourceAdapterRegistry,
    SourceResolver,
    toOperationResult,
} from '@getreceipt/core';
import type {
    ArtifactHandle,
    AuthHandle,
    BrowserProfileBindableAdapter,
    CollectResult,
    CredentialContext,
    DateRange,
    InstanceContext,
    ReceiptRef,
    SourceAdapter,
} from '@getreceipt/core';
import { fromCredentialContext } from '@getreceipt/auth';
import { describe, expect, it, vi } from 'vitest';

import { ConsentRequiredError, createConsentGate } from './consent-gate.js';
import { createFromCommand } from './from-command.js';
import type { FromCommandEnv } from './from-command.js';
import type { SignInWindowOpener } from './reauth-loop.js';
import { addGlobalConfigOptions } from './resolve-options.js';

const configFixture = fileURLToPath(new URL('./__fixtures__/from.getreceipt.yaml', import.meta.url));
const workFixture = fileURLToPath(new URL('./__fixtures__/from.work.getreceipt.yaml', import.meta.url));

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

/**
 * A selection-aware `resolveConfigPath` mapping the per-file model onto the fixtures: `--config` path
 * wins; `--profile work` → the work fixture; an unknown profile → a deliberately-missing path; else
 * the default `from` fixture.
 */
function fixtureResolver(selection?: { path?: string; profile?: string }): string {
    if (selection?.path !== undefined && selection.path !== '') {
        return selection.path;
    }
    if (selection?.profile === 'work') {
        return workFixture;
    }
    if (selection?.profile !== undefined) {
        return `/nonexistent/${selection.profile}.getreceipt.yaml`;
    }
    return configFixture;
}

function ref(id: string, day: number, title?: string): ReceiptRef {
    const issuedAt = new Date(Date.UTC(2024, 0, day, 9, 0, 0));
    return title === undefined ? { id, issuedAt } : { id, issuedAt, title };
}

/** Behavior knobs for the fake adapter — each stage either yields a value or throws to exercise a failure mode. */
interface FakeAdapterOptions {
    readonly listed?: readonly ReceiptRef[];
    readonly onAuthenticate?: (credentials: CredentialContext) => void;
    readonly throwOnAuthenticate?: Error;
    readonly throwOnList?: Error;
    readonly throwOnFetchId?: string;
}

function fakeAdapter(options: FakeAdapterOptions = {}): SourceAdapter {
    const listed = options.listed ?? [ref('inv-1', 5, 'January invoice'), ref('inv-2', 6)];
    return {
        descriptor: {
            canonicalDomain: 'shop.example',
            aliasDomains: ['www.shop.example'],
            authKind: 'password',
            credentialShapes: ['password'],
            transportTier: 'http-api',
            artifactMode: 'pdf-download',
            dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
            timezone: 'UTC', // pin the window-resolution zone so date assertions are host-TZ-independent
            defaultWindow: { days: 30 },
            pagination: 'none',
        },
        async authenticate(credentials: CredentialContext): Promise<AuthHandle> {
            options.onAuthenticate?.(credentials);
            if (options.throwOnAuthenticate !== undefined) {
                throw options.throwOnAuthenticate;
            }
            return {} as unknown as AuthHandle;
        },
        async list(): Promise<readonly ReceiptRef[]> {
            if (options.throwOnList !== undefined) {
                throw options.throwOnList;
            }
            return listed;
        },
        async fetch(_auth: AuthHandle, receipt: ReceiptRef): Promise<ArtifactHandle> {
            if (options.throwOnFetchId === receipt.id) {
                throw new Error(`fetch failed for ${receipt.id}`);
            }
            return {
                bytes: PDF_BYTES,
                contentType: 'application/pdf',
                filename: `${receipt.id}.pdf`,
            } as unknown as ArtifactHandle;
        },
    };
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

/**
 * Build the `from` command and genuinely execute it through Commander — capturing output
 * and any non-zero-exit signal — so each test drives the real parse → action → render path.
 * Defaults wire a fake adapter + stub credential resolver; individual seams are overridable.
 */
async function runFrom(args: string[], overrides: Partial<FromCommandEnv> = {}): Promise<RunResult> {
    const out: string[] = [];
    const err: string[] = [];
    const env: Partial<FromCommandEnv> = {
        io: { writeOut: (t) => out.push(t), writeErr: (t) => err.push(t) },
        // Consent is its own concern (consent-gate.test.ts); pass it through here so these tests
        // exercise the collection path. Tests that target the gate override this seam.
        consent: { ensure: () => Promise.resolve() },
        resolveConfigPath: fixtureResolver,
        resolver: resolverWith(fakeAdapter()),
        resolveCredential: (value) =>
            Promise.resolve(value instanceof Object ? new Secret('resolved') : new Secret(value)),
        ...overrides,
    };
    const cmd = createFromCommand(env);
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

describe('from <domain> — collection (AC #1)', () => {
    it('collects from a configured source and writes its PDFs to disk', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'gr-from-'));
        try {
            const { out, error } = await runFrom(['shop.example', '--out', dir], {
                createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
            });

            expect(error).toBeUndefined();
            // Genuine writes landed on disk under <out>/<source>/<id>.pdf.
            expect(existsSync(join(dir, 'shop.example', 'inv-1.pdf'))).toBe(true);
            expect(existsSync(join(dir, 'shop.example', 'inv-2.pdf'))).toBe(true);
            expect(readFileSync(join(dir, 'shop.example', 'inv-1.pdf'))).toEqual(Buffer.from(PDF_BYTES));
            expect(out).toContain('shop.example — succeeded');
            expect(out).toContain('written: 2');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('resolves the configured credential and hands it to the adapter', async () => {
        let received: CredentialContext | undefined;
        const dir = mkdtempSync(join(tmpdir(), 'gr-from-cred-'));
        try {
            await runFrom(['shop.example', '--out', dir], {
                resolver: resolverWith(fakeAdapter({ onAuthenticate: (c) => (received = c) })),
                createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
                // The username and secret BOTH resolve on this path now; map the configured secret to a
                // distinct value and echo the username, proving each was resolved (not passed through blind).
                resolveCredential: (value) => {
                    const literal = typeof value === 'string' ? value : value.ref;
                    return Promise.resolve(new Secret(literal === 'hunter2-not-real' ? 'resolved-token' : literal));
                },
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }

        expect(received).toBeDefined();
        const creds = fromCredentialContext(received!);
        expect(creds.kind).toBe('password');
        // The username resolved to its configured literal (a string username resolves to itself).
        expect(creds.username).toBe('alice@shop.example');
        expect(creds.secret?.expose()).toBe('resolved-token');
    });

    it('honors --since/--until as the collection window', async () => {
        let listRange: DateRange | undefined;
        const adapter = fakeAdapter();
        const wrapped: SourceAdapter = {
            ...adapter,
            list: async (auth, range) => {
                listRange = range;
                return adapter.list(auth, range);
            },
        };
        const dir = mkdtempSync(join(tmpdir(), 'gr-from-win-'));
        try {
            const { error } = await runFrom(
                ['shop.example', '--since', '2024-01-01', '--until', '2024-01-31', '--out', dir],
                {
                    resolver: resolverWith(wrapped),
                    createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
                },
            );
            expect(error).toBeUndefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        expect(listRange?.from.toISOString()).toBe('2024-01-01T00:00:00.000Z');
        // `--until` covers the WHOLE named day (end-of-day in the source zone), not its first instant (#127).
        expect(listRange?.to.toISOString()).toBe('2024-01-31T23:59:59.999Z');
    });

    it('accepts --since alone, leaving the window open-ended to now (#127)', async () => {
        let listRange: DateRange | undefined;
        const adapter = fakeAdapter();
        const wrapped: SourceAdapter = {
            ...adapter,
            list: async (auth, range) => {
                listRange = range;
                return adapter.list(auth, range);
            },
        };
        const dir = mkdtempSync(join(tmpdir(), 'gr-from-since-'));
        try {
            const { error } = await runFrom(['shop.example', '--since', '2024-01-01', '--out', dir], {
                resolver: resolverWith(wrapped),
                createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
                now: () => new Date('2024-02-01T00:00:00.000Z'),
            });
            expect(error).toBeUndefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        expect(listRange?.from.toISOString()).toBe('2024-01-01T00:00:00.000Z');
        expect(listRange?.to.toISOString()).toBe('2024-02-01T00:00:00.000Z'); // open end = injected now
    });

    it('resolves an alias domain and finds its credentials under the canonical key', async () => {
        // `www.shop.example` is an alias of `shop.example`; the config keys only the canonical domain,
        // so this exercises the alias → canonical credential fallback end-to-end.
        const dir = mkdtempSync(join(tmpdir(), 'gr-from-alias-'));
        try {
            const { out, error } = await runFrom(['www.shop.example', '--out', dir], {
                createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
            });
            expect(error).toBeUndefined();
            // Written under the canonical domain the adapter reports, not the requested alias.
            expect(existsSync(join(dir, 'shop.example', 'inv-1.pdf'))).toBe(true);
            expect(out).toContain('shop.example — succeeded');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('--profile selects a FILE (the work profile), resolving its credentials from that file', async () => {
        // The work fixture configures shop.example with the username bob@shop.example; resolving the
        // username (a literal → itself) proves the work FILE was loaded, not the default.
        let received: CredentialContext | undefined;
        const dir = mkdtempSync(join(tmpdir(), 'gr-from-profile-'));
        try {
            const { error } = await runFrom(['shop.example', '--profile', 'work', '--out', dir], {
                resolver: resolverWith(fakeAdapter({ onAuthenticate: (c) => (received = c) })),
                createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
            });
            expect(error).toBeUndefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        expect(fromCredentialContext(received!).username).toBe('bob@shop.example');
    });

    it('--config selects an explicit file, overriding the default resolution', async () => {
        let received: CredentialContext | undefined;
        const dir = mkdtempSync(join(tmpdir(), 'gr-from-config-'));
        try {
            const { error } = await runFrom(['shop.example', '--config', workFixture, '--out', dir], {
                resolver: resolverWith(fakeAdapter({ onAuthenticate: (c) => (received = c) })),
                createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
            });
            expect(error).toBeUndefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        // The work fixture's bob@shop.example proves --config loaded that explicit file.
        expect(fromCredentialContext(received!).username).toBe('bob@shop.example');
    });
});

describe('from --json — structured result parity (AC #2)', () => {
    it('emits exactly toOperationResult(collectResult) — the shared CLI↔MCP shape', async () => {
        const collectResult: CollectResult = {
            outcome: 'succeeded',
            source: 'shop.example',
            window: { from: new Date('2024-01-01T00:00:00.000Z'), to: new Date('2024-01-31T00:00:00.000Z') },
            written: [ref('inv-1', 5, 'January invoice')],
            skipped: [ref('inv-0', 4)],
        };

        // Inject collect so the CLI's emitted JSON can be compared against the SAME mapper the MCP surface uses.
        const { out, error } = await runFrom(['shop.example', '--json'], {
            collect: () => Promise.resolve(collectResult),
        });

        expect(error).toBeUndefined();
        expect(JSON.parse(out)).toEqual(toOperationResult(collectResult));
    });
});

describe('from — exit-code ladder (AC #3)', () => {
    function collectReturning(result: CollectResult): Partial<FromCommandEnv> {
        return { collect: () => Promise.resolve(result) };
    }
    const window = { from: new Date('2024-01-01T00:00:00.000Z'), to: new Date('2024-01-31T00:00:00.000Z') };

    it('exits 0 on success', async () => {
        const { error } = await runFrom(
            ['shop.example'],
            collectReturning({ outcome: 'succeeded', source: 'shop.example', window, written: [], skipped: [] }),
        );
        expect(error).toBeUndefined();
    });

    it('exits 3 on partial (some written, then failed)', async () => {
        const { error } = await runFrom(
            ['shop.example'],
            collectReturning({
                outcome: 'failed',
                source: 'shop.example',
                window,
                reason: 'fetch failed for inv-2',
                cause: new Error('boom'),
                written: [ref('inv-1', 5)],
                skipped: [],
            }),
        );
        expect(error).toMatchObject({ exitCode: 3 });
    });

    it('exits 4 on failure with no progress', async () => {
        const { error } = await runFrom(
            ['shop.example'],
            collectReturning({
                outcome: 'failed',
                source: 'shop.example',
                window,
                reason: 'auth endpoint unreachable',
                cause: new Error('ENOTFOUND'),
                written: [],
                skipped: [],
            }),
        );
        expect(error).toMatchObject({ exitCode: 4 });
    });

    it('exits 5 on reauth-required', async () => {
        const { error } = await runFrom(
            ['shop.example'],
            collectReturning({ outcome: 'reauth-required', source: 'shop.example', window, reason: 'session expired' }),
        );
        expect(error).toMatchObject({ exitCode: 5 });
    });

    it('drives the real pipeline: a dead session surfaces as reauth-required (exit 5)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'gr-from-reauth-'));
        try {
            const { error } = await runFrom(['shop.example', '--out', dir], {
                resolver: resolverWith(
                    fakeAdapter({ throwOnAuthenticate: new ReauthRequiredError('shop.example', 'session expired') }),
                ),
                createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
            });
            expect(error).toMatchObject({ exitCode: 5 });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('drives the real pipeline: an unresolvable challenge surfaces as reauth-required with the login remedy (exit 5) [#134]', async () => {
        // A source that demands a 2FA step mid-authenticate, with NO challenge resolver wired into the
        // collection path — so the challenge cannot be resolved on this surface.
        const challenger: SourceAdapter = {
            ...fakeAdapter(),
            authenticate: async () => ({
                challenge: { type: 'otp-sms', prompt: 'Enter the SMS code' },
                resume: async () => ({}) as unknown as AuthHandle,
            }),
        };
        const { out, error } = await runFrom(['shop.example'], { resolver: resolverWith(challenger) });

        // Never a hang, never a silent success: it surfaces the first-class re-auth signal (exit 5)...
        expect(error).toMatchObject({ exitCode: 5 });
        expect(out).toContain('shop.example — reauth-required');
        // ...carrying the actionable `login` remedy.
        expect(out).toContain('run `getreceipt login shop.example`');
    });

    it('exits 1 (usage) for an unknown source', async () => {
        const { err, error } = await runFrom(['no-such.example'], {
            resolver: new SourceResolver(new SourceAdapterRegistry()), // empty: nothing resolves
        });
        expect(error).toMatchObject({ exitCode: 1 });
        expect(err).toContain('No source adapter is registered');
    });

    it('exits 1 (usage) when the requested profile file does not exist (per-file model)', async () => {
        // --profile absent → ~/.getreceipt/absent.yaml; here a deliberately-missing path → a config read error.
        const { err, error } = await runFrom(['shop.example', '--profile', 'absent']);
        expect(error).toMatchObject({ exitCode: 1 });
        expect(err).toContain('config file could not be read');
    });

    it('exits 1 (usage) rejecting an inline-literal secret under --strict, never echoing it (#155)', async () => {
        // The default fixture configures `shop.example` with an INLINE secret. The `--strict` flag makes it
        // fail closed at config-load (the same fixture collects fine WITHOUT the flag — see the AC #1 test
        // above — so the flag is what rejects). The rejection is value-free.
        const { err, error } = await runFrom(['shop.example', '--strict']);
        expect(error).toMatchObject({ exitCode: 1, code: 'getreceipt.from.config' });
        expect(err).toContain('strict mode');
        expect(err).not.toContain('hunter2-not-real');
    });

    it('exits 1 (usage) on an incomplete window (--until without --since)', async () => {
        const { err, error } = await runFrom(['shop.example', '--until', '2024-01-31']);
        expect(error).toMatchObject({ exitCode: 1 });
        expect(err).toContain('requires --since');
    });

    // `2024-02-30`/`2024-04-31` (impossible day) and `2024-1-1`/`01/15/2024` (locale-dependent
    // legacy formats) would all silently parse to the WRONG window via bare `new Date(...)`;
    // strict YYYY-MM-DD validation rejects them as usage errors instead.
    it.each(['2024-02-30', '2024-04-31', '2024-1-1', '01/15/2024', 'last-tuesday'])(
        'exits 1 (usage) rejecting a malformed --since date: %s',
        async (bad) => {
            const { err, error } = await runFrom(['shop.example', '--since', bad, '--until', '2024-01-31']);
            expect(error).toMatchObject({ exitCode: 1 });
            expect(err).toContain('not a valid ISO date');
        },
    );
});

describe('from — human output names the outcome on a non-success run', () => {
    it('reports the source + outcome in human output for a non-success run', async () => {
        const { out, error } = await runFrom(['shop.example'], {
            collect: () =>
                Promise.resolve({
                    outcome: 'reauth-required',
                    source: 'shop.example',
                    window: { from: new Date('2024-01-01T00:00:00.000Z'), to: new Date('2024-01-31T00:00:00.000Z') },
                    reason: 'session expired',
                }),
        });
        expect(error).toMatchObject({ exitCode: 5 });
        expect(out).toContain('reauth-required');
    });
});

describe('from — consent gate (#32)', () => {
    it('blocks with exit 6 and never fetches when consent is required non-interactively', async () => {
        const collect = vi.fn(
            (): Promise<CollectResult> =>
                Promise.resolve({
                    outcome: 'succeeded',
                    source: 'shop.example',
                    window: { from: new Date(), to: new Date() },
                    written: [],
                    skipped: [],
                }),
        );
        const { error } = await runFrom(['shop.example'], {
            consent: { ensure: () => Promise.reject(new ConsentRequiredError('non-interactive')) },
            collect,
        });
        expect(error).toMatchObject({ exitCode: 6, code: 'getreceipt.from.consent-non-interactive' });
        expect(collect).not.toHaveBeenCalled();
    });

    it('exits 7 when the user declines consent', async () => {
        const { error } = await runFrom(['shop.example'], {
            consent: { ensure: () => Promise.reject(new ConsentRequiredError('declined')) },
        });
        expect(error).toMatchObject({ exitCode: 7, code: 'getreceipt.from.consent-declined' });
    });

    // These two assert ONLY the flag wiring; stub `collect` so the gate-passed run does no real fetch/write.
    const noopCollect = (): Promise<CollectResult> =>
        Promise.resolve({
            outcome: 'succeeded',
            source: 'shop.example',
            window: { from: new Date(), to: new Date() },
            written: [],
            skipped: [],
        });

    it('passes --accept-consent through to the gate as acceptFlag', async () => {
        const ensure = vi.fn(() => Promise.resolve());
        await runFrom(['shop.example', '--accept-consent'], { consent: { ensure }, collect: noopCollect });
        expect(ensure).toHaveBeenCalledWith({ acceptFlag: true });
    });

    it('defaults acceptFlag to false without the flag', async () => {
        const ensure = vi.fn(() => Promise.resolve());
        await runFrom(['shop.example'], { consent: { ensure }, collect: noopCollect });
        expect(ensure).toHaveBeenCalledWith({ acceptFlag: false });
    });

    it('end-to-end with the REAL gate + file store: blocks (6) non-interactively, then --accept-consent records and persists', async () => {
        // vitest is non-interactive (no TTY), so the real gate exercises the CI / piped path.
        const dir = mkdtempSync(join(tmpdir(), 'gr-consent-e2e-'));
        const consentPath = join(dir, 'consent.json');
        try {
            const notices: string[] = [];
            const consent = createConsentGate({
                store: createConsentStore(consentPath),
                io: { writeOut: () => {}, writeErr: (t) => notices.push(t) },
            });

            // No record + non-interactive + no flag → blocked with exit 6; nothing recorded, nothing fetched.
            const blocked = await runFrom(['shop.example', '--out', dir], { consent });
            expect(blocked.error).toMatchObject({ exitCode: 6 });
            expect(existsSync(consentPath)).toBe(false);
            expect(notices.join('')).toContain('--accept-consent'); // tells the user how to proceed

            // --accept-consent records the acknowledgment (genuinely on disk) and the run proceeds.
            notices.length = 0;
            const accepted = await runFrom(['shop.example', '--out', dir, '--accept-consent'], {
                consent,
                createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
            });
            expect(accepted.error).toBeUndefined();
            expect(existsSync(consentPath)).toBe(true);
            expect(notices.join('')).toContain('I confirm that I am collecting'); // disclosure shown before recording

            // Persistence: a later run is no longer gated — even WITHOUT the flag.
            const after = await runFrom(['shop.example', '--out', dir], {
                consent,
                createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
            });
            expect(after.error).toBeUndefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('from --verbose/--debug — secret-fenced diagnostics (AC #5)', () => {
    it('is silent by default (no stage diagnostics on stderr)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'gr-from-quiet-'));
        try {
            const { err } = await runFrom(['shop.example', '--out', dir], {
                createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
            });
            expect(err).toBe('');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('--verbose streams stage-level diagnostics to stderr', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'gr-from-verbose-'));
        try {
            const { err } = await runFrom(['shop.example', '--out', dir, '--verbose'], {
                createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
            });
            expect(err).toContain('authenticate: start');
            expect(err).toContain('list: 2 receipt(s)');
            expect(err).toContain('fetch: inv-1');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('--debug behaves as a --verbose alias', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'gr-from-debug-'));
        try {
            const { err } = await runFrom(['shop.example', '--out', dir, '--debug'], {
                createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
            });
            expect(err).toContain('authenticate: start');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('redacts a secret-shaped value from diagnostics, and the credential never appears', async () => {
        // A receipt id that matches a credential format must not survive into the trace.
        const secretShapedId = 'sk' + '_live_' + 'A'.repeat(28);
        const dir = mkdtempSync(join(tmpdir(), 'gr-from-fence-'));
        try {
            const { err } = await runFrom(['shop.example', '--out', dir, '--verbose'], {
                resolver: resolverWith(fakeAdapter({ listed: [ref(secretShapedId, 5)] })),
                createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
                resolveCredential: () => Promise.resolve(new Secret('sk' + '_live_' + 'B'.repeat(28))),
            });

            expect(err).toContain('authenticate: start');
            expect(err).toContain('suppressed');
            // No secret-shaped value reaches any diagnostic line.
            expect(scanForSecrets([{ path: 'verbose-stderr', content: err }])).toEqual([]);
            expect(err).not.toContain(secretShapedId);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('--verbose streams the challenge lifecycle to stderr — and never the prompt (#142 AC1)', async () => {
        // A source that demands a 2FA step, with NO challenge resolver wired into the collect path: the
        // challenge is emitted then degrades (no-resolver). That lifecycle is what --verbose must surface,
        // proving the observer is actually installed and fed through the real pipeline (not just unit-tested).
        const challenger: SourceAdapter = {
            ...fakeAdapter(),
            authenticate: async () => ({
                challenge: { type: 'otp-sms', prompt: 'Enter the SMS code' },
                resume: async () => ({}) as unknown as AuthHandle,
            }),
        };
        const dir = mkdtempSync(join(tmpdir(), 'gr-from-challenge-verbose-'));
        try {
            const { err } = await runFrom(['shop.example', '--out', dir, '--verbose'], {
                resolver: resolverWith(challenger),
                createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
            });
            // The adapter trace reports the stage honestly (#133 follow-up) — never a false "ok"...
            expect(err).toContain('authenticate: challenge issued (otp-sms)');
            expect(err).not.toContain('authenticate: ok');
            // ...and the observer streams the emitted → degraded lifecycle, built only from closed enums.
            expect(err).toContain('challenge emitted source=shop.example type=otp-sms');
            expect(err).toContain('challenge degraded source=shop.example reason=no-resolver type=otp-sms');
            // The human-facing prompt is NOT a closed enum — it must never reach a diagnostic line (AC2).
            expect(err).not.toContain('Enter the SMS code');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('from <canonical> --all-instances — one sign-in, data per instance (#190)', () => {
    const FR: InstanceContext = {
        domain: 'shop.example',
        host: 'www.shop.example',
        cookieDomain: '.shop.example',
        locale: 'fr-FR',
    };
    const DE: InstanceContext = { domain: 'shop.de', host: 'www.shop.de', cookieDomain: '.shop.de', locale: 'de-DE' };

    /** A multi-instance source: ONE sign-in, but `list`/`fetch` return DIFFERENT data per instance domain. */
    function multiInstanceAdapter(authCount: { n: number }): SourceAdapter {
        return {
            descriptor: {
                canonicalDomain: 'shop.example',
                aliasDomains: [],
                instances: [FR, DE],
                authKind: 'password',
                credentialShapes: ['password'],
                transportTier: 'http-api',
                artifactMode: 'pdf-download',
                dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
                timezone: 'UTC',
                defaultWindow: { days: 30 },
                pagination: 'none',
            },
            authenticate: async () => {
                authCount.n += 1;
                return {} as unknown as AuthHandle;
            },
            // Separate data per instance — the orders on .de are NOT the orders on .example (#190).
            list: async (_auth, _range, instance) =>
                instance?.domain === 'shop.de' ? [ref('de-1', 7)] : [ref('fr-1', 5), ref('fr-2', 6)],
            fetch: async (_auth, receipt, instance) =>
                ({
                    bytes: PDF_BYTES,
                    contentType: 'application/pdf',
                    filename: `${receipt.id}@${instance?.locale ?? 'none'}.pdf`,
                }) as unknown as ArtifactHandle,
        };
    }

    /** Config for the ONE source, fanning out to both instances under a single credential (#190). */
    function multiConfig(): ConfigParseResult {
        return {
            config: {
                sources: {
                    'shop.example': {
                        kind: 'password',
                        username: 'alice@shop.example',
                        secret: 'pw-not-real',
                        instances: ['shop.example', 'shop.de'],
                    },
                },
            },
            warnings: [],
        };
    }

    it('authenticates ONCE and writes each instance under its own output namespace (AC2/AC4)', async () => {
        const authCount = { n: 0 };
        const dir = mkdtempSync(join(tmpdir(), 'gr-from-instances-'));
        try {
            const { out, error } = await runFrom(['shop.example', '--all-instances', '--out', dir], {
                resolver: resolverWith(multiInstanceAdapter(authCount)),
                loadConfig: () => multiConfig(),
                createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
            });

            expect(error).toBeUndefined();
            // ONE sign-in shared across both instances — not one per instance.
            expect(authCount.n).toBe(1);
            // Per-instance output namespace: .example's two invoices and .de's one, each under its domain.
            expect(existsSync(join(dir, 'shop.example', 'fr-1.pdf'))).toBe(true);
            expect(existsSync(join(dir, 'shop.example', 'fr-2.pdf'))).toBe(true);
            expect(existsSync(join(dir, 'shop.de', 'de-1.pdf'))).toBe(true);
            // The .de invoice is NOT visible under .example (separate data, not aliased).
            expect(existsSync(join(dir, 'shop.example', 'de-1.pdf'))).toBe(false);
            // The batch report names both instances as succeeded.
            expect(out).toMatch(/shop\.example — succeeded/);
            expect(out).toMatch(/shop\.de — succeeded/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('fails closed when config lists an instance the adapter does not serve (AC2)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'gr-from-instances-bad-'));
        try {
            const { err, error } = await runFrom(['shop.example', '--all-instances', '--out', dir], {
                resolver: resolverWith(multiInstanceAdapter({ n: 0 })),
                loadConfig: () => ({
                    config: {
                        sources: {
                            'shop.example': {
                                kind: 'password',
                                secret: 'pw-not-real',
                                instances: ['shop.example', 'shop.it'],
                            },
                        },
                    },
                    warnings: [],
                }),
                createWriter: (outDir) => new FilesystemReceiptWriter({ outDir }),
            });
            // An unserved configured instance is a usage error, not a silent skip.
            expect(err).toContain('shop.it');
            expect(error).toMatchObject({ exitCode: 1 });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('from <domain> — attended re-auth loop (--reauth, #247)', () => {
    const window = { from: new Date('2024-01-01T00:00:00.000Z'), to: new Date('2024-01-31T00:00:00.000Z') };
    const reauthResult: CollectResult = {
        outcome: 'reauth-required',
        source: 'shop.example',
        window,
        reason: 'session expired',
    };
    const okResult: CollectResult = { outcome: 'succeeded', source: 'shop.example', window, written: [], skipped: [] };

    /** A `collect` seam yielding the queued outcomes in order (the last repeats), counting its calls. */
    function scriptedCollect(...results: readonly CollectResult[]): {
        collect: () => Promise<CollectResult>;
        calls: () => number;
    } {
        let index = 0;
        let calls = 0;
        return {
            collect: () => {
                calls += 1;
                const result = results[Math.min(index, results.length - 1)]!;
                index += 1;
                return Promise.resolve(result);
            },
            calls: () => calls,
        };
    }

    it('on a TTY: a mid-collect reauth-required prompts once, then the resume succeeds (exit 0)', async () => {
        const scripted = scriptedCollect(reauthResult, okResult);
        const prompts: string[] = [];
        const { out, err, error } = await runFrom(['shop.example', '--reauth'], {
            collect: scripted.collect,
            isInteractive: () => true,
            readLine: (_io, prompt) => {
                prompts.push(prompt);
                return Promise.resolve(''); // operator re-authed, pressed Enter
            },
        });
        expect(error).toBeUndefined(); // resumed to success → exit 0
        expect(scripted.calls()).toBe(2); // initial + one resume
        expect(prompts).toHaveLength(1); // exactly one prompt
        expect(err).toContain('Re-authentication is required to continue collecting from shop.example');
        expect(out).toContain('shop.example — succeeded');
    });

    it('bound=1: a resume that still needs re-auth stops after one prompt (exit 5, no coercive loop)', async () => {
        const scripted = scriptedCollect(reauthResult, reauthResult); // never clears
        const prompts: string[] = [];
        const { error } = await runFrom(['shop.example', '--reauth'], {
            collect: scripted.collect,
            isInteractive: () => true,
            readLine: (_io, prompt) => {
                prompts.push(prompt);
                return Promise.resolve('');
            },
        });
        expect(error).toMatchObject({ exitCode: 5 }); // honest reauth-required, not a re-prompt
        expect(scripted.calls()).toBe(2); // initial + exactly one resume
        expect(prompts).toHaveLength(1);
    });

    it('--reauth without a TTY: never prompts, never reads stdin — exit 5 (no hang)', async () => {
        const scripted = scriptedCollect(reauthResult);
        let readLineCalled = false;
        const { error } = await runFrom(['shop.example', '--reauth'], {
            collect: scripted.collect,
            isInteractive: () => false, // piped / CI
            readLine: () => {
                readLineCalled = true;
                return Promise.resolve('');
            },
        });
        expect(error).toMatchObject({ exitCode: 5 });
        expect(readLineCalled).toBe(false); // the blocked branch never reads stdin
        expect(scripted.calls()).toBe(1); // no resume
    });

    it('without --reauth: a reauth-required outcome never prompts, even on a TTY (loop not entered, exit 5)', async () => {
        const scripted = scriptedCollect(reauthResult);
        let readLineCalled = false;
        const { error } = await runFrom(['shop.example'], {
            collect: scripted.collect,
            isInteractive: () => true, // interactive, but no flag
            readLine: () => {
                readLineCalled = true;
                return Promise.resolve('');
            },
        });
        expect(error).toMatchObject({ exitCode: 5 });
        expect(readLineCalled).toBe(false);
        expect(scripted.calls()).toBe(1);
    });

    it('--json --reauth on a TTY: the prompt goes to stderr, a clean JSON document to stdout', async () => {
        const scripted = scriptedCollect(reauthResult, okResult);
        const { out, err, error } = await runFrom(['shop.example', '--reauth', '--json'], {
            collect: scripted.collect,
            isInteractive: () => true,
            readLine: () => Promise.resolve(''),
        });
        expect(error).toBeUndefined();
        expect(err).toContain('Re-authentication is required'); // human prompt on stderr
        const parsed = JSON.parse(out) as { outcome: string }; // stdout is a single clean JSON document
        expect(parsed.outcome).toBe('succeeded');
    });

    it('--all-instances --reauth: a batch reauth-required prompts once, then the resume succeeds (exit 0)', async () => {
        // With no configured instances the batch degrades to a single shared-auth run; one shared re-auth
        // heals it, so a single prompt resumes the whole batch.
        const scripted = scriptedCollect(reauthResult, okResult);
        const prompts: string[] = [];
        const { out, error } = await runFrom(['shop.example', '--all-instances', '--reauth'], {
            collect: scripted.collect,
            isInteractive: () => true,
            readLine: (_io, prompt) => {
                prompts.push(prompt);
                return Promise.resolve('');
            },
        });
        expect(error).toBeUndefined();
        expect(scripted.calls()).toBe(2);
        expect(prompts).toHaveLength(1);
        expect(out).toContain('shop.example — succeeded');
    });
});

describe('from <domain> — browser-tier attended sign-in wiring (#270)', () => {
    const BROWSER_SIGN_IN_URL = 'https://shop.example/ap/signin';
    const BROWSER_PROFILE_DIR = '/owned/shop.example';
    const window = { from: new Date('2024-01-01T00:00:00.000Z'), to: new Date('2024-01-31T00:00:00.000Z') };
    const reauthResult: CollectResult = {
        outcome: 'reauth-required',
        source: 'shop.example',
        window,
        reason: 'session expired',
    };
    const okResult: CollectResult = { outcome: 'succeeded', source: 'shop.example', window, written: [], skipped: [] };

    /**
     * A session adapter DECLARING the browser tier AND exposing the #264 `withBrowserProfile` bind seam, carrying
     * the baked sign-in URL fetch's step-up keys off — the shape a real browser-tier source (amazon) presents.
     */
    function browserTierAdapter(): SourceAdapter {
        const base = fakeAdapter();
        const bound: SourceAdapter = {
            ...base,
            descriptor: {
                ...base.descriptor,
                authKind: 'session',
                credentialShapes: ['none'],
                transportTier: 'headless-browser',
                signInUrl: BROWSER_SIGN_IN_URL,
            },
        };
        const bindable: SourceAdapter & BrowserProfileBindableAdapter = { ...bound, withBrowserProfile: () => bound };
        return bindable;
    }

    /** A paste-session config SELECTING the browser tier (`transport: headless-browser`). */
    const browserTierConfig: ConfigParseResult = {
        config: {
            sources: {
                'shop.example': {
                    kind: 'session',
                    paste: { ref: 'op://Private/browser-session' },
                    transport: 'headless-browser',
                },
            },
        },
        warnings: [],
    };

    /** A stub {@link SignInWindowOpener} recording each (profileDir, signInUrl) open + its closes — no Playwright. */
    function stubOpener(): {
        open: SignInWindowOpener;
        opens: () => ReadonlyArray<readonly [string, string]>;
        closes: () => number;
    } {
        const opens: Array<readonly [string, string]> = [];
        let closes = 0;
        return {
            open: (profileDir, signInUrl) => {
                opens.push([profileDir, signInUrl]);
                return Promise.resolve({
                    close: () => {
                        closes += 1;
                        return Promise.resolve();
                    },
                });
            },
            opens: () => opens,
            closes: () => closes,
        };
    }

    /** A `collect` seam yielding the queued outcomes in order (the last repeats), counting its calls. */
    function queuedCollect(...results: readonly CollectResult[]): {
        collect: () => Promise<CollectResult>;
        calls: () => number;
    } {
        let index = 0;
        let calls = 0;
        return {
            collect: () => {
                calls += 1;
                const result = results[Math.min(index, results.length - 1)]!;
                index += 1;
                return Promise.resolve(result);
            },
            calls: () => calls,
        };
    }

    /** Browser-tier overrides: a bindable browser adapter + its config, an injected owned-profile resolver (no home dir), a paste credential. */
    function browserTierEnv(firstRun: boolean, opener: SignInWindowOpener): Partial<FromCommandEnv> {
        return {
            resolver: resolverWith(browserTierAdapter()),
            loadConfig: () => browserTierConfig,
            resolveCredential: () => Promise.resolve(new Secret('Cookie: session-id=synthetic')),
            resolveOwnedProfile: () => ({ profileDir: BROWSER_PROFILE_DIR, firstRun }),
            openSignInWindow: opener,
            // No-op the #264 first-run notice: the default binds defaultEnv's real stderr (not the captured io), so
            // leaving it would leak to the process stream. Its behavior is covered in operation-runner.test.ts.
            onOwnedProfileFirstRun: () => {},
        };
    }

    it('AC1 first-run: an empty-profile browser-tier reauth on a TTY opens the OWNED window at the baked URL, then resumes (exit 0)', async () => {
        const opener = stubOpener();
        const scripted = queuedCollect(reauthResult, okResult);
        const { out, err, error } = await runFrom(['shop.example', '--reauth'], {
            ...browserTierEnv(true, opener.open),
            collect: scripted.collect,
            isInteractive: () => true,
            readLine: () => Promise.resolve(''), // operator signed in, pressed Enter
        });
        expect(error).toBeUndefined();
        expect(scripted.calls()).toBe(2); // initial reauth-required + one resume
        // The OWNED-profile window opened exactly once at the source's baked sign-in URL, and was closed on resume.
        expect(opener.opens()).toEqual([[BROWSER_PROFILE_DIR, BROWSER_SIGN_IN_URL]]);
        expect(opener.closes()).toBe(1);
        // The browser-tier prompt OPENS A WINDOW (not the HTTP text prompt) even on a first-run (empty) profile.
        expect(err).toContain('Opening a sign-in window in the getreceipt-owned browser profile');
        expect(out).toContain('shop.example — succeeded');
    });

    it('AC2 mid-collect: a warm-profile browser-tier step-up on a TTY opens the OWNED window, then resumes (exit 0)', async () => {
        const opener = stubOpener();
        const scripted = queuedCollect(reauthResult, okResult);
        const { err, error } = await runFrom(['shop.example', '--reauth'], {
            ...browserTierEnv(false, opener.open), // warm profile — no first-run notice
            collect: scripted.collect,
            isInteractive: () => true,
            readLine: () => Promise.resolve(''),
        });
        expect(error).toBeUndefined();
        expect(opener.opens()).toEqual([[BROWSER_PROFILE_DIR, BROWSER_SIGN_IN_URL]]);
        expect(opener.closes()).toBe(1);
        expect(err).not.toContain('First run'); // warm profile → no first-run heads-up, still opens the window
    });

    it('AC3 non-TTY: a browser-tier reauth-required NEVER opens a window (structural gate preserved), exit 5', async () => {
        const opener = stubOpener();
        const scripted = queuedCollect(reauthResult);
        const { error } = await runFrom(['shop.example', '--reauth'], {
            ...browserTierEnv(true, opener.open),
            collect: scripted.collect,
            isInteractive: () => false, // piped / scheduled
            readLine: () => Promise.reject(new Error('readLine must not be called on a non-TTY run')),
        });
        expect(error).toMatchObject({ exitCode: 5 }); // honest reauth-required
        expect(opener.opens()).toEqual([]); // no window ever launched
        expect(scripted.calls()).toBe(1); // no resume
    });

    it('AC3 no --reauth: a browser-tier reauth-required NEVER opens a window even on a TTY, exit 5', async () => {
        const opener = stubOpener();
        const scripted = queuedCollect(reauthResult);
        const { error } = await runFrom(['shop.example'], {
            ...browserTierEnv(true, opener.open),
            collect: scripted.collect,
            isInteractive: () => true, // interactive, but no --reauth flag
            readLine: () => Promise.reject(new Error('readLine must not be called without --reauth')),
        });
        expect(error).toMatchObject({ exitCode: 5 });
        expect(opener.opens()).toEqual([]);
        expect(scripted.calls()).toBe(1);
    });

    it('AC4 HTTP tier unchanged: a reauth on an http-api source keeps the text prompt — the window opener is NEVER called', async () => {
        const opener = stubOpener();
        const scripted = queuedCollect(reauthResult, okResult);
        const prompts: string[] = [];
        const { err, error } = await runFrom(['shop.example', '--reauth'], {
            // Default resolver/config = the http-api password source; inject an opener to PROVE it stays unused.
            openSignInWindow: opener.open,
            collect: scripted.collect,
            isInteractive: () => true,
            readLine: (_io, prompt) => {
                prompts.push(prompt);
                return Promise.resolve('');
            },
        });
        expect(error).toBeUndefined();
        expect(opener.opens()).toEqual([]); // the browser window is NEVER opened for an HTTP source
        expect(prompts).toHaveLength(1);
        // The HTTP text prompt directs the operator to THEIR OWN browser (the readLine prompt), and the
        // owned-profile window notice is absent from stderr — the HTTP path is unchanged (attendedReauthPrompt).
        expect(prompts[0]).toContain('in your browser');
        expect(err).not.toContain('Opening a sign-in window');
    });

    it('AC6 redaction: the owned-profile path is handed to the opener in-process but NEVER printed to the operator', async () => {
        const opener = stubOpener();
        const scripted = queuedCollect(reauthResult, okResult);
        const { err } = await runFrom(['shop.example', '--reauth'], {
            ...browserTierEnv(false, opener.open),
            collect: scripted.collect,
            isInteractive: () => true,
            readLine: () => Promise.resolve(''),
        });
        // The dir reaches the opener (the window needs it) but is a fixed-literal-free surface to the operator.
        expect(opener.opens()).toEqual([[BROWSER_PROFILE_DIR, BROWSER_SIGN_IN_URL]]);
        expect(err).not.toContain(BROWSER_PROFILE_DIR);
        expect(err).not.toContain('/owned');
    });
});
