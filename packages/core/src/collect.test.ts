// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { http, HttpResponse, server } from '@getreceipt/testing';

import {
    collect,
    collectInstances,
    formatChallengeEvent,
    ReauthRequiredError,
    SourceAdapterRegistry,
    SourceResolver,
} from './index.js';
import type {
    ArtifactHandle,
    AuthChallenge,
    AuthHandle,
    AuthResult,
    ChallengeLifecycleEvent,
    ChallengeResolution,
    ChallengeResolver,
    CollectFailed,
    CollectReauthRequired,
    CredentialContext,
    DateRange,
    InstanceContext,
    ReceiptRef,
    ReceiptWriter,
    SourceAdapter,
    SourceDescriptor,
} from './index.js';

// --- opaque-handle helpers -------------------------------------------------
// The pipeline threads these branded handles through without inspecting them, so
// tests mint them by casting a plain object.
function brand<T>(value: object): T {
    return value as unknown as T;
}
const credentials = brand<CredentialContext>({});

const baseDescriptor: SourceDescriptor = {
    canonicalDomain: 'free.fr',
    aliasDomains: [],
    authKind: 'password',
    credentialShapes: ['password'],
    transportTier: 'http-api',
    artifactMode: 'pdf-download',
    dateFilter: { basis: 'issued', fromInclusive: true, toInclusive: true },
    defaultWindow: { days: 90 },
    pagination: 'none',
};

function ref(id: string, issuedAt = '2026-03-01T00:00:00.000Z'): ReceiptRef {
    return { id, issuedAt: new Date(issuedAt) };
}

// --- in-memory scripted adapter -------------------------------------------
interface AdapterScript {
    readonly descriptor?: Partial<SourceDescriptor>;
    readonly refs?: readonly ReceiptRef[];
    /** Per-instance refs keyed by instance domain (#190): lets a multi-instance run yield distinct data per instance. */
    readonly refsByInstance?: Readonly<Record<string, readonly ReceiptRef[]>>;
    // Widened to AuthResult (#133) so a script can emit an interactive challenge, not only a session.
    readonly authenticate?: () => Promise<AuthResult>;
    readonly fetch?: (auth: AuthHandle, ref: ReceiptRef) => Promise<ArtifactHandle>;
}

interface AdapterProbe {
    readonly adapter: SourceAdapter;
    readonly log: string[];
    readonly listRanges: DateRange[];
    readonly fetched: string[];
    /** The instance domain each list/fetch was invoked with (undefined for a single-instance call) — used by #190 tests. */
    readonly listInstances: (string | undefined)[];
    readonly fetchInstances: (string | undefined)[];
}

function makeAdapter(script: AdapterScript = {}): AdapterProbe {
    const log: string[] = [];
    const listRanges: DateRange[] = [];
    const fetched: string[] = [];
    const listInstances: (string | undefined)[] = [];
    const fetchInstances: (string | undefined)[] = [];
    // A per-instance script (#190): map an instance domain to the refs its list returns, so a multi-instance
    // run can yield distinct data per instance. Falls back to the flat `refs` for single-instance runs.
    const refsByInstance = script.refsByInstance;
    const refs = script.refs ?? [];

    const adapter: SourceAdapter = {
        descriptor: { ...baseDescriptor, ...script.descriptor },
        authenticate: async (creds) => {
            log.push('authenticate');
            return script.authenticate ? script.authenticate() : brand<AuthHandle>({ creds });
        },
        list: async (_auth, range, instance) => {
            log.push('list');
            listRanges.push(range);
            listInstances.push(instance?.domain);
            if (refsByInstance !== undefined && instance !== undefined) {
                return refsByInstance[instance.domain] ?? [];
            }
            return refs;
        },
        fetch: async (auth, receiptRef, instance) => {
            log.push(`fetch:${receiptRef.id}`);
            fetched.push(receiptRef.id);
            fetchInstances.push(instance?.domain);
            return script.fetch ? script.fetch(auth, receiptRef) : brand<ArtifactHandle>({ id: receiptRef.id });
        },
    };
    return { adapter, log, listRanges, fetched, listInstances, fetchInstances };
}

// --- recording writer ------------------------------------------------------
interface WriterProbe {
    readonly writer: ReceiptWriter;
    readonly written: string[];
    readonly artifacts: ArtifactHandle[];
    /** `${source}/${id}` per write — proves per-instance output namespacing (#190 AC7). */
    readonly writtenPaths: string[];
}

function makeWriter(options: { has?: (source: string, ref: ReceiptRef) => boolean; log?: string[] } = {}): WriterProbe {
    const written: string[] = [];
    const artifacts: ArtifactHandle[] = [];
    const writtenPaths: string[] = [];
    const writer: ReceiptWriter = {
        has: async (source, receiptRef) => options.has?.(source, receiptRef) ?? false,
        write: async (source, receiptRef, artifact) => {
            options.log?.push(`write:${receiptRef.id}`);
            written.push(receiptRef.id);
            writtenPaths.push(`${source}/${receiptRef.id}`);
            artifacts.push(artifact);
        },
    };
    return { writer, written, artifacts, writtenPaths };
}

// --- concurrency test helpers ---------------------------------------------
interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
}
function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const NOW = new Date('2026-06-21T00:00:00.000Z');

describe('collect', () => {
    it('runs authenticate -> list -> fetch -> write in order [AC1]', async () => {
        const probe = makeAdapter({ refs: [ref('r1'), ref('r2')] });
        const writer = makeWriter({ log: probe.log });

        const result = await collect({ adapter: probe.adapter, credentials, writer: writer.writer, now: NOW });

        expect(result.outcome).toBe('succeeded');
        expect(probe.log).toEqual(['authenticate', 'list', 'fetch:r1', 'write:r1', 'fetch:r2', 'write:r2']);
        expect(writer.written).toEqual(['r1', 'r2']);
    });

    it('drives a registered adapter end-to-end against mocked transport [AC1]', async () => {
        server.use(
            http.post('https://free.fr/session', () => new HttpResponse(null, { status: 204 })),
            http.get('https://free.fr/receipts', () =>
                HttpResponse.json([
                    { id: 'inv-1', issuedAt: '2026-05-01T00:00:00.000Z' },
                    { id: 'inv-2', issuedAt: '2026-05-08T00:00:00.000Z' },
                ]),
            ),
            http.get('https://free.fr/receipts/:id', ({ params }) => HttpResponse.text(`pdf:${String(params.id)}`)),
        );

        const registry = new SourceAdapterRegistry();
        registry.register(makeHttpAdapter());
        const resolver = new SourceResolver(registry);
        const writer = makeWriter();

        const result = await collect({
            adapter: resolver.resolve('free.fr'),
            credentials,
            writer: writer.writer,
            now: NOW,
        });

        expect(result.outcome).toBe('succeeded');
        if (result.outcome === 'succeeded') {
            expect(result.written.map((r) => r.id)).toEqual(['inv-1', 'inv-2']);
        }
        expect(writer.artifacts.map((a) => (a as unknown as { body: string }).body)).toEqual([
            'pdf:inv-1',
            'pdf:inv-2',
        ]);
    });

    it('applies and echoes an explicit date window [AC2]', async () => {
        const probe = makeAdapter({ refs: [] });
        const writer = makeWriter();
        const window: DateRange = {
            from: new Date('2026-01-01T00:00:00.000Z'),
            to: new Date('2026-03-01T00:00:00.000Z'),
        };

        const result = await collect({ adapter: probe.adapter, credentials, writer: writer.writer, window, now: NOW });

        expect(probe.listRanges).toEqual([window]); // applied: handed to list()
        expect(result.window).toEqual(window); // echoed back
    });

    it('falls back to the adapter default window when none is given [AC2]', async () => {
        const probe = makeAdapter({ refs: [], descriptor: { defaultWindow: { days: 30 } } });
        const writer = makeWriter();

        const result = await collect({ adapter: probe.adapter, credentials, writer: writer.writer, now: NOW });

        const expected: DateRange = { from: new Date('2026-05-22T00:00:00.000Z'), to: NOW };
        expect(probe.listRanges).toEqual([expected]); // default applied
        expect(result.window).toEqual(expected); // and echoed
    });

    it('surfaces exactly one typed reauth-required signal for a dead session [AC3]', async () => {
        const probe = makeAdapter({
            refs: [ref('r1')],
            authenticate: () => {
                throw new ReauthRequiredError('free.fr', 'token expired');
            },
        });
        const writer = makeWriter();

        const result = await collect({ adapter: probe.adapter, credentials, writer: writer.writer, now: NOW });

        expect(result.outcome).toBe('reauth-required');
        expect(result.source).toBe('free.fr');
        expect((result as CollectReauthRequired).reason).toBe('token expired');
        // No inline prompt; nothing fetched or written.
        expect(probe.fetched).toEqual([]);
        expect(writer.written).toEqual([]);
        // The effective window is still echoed for the caller.
        expect(result.window).toEqual({ from: new Date('2026-03-23T00:00:00.000Z'), to: NOW });
    });

    it('reports reauth-required when the session dies mid-run [AC3]', async () => {
        const probe = makeAdapter({
            refs: [ref('r1'), ref('r2')],
            fetch: (_auth, receiptRef) => {
                if (receiptRef.id === 'r2') {
                    throw new ReauthRequiredError('free.fr');
                }
                return Promise.resolve(brand<ArtifactHandle>({ id: receiptRef.id }));
            },
        });
        const writer = makeWriter();

        const result = await collect({ adapter: probe.adapter, credentials, writer: writer.writer, now: NOW });

        expect(result.outcome).toBe('reauth-required');
        expect((result as CollectReauthRequired).reason).toBeUndefined();
    });

    it('captures a source failure as a structured result instead of throwing [AC4]', async () => {
        const boom = new Error('connection reset');
        const probe = makeAdapter({
            refs: [ref('r1')],
            fetch: () => {
                throw boom;
            },
        });
        const writer = makeWriter();

        // Resolves (does not reject) — the failure never escapes the boundary.
        const result = await collect({ adapter: probe.adapter, credentials, writer: writer.writer, now: NOW });

        expect(result.outcome).toBe('failed');
        const failed = result as CollectFailed;
        expect(failed.reason).toContain('connection reset');
        expect(failed.cause).toBe(boom);
    });

    it('keeps partial progress when one receipt fails [AC4]', async () => {
        const probe = makeAdapter({
            refs: [ref('r1'), ref('r2'), ref('r3')],
            fetch: (_auth, receiptRef) => {
                if (receiptRef.id === 'r2') {
                    throw new Error('fetch r2 failed');
                }
                return Promise.resolve(brand<ArtifactHandle>({ id: receiptRef.id }));
            },
        });
        const writer = makeWriter();

        const result = await collect({ adapter: probe.adapter, credentials, writer: writer.writer, now: NOW });

        expect(result.outcome).toBe('failed');
        const failed = result as CollectFailed;
        expect(failed.written.map((r) => r.id)).toEqual(['r1', 'r3']); // r1 and r3 still collected
        expect(failed.reason).toContain('fetch r2 failed');
    });

    it('returns a structured failure for an invalid fetchConcurrency instead of throwing [AC4]', async () => {
        const probe = makeAdapter({ refs: [ref('r1')] });
        const writer = makeWriter();

        // Resolves rather than rejecting, even though Semaphore rejects a 0 capacity.
        const result = await collect({
            adapter: probe.adapter,
            credentials,
            writer: writer.writer,
            fetchConcurrency: 0,
            now: NOW,
        });

        expect(result.outcome).toBe('failed');
        expect((result as CollectFailed).cause).toBeInstanceOf(RangeError);
        expect(probe.log).toEqual([]); // the bad cap is caught before authenticating
    });

    it('skips receipts the writer already has, without fetching them [idempotency]', async () => {
        const probe = makeAdapter({ refs: [ref('r1'), ref('r2'), ref('r3')] });
        const writer = makeWriter({ has: (_source, receiptRef) => receiptRef.id === 'r2' });

        const result = await collect({ adapter: probe.adapter, credentials, writer: writer.writer, now: NOW });

        expect(result.outcome).toBe('succeeded');
        if (result.outcome === 'succeeded') {
            expect(result.written.map((r) => r.id)).toEqual(['r1', 'r3']);
            expect(result.skipped.map((r) => r.id)).toEqual(['r2']);
        }
        // r2 already present: never re-downloaded (never-clobber, no wasted work).
        expect(probe.fetched).toEqual(['r1', 'r3']);
        expect(writer.written).toEqual(['r1', 'r3']);
    });

    it('caps concurrent fetches at fetchConcurrency [AC5 integration]', async () => {
        const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
        let active = 0;
        let peak = 0;
        const probe = makeAdapter({
            refs: [ref('r1'), ref('r2'), ref('r3'), ref('r4')],
            fetch: async (_auth, receiptRef) => {
                active += 1;
                peak = Math.max(peak, active);
                const index = Number(receiptRef.id.slice(1)) - 1;
                await gates[index]!.promise;
                active -= 1;
                return brand<ArtifactHandle>({ id: receiptRef.id });
            },
        });
        const writer = makeWriter();

        const run = collect({
            adapter: probe.adapter,
            credentials,
            writer: writer.writer,
            fetchConcurrency: 2,
            now: NOW,
        });
        await flush();
        expect(active).toBe(2); // only 2 in flight despite 4 listed

        for (const gate of gates) {
            gate.resolve();
            await flush();
        }
        const result = await run;

        expect(result.outcome).toBe('succeeded');
        expect(peak).toBe(2); // fan-out never exceeded the cap
    });
});

// --- interactive auth challenge (#133) ------------------------------------
// A resolver that answers every challenge with a fixed resolution, recording the challenges it saw.
function recordingResolver(resolution: ChallengeResolution = { response: '123456' }): {
    readonly resolver: ChallengeResolver;
    readonly seen: AuthChallenge[];
} {
    const seen: AuthChallenge[] = [];
    return {
        resolver: {
            resolve: async (challenge) => {
                seen.push(challenge);
                return resolution;
            },
        },
        seen,
    };
}

// An authenticate() that demands one challenge, then resumes to a session.
function challengingAuth(type: AuthChallenge['type'] = 'otp-totp'): () => Promise<AuthResult> {
    return async () => ({
        challenge: { type, prompt: 'Enter the code' },
        resume: async () => brand<AuthHandle>({ resumed: true }),
    });
}

// An authenticate() that NEVER establishes a session: every resume yields a further challenge, so a
// resolver that keeps answering eventually trips MAX_AUTH_CHALLENGE_ROUNDS (the `exhausted` path).
function endlesslyChallengingAuth(type: AuthChallenge['type'] = 'otp-totp'): () => Promise<AuthResult> {
    const result: AuthResult = {
        challenge: { type, prompt: 'Enter the code' },
        resume: async () => result,
    };
    return async () => result;
}

describe('collect — interactive auth challenge (#133)', () => {
    it('resolves an adapter-issued challenge through the injected resolver, then resumes into list/fetch', async () => {
        const { resolver, seen } = recordingResolver();
        const probe = makeAdapter({ refs: [ref('inv-1')], authenticate: challengingAuth('otp-totp') });
        const writer = makeWriter({ log: probe.log });

        const result = await collect({
            adapter: probe.adapter,
            credentials,
            writer: writer.writer,
            challengeResolver: resolver,
            now: NOW,
        });

        expect(result.outcome).toBe('succeeded');
        // The flow resumed past authenticate into list + fetch.
        expect(probe.log).toEqual(['authenticate', 'list', 'fetch:inv-1', 'write:inv-1']);
        expect(seen.map((c) => c.type)).toEqual(['otp-totp']); // the resolver saw exactly the issued challenge
    });

    it('surfaces reauth-required (never failed, never a hang) when a challenge is issued but no resolver is configured [#134]', async () => {
        const probe = makeAdapter({ refs: [ref('inv-1')], authenticate: challengingAuth('otp-sms') });
        const writer = makeWriter({ log: probe.log });

        const result = await collect({ adapter: probe.adapter, credentials, writer: writer.writer, now: NOW });

        // The unresolvable challenge maps onto the first-class re-auth signal (a front-end renders the
        // `login` remedy from it), not a generic `failed` — and not a silent success.
        expect(result.outcome).toBe('reauth-required');
        expect((result as CollectReauthRequired).reason).toContain('otp-sms');
        // Stopped at authenticate: it never blocked on input and never reached list/fetch/write.
        expect(probe.log).toEqual(['authenticate']);
    });

    it('leaves a non-challenge adapter unaffected: succeeds with no resolver supplied', async () => {
        const probe = makeAdapter({ refs: [ref('inv-1')] }); // default authenticate returns a bare AuthHandle
        const writer = makeWriter({ log: probe.log });

        const result = await collect({ adapter: probe.adapter, credentials, writer: writer.writer, now: NOW });

        expect(result.outcome).toBe('succeeded');
        expect(probe.log).toEqual(['authenticate', 'list', 'fetch:inv-1', 'write:inv-1']);
    });
});

// --- unresolvable challenge → reauth-required (#134) -----------------------
describe('collect — unresolvable challenge surfaces reauth-required (#134)', () => {
    it('maps an exhausted challenge chain (a source that never stops challenging) to reauth-required', async () => {
        const { resolver } = recordingResolver();
        const probe = makeAdapter({ refs: [ref('inv-1')], authenticate: endlesslyChallengingAuth('otp-totp') });
        const writer = makeWriter({ log: probe.log });

        const result = await collect({
            adapter: probe.adapter,
            credentials,
            writer: writer.writer,
            challengeResolver: resolver,
            now: NOW,
        });

        expect(result.outcome).toBe('reauth-required');
        expect((result as CollectReauthRequired).reason).toMatch(/too many authentication challenges/);
        // The round cap tripped during authenticate; list/fetch were never reached.
        expect(probe.log).toEqual(['authenticate']);
    });

    it('keeps the reauth-required reason redaction-fenced: only the challenge type, never the prompt or descriptor', async () => {
        // The human-facing prompt + descriptor carry recognizable strings; none may surface in the result.
        const probe = makeAdapter({
            authenticate: async () => ({
                challenge: {
                    type: 'otp-sms',
                    prompt: 'Enter the 6-digit code we texted to 06-SECRET-89',
                    metadata: { target: 'phone-ending-SECRET89' },
                },
                resume: async () => brand<AuthHandle>({}),
            }),
        });
        const writer = makeWriter({ log: probe.log });

        const result = await collect({ adapter: probe.adapter, credentials, writer: writer.writer, now: NOW });

        expect(result.outcome).toBe('reauth-required');
        const reason = (result as CollectReauthRequired).reason ?? '';
        expect(reason).toContain('otp-sms'); // the safe, closed-enum type is named
        expect(reason).not.toContain('SECRET'); // neither the prompt nor the descriptor leaks through
    });
});

// --- challenge lifecycle observability (#142) ------------------------------
describe('collect — challenge lifecycle observability (#142)', () => {
    it('records a resolved challenge as a terminal outcome on the result [AC3]', async () => {
        const { resolver } = recordingResolver();
        const probe = makeAdapter({ refs: [ref('inv-1')], authenticate: challengingAuth('otp-totp') });
        const writer = makeWriter({ log: probe.log });

        const result = await collect({
            adapter: probe.adapter,
            credentials,
            writer: writer.writer,
            challengeResolver: resolver,
            now: NOW,
        });

        expect(result.outcome).toBe('succeeded');
        expect(result.challenges).toEqual([{ outcome: 'resolved', type: 'otp-totp', mode: 'totp-computed' }]);
    });

    it('records a degraded challenge outcome even when the run surfaces reauth-required [AC3]', async () => {
        // No resolver → the otp-sms challenge degrades; the outcome must still reach the report.
        const probe = makeAdapter({ refs: [ref('inv-1')], authenticate: challengingAuth('otp-sms') });
        const writer = makeWriter({ log: probe.log });

        const result = await collect({ adapter: probe.adapter, credentials, writer: writer.writer, now: NOW });

        expect(result.outcome).toBe('reauth-required');
        expect(result.challenges).toEqual([{ outcome: 'degraded', reason: 'no-resolver', type: 'otp-sms' }]);
    });

    it('keeps a resolved outcome on the report even when the run later fails — resolved means answered, not succeeded [AC3]', async () => {
        // The resolver answers the challenge, but resuming the session then throws (a downstream failure).
        // The challenge WAS resolved, so its outcome must survive onto the `failed` result, not vanish.
        const { resolver } = recordingResolver();
        const probe = makeAdapter({
            authenticate: async () => ({
                challenge: { type: 'otp-totp', prompt: 'Enter the code' },
                resume: async () => {
                    throw new Error('session broke after the challenge was answered');
                },
            }),
        });
        const writer = makeWriter({ log: probe.log });

        const result = await collect({
            adapter: probe.adapter,
            credentials,
            writer: writer.writer,
            challengeResolver: resolver,
            now: NOW,
        });

        expect(result.outcome).toBe('failed');
        expect(result.challenges).toEqual([{ outcome: 'resolved', type: 'otp-totp', mode: 'totp-computed' }]);
    });

    it('streams the live lifecycle to an injected observer [AC1]', async () => {
        const { resolver } = recordingResolver();
        const probe = makeAdapter({ refs: [ref('inv-1')], authenticate: challengingAuth('otp-totp') });
        const writer = makeWriter({ log: probe.log });
        const events: ChallengeLifecycleEvent[] = [];

        await collect({
            adapter: probe.adapter,
            credentials,
            writer: writer.writer,
            challengeResolver: resolver,
            challengeObserver: (event) => events.push(event),
            now: NOW,
        });

        expect(events).toEqual([
            { phase: 'emitted', source: 'free.fr', type: 'otp-totp' },
            { phase: 'resolved', source: 'free.fr', type: 'otp-totp', mode: 'totp-computed' },
        ]);
    });

    it('omits `challenges` entirely when no challenge occurred (the common case)', async () => {
        const probe = makeAdapter({ refs: [ref('inv-1')] }); // bare AuthHandle, no challenge
        const writer = makeWriter({ log: probe.log });

        const result = await collect({ adapter: probe.adapter, credentials, writer: writer.writer, now: NOW });

        expect(result.outcome).toBe('succeeded');
        expect(result.challenges).toBeUndefined();
    });

    it('NEVER leaks the resolved code or trust election into the report or any log line [AC2]', async () => {
        // The resolver answers with a real OTP code + a trust election; neither is credential-format-shaped
        // (the regex fence cannot catch them), so this proves the stronger by-construction guarantee:
        // the event/outcome types simply have no field to carry them.
        const { resolver } = recordingResolver({ response: '123456', trustThisDevice: true });
        const probe = makeAdapter({ refs: [ref('inv-1')], authenticate: challengingAuth('otp-totp') });
        const writer = makeWriter({ log: probe.log });
        const lines: string[] = [];

        const result = await collect({
            adapter: probe.adapter,
            credentials,
            writer: writer.writer,
            challengeResolver: resolver,
            challengeObserver: (event) => lines.push(formatChallengeEvent(event)),
            now: NOW,
        });

        const reportJson = JSON.stringify(result);
        expect(reportJson).not.toContain('123456');
        expect(reportJson).not.toContain('trustThisDevice');
        for (const line of lines) {
            expect(line).not.toContain('123456');
            expect(line).not.toContain('trustThisDevice');
        }
        // The outcome IS present (enums only) — redaction must not have dropped the observability itself.
        expect(result.challenges).toEqual([{ outcome: 'resolved', type: 'otp-totp', mode: 'totp-computed' }]);
    });
});

/** A minimal adapter that actually speaks HTTP — exercised against MSW-mocked transport. */
function makeHttpAdapter(): SourceAdapter {
    return {
        descriptor: baseDescriptor,
        authenticate: async () => {
            const res = await fetch('https://free.fr/session', { method: 'POST' });
            if (!res.ok) {
                throw new Error(`session failed: ${res.status}`);
            }
            return brand<AuthHandle>({});
        },
        list: async (_auth, range) => {
            const url = new URL('https://free.fr/receipts');
            url.searchParams.set('since', range.from.toISOString());
            url.searchParams.set('until', range.to.toISOString());
            const res = await fetch(url);
            const rows = (await res.json()) as Array<{ id: string; issuedAt: string }>;
            return rows.map((row) => ({ id: row.id, issuedAt: new Date(row.issuedAt) }));
        },
        fetch: async (_auth, receiptRef) => {
            const res = await fetch(`https://free.fr/receipts/${receiptRef.id}`);
            return brand<ArtifactHandle>({ body: await res.text() });
        },
    };
}

// --- #190 multi-instance: collectInstances (auth once, data per instance) --
const FR: InstanceContext = {
    domain: 'amazon.fr',
    host: 'https://www.amazon.fr',
    cookieDomain: 'amazon.fr',
    locale: 'fr-FR',
};
const COM: InstanceContext = {
    domain: 'amazon.com',
    host: 'https://www.amazon.com',
    cookieDomain: 'amazon.com',
    locale: 'en-US',
};
const DE: InstanceContext = {
    domain: 'amazon.de',
    host: 'https://www.amazon.de',
    cookieDomain: 'amazon.de',
    locale: 'de-DE',
};

describe('collectInstances — one config, shared auth, data per instance (#190)', () => {
    it('authenticates ONCE then lists/fetches per instance, yielding two distinct data instances [AC4/AC8]', async () => {
        const probe = makeAdapter({
            descriptor: { canonicalDomain: 'amazon.fr' },
            refsByInstance: { 'amazon.fr': [ref('FR-1')], 'amazon.com': [ref('COM-1'), ref('COM-2')] },
        });
        const writer = makeWriter();

        const results = await collectInstances({
            adapter: probe.adapter,
            credentials,
            writer: writer.writer,
            instances: [FR, COM],
            now: NOW,
        });

        // Auth once for the source (AC4); list runs per instance, in order.
        expect(probe.log.filter((entry) => entry === 'authenticate')).toHaveLength(1);
        expect(probe.listInstances).toEqual(['amazon.fr', 'amazon.com']);
        // One result per instance, each keyed by its OWN domain; both succeed.
        expect(results.map((result) => result.outcome)).toEqual(['succeeded', 'succeeded']);
        expect(results.map((result) => result.source)).toEqual(['amazon.fr', 'amazon.com']);
        // Two distinct data instances, namespaced per instance domain (AC7/AC8) — no collision.
        expect(writer.writtenPaths).toEqual(['amazon.fr/FR-1', 'amazon.com/COM-1', 'amazon.com/COM-2']);
        expect(probe.fetchInstances).toEqual(['amazon.fr', 'amazon.com', 'amazon.com']);
    });

    it('surfaces ONE source-level reauth-required for a dead shared session, never one per instance [AC6]', async () => {
        const probe = makeAdapter({
            descriptor: { canonicalDomain: 'amazon.fr' },
            authenticate: async () => {
                throw new ReauthRequiredError('amazon.fr', 'the imported browser session is no longer signed in');
            },
        });
        const writer = makeWriter();

        const results = await collectInstances({
            adapter: probe.adapter,
            credentials,
            writer: writer.writer,
            instances: [FR, COM, DE],
            now: NOW,
        });

        // Exactly ONE reauth signal, for the SOURCE (canonical), not N per instance; no instance listed.
        expect(results).toHaveLength(1);
        expect(results[0]?.outcome).toBe('reauth-required');
        expect(results[0]?.source).toBe('amazon.fr');
        expect(probe.listInstances).toEqual([]);
    });

    it('stops at the first instance whose session dies mid-run, blocking the rest [AC6]', async () => {
        const log: string[] = [];
        const adapter: SourceAdapter = {
            descriptor: { ...baseDescriptor, canonicalDomain: 'amazon.fr' },
            authenticate: async () => {
                log.push('authenticate');
                return brand<AuthHandle>({});
            },
            list: async (_auth, _range, instance) => {
                log.push(`list:${instance?.domain}`);
                if (instance?.domain === 'amazon.com') {
                    throw new ReauthRequiredError('amazon.com');
                }
                return [ref('FR-1')];
            },
            fetch: async (_auth, receiptRef) => {
                log.push(`fetch:${receiptRef.id}`);
                return brand<ArtifactHandle>({ id: receiptRef.id });
            },
        };

        const results = await collectInstances({
            adapter,
            credentials,
            writer: makeWriter().writer,
            instances: [FR, COM, DE],
            now: NOW,
        });

        // fr succeeds, com hits reauth, de is never attempted (the dead session blocks every remaining instance).
        expect(results.map((result) => result.outcome)).toEqual(['succeeded', 'reauth-required']);
        expect(log).toEqual(['authenticate', 'list:amazon.fr', `fetch:FR-1`, 'list:amazon.com']);
    });

    it('continues to the next instance after a non-reauth failure (continue-on-error) [AC5]', async () => {
        const adapter: SourceAdapter = {
            descriptor: { ...baseDescriptor, canonicalDomain: 'amazon.fr' },
            authenticate: async () => brand<AuthHandle>({}),
            list: async (_auth, _range, instance) => {
                if (instance?.domain === 'amazon.fr') {
                    throw new Error('fr listing boom');
                }
                return [ref('COM-1')];
            },
            fetch: async (_auth, receiptRef) => brand<ArtifactHandle>({ id: receiptRef.id }),
        };
        const writer = makeWriter();

        const results = await collectInstances({
            adapter,
            credentials,
            writer: writer.writer,
            instances: [FR, COM],
            now: NOW,
        });

        expect(results[0]?.outcome).toBe('failed');
        expect(results[1]?.outcome).toBe('succeeded');
        // The failing instance does not strand the next: com still collected, namespaced to its own domain.
        expect(writer.writtenPaths).toEqual(['amazon.com/COM-1']);
    });
});

describe('collect — coarse-list window (#243)', () => {
    // A coarse-list source (e.g. amazon): list() can't precisely date-filter, so refs carry only a coarse
    // provisional date; the authoritative date arrives at FETCH time on the artifact. `real` maps each id to
    // the date its fetch reveals; the list refs all carry the same coarse Jan-1 provisional.
    const COARSE = { precision: 'coarse', order: 'newest-first' } as const;
    const COARSE_PROVISIONAL = '2026-01-01T00:00:00.000Z';

    /** An artifact `asReceiptArtifact()` accepts, carrying the authoritative fetched date (or none, for a degraded parse). */
    function datedArtifact(issuedAt: Date | undefined): ArtifactHandle {
        return brand<ArtifactHandle>({
            bytes: new Uint8Array([1]),
            contentType: 'application/pdf',
            ...(issuedAt !== undefined ? { issuedAt } : {}),
        });
    }

    /** A coarse adapter whose refs (newest-first) each fetch to the date `real[id]` reveals. */
    function coarseProbe(ids: readonly string[], real: Record<string, Date | undefined>): AdapterProbe {
        return makeAdapter({
            descriptor: { listWindow: COARSE },
            refs: ids.map((id) => ref(id, COARSE_PROVISIONAL)),
            fetch: async (_auth, r) => datedArtifact(real[r.id]),
        });
    }

    const win = (from: string, to: string): DateRange => ({ from: new Date(from), to: new Date(to) });

    it('writes in-window receipts with the AUTHORITATIVE fetched date, superseding the coarse provisional', async () => {
        const probe = coarseProbe(['a', 'b'], {
            a: new Date('2026-05-10T00:00:00.000Z'),
            b: new Date('2026-04-02T00:00:00.000Z'),
        });
        const writer = makeWriter({ log: probe.log });

        const result = await collect({
            adapter: probe.adapter,
            credentials,
            writer: writer.writer,
            window: win('2026-03-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
            now: NOW,
        });

        expect(result.outcome).toBe('succeeded');
        expect(probe.fetched).toEqual(['a', 'b']); // sequential, in listing order
        expect(writer.written).toEqual(['a', 'b']);
        if (result.outcome === 'succeeded') {
            // The result surface carries the real fetched date, NOT the coarse Jan-1 provisional (#243 result-leak fix).
            expect(result.written.map((r) => r.issuedAt.toISOString())).toEqual([
                '2026-05-10T00:00:00.000Z',
                '2026-04-02T00:00:00.000Z',
            ]);
            expect(result.outOfWindow).toBeUndefined(); // all in-window → omitted (exact-path parity)
        }
    });

    it('stops at the first ref OLDER than the window (newest-first) — later refs are never fetched', async () => {
        const probe = coarseProbe(['a', 'b', 'c', 'd'], {
            a: new Date('2026-06-01T00:00:00.000Z'), // in
            b: new Date('2026-04-01T00:00:00.000Z'), // in
            c: new Date('2026-02-01T00:00:00.000Z'), // older than from → out, and STOP
            d: new Date('2026-01-15T00:00:00.000Z'), // never reached
        });
        const writer = makeWriter();

        const result = await collect({
            adapter: probe.adapter,
            credentials,
            writer: writer.writer,
            window: win('2026-03-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
            now: NOW,
        });

        expect(probe.fetched).toEqual(['a', 'b', 'c']); // c fetched to learn its date; d never fetched (early-stop)
        expect(writer.written).toEqual(['a', 'b']); // c is out-of-window, not written
        if (result.outcome === 'succeeded') {
            expect(result.outOfWindow?.map((r) => r.id)).toEqual(['c']);
        }
    });

    it('skips too-NEW refs but keeps walking (a past --until), only stopping on the older boundary', async () => {
        const probe = coarseProbe(['a', 'b', 'c'], {
            a: new Date('2026-06-01T00:00:00.000Z'), // newer than to → out, but CONTINUE
            b: new Date('2026-04-01T00:00:00.000Z'), // in
            c: new Date('2026-02-01T00:00:00.000Z'), // older than from → out, and STOP
        });
        const writer = makeWriter();

        const result = await collect({
            adapter: probe.adapter,
            credentials,
            writer: writer.writer,
            window: win('2026-03-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
            now: NOW,
        });

        expect(probe.fetched).toEqual(['a', 'b', 'c']); // walked past the too-new head
        expect(writer.written).toEqual(['b']);
        if (result.outcome === 'succeeded') {
            expect(result.outOfWindow?.map((r) => r.id)).toEqual(['a', 'c']); // too-new + too-old
        }
    });

    it('writes an UNDATEABLE receipt (never drops it) and never early-stops on it', async () => {
        const probe = coarseProbe(['a', 'b'], { a: undefined, b: undefined }); // parser degraded to no date
        const writer = makeWriter();

        const result = await collect({
            adapter: probe.adapter,
            credentials,
            writer: writer.writer,
            window: win('2026-03-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
            now: NOW,
        });

        expect(probe.fetched).toEqual(['a', 'b']); // no early-stop on an undefined date
        expect(writer.written).toEqual(['a', 'b']); // both written (inclusive degrade — never under-collect)
        if (result.outcome === 'succeeded') {
            // Nothing authoritative to supersede with → the ref keeps its coarse provisional date.
            expect(result.written.map((r) => r.issuedAt.toISOString())).toEqual([
                COARSE_PROVISIONAL,
                COARSE_PROVISIONAL,
            ]);
            expect(result.outOfWindow).toBeUndefined();
        }
    });

    it('skips a receipt the writer already has WITHOUT fetching it, then continues the walk', async () => {
        const probe = coarseProbe(['a', 'b'], {
            a: new Date('2026-06-01T00:00:00.000Z'),
            b: new Date('2026-05-01T00:00:00.000Z'),
        });
        const writer = makeWriter({ has: (_source, r) => r.id === 'a' }); // already have 'a'

        const result = await collect({
            adapter: probe.adapter,
            credentials,
            writer: writer.writer,
            window: win('2026-03-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
            now: NOW,
        });

        expect(probe.fetched).toEqual(['b']); // 'a' skipped without a fetch
        expect(writer.written).toEqual(['b']);
        if (result.outcome === 'succeeded') {
            expect(result.skipped.map((r) => r.id)).toEqual(['a']);
        }
    });

    it('a fetch re-auth stops the pass, surfaces reauth-required, and keeps partial progress on disk', async () => {
        const probe = makeAdapter({
            descriptor: { listWindow: COARSE },
            refs: ['a', 'b', 'c'].map((id) => ref(id, COARSE_PROVISIONAL)),
            fetch: async (_auth, r) => {
                if (r.id === 'b') {
                    throw new ReauthRequiredError('free.fr', 'step-up');
                }
                return datedArtifact(new Date('2026-06-01T00:00:00.000Z'));
            },
        });
        const writer = makeWriter();

        const result = await collect({
            adapter: probe.adapter,
            credentials,
            writer: writer.writer,
            window: win('2026-03-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
            now: NOW,
        });

        expect(result.outcome).toBe('reauth-required'); // reauth precedence, via the shared summarizeErrors mapping
        expect(probe.fetched).toEqual(['a', 'b']); // stopped at b; c never fetched (no deeper exposure)
        expect(writer.written).toEqual(['a']); // partial progress persisted before the stop
    });
});
