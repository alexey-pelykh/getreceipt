// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';

import { http, HttpResponse, server } from '@getreceipt/testing';

import { collect, ReauthRequiredError, SourceAdapterRegistry, SourceResolver } from './index.js';
import type {
    ArtifactHandle,
    AuthHandle,
    CollectFailed,
    CollectReauthRequired,
    CredentialContext,
    DateRange,
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
    readonly authenticate?: () => Promise<AuthHandle>;
    readonly fetch?: (auth: AuthHandle, ref: ReceiptRef) => Promise<ArtifactHandle>;
}

interface AdapterProbe {
    readonly adapter: SourceAdapter;
    readonly log: string[];
    readonly listRanges: DateRange[];
    readonly fetched: string[];
}

function makeAdapter(script: AdapterScript = {}): AdapterProbe {
    const log: string[] = [];
    const listRanges: DateRange[] = [];
    const fetched: string[] = [];
    const refs = script.refs ?? [];

    const adapter: SourceAdapter = {
        descriptor: { ...baseDescriptor, ...script.descriptor },
        authenticate: async (creds) => {
            log.push('authenticate');
            return script.authenticate ? script.authenticate() : brand<AuthHandle>({ creds });
        },
        list: async (_auth, range) => {
            log.push('list');
            listRanges.push(range);
            return refs;
        },
        fetch: async (auth, receiptRef) => {
            log.push(`fetch:${receiptRef.id}`);
            fetched.push(receiptRef.id);
            return script.fetch ? script.fetch(auth, receiptRef) : brand<ArtifactHandle>({ id: receiptRef.id });
        },
    };
    return { adapter, log, listRanges, fetched };
}

// --- recording writer ------------------------------------------------------
interface WriterProbe {
    readonly writer: ReceiptWriter;
    readonly written: string[];
    readonly artifacts: ArtifactHandle[];
}

function makeWriter(options: { has?: (source: string, ref: ReceiptRef) => boolean; log?: string[] } = {}): WriterProbe {
    const written: string[] = [];
    const artifacts: ArtifactHandle[] = [];
    const writer: ReceiptWriter = {
        has: async (source, receiptRef) => options.has?.(source, receiptRef) ?? false,
        write: async (_source, receiptRef, artifact) => {
            options.log?.push(`write:${receiptRef.id}`);
            written.push(receiptRef.id);
            artifacts.push(artifact);
        },
    };
    return { writer, written, artifacts };
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
